// Scheduled Claude jobs (launchd jobs that run `claude -p`) on each Mac, drawn into a box on the Mac page or
// the phone: each job's schedule, how its last run ended, when its log last changed, its log, and Run now
// (which asks first). The server finds them with scripts/claude-jobs.js (lib/jobs.js).
window.CorralJobs = (() => {
  const short = (label) => label.replace(/^com\.chester(ismay)?\./, '');
  function ago(ms) {
    if (!ms) return 'no log yet';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'log changed just now';
    if (m < 60) return `log changed ${m} min ago`;
    if (m < 48 * 60) return `log changed ${Math.round(m / 60)} h ago`;
    return `log changed ${Math.round(m / 1440)} days ago`;
  }
  async function get(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text ?? '' });
  const button = (text, onclick, cls) => Object.assign(el('button', cls, text), { onclick });
  // How the last run ended, as a class and words.
  function state(j) {
    if (j.running) return ['run', 'Running now'];
    if (j.lastExit === 0) return ['ok', 'Last run worked'];
    if (j.lastExit !== null && j.lastExit !== undefined) return ['bad', `Last run failed (exit ${j.lastExit})`];
    if (!j.loaded) return ['off', 'Not loaded in launchd'];
    return ['none', 'No run since the Mac started'];
  }

  async function show(box, opts = {}) {
    box.replaceChildren(el('p', 'jnote', 'Asking each Mac…'));
    let r;
    try { r = await get(`/api/jobs${opts.fresh ? '?fresh=1' : ''}`); } catch (e) { return box.replaceChildren(el('p', 'jnote', `Could not list the jobs: ${e.message}`)); }
    const kids = [button('Refresh', () => show(box, { ...opts, fresh: true }), 'jrefresh')];
    for (const m of r.machines) {
      kids.push(el('div', 'jmac', m.name));
      if (m.error) kids.push(el('p', 'jnote', m.error));
      else if (!m.jobs.length) kids.push(el('p', 'jnote', 'No scheduled Claude jobs here.'));
      for (const j of m.jobs) kids.push(row(box, m, j, opts));
    }
    box.replaceChildren(...kids);
  }

  function row(box, m, j, opts) {
    const [cls, says] = state(j);
    const r = el('div', 'jrow');
    const name = el('div', 'jname', short(j.label));
    name.title = `${j.label}${j.script ? `\n${j.script}` : ''}`;
    const st = el('span', `jstate ${cls}`, says);
    const info = el('div', 'jinfo', `${j.schedule} · ${ago(j.logAt)}`);
    const btns = el('div', 'jbtns');
    const ask = () => {
      btns.replaceChildren(el('span', 'jask', `Run ${short(j.label)} now?`),
        button('Run', async () => {
          btns.replaceChildren(el('span', 'jask', 'Starting…'));
          try {
            await get('/api/jobs/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: m.host, label: j.label }) });
            opts.toast?.(`Started ${short(j.label)} on ${m.name}.`);
          } catch (e) { opts.toast?.(`Could not start it: ${e.message}`); }
          show(box, { ...opts, fresh: true });
        }, 'primary'),
        button('Cancel', () => btns.replaceChildren(...plain())));
    };
    const plain = () => [button('Log', () => showLog(box, m, j, opts)), ...(j.running ? [] : [button('Run now', ask)])];
    btns.append(...plain());
    r.append(name, st, info, btns);
    return r;
  }

  async function showLog(box, m, j, opts) {
    const back = button('Back to the jobs', () => show(box, opts), 'jrefresh');
    box.replaceChildren(back, el('p', 'jnote', 'Reading the log…'));
    let r;
    try { r = await get(`/api/jobs/log?host=${encodeURIComponent(m.host)}&label=${encodeURIComponent(j.label)}`); } catch (e) { return box.replaceChildren(back, el('p', 'jnote', `Could not read the log: ${e.message}`)); }
    const kids = [back, el('div', 'jmac', `${short(j.label)} on ${m.name}`)];
    if (!r.logs.length) kids.push(el('p', 'jnote', 'This job writes no log file.'));
    for (const l of r.logs) kids.push(el('div', 'jfile', l.file), el('pre', 'jlog', l.text ?? '(no file yet)'));
    box.replaceChildren(...kids);
  }

  return { show, state, short, ago };
})();
