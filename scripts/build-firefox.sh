#!/usr/bin/env bash
# Build the Firefox extension into build/firefox/
# Usage: bash scripts/build-firefox.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$ROOT/build/firefox"

echo "Building Firefox extension…"
rm -rf "$OUT"
mkdir -p "$OUT/js" "$OUT/modules"

# Manifest
cp "$ROOT/manifests/firefox.json" "$OUT/manifest.json"

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

# Firefox-specific background  →  js/background.js
cp "$ROOT/src/adapters/firefox/background.js" "$OUT/js/background.js"

# Platform modules
cp "$ROOT/src/modules/"*.js "$OUT/modules/"

echo "Done.  Load $OUT as a temporary extension in Firefox:"
echo "  about:debugging → This Firefox → Load Temporary Add-on…"
echo "  (select any file inside $OUT)"
