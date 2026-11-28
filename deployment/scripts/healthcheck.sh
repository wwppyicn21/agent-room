#!/usr/bin/env bash
# Local readiness probe for systemd/monitoring. Never requires Cloudflare.
set -euo pipefail
BASE=${BASE_URL:-http://127.0.0.1:8787}
curl -fsS --max-time 5 "$BASE/healthz" >/dev/null
curl -fsS --max-time 5 "$BASE/readyz" | grep -q '"status":"ready"'
echo "healthcheck: ok ($BASE)"
