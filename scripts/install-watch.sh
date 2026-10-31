#!/bin/zsh
# Sets up scripts/corral-watch.js on the Mac that watches (a Mac mini that stays on, say): a LaunchAgent that
# starts it at login and restarts it if it stops, and `tailscale serve` so your devices can open its page.
#   scripts/install-watch.sh <Tailscale name of the Mac that runs Corral> [user@host for SSH]
# WATCH_PORT and WATCH_TAILSCALE_PORT change the ports (8778 and 8444); other WATCH_* settings set in the
# environment when this runs are kept in the LaunchAgent. Re-run after moving the repo. To remove it:
#   launchctl bootout gui/$(id -u)/com.github.ismayc.corral-watch; rm ~/Library/LaunchAgents/com.github.ismayc.corral-watch.plist
#   tailscale serve --https=8444 off
set -eu
REPO="${0:A:h:h}"
TARGET="${1:?usage: scripts/install-watch.sh <Tailscale name of the Mac that runs Corral> [user@host for SSH]}"
[[ -n "${2:-}" ]] && export WATCH_SSH="$2"
export WATCH_TARGET="$TARGET"
LABEL=com.github.ismayc.corral-watch
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.local/share/corral/watch.log"
PORT="${WATCH_PORT:-8778}"
TS_PORT="${WATCH_TAILSCALE_PORT:-8444}"

# As in corral-launcher.sh: a LaunchAgent starts with a bare PATH, so find node now and write its full path.
NODE="$(command -v node || true)"
for n in /opt/homebrew/bin/node /usr/local/bin/node; do [[ -z "$NODE" && -x "$n" ]] && NODE="$n"; done
[[ -z "$NODE" ]] && NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
[[ -x "$NODE" ]] || { echo "install-watch: node was not found" >&2; exit 1; }
TS=""
for p in /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  [[ -x "$p" ]] && { TS="$p"; break; }
done
[[ -n "$TS" ]] || { echo "install-watch: tailscale was not found" >&2; exit 1; }

xml() { print -r -- "${1//&/&amp;}" | sed 's/</\&lt;/g; s/>/\&gt;/g'; }
envs=""
for k in ${(ko)parameters[(I)WATCH_*]}; do envs+="    <key>$k</key><string>$(xml "${(P)k}")</string>"$'\n'; done

mkdir -p "${PLIST:h}" "${LOG:h}"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "$NODE")</string><string>$(xml "$REPO/scripts/corral-watch.js")</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>WATCH_TAILSCALE_BIN</key><string>$(xml "$TS")</string>
$envs  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
"$TS" serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT"
NAME="$("$TS" status --json | "$NODE" -e 'let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>console.log(JSON.parse(t).Self.DNSName.replace(/\.$/,"")))')"
URL="https://$NAME:$TS_PORT/"
echo "Corral watch is running for $TARGET: $URL"
echo "On $TARGET, so the phone offers it when that Mac does not answer:"
echo "  mkdir -p ~/.config/corral && echo $URL > ~/.config/corral/watch-url"
