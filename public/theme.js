// Light or dark for the Mac pages. The choice is Auto (follow macOS), Light, or Dark, kept per browser and
// shared by every Corral page open in it: a change on one page reaches the others through the storage event.
// Loaded in <head>, so the page is drawn in the right colors from the start (theme.css holds them).
(() => {
  const KEY = 'corral.theme';
  const MODES = ['auto', 'light', 'dark'];
  const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const media = matchMedia('(prefers-color-scheme: light)');
  const listeners = [];
  const read = () => { try { const v = localStorage.getItem(KEY); return MODES.includes(v) ? v : 'auto'; } catch { return 'auto'; } };
  let mode = read();
  const resolved = () => (mode === 'auto' ? (media.matches ? 'light' : 'dark') : mode);

  // The terminals' colors. Light gives the 16 named colors darker shades, so text a program prints in yellow
  // or white stays readable on the light background. Claude Code picks its own colors: /theme there.
  const TERM = {
    dark: { background: '#100e15', cursor: '#c9c1ff', selectionBackground: '#4d4366' },
    light: {
      background: '#fdfcff', foreground: '#24202d', cursor: '#5240c9', cursorAccent: '#fdfcff', selectionBackground: '#d9d2ff',
      black: '#24202d', red: '#c4342b', green: '#23875a', yellow: '#94650a', blue: '#2f63c4', magenta: '#8a3fb8', cyan: '#1f7f8c', white: '#665e7a',
      brightBlack: '#665e7a', brightRed: '#d9473e', brightGreen: '#2f9e6b', brightYellow: '#b7791f', brightBlue: '#3f7be0', brightMagenta: '#a45bd4', brightCyan: '#2898a8', brightWhite: '#1f1b29',
    },
  };

  function apply() {
    document.documentElement.dataset.theme = resolved();
    for (const cb of listeners) cb();
  }
  function set(next) {
    mode = next;
    try { localStorage.setItem(KEY, next); } catch {}
    apply();
  }
  media.addEventListener('change', () => { if (mode === 'auto') apply(); });
  window.addEventListener('storage', (e) => { if (e.key === KEY) { mode = read(); apply(); } });

  globalThis.corralTheme = {
    get mode() { return mode; },
    get resolved() { return resolved(); },
    set,
    onChange(cb) { listeners.push(cb); },
    term: () => TERM[resolved()],
    // A button that shows the choice and moves to the next one: Auto, Light, Dark, then Auto again.
    button(el) {
      const draw = () => {
        el.textContent = `Theme: ${LABEL[mode]}`;
        el.title = mode === 'auto' ? `Follows macOS (now ${LABEL[resolved()].toLowerCase()}). Click for Light.` : `Click for ${LABEL[MODES[(MODES.indexOf(mode) + 1) % 3]]}.`;
      };
      el.onclick = () => set(MODES[(MODES.indexOf(mode) + 1) % 3]);
      listeners.push(draw);
      draw();
    },
  };
  apply();
})();
