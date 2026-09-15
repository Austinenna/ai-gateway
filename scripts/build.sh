#!/usr/bin/env bash
set -euo pipefail
gateway_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$gateway_root/web"
npm ci --no-audit --no-fund
npm run build
cd "$gateway_root"
bash scripts/go.sh build -o bin/gateway ./cmd/gateway
echo '构建完成：bin/gateway'
