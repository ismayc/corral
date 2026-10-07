// Usage: osascript -l JavaScript apps-for-file.js <file>
// Prints JSON naming the apps macOS offers for the file (as Finder's "Open With" does) and its default app.
ObjC.import('AppKit');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const ws = $.NSWorkspace.sharedWorkspace;
  const fm = $.NSFileManager.defaultManager;
  const def = ws.URLForApplicationToOpenURL(url);
  const list = ws.URLsForApplicationsToOpenURL(url);
  const apps = [];
  for (let i = 0; i < list.count; i++) {
    const p = ObjC.unwrap(list.objectAtIndex(i).path);
    apps.push({ path: p, name: ObjC.unwrap(fm.displayNameAtPath(p)).replace(/\.app$/, '') });
  }
  return JSON.stringify({ def: def.isNil() ? null : ObjC.unwrap(def.path), apps });
}
