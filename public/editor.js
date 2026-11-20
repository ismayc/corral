// Edit mode for a markdown file, shared by the viewer (/view) and the pop-out's tabs (/pop). The page keeps
// reading the file every 2 seconds and hands each new version to diskChanged: with no unsaved edits the text
// follows the file, and with unsaved edits it is never replaced; the editor says the file changed and offers
// the version on disk or Save anyway. A save names the version the edit started from, and the server refuses
// it if the file changed since (POST /api/save), so a save never silently replaces what Claude Code wrote.
(() => {
  const { h } = corralMd;

  // o.file: {text, modified} as read. o.save(body) posts {text, base, force} and answers the server's JSON.
  // o.onSaved(file) gets the version now on disk; o.onDirty() is called when the unsaved state may have changed.
  function editor(o) {
    let saved = o.file.text; // the text on disk, as far as this editor knows
    let base = o.file.modified; // the version the edits started from
    let disk = null; // a newer version on disk, kept for "Use the version on disk"
    const area = h('textarea', { class: 'edit', spellcheck: 'true', 'aria-label': 'The file\'s text' });
    area.value = saved;
    const state = h('span', { class: 'estate', role: 'status' });
    const force = h('button', { type: 'button', class: 'eforce', title: 'Replace the version on disk with this text' }, 'Save anyway');
    const take = h('button', { type: 'button', class: 'etake', title: 'Drop the edits here and show the file as it is on disk' }, 'Use the version on disk');
    const saveBtn = h('button', { type: 'button', class: 'esave', title: 'Save (Cmd-S)' }, 'Save');
    const el = h('div', { class: 'editor' }, h('div', { class: 'ebar' }, saveBtn, force, take, state), area);
    const conflict = (on, text) => { force.hidden = take.hidden = !on; state.textContent = text; };
    conflict(false, '');
    const dirty = () => area.value !== saved;

    async function save(forced) {
      if (!forced && !dirty()) return void (state.textContent = 'No changes to save.');
      const text = area.value;
      state.textContent = 'Saving...';
      let r;
      try { r = await o.save({ text, base, force: forced }); } catch { r = { error: 'Could not reach Corral.' }; }
      if (r.conflict) {
        disk = { text: r.text, modified: r.modified };
        return conflict(true, 'The file changed on disk after you started editing.');
      }
      if (!r.ok) return void (state.textContent = `Could not save: ${r.error}`);
      saved = text;
      base = r.modified;
      conflict(false, 'Saved.');
      o.onSaved({ text, modified: r.modified });
      o.onDirty();
    }

    saveBtn.onclick = () => save(false);
    force.onclick = () => save(true);
    take.onclick = () => {
      area.value = saved = disk.text;
      base = disk.modified;
      conflict(false, 'Showing the version on disk.');
      o.onDirty();
    };
    area.addEventListener('input', () => { if (state.textContent === 'Saved.') state.textContent = ''; o.onDirty(); });
    area.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(false); }
    });

    return {
      el,
      dirty,
      focus: () => area.focus(),
      // A version read from disk. The editor's own save comes back here too, and is ignored.
      diskChanged(file) {
        if (file.modified === base) return;
        disk = file;
        if (!dirty()) {
          area.value = saved = file.text;
          base = file.modified;
          return;
        }
        conflict(true, 'The file changed on disk. Save anyway replaces it, or use the version on disk.');
      },
    };
  }

  globalThis.corralEdit = { editor };
})();
