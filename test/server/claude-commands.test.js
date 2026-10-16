// The slash commands a window offers, for the phone's autocomplete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('../helpers/claude');
const { listen } = require('../helpers/server');

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const skill = (root, dir, fm) => put(path.join(root, 'skills', dir, 'SKILL.md'), `---\n${fm}\n---\n\n# Body\n`);
const names = (list, source) => list.filter((c) => c.source === source).map((c) => c.name);

test('frontMatter reads flat, quoted, and folded values, and tells a missing file from one with none', (t) => {
  const c = setup();
  const file = path.join(c.home, 'f.md');
  put(file, '---\nname: "quoted"\ndescription: >\n  first line\n  second line\nother: \'single\'\nempty:\nnot a key\n---\nbody');
  assert.deepEqual(c.srv.frontMatter(file), { name: 'quoted', description: 'first line second line', other: 'single', empty: '' });
  put(file, 'no front matter');
  assert.deepEqual(c.srv.frontMatter(file), {});
  assert.equal(c.srv.frontMatter(path.join(c.home, 'missing.md')), null);
});

test('slashCommands lists project, user, and plugin skills and commands, then the built-in ones', () => {
  const c = setup();
  const claude = path.join(c.home, '.claude');
  const repo = path.join(c.home, 'repos', 'proj');
  const sub = path.join(repo, 'src');
  fs.mkdirSync(sub, { recursive: true });

  skill(path.join(repo, '.claude'), 'deploy', 'name: deploy\ndescription: Ship it');
  skill(path.join(repo, '.claude'), 'verify', 'description: The project gate wins over the user one');
  put(path.join(c.home, 'repos', '.claude', 'commands', 'above.md'), 'Found in a folder above the project');
  skill(claude, 'verify', 'description: User gate');
  skill(claude, 'hidden', 'description: x\nuser-invocable: false');
  skill(claude, 'muted', 'description: turned off');
  skill(claude, 'Odd Folder', 'name: renamed\ndescription: The name comes from the front matter');
  fs.mkdirSync(path.join(claude, 'skills', 'empty-folder'));
  put(path.join(claude, 'commands', 'pause.md'), '---\ndescription: Save a resume point\n---\nbody');
  put(path.join(claude, 'commands', 'notes.txt'), 'not a command');
  fs.mkdirSync(path.join(claude, 'commands', 'folder.md'));
  put(path.join(claude, 'settings.json'), JSON.stringify({
    skillOverrides: { muted: 'off', 'other@x:thing': 'off' },
    enabledPlugins: { 'tools@market': true, 'here@market': true, 'elsewhere@market': true, 'disabled@market': false, 'missing@market': true, 'gone@market': true },
  }));
  const plugin = (n) => path.join(c.home, 'plugins', n);
  skill(plugin('tools'), 'review', 'description: Plugin review');
  put(path.join(plugin('tools'), 'commands', 'go.md'), '---\ndescription: Plugin command\n---\n');
  skill(plugin('here'), 'local', 'description: Project-scoped plugin');
  skill(plugin('elsewhere'), 'far', 'description: Installed for another project');
  skill(plugin('disabled'), 'off', 'description: Disabled plugin');
  put(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'tools@market': [{ scope: 'user', installPath: plugin('tools') }],
      'here@market': [{ scope: 'project', projectPath: path.join(c.home, 'elsewhere'), installPath: plugin('here') }, { scope: 'project', projectPath: repo, installPath: plugin('here') }],
      'elsewhere@market': [{ scope: 'project', projectPath: path.join(c.home, 'elsewhere'), installPath: plugin('elsewhere') }],
      'disabled@market': [{ scope: 'user', installPath: plugin('disabled') }],
      'missing@market': [{ scope: 'user' }],
    },
  }));

  const list = c.srv.slashCommands(sub);
  assert.deepEqual(names(list, 'project'), ['deploy', 'verify', 'above']);
  assert.equal(list.find((x) => x.name === 'verify').description, 'The project gate wins over the user one');
  assert.deepEqual(names(list, 'user'), ['renamed', 'pause']);
  assert.deepEqual(names(list, 'plugin'), ['tools:review', 'tools:go', 'here:local']);
  assert.equal(list.find((x) => x.name === 'above').description, '');
  assert.equal(names(list, 'built-in')[0], 'clear');
  assert.equal(list.find((x) => x.name === 'clear').source, 'built-in');

  // Outside the home folder there is no project to look in; long descriptions are cut.
  skill(claude, 'long', `description: ${'x'.repeat(400)}`);
  const outside = c.srv.slashCommands('/');
  assert.deepEqual(names(outside, 'project'), []);
  assert.equal(outside.find((x) => x.name === 'long').description.length, 300);
});

test('slashCommands works with no settings and no plugins, and with no folder at all', () => {
  const c = setup();
  const list = c.srv.slashCommands(null);
  assert.deepEqual([...new Set(list.map((x) => x.source))], ['built-in']);
});

test('GET /api/sessions/:id/commands reads the folder Claude runs in, or the window\'s own', async () => {
  const c = setup();
  const h = await listen(c.srv);
  try {
    const proj = path.join(c.home, 'proj');
    skill(path.join(proj, '.claude'), 'only-here', 'description: Project skill');
    const s = c.open('a');
    let r = await h.request('GET', `/api/sessions/${s.id}/commands`);
    assert.equal(r.status, 200);
    assert.equal(r.json.commands.some((x) => x.name === 'only-here'), false);
    c.claude(s, { cwd: proj });
    r = await h.request('GET', `/api/sessions/${s.id}/commands`);
    assert.equal(r.json.commands[0].name, 'only-here');
  } finally { await h.close(); }
});
