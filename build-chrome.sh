#!/bin/zsh
#
# Assemble a Chrome-compatible copy of the extension.
#
# Chrome needs a manifest v3 manifest, which cannot live in the same file as
# the manifest v2 one Firefox uses, so the extension is assembled in dist/
# with manifest-chrome.json as its manifest.
#
# By default the assembled extension is made of symlinks back to the source
# files, so that it only has to be loaded into Chrome once: after editing the
# source, 'Reload' in chrome://extensions is enough. Pass --package for a
# self-contained copy and a zip file to distribute.
#
set -e

ROOT="${0:a:h}"
CONTENTS=(images fonts inc js modules popup LICENSE README.md)

if [[ "$1" == "--package" ]]; then
    VERSION=$(grep '"version"' "$ROOT/manifest.json" | cut -d'"' -f 4)
    TARGET="$ROOT/dist/chrome-package"

    rm -rf "$TARGET"
    mkdir -p "$TARGET"
    for item in $CONTENTS; do
        cp -R "$ROOT/$item" "$TARGET/"
    done
    cp "$ROOT/manifest-chrome.json" "$TARGET/manifest.json"

    rm -f "$ROOT/zeeschuimer-chrome-v$VERSION.zip"
    cd "$TARGET"
    zip -qr "$ROOT/zeeschuimer-chrome-v$VERSION.zip" . -x "*.DS_Store"

    echo "Packaged extension: dist/chrome-package"
    echo "Zipped extension:   zeeschuimer-chrome-v$VERSION.zip"
    exit 0
fi

TARGET="$ROOT/dist/chrome"

rm -rf "$TARGET"
mkdir -p "$TARGET"
for item in $CONTENTS; do
    ln -s "$ROOT/$item" "$TARGET/$item"
done
ln -s "$ROOT/manifest-chrome.json" "$TARGET/manifest.json"

echo "Extension assembled in dist/chrome (symlinked to the source files)."
echo ""
echo "Load it once via chrome://extensions > Developer mode > Load unpacked:"
echo "  $TARGET"
echo ""
echo "After that, editing the source and pressing 'Reload' on the extension is"
echo "enough; this script only needs to be run again when a file is added or"
echo "removed. Use --package for a self-contained copy and a zip file."
