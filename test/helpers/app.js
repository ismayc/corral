// Helpers for the Mac page tests (public/app.js). boot() loads the page through the shared harness and adds
// what the harness leaves out for this page: xterm's parser (for the OSC 52 handler), a write callback,
// pointer capture, and control over the page's timers, so a test can run a 3 second poll or a 1.5 second
// reconnect on demand instead of waiting for it.
const { loadPage, unloadPage, flush, fire } = require('./browser');

const nodeClearTimeout = globalThis.clearTimeout;
const nodeClearInterval = globalThis.clearInterval;
// Unloads the page and puts back the clear functions boot() replaced (the harness restores the rest).
function stop() {
  unloadPage();
  globalThis.clearTimeout = nodeClearTimeout;
  globalThis.clearInterval = nodeClearInterval;
}

// A herdr space as GET /api/herdr lists it.
const space = (id, extra = {}) => ({ id, label: id, cwd: `/Users/me/repos/${id}`, root: `/Users/me/repos/${id}`, status: 'idle', ...extra });
// A window as GET /api/sessions and POST /api/sessions return it.
const session = (id, extra = {}) => ({ id, label: id, cwd: `/Users/me/repos/${id}`, space: null, exited: false, remote: false, ...extra });
// A window as GET /api/overview lists it.
const status = (id, extra = {}) => ({ id, label: id, exited: false, muted: false, prompt: null, claude: { status: 'idle' }, ...extra });

// A stand-in for DragEvent.dataTransfer.
function dt(data = {}) {
  return {
    data: { ...data },
    effectAllowed: '',
    get types() { return Object.keys(this.data); },
    setData(k, v) { this.data[k] = v; },
    getData(k) { return this.data[k] ?? ''; },
  };
}

function boot(opts = {}) {
  const jsdomErrors = [];
  // Unless a test says otherwise, /api/overview lists the windows that GET /api/sessions lists, so the
  // status poll does not treat them as closed on another device.
  const routes = { ...opts.routes };
  if (!routes['GET /api/overview']) {
    routes['GET /api/overview'] = () => {
      const r = p.api.routes['GET /api/sessions'];
      return { machine: 'Test Mac', sessions: (r?.sessions || []).map((x) => status(x.id, { label: x.label, exited: x.exited })) };
    };
  }
  const p = loadPage('app', {
    ...opts,
    routes,
    setup(window) {
      const Base = window.Terminal;
      class Terminal extends Base {
        constructor(o) {
          super(o);
          this.osc = {};
          this.parser = { registerOscHandler: (n, cb) => { this.osc[n] = cb; } };
        }
        write(d, cb) { super.write(d); if (cb) this.writeCb = cb; }
      }
      window.Terminal = Terminal;
      window.Element.prototype.setPointerCapture = function setPointerCapture(id) { this.captured = id; };
      window._virtualConsole.removeAllListeners('jsdomError');
      window._virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e.message));
      opts.setup?.(window);
    },
  });
  // The page's own delays are recorded and run by tick(ms); any other timer (flush, jsdom's animation
  // frames) runs on its own.
  const PAGE_DELAYS = [250, 600, 1500, 3000, 6000, 10000];
  const timers = [];
  const realSet = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  const realClear = globalThis.clearTimeout;
  const hold = (repeat) => (fn, ms, ...a) => {
    if (!PAGE_DELAYS.includes(ms)) return (repeat ? realInterval : realSet)(fn, ms, ...a);
    const rec = { fn, ms, repeat, cancelled: false, ran: false };
    timers.push(rec);
    return rec;
  };
  globalThis.setTimeout = hold(false);
  globalThis.setInterval = hold(true);
  const realClearInterval = globalThis.clearInterval;
  const held = (t) => t && typeof t === 'object' && 'repeat' in t;
  globalThis.clearTimeout = (t) => { if (held(t)) t.cancelled = true; else realClear(t); };
  globalThis.clearInterval = (t) => { if (held(t)) t.cancelled = true; else realClearInterval(t); };
  p.held = timers;
  // Runs every live timer of this delay once. Returns how many ran.
  p.tick = (ms) => {
    const due = timers.filter((t) => t.ms === ms && !t.cancelled && (t.repeat || !t.ran));
    for (const t of due) { t.ran = true; t.fn(); }
    return due.length;
  };
  p.jsdomErrors = jsdomErrors;
  p.doc = p.window.document;
  p.$ = (s) => p.doc.querySelector(s);
  p.$$ = (s) => [...p.doc.querySelectorAll(s)];
  p.toast = () => (p.$('#toast').hidden ? null : p.$('#toast span').textContent);
  p.store = (k) => JSON.parse(p.window.localStorage.getItem(k));
  p.wins = () => p.$$('#grid .win .t').map((n) => n.textContent);
  // Labels of the windows in zones, in zone order.
  p.visible = () => p.$$('#grid .slot').filter((s) => !s.hidden).sort((a, b) => a.dataset.zone - b.dataset.zone).map((s) => s.querySelector('.t').textContent);
  p.chips = () => p.$$('#tray .chip').map((c) => c.textContent);
  p.rowNames = () => p.$$('#spaces .space .name').map((n) => n.textContent);
  p.secs = () => p.$$('#spaces .sec').map((n) => (n.querySelector('.cn') ? `${n.querySelector('.cc').textContent} ${n.querySelector('.cn').textContent} ${n.querySelector('.ct').textContent}` : n.textContent));
  p.row = (name) => p.$$('#spaces .space').find((d) => d.querySelector('.name').textContent === name);
  p.slotOf = (label) => p.$$('#grid .slot').find((s) => s.querySelector('.t').textContent === label);
  p.box = (label) => { const s = p.slotOf(label).style; return [s.left, s.top, s.width, s.height].join(' '); };
  p.frame = () => new Promise((r) => p.window.requestAnimationFrame(() => r()));
  return p;
}

// Boots and waits for startup to finish.
async function start(opts) {
  const p = boot(opts);
  await flush(20);
  return p;
}

module.exports = { boot, start, stop, space, session, status, dt, flush, fire };
