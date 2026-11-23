// Scheduled Claude Code runs (launchd jobs that run `claude -p`) on this Mac and on the Macs named in
// ~/.config/corral/job-hosts, one ssh host per line. scripts/claude-jobs.js finds them and reads their
// status and logs; for another Mac it goes over ssh with the script on stdin, so nothing is installed there.
// The list is kept 30 seconds, since asking another Mac takes a second or two.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'claude-jobs.js');
const HOST = /^[A-Za-z0-9][\w.@-]{0,99}$/;
const LABEL = /^[\w.-]{1,200}$/;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Runs a command, writes `input` to its stdin, and answers its stdout parsed as JSON. Rejects on a non-zero
// exit, a timeout, or output that is not JSON.
function runJson(cmd, args, input, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('it took too long')); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `exit code ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('it did not answer in JSON')); }
    });
    child.stdin.end(input || '');
  });
}

// `script` and `ssh` are there for the tests, which use stand-ins for both.
function createJobs({ hostsFile, thisMac, script = SCRIPT, ssh = 'ssh' }) {
  let cache = null;
  const hosts = () => {
    try { return fs.readFileSync(hostsFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => HOST.test(l)); } catch { return []; }
  };
  // One call to the script: here with Node itself, elsewhere over ssh with the script on stdin.
  const call = (host, args) => (host
    ? runJson(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', host, `PATH=/opt/homebrew/bin:/usr/local/bin:$PATH node - ${args.map(shq).join(' ')}`], fs.readFileSync(script, 'utf8'))
    : runJson(process.execPath, [script, ...args], ''));
  const known = (host) => host === '' || hosts().includes(host);
  return {
    hosts,
    async list(fresh) {
      if (!fresh && cache && Date.now() - cache.at < 30000) return cache.value;
      const machines = [{ name: thisMac(), host: '' }, ...hosts().map((h) => ({ name: h, host: h }))];
      const value = {
        machines: await Promise.all(machines.map(async (m) => {
          try { return { ...m, jobs: (await call(m.host, ['list'])).jobs }; } catch (e) { return { ...m, jobs: [], error: `Could not ask ${m.name}: ${e.message}` }; }
        })),
      };
      cache = { at: Date.now(), value };
      return value;
    },
    async log(host, label) {
      if (!known(host) || !LABEL.test(label || '')) return { status: 404, error: 'no such job' };
      try {
        const r = await call(host, ['log', label]);
        return r.error ? { status: 404, error: r.error } : { status: 200, ...r };
      } catch (e) { return { status: 502, error: e.message }; }
    },
    async run(host, label) {
      if (!known(host) || !LABEL.test(label || '')) return { status: 404, error: 'no such job' };
      try {
        const r = await call(host, ['run', label]);
        cache = null; // its status changes
        return r.error ? { status: 409, error: r.error } : { status: 200, ...r };
      } catch (e) { return { status: 502, error: e.message }; }
    },
  };
}

module.exports = { SCRIPT, runJson, createJobs };
