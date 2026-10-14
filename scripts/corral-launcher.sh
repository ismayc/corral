#!/bin/zsh
# The Dock launcher's logic: start the herdr server and the Corral server when they are not running, wait
# for Corral, then open the Corral page. scripts/install-launcher.sh wraps this in ~/Applications/Corral.app.
# Run it by hand to test: CORRAL_REPO, CORRAL_PORT, and HERDR_BIN override the defaults.
set -u
# Run by hand from inside a Claude Code or herdr terminal, these would make the servers' children think they
# belong to that session (the same list as LEAKY_ENV in server.js). A Dock launch has none of them.
# This runs before the variables below so the HERDR_* pattern cannot take one of the launcher's own.
herdr_bin="${HERDR_BIN:-}"   # the one HERDR_* value to keep: the documented override
unset CLAUDECODE CLAUDE_PID CLAUDE_EFFORT TMUX TMUX_PANE
unset -m 'CLAUDE_CODE_*' 'HERDR_*'

REPO="${CORRAL_REPO:-${0:A:h:h}}"
PORT="${CORRAL_PORT:-8777}"
LOG="$HOME/.local/share/corral/server.log"
LOG_HERDR="$HOME/.local/share/corral/herdr-server.log"
HERDR="${herdr_bin:-$HOME/.local/bin/herdr}"
[[ -x "$HERDR" ]] || HERDR="$(command -v herdr 2>/dev/null || true)"
PAGE_APP="$HOME/Applications/Chrome Apps.localized/Corral.app"   # the Chrome web app, if installed
URL="http://127.0.0.1:$PORT/"

listening() { lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

fail() {
  echo "corral-launcher: $1" >&2
  osascript -e "display dialog \"$1\" with title \"Corral\" buttons {\"OK\"} default button 1 with icon stop" >/dev/null 2>&1
  exit 1
}

# A Dock app starts with a bare PATH, so look where node usually lives (nvm's newest version last).
find_node() {
  local n
  n="$(command -v node)" && { echo "$n"; return; }
  for n in /opt/homebrew/bin/node /usr/local/bin/node; do [[ -x "$n" ]] && { echo "$n"; return; }; done
  n="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [[ -n "$n" ]] && { echo "$n"; return; }
  return 1
}

# Starts the server detached and waits up to 10 seconds for the listener.
start_server() {
  local node i
  node="$(find_node)" || fail "node was not found. Install it (or nvm) and click again."
  [[ -f "$REPO/server.js" ]] || fail "server.js is missing from $REPO."
  mkdir -p "${LOG:h}"
  echo "corral-launcher: starting $node server.js in $REPO ($(date '+%Y-%m-%d %H:%M:%S'))" >> "$LOG"
  (cd "$REPO" && nohup "$node" server.js >> "$LOG" 2>&1 &)
  for i in {1..40}; do listening && return 0; sleep 0.25; done
  return 1
}

# herdr's spaces fill Corral's sidebar. Its background server dies with a reboot too, and `herdr server`
# runs it headless (the documented form for service-style setups); the herdr TUI attaches to it later.
herdr_running() { [[ -n "$HERDR" ]] && "$HERDR" status server 2>/dev/null | grep -q '^status: running'; }
start_herdr() {
  mkdir -p "${LOG_HERDR:h}"
  echo "corral-launcher: starting $HERDR server ($(date '+%Y-%m-%d %H:%M:%S'))" >> "$LOG_HERDR"
  (cd "$HOME" && nohup "$HERDR" server >> "$LOG_HERDR" 2>&1 &)
}
[[ -n "$HERDR" ]] && ! herdr_running && start_herdr

if ! listening; then
  # The first start after a kill has failed with EADDRINUSE while the old process released the port; one retry.
  start_server || { sleep 2; start_server; } || fail "The Corral server did not start. See $LOG."
fi

# herdr down is not fatal: Corral opens either way, and its sidebar says "herdr not reachable" until it is up.
if [[ -n "$HERDR" ]]; then
  for i in {1..20}; do herdr_running && break; sleep 0.25; done
  herdr_running || echo "corral-launcher: herdr server not running after 5s, see $LOG_HERDR" >> "$LOG"
fi

if [[ -d "$PAGE_APP" ]]; then open "$PAGE_APP"; else open "$URL"; fi
