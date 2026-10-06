#!/bin/zsh
# Re-renders every icon and the link-preview image from their sources in assets/.
#   assets/icon.svg      -> public/favicon.svg, public/favicon-32.png, public/apple-touch-icon.png
#   assets/og-image.html -> assets/og-image.png (1200x630)
# Needs Google Chrome (headless) and macOS `sips`. og-image.html loads two Google Fonts, so it needs network.
set -eu
cd "${0:A:h}/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"                      # throwaway profile, never a real one
trap 'rm -rf "$TMP"' EXIT

# shot <html> <out.png> <width> <height> <background: transparent|default>
# Headless Chrome can exit non-zero even after writing the screenshot, so success means a non-empty file.
shot() {
  local extra=()
  [[ "$5" == transparent ]] && extra=(--default-background-color=00000000)
  rm -f "$2"
  perl -e 'alarm 90; exec @ARGV' "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --user-data-dir="$TMP/profile" --virtual-time-budget=8000 $extra \
    --window-size="$3,$4" --screenshot="$2" "file://$1" >/dev/null 2>&1 || true
  [[ -s "$2" ]] || { echo "render failed: $2" >&2; exit 1; }
}

# Icon: a 1024px master, then the sizes browsers and iOS ask for.
cp assets/icon.svg public/favicon.svg
cat > "$TMP/icon.html" <<EOF
<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:1024px;height:1024px}</style>
<img src="file://$PWD/assets/icon.svg">
EOF
sed 's/rx="112"/rx="0"/' assets/icon.svg > "$TMP/icon-square.svg"   # iOS fills transparent corners black
cat > "$TMP/icon-square.html" <<EOF
<!doctype html><style>html,body{margin:0;background:#14161a}img{display:block;width:1024px;height:1024px}</style>
<img src="file://$TMP/icon-square.svg">
EOF
shot "$TMP/icon.html" "$TMP/icon-1024.png" 1024 1024 transparent
shot "$TMP/icon-square.html" "$TMP/icon-square-1024.png" 1024 1024 default
sips -z 32 32   "$TMP/icon-1024.png"        --out public/favicon-32.png >/dev/null
sips -z 180 180 "$TMP/icon-square-1024.png" --out public/apple-touch-icon.png >/dev/null

# Link preview.
shot "$PWD/assets/og-image.html" "$PWD/assets/og-image.png" 1200 630 default
echo "rendered: public/favicon.svg favicon-32.png apple-touch-icon.png, assets/og-image.png"
