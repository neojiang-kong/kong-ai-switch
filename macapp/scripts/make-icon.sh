#!/bin/bash
# Regenerate macapp/Resources/AppIcon.icns from the official Kong logomark.
#
# Usage: macapp/scripts/make-icon.sh [preview.png]
#   preview.png  optional path to also write the 512 px icon for review
set -euo pipefail

MACAPP="$(cd "$(dirname "$0")/.." && pwd)"
LOGO="$MACAPP/Sources/KongAISwitch/Resources/kong-logomark@2x.png"
OUT="$MACAPP/Resources/AppIcon.icns"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ICONSET="$WORK/AppIcon.iconset"
swift "$MACAPP/scripts/make-icon.swift" "$LOGO" "$ICONSET"

mkdir -p "$(dirname "$OUT")"
iconutil -c icns "$ICONSET" -o "$OUT"
echo "wrote $OUT"

if [ -n "${1:-}" ]; then
  cp "$ICONSET/icon_512x512.png" "$1"
  echo "preview $1"
fi
