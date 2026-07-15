const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
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

function readAccessToken() {
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  return creds?.claudeAiOauth?.accessToken || null;
}

async function fetchUsage() {
  const token = readAccessToken();
  if (!token) throw new Error('no-token');
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
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
    win.webContents.send('usage', {
      ok: false,
      error: String(err.message || err),
      staleForMs: lastGoodAt ? Date.now() - lastGoodAt : null,
    });
    // exponential backoff so we don't feed the rate limiter
    usageRetryTimer = setTimeout(pollUsage, usageBackoffMs);
    usageBackoffMs = Math.min(usageBackoffMs * 2, 600_000);
  }
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

  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: win.isAlwaysOnTop(),
        click: (item) => win.setAlwaysOnTop(item.checked, 'screen-saver'),
      },
      { label: 'Refresh now', click: () => pollUsage() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]).popup({ window: win });
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
