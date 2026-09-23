#!/bin/bash
# Build KongAISwitch.app — a real macOS bundle you can double-click.
#
# A bare SwiftPM executable cannot be a menu bar app: macOS needs an .app
# bundle with an Info.plist declaring LSUIElement so the app runs without a
# Dock icon or menu bar title of its own.
set -euo pipefail

CONFIG="${1:-release}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/build/KongAISwitch.app"

# SwiftPM may emit either the classic `.build/<config>/` layout or the newer
# `.build/out/Products/<Config>/` layout (capitalized Debug/Release).
find_bin() {
  local cfg="$1"
  local capped
  capped="$(printf '%s' "$cfg" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  local candidates=(
    "$ROOT/.build/out/Products/$capped/KongAISwitch"
    "$ROOT/.build/$cfg/KongAISwitch"
  )
  local c
  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

find_resource_bundle() {
  local bin_dir
  bin_dir="$(dirname "$1")"
  local candidates=(
    "$bin_dir/KongAISwitch_KongAISwitch.bundle"
    "$ROOT/.build/out/Products/$(basename "$(dirname "$bin_dir")")/KongAISwitch_KongAISwitch.bundle"
  )
  local c
  for c in "${candidates[@]}"; do
    if [ -d "$c" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

echo "Building ($CONFIG) ..."
cd "$ROOT"
# SwiftPM can emit a benign build.db I/O warning; the binary is what matters.
swift build -c "$CONFIG" 2>&1 | grep -viE "ld: warning: search path|build\.db|disk I/O" || true

BIN="$(find_bin "$CONFIG" || true)"
if [ -z "${BIN:-}" ]; then
  echo "Build failed: KongAISwitch binary not found under .build/" >&2
  exit 1
fi
echo "  binary: $BIN"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/KongAISwitch"

# Logo / attribution assets live in the SwiftPM resource bundle. Generated
# Bundle.module looks in Bundle.main.resourceURL first — i.e. Contents/Resources/
# inside an .app — not next to the Mach-O in Contents/MacOS.
if BUNDLE="$(find_resource_bundle "$BIN")"; then
  echo "  resources: $BUNDLE"
  rm -rf "$APP/Contents/Resources/KongAISwitch_KongAISwitch.bundle"
  cp -R "$BUNDLE" "$APP/Contents/Resources/KongAISwitch_KongAISwitch.bundle"
else
  echo "warning: KongAISwitch_KongAISwitch.bundle not found; logos will fall back to SF Symbols" >&2
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>KongAISwitch</string>
    <key>CFBundleIdentifier</key>
    <string>com.konghq.kong-ai-switch</string>
    <key>CFBundleName</key>
    <string>Kong AI Switch</string>
    <key>CFBundleDisplayName</key>
    <string>Kong AI Switch</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.2.0</string>
    <key>CFBundleVersion</key>
    <string>2</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <!-- Menu bar only: no Dock icon, no app menu. -->
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Bundle the CLI inside the .app so zip downloads work without a manual
# checkout. Users still need Node.js on the machine; the script is pure JS
# with no npm dependencies.
#
# Also mirror into Application Support for older builds / TCC-safe overrides
# (a Documents checkout is not readable from an unsigned .app).
CLI_SRC="$(cd "$ROOT/.." && pwd)"
CLI_IN_APP="$APP/Contents/Resources/cli"
CLI_APP_SUPPORT="$HOME/Library/Application Support/KongAISwitch/cli"

install_cli() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$CLI_SRC/src" "$dest/src"
  [ -f "$CLI_SRC/package.json" ] && cp "$CLI_SRC/package.json" "$dest/package.json"
}

if [ -f "$CLI_SRC/src/cli/index.js" ]; then
  echo "Bundling CLI into app Resources ..."
  install_cli "$CLI_IN_APP"
  echo "  $CLI_IN_APP"

  echo "Installing CLI to Application Support ..."
  install_cli "$CLI_APP_SUPPORT"
  echo "  $CLI_APP_SUPPORT"
else
  echo "warning: CLI source not found at $CLI_SRC/src/cli/index.js" >&2
fi

# Ad-hoc signature so macOS will run it locally without a developer account.
codesign --force --deep --sign - "$APP" 2>/dev/null || \
  echo "note: could not codesign; the app still runs locally"

echo "Built $APP"
echo "Open it with:  open '$APP'"
