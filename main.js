const { app, BrowserWindow, ipcMain, Menu, screen, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CREDS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const USAGE_POLL_MS = 180_000;   // gentle cadence — the usage endpoint rate-limits
const API_POLL_MS = 300_000;
const TOKEN_POLL_MS = 2_000;
const ACTIVE_FILE_WINDOW_MS = 15 * 60_000;
const FIVE_H = 5 * 3600_000;
const SEVEN_D = 7 * 86_400_000;

let win = null;

// keep one userData dir (window position, flags) across dev runs and the
// packaged app, which would otherwise use the productName-based path
app.setPath('userData', path.join(app.getPath('appData'), 'claude-usage-widget'));

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

// WIDGET_DEMO=subscription|api renders fixed sample figures and makes no
// network calls, so screenshots never carry anyone's account details
const DEMO = ['subscription', 'api'].includes(process.env.WIDGET_DEMO) ? process.env.WIDGET_DEMO : null;

function demoUsage() {
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  const week = at(4 * 86_400_000 + 6 * 3_600_000);
  return {
    ok: true,
    fetchedAt: Date.now(),
    limits: [
      { kind: 'session', percent: 46, severity: 'normal', resetsAt: at(2 * 3_600_000 + 21 * 60_000), label: 'Session' },
      { kind: 'weekly_all', percent: 38, severity: 'normal', resetsAt: week, label: 'Weekly' },
      { kind: 'weekly_scoped', percent: 55, severity: 'normal', resetsAt: week, label: 'Model' },
    ],
    credits: {
      currency: 'USD', usedMinor: 1840, capMinor: 5000, balanceMinor: 3160, enabled: true,
      reason: null, userDisabled: false, limitReached: false, autoReload: true, severity: 'normal',
    },
  };
}

const DEMO_API = {
  ok: true, currency: 'USD', loadedMinor: 10000, remainingMinor: 6275, usedMinor: 3725,
  nextExpiry: '2027-03-01T00:00:00Z', monthMinor: 1210, monthResetsAt: null,
  capMinor: null, userCapSet: false, autoReload: true,
};

// 'subscription' reads the plan limits; 'api' reads Console prepaid credits
const isApi = () => (DEMO ? DEMO === 'api' : loadConfig().mode === 'api');

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
// money fields come as { money|credits: { amount_minor } } or bare
const minorOf = (v) => v?.money?.amount_minor ?? v?.credits?.amount_minor ?? v?.amount_minor ?? null;

// subscription usage credits, read straight from the usage payload: monthly
// cap, this month's spend, on/off state and why. balance and auto_reload are
// passed through whenever Anthropic fills them (both null on this account so
// far). Returns null when credits were never set up.
function extraUsageState(data) {
  const x = data.extra_usage || {};
  const s = data.spend || {};
  if (!(x.credits_ever_enabled || x.is_enabled || s.enabled || x.monthly_limit != null)) return null;
  const ar = s.auto_reload;
  return {
    currency: s.used?.currency || x.currency || 'USD',
    usedMinor: s.used?.amount_minor ?? Math.round(x.used_credits || 0),
    capMinor: minorOf(s.cap) ?? minorOf(s.limit) ?? x.monthly_limit ?? null,
    balanceMinor: minorOf(s.balance),
    enabled: !!(x.is_enabled ?? s.enabled),
    reason: x.disabled_reason || s.disabled_reason || null,
    userDisabled: !!x.user_disabled,
    limitReached: !!x.spend_limit_reached,
    autoReload: ar == null ? null
      : typeof ar === 'object' ? !!(ar.enabled ?? (ar.status ? ar.status !== 'disabled' : true))
      : !!ar,
    severity: s.severity || 'normal',
  };
}

async function pollUsage() {
  if (!win || win.isDestroyed() || isApi()) return;
  if (DEMO) { win.webContents.send('usage', demoUsage()); return; }
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
    win.webContents.send('usage', {
      ok: true,
      limits,
      credits: extraUsageState(data),
      fetchedAt: lastGoodAt,
    });
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

// ---------- API credits (Claude Console) ----------
// There is no public endpoint for prepaid balance, and the Admin API is not
// available to individual orgs, so this reads the internal endpoints the
// Console billing page itself uses. They are authenticated by a Console
// sign-in held in a widget-only session partition, and are undocumented:
// any failure blanks the readings rather than showing stale numbers.

const CONSOLE_ORIGIN = 'https://platform.claude.com';
const CONSOLE_PARTITION = 'persist:console';

let consoleSes = null;
function consoleSession() {
  if (!consoleSes) {
    consoleSes = session.fromPartition(CONSOLE_PARTITION);
    // Google refuses sign-in from user agents that name an embedded browser
    consoleSes.setUserAgent(
      consoleSes.getUserAgent().replace(/ (Electron|claude-usage-widget)\/\S+/g, ''),
    );
  }
  return consoleSes;
}

// diagnostics for the undocumented Console calls: statuses and error text
// only, never response bodies on success or cookie values
function log(msg) {
  try {
    const p = path.join(app.getPath('userData'), 'widget.log');
    if (fs.existsSync(p) && fs.statSync(p).size > 100_000) fs.writeFileSync(p, '');
    fs.appendFileSync(p, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

async function consoleGet(p) {
  const res = await consoleSession().fetch(CONSOLE_ORIGIN + p, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    const names = (await consoleSession().cookies.get({ url: CONSOLE_ORIGIN })).map((c) => c.name);
    const text = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
    log(`console GET ${p} -> ${res.status} cookies=[${names.join(',')}] body=${text}`);
  }
  if (res.status === 401 || res.status === 403) {
    const e = new Error('console-signin');
    e.signin = true;
    throw e;
  }
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json();
}

// the account can hold a claude.ai org and a Console org; credits live on the
// one with the 'api' capability
async function findApiOrg() {
  const orgs = await consoleGet('/api/organizations');
  const api = (orgs || []).filter((o) => (o.capabilities || []).includes('api'));
  const pick = api.find((o) => o.billing_type === 'prepaid') || api[0];
  if (!pick) throw new Error('no-api-org');
  return pick.uuid;
}

// loaded = credit granted across the current tranches; remaining is the live
// balance, so used covers spend from every tranche. All amounts are cents.
function summariseApi(credits, month, limits, reload) {
  const tranches = [...(credits.tranches || []), ...(credits.promo_tranches || [])];  const loadedMinor = tranches.reduce((s, t) => s + (t.granted_amount_minor_units || 0), 0);
  const remainingMinor =
    credits.balance?.credits?.amount_minor ?? credits.balance?.money?.amount_minor ?? credits.amount ?? 0;
  return {
    currency: credits.currency || 'USD',
    loadedMinor,
    remainingMinor,
    usedMinor: Math.max(0, loadedMinor - remainingMinor),
    nextExpiry: credits.next_expires_at || null,
    monthMinor: month.amount ?? 0,
    monthResetsAt: month.resets_at || null,
    // enforced_limit_usd is in cents despite its name; with no user limit it
    // is the tier ceiling
    capMinor: limits.enforced_limit_usd ?? null,
    userCapSet: (limits.spend_limits || []).length > 0,
    autoReload: reload.status && reload.status !== 'disabled',
  };
}

let apiOrg = null;
let apiInFlight = false;
let lastApiGoodAt = null;

async function pollApi() {
  if (!win || win.isDestroyed() || !isApi() || apiInFlight) return;
  if (DEMO) { win.webContents.send('api', DEMO_API); return; }
  apiInFlight = true;
  try {
    if (!apiOrg) apiOrg = await findApiOrg();
    const base = `/api/organizations/${apiOrg}`;
    const [credits, month, limits, reload] = await Promise.all([
      consoleGet(`${base}/prepaid/credits`),
      consoleGet(`${base}/current_spend`),
      consoleGet(`${base}/spend_limits`),
      consoleGet(`${base}/prepaid/auto_recharge`),
    ]);
    lastApiGoodAt = Date.now();
    win.webContents.send('api', { ok: true, ...summariseApi(credits, month, limits, reload) });
  } catch (err) {
    if (err.signin) apiOrg = null;
    win.webContents.send('api', {
      ok: false,
      error: err.signin ? 'console-signin' : String(err.message || err),
      staleForMs: lastApiGoodAt ? Date.now() - lastApiGoodAt : null,
    });
  } finally {
    apiInFlight = false;
  }
}

let signinWin = null;

// a window opened from the widget's context menu can come up hidden on
// Windows, so show it explicitly rather than trusting the default
function revealSignin() {
  if (!signinWin || signinWin.isDestroyed()) return;
  if (signinWin.isMinimized()) signinWin.restore();
  signinWin.show();
  signinWin.focus();
}

function openConsoleSignin() {
  if (signinWin && !signinWin.isDestroyed()) { revealSignin(); return; }
  consoleSession(); // apply the user agent before the first request
  signinWin = new BrowserWindow({
    width: 520,
    height: 720,
    show: false,
    center: true,
    title: 'Sign in to Claude Console',
    autoHideMenuBar: true,
    webPreferences: { partition: CONSOLE_PARTITION },
  });
  // the widget sits at screen-saver level; keep sign-in above it
  signinWin.setAlwaysOnTop(true, 'screen-saver');
  signinWin.once('ready-to-show', revealSignin);
  // fallback if the page is slow to paint
  setTimeout(revealSignin, 1500);
  // Google sign-in opens a popup, which must share this session and sit
  // above the always-on-top sign-in window
  signinWin.webContents.setWindowOpenHandler(({ url }) => ({
    action: url.startsWith('https://') ? 'allow' : 'deny',
  }));
  signinWin.webContents.on('did-create-window', (child) => {
    child.setAlwaysOnTop(true, 'screen-saver');
    child.show();
    child.focus();
  });
  signinWin.loadURL(`${CONSOLE_ORIGIN}/settings/billing`);

  // the session is signed in once the org list answers; close and poll
  const timer = setInterval(async () => {
    try { apiOrg = await findApiOrg(); } catch { return; }
    clearInterval(timer);
    if (signinWin && !signinWin.isDestroyed()) signinWin.close();
  }, 3000);
  signinWin.on('closed', () => {
    clearInterval(timer);
    signinWin = null;
    pollApi();
  });
}

async function signOutConsole() {
  await consoleSession().clearStorageData();
  apiOrg = null;
  lastApiGoodAt = null;
  pollApi();
}

function setMode(mode) {
  saveConfig({ mode });
  if (!win || win.isDestroyed()) return;
  win.webContents.send('mode', mode);
  if (mode === 'api') pollApi(); else pollUsage();
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
  if (DEMO) { win.webContents.send('totals', { session: 48_213_904, weekly: 612_447_210 }); return; }
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

// a saved position survives monitor changes, so it can point outside every
// display; the widget is frameless and skips the taskbar, which leaves no way
// to drag it back. Restore it only while a grabbable corner is still on a
// display, otherwise pull it inside the nearest one.
const MIN_VISIBLE = 48;

function restorePosition(x, y, w, h) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {};
  const overlap = (a) =>
    Math.min(x + w, a.x + a.width) - Math.max(x, a.x) >= MIN_VISIBLE &&
    Math.min(y + h, a.y + a.height) - Math.max(y, a.y) >= MIN_VISIBLE;
  if (screen.getAllDisplays().some((d) => overlap(d.workArea))) return { x, y };
  const a = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  return {
    x: Math.round(Math.max(a.x, Math.min(x, a.x + a.width - w))),
    y: Math.round(Math.max(a.y, Math.min(y, a.y + a.height - h))),
  };
}

// re-run the check when a monitor is added, removed or rescaled while the
// widget is running, so it is never stranded off the desktop
function keepOnScreen() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const pos = restorePosition(b.x, b.y, b.width, b.height);
  if (pos.x === undefined || (pos.x === b.x && pos.y === b.y)) return;
  win.setPosition(pos.x, pos.y);
  saveConfig({ x: pos.x, y: pos.y });
}

function createWindow() {
  const cfg = loadConfig();
  const w = clampW(cfg.w || BASE_W);
  const h = Math.round(w * RATIO);
  const pos = restorePosition(cfg.x, cfg.y, w, h);
  // write the corrected position straight back, so a stranded config heals
  // even if the widget is never moved by hand afterwards
  if (pos.x !== undefined && (pos.x !== cfg.x || pos.y !== cfg.y)) saveConfig(pos);
  win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
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
    const api = isApi();
    Menu.buildFromTemplate([
      { label: 'Refresh now', click: () => (api ? pollApi() : pollUsage()) },
      {
        label: 'Mode',
        submenu: [
          { label: 'Subscription', type: 'radio', checked: !api, click: () => setMode('subscription') },
          { label: 'API credits', type: 'radio', checked: api, click: () => setMode('api') },
        ],
      },
      { label: 'Sign in to Console…', visible: api, click: openConsoleSignin },
      { label: 'Sign out of Console', visible: api, click: signOutConsole },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: win.isAlwaysOnTop(),
        click: (item) => win.setAlwaysOnTop(item.checked, 'screen-saver'),
      },
      {
        label: 'Start at login',
        type: 'checkbox',
        enabled: app.isPackaged, // dev runs would register electron.exe
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
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

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('mode', isApi() ? 'api' : 'subscription');
    if (isApi()) pollApi(); else pollUsage();
  });
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
  // first packaged run: register with Windows startup (Settings > Apps >
  // Startup) once; the context-menu checkbox controls it from then on
  if (app.isPackaged && !loadConfig().loginItemInit) {
    app.setLoginItemSettings({ openAtLogin: true });
    saveConfig({ loginItemInit: true });
  }

  createWindow();
  initWatcher();
  scanHistory();
  setInterval(pollUsage, USAGE_POLL_MS);
  setInterval(pollApi, API_POLL_MS);
  setInterval(pollTokens, TOKEN_POLL_MS);
  setInterval(pollHover, 150);

  for (const ev of ["display-removed", "display-added", "display-metrics-changed"]) {
    screen.on(ev, keepOnScreen);
  }
});

app.on('window-all-closed', () => app.quit());
