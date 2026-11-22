#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f apps/server/dist/main.js ]; then
  echo "apps/server/dist/main.js not found; run 'pnpm build' first" >&2
  exit 1
fi

exec "${NODE_BIN:-node}" apps/server/dist/main.js
