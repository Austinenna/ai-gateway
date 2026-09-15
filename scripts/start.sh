#!/usr/bin/env bash
set -euo pipefail
gateway_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$gateway_root"
if [[ ! -x bin/gateway ]]; then
  bash scripts/build.sh
fi
# 当前本机 Demo 临时启用空白解锁；传 --local-no-password=false 恢复密码登录。
exec ./bin/gateway --data-dir "$gateway_root/.data" --local-no-password "$@"
