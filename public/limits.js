// The plan's usage limits as a strip outside every window, on the Mac page's sidebar and the phone's home
// header: "5h 3% · 4h 19m", "Week 32% · 4d 21h", "Fable 0% · 4d 21h". The server reads them from the Claude Code
// status line's cache (lib/limits.js) and sends them with /api/overview. Colors follow the status line: yellow
// from 50%, red from 80%. A Fable figure the server sent with no reset time reads "?%", as the status line
// shows it. The strip hides when there are no numbers (no cache, or one over 2 hours old).
window.CorralLimits = (() => {
  const WARN = 50;
  const ALERT = 80;
  const OLD = 10 * 60 * 1000; // older than this, the strip says how old

  // "4h 19m", "19m", "4d 21h", or "now", for the time left until a reset.
  function left(ms) {
    if (ms <= 0) return 'now';
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    if (d) return `${d}d ${h}h`;
    return h ? `${h}h ${m % 60}m` : `${m % 60}m`;
  }
  const level = (pct) => (pct >= ALERT ? 'alert' : pct >= WARN ? 'warn' : 'ok');
  const ago = (ms) => {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
  };

  // One part per limit: { key, text, level, title }.
  function parts(l, now = Date.now()) {
    return (l?.items || []).map((it) => {
      const pct = it.unreliable ? '?%' : `${it.pct}%`;
      const reset = it.resetsAt != null ? left(it.resetsAt - now) : null;
      const names = { five: '5-hour limit', week: 'Weekly limit, all models', fable: 'Weekly Fable limit' };
      const title = [`${names[it.key] || it.label}: ${it.pct}% used`,
        reset ? `Resets in ${reset} (${new Date(it.resetsAt).toLocaleString()})` : 'No reset time given',
        it.unreliable ? 'Anthropic sent this with no reset time, which has under-reported before.' : null]
        .filter(Boolean).join('\n');
      return { key: it.key, text: `${it.label} ${pct}${reset ? ` · ${reset}` : ''}`, level: it.unreliable ? 'warn' : level(it.pct), title };
    });
  }

  // Fills el with the strip, or hides it when there are no numbers.
  function paint(el, l, now = Date.now()) {
    const ps = parts(l, now);
    el.hidden = !ps.length;
    el.replaceChildren(...ps.map((p) => {
      const s = document.createElement('span');
      s.className = `lim ${p.level}`;
      s.dataset.key = p.key;
      s.textContent = p.text;
      s.title = p.title;
      return s;
    }));
    if (ps.length && now - l.at > OLD) {
      const s = document.createElement('span');
      s.className = 'lim age';
      s.textContent = `as of ${ago(now - l.at)}`;
      s.title = 'The numbers refresh when an open Claude Code session draws its status line.';
      el.append(s);
    }
    el.title = ps.length ? `Plan usage, read ${ago(now - l.at)} from the Claude Code status line's cache` : '';
  }

  return { left, parts, paint };
})();
