// Small helpers shared by the test/server/platform-*.test.js files.
const fs = require('fs');
const path = require('path');
const { tick } = require('./server');

const UUID1 = '11111111-2222-3333-4444-555555555555';
const UUID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Silences console.log and console.error for one test and records what was printed.
function quiet(t) {
  const out = { logs: [], errors: [] };
  t.mock.method(console, 'log', (...a) => { out.logs.push(a.join(' ')); });
  t.mock.method(console, 'error', (...a) => { out.errors.push(a.join(' ')); });
  return out;
}

// Waits (up to about two seconds) for fn() to return something truthy.
async function until(fn, what = 'condition') {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (v) return v;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The JSON `herdr api snapshot` prints.
function snapshotJson({ workspaces = [], panes = [] } = {}) {
  return JSON.stringify({ result: { snapshot: { workspaces, panes } } });
}

// A fake herdr whose answer tests change through `state.snap`. Calls to other subcommands go to `state.other`.
function fakeHerdr(state) {
  return (args) => {
    state.calls.push(args);
    if (args[0] === 'api') {
      if (state.fail) throw new Error('herdr is not running');
      return typeof state.snap === 'string' ? state.snap : snapshotJson(state.snap);
    }
    return state.other ? state.other(args) : '';
  };
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

module.exports = { UUID1, UUID2, quiet, until, snapshotJson, fakeHerdr, writeFile };
