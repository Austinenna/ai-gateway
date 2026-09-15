#!/usr/bin/env bash
set -euo pipefail
gateway_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$gateway_root"
export GOMODCACHE="$gateway_root/.cache/gomod"
export GOCACHE="$gateway_root/.cache/gobuild"
if [[ -x "$gateway_root/.tools/go/bin/go" ]]; then
  exec "$gateway_root/.tools/go/bin/go" "$@"
fi
if command -v go >/dev/null 2>&1; then
  exec go "$@"
fi
echo '需要 Go 1.26 或更新版本；请安装后重新运行。' >&2
exit 1
