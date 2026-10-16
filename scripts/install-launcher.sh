#!/bin/zsh
# Builds ~/Applications/Corral.app, a Dock launcher that runs scripts/corral-launcher.sh (start the server
# if needed, then open the page), and puts it in the Dock in place of the Chrome web app's icon.
#   scripts/install-launcher.sh            build the app and update the Dock
#   scripts/install-launcher.sh --no-dock  build the app only
# Re-run after moving the repo. The app only calls the script, so edits to the script need no reinstall.
set -eu
REPO="${0:A:h:h}"
APP="$HOME/Applications/Corral.app"
CHROME_APP="$HOME/Applications/Chrome Apps.localized/Corral.app"
DOCK="${1:-}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/MacOS/Corral" <<STUB
#!/bin/zsh
exec "$REPO/scripts/corral-launcher.sh" "\$@"
STUB
chmod +x "$APP/Contents/MacOS/Corral"
# LSArchitecturePriority: a script executable has no architecture of its own, so without this key macOS
# launches it under Rosetta on Apple silicon. The Intel preference then carries through the native node
# server to the tmux server and every shell in its panes (`uname -m` says x86_64 there). Verified with a
# test app on 2026-10-16: sysctl.proc_translated was 1 without the key and 0 with it.
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Corral</string>
  <key>CFBundleDisplayName</key><string>Corral</string>
  <key>CFBundleIdentifier</key><string>com.chesterismay.corral.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Corral</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
</dict>
</plist>
PLIST
# Same icon as the Chrome web app, so the Dock tile looks unchanged.
if [[ -f "$CHROME_APP/Contents/Resources/app.icns" ]]; then
  cp "$CHROME_APP/Contents/Resources/app.icns" "$APP/Contents/Resources/app.icns"
else
  echo "no icon: $CHROME_APP is not installed, the app gets the generic icon" >&2
fi
codesign --force --sign - "$APP" 2>/dev/null || true
echo "built $APP"

[[ "$DOCK" == "--no-dock" ]] && exit 0

# Replace the Chrome app's Dock tile (or an older copy of this one) at the same position; append if neither is there.
BACKUP="$HOME/.local/share/corral/dock-backup-$(date +%Y%m%d-%H%M%S).plist"
mkdir -p "${BACKUP:h}"
defaults export com.apple.dock "$BACKUP"
NEW="$(mktemp)"
python3 - "$BACKUP" "$NEW" "$APP" <<'PY'
import plistlib, sys, urllib.parse
src, dst, app = sys.argv[1:4]
d = plistlib.load(open(src, 'rb'))
url = 'file://' + urllib.parse.quote(app) + '/'
tile = {'tile-data': {'file-data': {'_CFURLString': url, '_CFURLStringType': 15},
                      'file-label': 'Corral', 'file-type': 41}, 'tile-type': 'file-tile'}
apps = d.setdefault('persistent-apps', [])
hits = [i for i, a in enumerate(apps)
        if a.get('tile-data', {}).get('file-data', {}).get('_CFURLString', '').endswith('/Corral.app/')]
if hits:
    apps[hits[0]] = tile
    for i in reversed(hits[1:]): del apps[i]
    print(f'Dock: replaced the Corral tile at position {hits[0] + 1}')
else:
    apps.append(tile)
    print('Dock: appended a Corral tile')
plistlib.dump(d, open(dst, 'wb'))
PY
defaults import com.apple.dock "$NEW"
rm -f "$NEW"
killall Dock
echo "Dock restarted (backup of the old Dock list: $BACKUP)"
