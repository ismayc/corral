const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'scripts', 'apps-for-file.js');

// A stand-in for the ObjC bridge: strings and nil values are plain JS, NSWorkspace answers from `world`.
function install(world) {
  const calls = [];
  const wrap = (p) => ({ path: p });
  globalThis.ObjC = {
    import: (n) => calls.push(['import', n]),
    unwrap: (v) => v,
  };
  globalThis.$ = {
    NSURL: { fileURLWithPath: (f) => ({ file: f }) },
    NSFileManager: { defaultManager: { displayNameAtPath: (p) => world.names[p] } },
    NSWorkspace: {
      sharedWorkspace: {
        URLForApplicationToOpenURL: (u) => {
          calls.push(['default', u.file]);
          const d = world.def;
          return { isNil: () => d === null, path: d };
        },
        URLsForApplicationsToOpenURL: (u) => {
          calls.push(['list', u.file]);
          return { count: world.apps.length, objectAtIndex: (i) => wrap(world.apps[i]) };
        },
      },
    },
  };
  return calls;
}

function load() {
  delete require.cache[require.resolve(FILE)];
  return require(FILE);
}

test.afterEach(() => {
  delete globalThis.ObjC;
  delete globalThis.$;
  delete require.cache[require.resolve(FILE)];
});

test('imports AppKit and prints the default app and every offered app with .app stripped', () => {
  const world = {
    def: '/Applications/TextEdit.app',
    apps: ['/Applications/TextEdit.app', '/Applications/Visual Studio Code.app'],
    names: { '/Applications/TextEdit.app': 'TextEdit.app', '/Applications/Visual Studio Code.app': 'Visual Studio Code' },
  };
  const calls = install(world);
  const { run } = load();
  assert.equal(calls[0][0], 'import');
  assert.deepEqual(calls[0], ['import', 'AppKit']);
  const out = run(['/tmp/notes.md']);
  assert.deepEqual(JSON.parse(out), {
    def: '/Applications/TextEdit.app',
    apps: [
      { path: '/Applications/TextEdit.app', name: 'TextEdit' },
      { path: '/Applications/Visual Studio Code.app', name: 'Visual Studio Code' },
    ],
  });
  assert.deepEqual(calls.slice(1), [['default', '/tmp/notes.md'], ['list', '/tmp/notes.md']]);
});

test('a file with no default app and no candidates gives def null and an empty list', () => {
  install({ def: null, apps: [], names: {} });
  const { run } = load();
  assert.equal(run(['/tmp/x.unknown']), '{"def":null,"apps":[]}');
});
