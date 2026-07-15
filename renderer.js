const SVG_NS = 'http://www.w3.org/2000/svg';
const CX = 160, CY = 160;
const START_DEG = 135, SWEEP_DEG = 270;   // classic gauge sweep, gap at bottom
const REDLINE_FRAC = 0.8;

// pin identities — length/weight/shape/color distinguish them, watch-hand style:
//   session = long thin bright-blue needle (the fast mover)
//   weekly  = shorter broad silver blade
//   fable   = short amber arrow (only shown when the API reports that limit)
const PINS = {
  session: { color: '#4aa3ff', len: 104 },
  weekly:  { color: '#dfe3e9', len: 78 },
  scoped:  { color: '#f5a623', len: 54 },
};

const svg = document.getElementById('gauge');

const shown = { session: 0, weekly: 0, scoped: 0 };
const target = { session: 0, weekly: 0, scoped: 0 };
const pinEls = {};
let odoSessionEl = null, odoWeeklyEl = null, errEl = null;
let timerSessionEl = null, timerWeeklyEl = null;

// ---------- geometry helpers ----------

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function arcPath(r, fromFrac, toFrac) {
  const a0 = START_DEG + SWEEP_DEG * fromFrac;
  const a1 = START_DEG + SWEEP_DEG * toFrac;
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

function el(name, attrs, parent) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  (parent || svg).appendChild(n);
  return n;
}

// ---------- build ----------

function build() {
  const defs = el('defs', {});
  const grad = el('radialGradient', { id: 'face' }, defs);
  el('stop', { offset: '0%', 'stop-color': '#20242e' }, grad);
  el('stop', { offset: '75%', 'stop-color': '#14171e' }, grad);
  el('stop', { offset: '100%', 'stop-color': '#0b0d11' }, grad);
  const glow = el('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
  el('feGaussianBlur', { stdDeviation: '1.8', result: 'b' }, glow);
  const merge = el('feMerge', {}, glow);
  el('feMergeNode', { in: 'b' }, merge);
  el('feMergeNode', { in: 'SourceGraphic' }, merge);

  // backing disc + face
  el('circle', { cx: CX, cy: CY, r: 157, fill: 'rgba(10,11,14,0.88)' });
  el('circle', { cx: CX, cy: CY, r: 146, fill: 'url(#face)', stroke: 'rgba(255,255,255,0.10)', 'stroke-width': 1 });

  // redline band 80-100%
  el('path', {
    d: arcPath(134, REDLINE_FRAC, 1), fill: 'none',
    stroke: 'rgba(255,69,48,0.5)', 'stroke-width': 7,
  });

  // ticks: minor every 5%, major every 20% with labels
  for (let i = 0; i <= 20; i++) {
    const frac = i / 20;
    const deg = START_DEG + SWEEP_DEG * frac;
    const major = i % 4 === 0;
    const inRed = frac >= REDLINE_FRAC;
    const [x0, y0] = polar(major ? 122 : 130, deg);
    const [x1, y1] = polar(138, deg);
    el('line', {
      x1: x0, y1: y0, x2: x1, y2: y1,
      stroke: inRed ? '#ff4530' : major ? '#c8ccd4' : '#565c68',
      'stroke-width': major ? 2.5 : 1,
    });
    if (major) {
      const [tx, ty] = polar(107, deg);
      const t = el('text', {
        x: tx, y: ty + 4, 'text-anchor': 'middle',
        'font-size': 12, 'font-weight': 600,
        fill: inRed ? '#ff6a58' : '#9aa0aa',
        'font-family': 'Segoe UI, system-ui, sans-serif',
      });
      t.textContent = String(frac * 100);
    }
  }

  // title
  el('text', {
    x: CX, y: CY - 44, 'text-anchor': 'middle',
    'font-size': 13, fill: '#7d838d', 'letter-spacing': '2',
    'font-family': 'Segoe UI, system-ui, sans-serif',
  }).textContent = 'CLAUDE CODE %';

  // reset countdowns, laid along the dial ring like bezel text — session
  // curves through the 20-40 gap, weekly arches through the 40-60 gap, both
  // on an arc at r=117 so even the longest pin (session, r=104) sweeps clear
  // beneath them. They tick locally off the system clock; an API refresh is
  // only requested when one reaches zero.
  // path radius sits just inside the tick-number ring (r=107) so the glyphs'
  // visual center lands on the same circle the 20/40/60 numbers align to
  const TIMER_R = 104;
  el('path', { id: 'timer-arc-session', d: arcPath(TIMER_R, 0.2, 0.4), fill: 'none' }, defs);
  el('path', { id: 'timer-arc-weekly', d: arcPath(TIMER_R, 0.6, 0.8), fill: 'none' }, defs);
  const timerFont = {
    'font-size': 12, 'font-weight': 600,
    'font-family': 'Segoe UI, system-ui, sans-serif',
  };
  const tS = el('text', { ...timerFont, fill: '#6fbaff' });   // brightened pin blue
  timerSessionEl = el('textPath', {
    href: '#timer-arc-session', startOffset: '50%', 'text-anchor': 'middle',
  }, tS);
  timerSessionEl.textContent = '—';
  const tW = el('text', { ...timerFont, fill: '#f4f7fb' });   // brightened pin silver
  timerWeeklyEl = el('textPath', {
    href: '#timer-arc-weekly', startOffset: '50%', 'text-anchor': 'middle',
  }, tW);
  timerWeeklyEl.textContent = '—';

  // odometers: session + weekly token totals, digit color = pin color,
  // fixed one-word label sitting to the right of each box; the block sits in
  // the dial's bottom void, inside the 0 and 100 tick labels
  odoSessionEl = buildOdometer(204, PINS.session.color, 'SESSION');
  odoWeeklyEl = buildOdometer(240, PINS.weekly.color, 'WEEKLY');

  // pins (weekly under session under fable), then hub
  pinEls.weekly = buildPin([
    ['path', {
      d: `M ${CX - 4.5} ${CY + 14} L ${CX - 2.5} ${CY - PINS.weekly.len} L ${CX + 2.5} ${CY - PINS.weekly.len} L ${CX + 4.5} ${CY + 14} Z`,
      fill: PINS.weekly.color,
    }],
  ]);
  pinEls.session = buildPin([
    ['path', {
      d: `M ${CX - 3} ${CY + 14} L ${CX - 0.8} ${CY - PINS.session.len} L ${CX + 0.8} ${CY - PINS.session.len} L ${CX + 3} ${CY + 14} Z`,
      fill: PINS.session.color, filter: 'url(#glow)',
    }],
  ]);
  pinEls.scoped = buildPin([
    ['rect', { x: CX - 1.5, y: CY - PINS.scoped.len + 16, width: 3, height: PINS.scoped.len + 26 - 16, fill: PINS.scoped.color }],
    ['path', {
      d: `M ${CX - 5.5} ${CY - PINS.scoped.len + 16} L ${CX + 5.5} ${CY - PINS.scoped.len + 16} L ${CX} ${CY - PINS.scoped.len} Z`,
      fill: PINS.scoped.color, filter: 'url(#glow)',
    }],
  ]);
  pinEls.scoped.setAttribute('display', 'none');

  el('circle', { cx: CX, cy: CY, r: 9, fill: '#22262f', stroke: '#3a3f4b', 'stroke-width': 2 });
  el('circle', { cx: CX, cy: CY, r: 3, fill: '#9aa0aa' });

  // status / error line, tucked in the dial's bottom gap
  errEl = el('text', {
    x: CX, y: 301, 'text-anchor': 'middle',
    'font-size': 9, fill: '#6b7280',
    'font-family': 'Segoe UI, system-ui, sans-serif',
  });
}

function buildPin(parts) {
  const g = el('g', {});
  for (const [name, attrs] of parts) el(name, attrs, g);
  g.setAttribute('transform', `rotate(${START_DEG - 270} ${CX} ${CY})`);
  return g;
}

function buildOdometer(y, color, label) {
  el('rect', {
    x: 96, y, width: 88, height: 22, rx: 5,
    fill: '#0a0c10', stroke: 'rgba(255,255,255,0.09)', 'stroke-width': 1,
  });
  el('rect', { x: 102, y: y + 5, width: 4, height: 12, rx: 2, fill: color });
  const t = el('text', {
    x: 178, y: y + 15, 'text-anchor': 'end',
    'font-size': 11.5, fill: color,
    'font-family': 'Consolas, "Cascadia Mono", monospace',
  });
  t.textContent = '—';
  const lab = el('text', {
    x: 188, y: y + 14.5, 'text-anchor': 'start',
    'font-size': 7.5, fill: color, opacity: 0.75, 'letter-spacing': '0.8',
    'font-family': 'Segoe UI, system-ui, sans-serif', 'font-weight': 600,
  });
  lab.textContent = label;
  return t;
}

// ---------- live updates ----------

function animate() {
  for (const key of Object.keys(pinEls)) {
    shown[key] += (target[key] - shown[key]) * 0.1;
    const deg = START_DEG + SWEEP_DEG * Math.min(1, Math.max(0, shown[key]));
    pinEls[key].setAttribute('transform', `rotate(${deg - 270} ${CX} ${CY})`);
  }
  requestAnimationFrame(animate);
}

const STALE_MS = 15 * 60_000;

window.widget.onUsage((data) => {
  if (!data.ok) {
    // stay quiet while the last good reading is still fresh — transient 429s
    // and blips resolve themselves via backoff retries
    const stale = data.staleForMs == null || data.staleForMs > STALE_MS;
    errEl.textContent = !stale
      ? ''
      : data.error === 'http-401'
        ? 'auth expired — open Claude Code to refresh'
        : data.error === 'http-429'
        ? 'rate limited — waiting to retry'
        : `usage fetch failed (${data.error})`;
    return;
  }
  errEl.textContent = '';

  const byKind = (k) => data.limits.find((l) => l.kind === k);
  const sess = byKind('session');
  const week = byKind('weekly_all');
  const scoped = byKind('weekly_scoped');

  target.session = sess ? (sess.percent || 0) / 100 : 0;
  target.weekly = week ? (week.percent || 0) / 100 : 0;
  resetsAt.session = sess?.resetsAt ? Date.parse(sess.resetsAt) : null;
  resetsAt.weekly = week?.resetsAt ? Date.parse(week.resetsAt) : null;
  renderTimers();
  if (scoped) {
    target.scoped = (scoped.percent || 0) / 100;
    pinEls.scoped.removeAttribute('display');
  } else {
    pinEls.scoped.setAttribute('display', 'none');
  }
});

// ---------- reset countdowns ----------
// resets_at timestamps come from the usage fetch; between fetches the
// countdown runs off the local clock. When one expires we ask the main
// process for a fresh fetch (at most once a minute while expired).

const resetsAt = { session: null, weekly: null };
const refreshRequestedFor = new Set(); // resets_at values already acted on

function fmtCountdown(ms) {
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function renderTimers() {
  const now = Date.now();
  let newlyExpired = false;
  for (const [key, elText] of [['session', timerSessionEl], ['weekly', timerWeeklyEl]]) {
    const at = resetsAt[key];
    if (at == null) { elText.textContent = '—'; continue; }
    const remaining = at - now;
    if (remaining <= 0) {
      elText.textContent = '…';
      // one refresh per distinct expiry — NEVER a retry loop; the regular
      // 3-minute poll (with backoff) owns recovery from here
      if (!refreshRequestedFor.has(at)) {
        refreshRequestedFor.add(at);
        newlyExpired = true;
      }
    } else {
      elText.textContent = fmtCountdown(remaining);
    }
  }
  if (newlyExpired) window.widget.refreshUsage();
  if (refreshRequestedFor.size > 50) refreshRequestedFor.clear(); // bound memory
}
setInterval(renderTimers, 5_000);

function fmtOdo(n) {
  if (n == null) return '—';
  if (n < 1e9) return Math.round(n).toLocaleString('en-US');
  return (n / 1e9).toFixed(2) + 'B';
}

window.widget.onTotals(({ session, weekly }) => {
  odoSessionEl.textContent = fmtOdo(session);
  odoWeeklyEl.textContent = fmtOdo(weekly);
});

document.getElementById('close-btn').addEventListener('click', () => window.widget.close());

window.widget.onHover((inside) => document.body.classList.toggle('hovered', inside));

// ---------- resize: scale the fixed 320x320 layout to the window ----------
// Aspect ratio is locked in the main process; letterbox-scale as a safety net
// in case the OS delivers a non-proportional size mid-drag.

const rootEl = document.getElementById('root');

function applyScale() {
  const s = Math.min(window.innerWidth / 320, window.innerHeight / 320);
  const tx = (window.innerWidth - 320 * s) / 2;
  const ty = (window.innerHeight - 320 * s) / 2;
  rootEl.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}
window.addEventListener('resize', applyScale);

build();
animate();
applyScale();
