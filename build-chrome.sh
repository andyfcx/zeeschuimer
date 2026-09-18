#!/bin/zsh
#
# Build a Chrome-compatible copy of the extension.
#
# Chrome needs a manifest v3 manifest, which cannot live in the same file as
# the manifest v2 one Firefox uses, so this assembles a copy of the extension
# with manifest-chrome.json as its manifest. The result can be loaded via
# chrome://extensions > Developer mode > Load unpacked, and is also zipped for
# distribution.
#
set -e

VERSION=$(grep '"version"' manifest.json | cut -d'"' -f 4)
TARGET="dist/chrome"

rm -rf "$TARGET"
mkdir -p "$TARGET"

for directory in images fonts inc js modules popup; do
    cp -R "$directory" "$TARGET/"
done
cp LICENSE README.md "$TARGET/"
cp manifest-chrome.json "$TARGET/manifest.json"

rm -f "zeeschuimer-chrome-v$VERSION.zip"
cd "$TARGET"
zip -qr "../../zeeschuimer-chrome-v$VERSION.zip" . -x "*.DS_Store"
cd ../..

echo "Unpacked extension: $TARGET"
echo "Zipped extension:   zeeschuimer-chrome-v$VERSION.zip"
