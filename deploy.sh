#!/usr/bin/env bash
# Deploy Sparkx to https://sparkx.akwiat.com (radify managed app on step1).
# The Node server is compiled into a single Linux binary with Bun; the frontend ships as static files.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist/bin
bun build server.mjs --compile --target=bun-linux-x64 --outfile dist/bin/app
cp -R public dist/static
~/radify/bin/radify deploy sparkx dist
