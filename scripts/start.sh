#!/usr/bin/env bash
set -euo pipefail
gateway_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$gateway_root"
if [[ ! -x bin/gateway ]]; then
  bash scripts/build.sh
fi
# 本机模式启动自动解锁，管理页可留空登录；传 --local-no-password=false 恢复密码登录。
exec ./bin/gateway --data-dir "$gateway_root/.data" --local-no-password "$@"
