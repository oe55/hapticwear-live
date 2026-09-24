#!/bin/sh
# Rebuilds vendor/three/three.bundle.js from the pinned three.js release.
# Only needed if js/three/vest.js starts using a new Three.js class. Requires Node.
set -e
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
(cd "$TMP" && npm init -y >/dev/null && npm install --silent three@0.186.0 esbuild@0.25.10)
cp tools/vendor-entry.js "$TMP/entry.js"
"$TMP/node_modules/.bin/esbuild" "$TMP/entry.js" --bundle --format=esm --minify \
  --legal-comments=eof --target=es2020 --outfile=vendor/three/three.bundle.js
cp "$TMP/node_modules/three/LICENSE" vendor/three/LICENSE
rm -rf "$TMP"
echo "vendor/three/three.bundle.js rebuilt"
