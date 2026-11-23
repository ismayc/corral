// lib/jobs.js and its routes, with a stand-in for scripts/claude-jobs.js and a stand-in ssh that runs its
// command here (with the script on stdin, as the real one does on the other Mac).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mock } = require('node:test');
const jobsLib = require('../../lib/jobs');
const { setup } = require('../helpers/claude');
const { listen } = require('../helpers/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corral-jobsrv-'));
// The stand-in script answers by its arguments, and says which Mac it ran on (FAKE_MAC, set by the fake ssh).
const FAKE_SCRIPT = `
const [cmd, label] = process.argv.slice(process.argv[1] === '-' ? 2 : 2);
const mac = process.env.FAKE_MAC || 'here';
let out;
if (cmd === 'list') out = { jobs: [{ label: 'com.x.' + mac, schedule: 'daily 06:00', loaded: true, running: false, lastExit: 0 }] };
else if (cmd === 'log') out = label === 'com.x.missing' ? { error: 'no scheduled Claude job by that name here' } : { label, logs: [{ file: '~/x.log', at: 1, text: 'ok on ' + mac }] };
else if (cmd === 'run') out = label === 'com.x.busy' ? { error: 'it is running now' } : { ok: true, label };
if (label === 'com.x.crash') process.exit(3);
if (label === 'com.x.text') { process.stdout.write('not json'); process.exit(0); }
process.stdout.write(JSON.stringify(out));
`;
// ssh -o ... -o ... <host> <command>: runs the command in sh, stdin passed through; host "down" fails.
const FAKE_SSH = `#!/bin/sh
shift 4
host="$1"; shift
if [ "$host" = down ]; then echo "ssh: connect to host down: Connection refused" >&2; exit 255; fi
FAKE_MAC="$host" exec sh -c "$*"
`;
function fixture(hostLines = 'mini\n') {
  const dir = tmp();
  const script = path.join(dir, 'claude-jobs.js');
  const ssh = path.join(dir, 'ssh');
  const hostsFile = path.join(dir, 'job-hosts');
  fs.writeFileSync(script, FAKE_SCRIPT);
  fs.writeFileSync(ssh, FAKE_SSH, { mode: 0o755 });
  if (hostLines !== null) fs.writeFileSync(hostsFile, hostLines);
  return { dir, script, ssh, hostsFile, jobs: jobsLib.createJobs({ hostsFile, thisMac: () => 'Studio', script, ssh }) };
}

test('runJson answers parsed JSON, and rejects a failure, a timeout, a missing command, or text', async () => {
  assert.deepEqual(await jobsLib.runJson(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], '{"a":1}'), { a: 1 });
  await assert.rejects(jobsLib.runJson(process.execPath, ['-e', 'console.error("first\\nlast"); process.exit(2)']), /^Error: last$/);
  await assert.rejects(jobsLib.runJson(process.execPath, ['-e', 'process.exit(2)']), /exit code 2/);
  await assert.rejects(jobsLib.runJson(process.execPath, ['-e', 'console.log("hi")']), /did not answer in JSON/);
  await assert.rejects(jobsLib.runJson(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], '', 100), /took too long/);
  await assert.rejects(jobsLib.runJson('/no/such/command', []), /ENOENT/);
});

test('list asks this Mac and each host, keeps the answer 30 seconds, and says which Mac could not be asked', async () => {
  const f = fixture('mini\n  \nbad host!\ndown\n');
  assert.deepEqual(f.jobs.hosts(), ['mini', 'down']);
  const r = await f.jobs.list();
  assert.deepEqual(r.machines.map((m) => [m.name, m.host, m.jobs.map((j) => j.label), m.error || null]), [
    ['Studio', '', ['com.x.here'], null],
    ['mini', 'mini', ['com.x.mini'], null],
    ['down', 'down', [], 'Could not ask down: ssh: connect to host down: Connection refused'],
  ]);
  fs.writeFileSync(f.hostsFile, '');
  assert.equal((await f.jobs.list()).machines.length, 3, 'cached');
  assert.equal((await f.jobs.list(true)).machines.length, 1, 'fresh');
  assert.deepEqual(fixture(null).jobs.hosts(), []);
});

test('log and run go to the right Mac, refuse an unknown host or label, and pass on the script\'s refusal', async () => {
  const f = fixture();
  assert.deepEqual(await f.jobs.log('mini', 'com.x.a'), { status: 200, label: 'com.x.a', logs: [{ file: '~/x.log', at: 1, text: 'ok on mini' }] });
  assert.equal((await f.jobs.log('', 'com.x.a')).logs[0].text, 'ok on here');
  assert.deepEqual(await f.jobs.log('elsewhere', 'com.x.a'), { status: 404, error: 'no such job' });
  assert.deepEqual(await f.jobs.log('', 'bad label!'), { status: 404, error: 'no such job' });
  assert.deepEqual(await f.jobs.log('', null), { status: 404, error: 'no such job' });
  assert.deepEqual(await f.jobs.log('', 'com.x.missing'), { status: 404, error: 'no scheduled Claude job by that name here' });
  assert.equal((await f.jobs.log('', 'com.x.crash')).status, 502);
  assert.deepEqual(await f.jobs.run('mini', 'com.x.a'), { status: 200, ok: true, label: 'com.x.a' });
  assert.deepEqual(await f.jobs.run('', 'com.x.busy'), { status: 409, error: 'it is running now' });
  assert.deepEqual(await f.jobs.run('nope', 'com.x.a'), { status: 404, error: 'no such job' });
  assert.deepEqual(await f.jobs.run('', 'com.x.text'), { status: 502, error: 'it did not answer in JSON' });
});

test('the jobs routes list, read a log, and run, with this Mac as the empty host', async () => {
  const c = setup();
  const f = fixture();
  const h = await listen(c.srv);
  try {
    // The server's own jobs object asks the real script; swap in the stand-ins for this test.
    const fake = f.jobs;
    for (const k of ['list', 'log', 'run']) mock.method(c.srv.state.jobs, k, (...a) => fake[k](...a));
    const list = await h.request('GET', '/api/jobs?fresh=1');
    assert.deepEqual(list.json.machines.map((m) => m.name), ['Studio', 'mini']);
    assert.deepEqual(c.srv.state.jobs.list.mock.calls[0].arguments, [true]);
    await h.request('GET', '/api/jobs');
    assert.deepEqual(c.srv.state.jobs.list.mock.calls[1].arguments, [false]);
    const log = await h.request('GET', '/api/jobs/log?host=mini&label=com.x.a');
    assert.equal(log.json.logs[0].text, 'ok on mini');
    assert.equal((await h.request('GET', '/api/jobs/log?label=com.x.a')).json.logs[0].text, 'ok on here');
    assert.equal((await h.request('POST', '/api/jobs/run', { body: { host: 'mini', label: 'com.x.a' } })).json.ok, true);
    assert.equal((await h.request('POST', '/api/jobs/run', { body: { label: 'com.x.busy' } })).status, 409);
    assert.equal((await h.request('POST', '/api/jobs/run', { raw: 'x' })).status, 404);
  } finally { await h.close(); mock.restoreAll(); }
});
