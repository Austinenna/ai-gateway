#!/usr/bin/env bash
set -euo pipefail
gateway_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$gateway_root/web"
if [[ ! -d node_modules ]]; then npm ci --no-audit --no-fund; fi
npm test
npm run build
cd "$gateway_root"
bash scripts/go.sh test -race ./...
