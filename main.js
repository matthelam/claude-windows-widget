const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CREDS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const USAGE_POLL_MS = 180_000;   // gentle cadence — the usage endpoint rate-limits
const TOKEN_POLL_MS = 2_000;
const ACTIVE_FILE_WINDOW_MS = 15 * 60_000;
const FIVE_H = 5 * 3600_000;
const SEVEN_D = 7 * 86_400_000;

let win = null;

// single-instance guard — a second launch focuses the existing widget
// instead of spawning another poller against the usage endpoint
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.show();
  });
}

// ---------- window position persistence ----------

const configPath = () => path.join(app.getPath('userData'), 'widget-config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg)); } catch {}
}

// ---------- plan usage (OAuth endpoint) ----------

// window starts derived from the API's resets_at timestamps; the odometers
// total local tokens within these windows
const windowStarts = { session: null, weekly: null };

function readCreds() {
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  const o = creds?.claudeAiOauth;
  return { token: o?.accessToken || null, expiresAt: o?.expiresAt || null };
}

async function fetchUsage() {
  const { token, expiresAt } = readCreds();
  if (!token) throw new Error('no-token');
  // an expired token gets 429s (not 401s) from the endpoint — never send it;
  // Claude Code rewrites the file on its next run and we re-read every poll
  if (expiresAt && Date.now() >= expiresAt) {
    const e = new Error('auth-expired');
    e.localOnly = true;
    throw e;
  }
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!res.ok) {
    const e = new Error(`http-${res.status}`);
    const ra = Number(res.headers.get('retry-after'));
    if (ra > 0) e.retryAfterMs = Math.min(ra * 1000, 3_600_000);
    throw e;
  }
  return res.json();
}

let usageRetryTimer = null;
let usageBackoffMs = 30_000;
let lastGoodAt = null;
let lastAttemptAt = 0;

async function pollUsage() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(usageRetryTimer);
  lastAttemptAt = Date.now();
  try {
    const data = await fetchUsage();
    const limits = (data.limits || []).map((l) => ({
      kind: l.kind,
      group: l.group,
      percent: l.percent,
      severity: l.severity,
      resetsAt: l.resets_at,
      label:
        l.kind === 'session' ? 'Session'
        : l.kind === 'weekly_all' ? 'Weekly'
        : (l.scope?.model?.display_name || 'Model'),
    }));

    const sess = limits.find((l) => l.kind === 'session');
    const week = limits.find((l) => l.kind === 'weekly_all');
    windowStarts.session = sess ? Date.parse(sess.resetsAt) - FIVE_H : null;
    windowStarts.weekly = week ? Date.parse(week.resetsAt) - SEVEN_D : null;

    lastGoodAt = Date.now();
    usageBackoffMs = 30_000;
    win.webContents.send('usage', { ok: true, limits, fetchedAt: lastGoodAt });
    sendTotals();
  } catch (err) {
    let errorCode = String(err.message || err);
    if (err.localOnly) {
      // token truly expired: silently run a minimal `claude -p` so Claude
      // Code rewrites the credentials file, and recheck the file soon
      tryAutoRefreshAuth();
      if (authRefreshInFlight) errorCode = 'auth-refreshing';
    }
    win.webContents.send('usage', {
      ok: false,
      error: errorCode,
      staleForMs: lastGoodAt ? Date.now() - lastGoodAt : null,
    });
    if (err.localOnly) {
      usageRetryTimer = setTimeout(pollUsage, 60_000);
    } else {
      // exponential backoff, and honor the server's Retry-After if longer
      const delay = Math.max(usageBackoffMs, err.retryAfterMs || 0);
      usageRetryTimer = setTimeout(pollUsage, delay);
      usageBackoffMs = Math.min(usageBackoffMs * 2, 600_000);
    }
  }
}

// ---------- silent auth refresh ----------
// Runs a minimal hidden `claude -p` purely so Claude Code refreshes the OAuth
// token in .credentials.json. Called ONLY when the stored token is already
// past its expiry timestamp; single-flight and at most once per 10 minutes.

let authRefreshInFlight = false;
let lastAuthRefreshAt = 0;

function tryAutoRefreshAuth() {
  const now = Date.now();
  if (authRefreshInFlight || now - lastAuthRefreshAt < 10 * 60_000) return;
  authRefreshInFlight = true;
  lastAuthRefreshAt = now;

  let child;
  try {
    child = spawn('claude', ['-p', 'ok', '--max-turns', '1'], {
      shell: true,          // resolves the claude .cmd shim on Windows
      windowsHide: true,    // no console window
      stdio: 'ignore',
    });
  } catch {
    authRefreshInFlight = false;
    return;
  }
  const killer = setTimeout(() => { try { child.kill(); } catch {} }, 120_000);
  child.on('exit', () => {
    clearTimeout(killer);
    authRefreshInFlight = false;
    pollUsage(); // pick up the refreshed token right away
  });
  child.on('error', () => {
    clearTimeout(killer);
    authRefreshInFlight = false;
  });
}

// ---------- token totals (tail Claude Code transcripts) ----------

const fileState = new Map();     // path -> { offset, remainder }
const minuteBuckets = new Map(); // epoch-minute -> tokens
let historyReady = false;
let lastPrune = 0;

function listTranscripts() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(PROJECTS_DIR, 0);
  return out;
}

function addTokens(t, tokens) {
  const m = Math.floor(t / 60_000);
  minuteBuckets.set(m, (minuteBuckets.get(m) || 0) + tokens);
}

function parseLine(line) {
  if (!line || line.indexOf('"usage"') === -1) return null;
  try {
    const obj = JSON.parse(line);
    const u = obj?.message?.usage;
    if (!u) return null;
    const tokens =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0);
    if (!tokens) return null;
    return { t: obj.timestamp ? Date.parse(obj.timestamp) : NaN, tokens };
  } catch { return null; }
}

function initWatcher() {
  // start at end of every existing file so the live tail only reads NEW lines
  for (const p of listTranscripts()) {
    try {
      fileState.set(p, { offset: fs.statSync(p).size, remainder: '' });
    } catch {}
  }
}

// one-time startup scan of the last 7 days, so the odometers include tokens
// spent before the widget launched; reads only up to each file's tail offset
async function scanHistory() {
  const cutoff = Date.now() - SEVEN_D;
  for (const p of listTranscripts()) {
    await new Promise((r) => setImmediate(r)); // keep the main process responsive
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    const end = fileState.get(p)?.offset ?? stat.size;
    if (end === 0) continue;
    let text;
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(end);
      fs.readSync(fd, buf, 0, end, 0);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { continue; }
    for (const line of text.split('\n')) {
      const ev = parseLine(line);
      if (ev && Number.isFinite(ev.t) && ev.t >= cutoff) addTokens(ev.t, ev.tokens);
    }
  }
  historyReady = true;
  sendTotals();
}

function pollTokens() {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();

  for (const p of listTranscripts()) {
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    if (now - stat.mtimeMs > ACTIVE_FILE_WINDOW_MS) continue;

    let state = fileState.get(p);
    if (!state) { state = { offset: 0, remainder: '' }; fileState.set(p, state); }
    if (stat.size < state.offset) { state.offset = 0; state.remainder = ''; } // truncated/rotated
    if (stat.size === state.offset) continue;

    let chunk;
    try {
      const fd = fs.openSync(p, 'r');
      const len = stat.size - state.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.offset);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { continue; }
    state.offset = stat.size;

    const text = state.remainder + chunk;
    const lines = text.split('\n');
    state.remainder = lines.pop() || '';
    for (const line of lines) {
      const ev = parseLine(line);
      if (ev) addTokens(Number.isFinite(ev.t) ? ev.t : now, ev.tokens);
    }
  }

  if (now - lastPrune > 3600_000) {
    lastPrune = now;
    const cutoffMin = Math.floor((now - SEVEN_D - 3600_000) / 60_000);
    for (const m of minuteBuckets.keys()) if (m < cutoffMin) minuteBuckets.delete(m);
  }

  sendTotals();
}

function sendTotals() {
  if (!win || win.isDestroyed()) return;
  const ss = windowStarts.session;
  const ws = windowStarts.weekly;
  let session = 0;
  let weekly = 0;
  for (const [m, tok] of minuteBuckets) {
    const t = m * 60_000;
    if (ws != null && t >= ws) weekly += tok;
    if (ss != null && t >= ss) session += tok;
  }
  win.webContents.send('totals', {
    session: historyReady && ss != null ? session : null,
    weekly: historyReady && ws != null ? weekly : null,
  });
}

// ---------- window ----------

const BASE_W = 320;
const BASE_H = 320;
const RATIO = BASE_H / BASE_W;
const MIN_W = 200;
const MAX_W = 800;

const clampW = (w) => Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));

function createWindow() {
  const cfg = loadConfig();
  const w = clampW(cfg.w || BASE_W);
  win = new BrowserWindow({
    width: w,
    height: Math.round(w * RATIO),
    x: cfg.x,
    y: cfg.y,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // native edge-drag resize (the body's near-invisible alpha makes the edges
  // hit-testable); keep the gauge's aspect while resizing
  win.setAspectRatio(BASE_W / BASE_H);
  win.setMinimumSize(MIN_W, Math.round(MIN_W * RATIO));
  win.setMaximumSize(MAX_W, Math.round(MAX_W * RATIO));
  win.loadFile('index.html');

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    saveConfig({ x, y });
  });

  win.on('resized', () => {
    const b = win.getBounds();
    saveConfig({ x: b.x, y: b.y, w: b.width });
  });

  const showMenu = () => {
    Menu.buildFromTemplate([
      { label: 'Refresh now', click: () => pollUsage() },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: win.isAlwaysOnTop(),
        click: (item) => win.setAlwaysOnTop(item.checked, 'screen-saver'),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]).popup({ window: win });
  };

  // right-clicks over no-drag areas surface here…
  win.webContents.on('context-menu', showMenu);
  // …but most of the widget is a drag region, where Windows intercepts
  // right-click for the system window menu — suppress that and show ours
  win.on('system-context-menu', (event) => {
    event.preventDefault();
    showMenu();
  });

  win.webContents.on('did-finish-load', () => pollUsage());
}

ipcMain.on('widget-close', () => app.quit());
// countdown hit zero — but never let renderer requests exceed 1/min
ipcMain.on('refresh-usage', () => {
  if (Date.now() - lastAttemptAt > 60_000) pollUsage();
});

// CSS :hover never fires over -webkit-app-region: drag areas (the OS handles
// them as caption hits), so detect hover here and tell the renderer.
let lastHover = false;
function pollHover() {
  if (!win || win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
  if (inside !== lastHover) {
    lastHover = inside;
    win.webContents.send('hover', inside);
  }
}

app.whenReady().then(() => {
  createWindow();
  initWatcher();
  scanHistory();
  setInterval(pollUsage, USAGE_POLL_MS);
  setInterval(pollTokens, TOKEN_POLL_MS);
  setInterval(pollHover, 150);
});

app.on('window-all-closed', () => app.quit());
