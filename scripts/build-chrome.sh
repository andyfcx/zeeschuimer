#!/usr/bin/env bash
# Build the Chrome extension into build/chrome/
# Usage: bash scripts/build-chrome.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$ROOT/build/chrome"

echo "Building Chrome extension…"
rm -rf "$OUT"
mkdir -p "$OUT/js" "$OUT/modules"

# Manifest
cp "$ROOT/manifests/chrome.json" "$OUT/manifest.json"

# Third-party deps and static assets
cp -r "$ROOT/inc"    "$OUT/"
cp -r "$ROOT/fonts"  "$OUT/"
cp -r "$ROOT/images" "$OUT/"
cp -r "$ROOT/popup"  "$OUT/"

# Shared core scripts  →  js/
cp "$ROOT/src/core/lib.js"        "$OUT/js/"
cp "$ROOT/src/core/database.js"   "$OUT/js/"
cp "$ROOT/src/core/registry.js"   "$OUT/js/"
cp "$ROOT/src/core/pipeline.js"   "$OUT/js/"
cp "$ROOT/src/core/navigation.js" "$OUT/js/"

# Chrome-specific scripts  →  js/
cp "$ROOT/src/adapters/chrome/background.js"     "$OUT/js/background.js"
cp "$ROOT/src/adapters/chrome/content-script.js" "$OUT/js/content-script.js"
cp "$ROOT/src/adapters/chrome/page-hook.js"      "$OUT/js/page-hook.js"

# Platform modules (instagram.js here has the document-guard fix)
cp "$ROOT/src/modules/"*.js "$OUT/modules/"

echo "Done.  Load $OUT as an unpacked extension in Chrome:"
echo "  chrome://extensions → Enable Developer mode → Load unpacked → select $OUT"
