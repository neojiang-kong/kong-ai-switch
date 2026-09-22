#!/bin/bash
# Build KongAISwitch.app — a real macOS bundle you can double-click.
#
# A bare SwiftPM executable cannot be a menu bar app: macOS needs an .app
# bundle with an Info.plist declaring LSUIElement so the app runs without a
# Dock icon or menu bar title of its own.
set -euo pipefail

CONFIG="${1:-debug}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/build/KongAISwitch.app"

echo "Building ($CONFIG) ..."
cd "$ROOT"
# SwiftPM can emit a benign build.db I/O warning; the binary is what matters.
swift build -c "$CONFIG" 2>&1 | grep -viE "ld: warning: search path|build\.db|disk I/O" || true

BIN="$ROOT/.build/$CONFIG/KongAISwitch"
if [ ! -x "$BIN" ]; then
  echo "Build failed: $BIN not found" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/KongAISwitch"

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
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <!-- Menu bar only: no Dock icon, no app menu. -->
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
PLIST
echo '</plist>' >> "$APP/Contents/Info.plist"

# Ad-hoc signature so macOS will run it locally without a developer account.
codesign --force --deep --sign - "$APP" 2>/dev/null || \
  echo "note: could not codesign; the app still runs locally"

echo "Built $APP"
echo "Open it with:  open '$APP'"
