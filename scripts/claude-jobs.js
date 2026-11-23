#!/usr/bin/env node
// Scheduled Claude Code runs on this Mac: the LaunchAgents whose program, or a script it names, runs
// `claude -p` (or `claude --print`). Corral runs this file here and, for another Mac, over ssh with the
// file on stdin (`node - list`), so it needs only Node and macOS's own plutil and launchctl.
//   node claude-jobs.js list          every such job, with its schedule, launchd status, and log times
//   node claude-jobs.js log <label>   the last lines of its output and error logs
//   node claude-jobs.js run <label>   start it now (launchctl kickstart), as its schedule would
// Answers JSON on stdout. Only a label found by `list` can be read or run.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const HOME = os.homedir();
const AGENTS = path.join(HOME, 'Library', 'LaunchAgents');
// `claude -p`, `claude --print`, or the same as separate arguments in a list ("claude", "-p").
const RUNS_CLAUDE = /\bclaude["']?\s*,?\s*["']?(?:-p|--print)\b/;
const LOG_LINES = 80;
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const run = (cmd, args) => cp.execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });

// The files a job's arguments name (a script, say), with ~ and $HOME read as the home folder.
function filesNamed(args) {
  const out = [];
  for (const a of args) {
    for (let tok of String(a).split(/[\s;&|]+/)) {
      tok = tok.replace(/^["']|["']$/g, '').replace(/^(~|\$HOME)(?=\/)/, HOME);
      try { if (tok.startsWith('/') && fs.statSync(tok).isFile() && fs.statSync(tok).size < 2e6) out.push(tok); } catch {}
    }
  }
  return out;
}

// What the job runs Claude from: 'plist' when its own arguments do, else the script that does, else null.
function claudeSource(args) {
  if (RUNS_CLAUDE.test(args.join(' '))) return 'plist';
  for (const f of filesNamed(args)) {
    try { if (RUNS_CLAUDE.test(fs.readFileSync(f, 'utf8'))) return f; } catch {}
  }
  return null;
}

const two = (n) => String(n).padStart(2, '0');
// A schedule in words: "Mondays 06:30", "day 1 of the month 04:30", "every 15 min", or "on demand".
function scheduleText(plist) {
  if (plist.StartInterval) return `every ${Math.round(plist.StartInterval / 60)} min`;
  const cal = plist.StartCalendarInterval;
  if (!cal) return plist.RunAtLoad ? 'at login' : 'on demand';
  const one = (c) => {
    if (c.Hour === undefined && c.Weekday === undefined && c.Day === undefined && !c.Month) return `every hour at :${two(c.Minute ?? 0)}`;
    const when = c.Hour === undefined ? `every hour at :${two(c.Minute ?? 0)}` : `${two(c.Hour)}:${two(c.Minute ?? 0)}`;
    const day = c.Weekday !== undefined ? DAYS[c.Weekday] : c.Day !== undefined ? `day ${c.Day}${c.Month ? ` of ${MONTHS[c.Month]}` : ' of the month'}` : c.Month ? `every day of ${MONTHS[c.Month]}` : 'daily';
    return `${day} ${when}`;
  };
  const list = (Array.isArray(cal) ? cal : [cal]).map(one);
  return list.length > 3 ? `${list.slice(0, 2).join(', ')}, and ${list.length - 2} more` : list.join(', ');
}

// launchd's view of a loaded job: whether it is running and the exit code of its last run.
function launchdState(label) {
  try {
    const out = run('launchctl', ['print', `gui/${process.getuid()}/${label}`]);
    const exit = out.match(/last exit code = (-?\d+|\(never exited\))/)?.[1];
    return { loaded: true, running: /\bstate = running\b/.test(out), lastExit: exit && /^-?\d+$/.test(exit) ? Number(exit) : null, runs: Number(out.match(/\bruns = (\d+)/)?.[1] ?? 0) };
  } catch { return { loaded: false, running: false, lastExit: null, runs: 0 }; }
}

const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

function jobs() {
  let names = [];
  try { names = fs.readdirSync(AGENTS).filter((n) => n.endsWith('.plist')); } catch {}
  const out = [];
  for (const name of names.sort()) {
    let plist;
    try { plist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path.join(AGENTS, name)])); } catch { continue; }
    const args = plist.ProgramArguments || (plist.Program ? [plist.Program] : []);
    const source = typeof plist.Label === 'string' ? claudeSource(args) : null;
    if (!source) continue;
    const logs = [plist.StandardOutPath, plist.StandardErrorPath].filter((f) => typeof f === 'string');
    out.push({
      label: plist.Label, schedule: scheduleText(plist), script: source === 'plist' ? null : source.replace(HOME, '~'),
      ...launchdState(plist.Label), logAt: Math.max(0, ...logs.map(mtime).filter(Boolean)) || null, logs,
    });
  }
  return out;
}

// The last LOG_LINES lines of a file, or null.
function tail(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, 256 * 1024));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(-LOG_LINES - 1).join('\n').trimEnd();
  } catch { return null; }
}

function main(argv) {
  const [cmd, label] = argv;
  if (cmd === 'list') return { jobs: jobs().map(({ logs, ...j }) => j) };
  const job = jobs().find((j) => j.label === label);
  if (cmd !== 'log' && cmd !== 'run') return { error: 'usage: list | log <label> | run <label>' };
  if (!job) return { error: 'no scheduled Claude job by that name here' };
  if (cmd === 'log') return { label, logs: job.logs.map((f) => ({ file: f.replace(HOME, '~'), at: mtime(f), text: tail(f) })) };
  if (job.running) return { error: 'it is running now' };
  try { run('launchctl', ['kickstart', `gui/${process.getuid()}/${label}`]); return { ok: true, label }; } catch (e) { return { error: `launchctl could not start it: ${String(e.message).split('\n')[0]}` }; }
}

module.exports = { RUNS_CLAUDE, filesNamed, claudeSource, scheduleText, launchdState, jobs, tail, main };

if (require.main === module || process.argv[1] === '-') process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
