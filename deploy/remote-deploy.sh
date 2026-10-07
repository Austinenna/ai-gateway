#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "用法：$0 RELEASE ARTIFACT" >&2
  exit 2
fi

release="$1"
artifact="$2"
service=ai-gateway.service
install_root=/opt/ai-gateway
data_dir=/var/lib/ai-gateway
health_url=http://127.0.0.1:8317/healthz

if [[ ! "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] \
  || "$artifact" != */gateway.gz; then
  echo '部署参数不符合固定生产路径' >&2
  exit 2
fi

bin_dir="$install_root/bin"
release_dir="$install_root/releases/$release"
binary="$bin_dir/gateway"
new_binary="$binary.new"
previous_binary="$release_dir/previous-gateway"
backup_dir="$data_dir/backups/deploy-$release"
binary_upload="${artifact%.gz}"

cleanup() {
  rm -f -- "$artifact" "$binary_upload"
  if [[ "$0" != /usr/local/sbin/ai-gateway-deploy ]]; then
    rm -f -- "$0"
  fi
  rmdir -- "$(dirname "$artifact")" 2>/dev/null || true
}
trap cleanup EXIT

sudo -n true
service_user="$(sudo systemctl show -p User --value "$service")"
if [[ -z "$service_user" ]]; then
  service_user=root
fi
sudo install -d -m 0755 "$bin_dir" "$release_dir"
sudo install -d -m 0700 "$data_dir/backups" "$backup_dir"
gzip -t "$artifact"
gzip -dc "$artifact" > "$binary_upload"
sudo install -m 0755 "$binary_upload" "$release_dir/gateway"

if sudo test -e "$binary"; then
  sudo cp -p "$binary" "$previous_binary"
fi

sudo systemctl stop "$service"

# The database uses SQLite WAL mode. Stop the service before copying all of the
# possible database files so a failed migration can be restored as one snapshot.
for name in gateway.db gateway.db-wal gateway.db-shm; do
  if sudo test -e "$data_dir/$name"; then
    sudo cp -p "$data_dir/$name" "$backup_dir/$name"
    sudo chown root:root "$backup_dir/$name"
    sudo chmod 0600 "$backup_dir/$name"
  fi
done

sudo install -m 0755 "$release_dir/gateway" "$new_binary"
sudo mv -f "$new_binary" "$binary"

wait_ready() {
  local attempt
  for attempt in {1..30}; do
    if sudo systemctl is-active --quiet "$service" \
      && curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if sudo systemctl start "$service" && wait_ready; then
  sudo find "$install_root/releases" -mindepth 1 -maxdepth 1 -type d \
    -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2- | xargs -r sudo rm -rf
  echo "部署成功：$release"
  exit 0
fi

echo "新版本未通过服务或健康检查，开始自动回滚" >&2
sudo systemctl stop "$service" || true
if [[ -e "$previous_binary" ]]; then
  sudo install -m 0755 "$previous_binary" "$new_binary"
  sudo mv -f "$new_binary" "$binary"
fi

# Restore the pre-deploy SQLite snapshot when one was captured. This matters
# when the new binary completed a schema migration before failing its check.
for name in gateway.db gateway.db-wal gateway.db-shm; do
  sudo rm -f "$data_dir/$name"
  if sudo test -e "$backup_dir/$name"; then
    sudo cp -p "$backup_dir/$name" "$data_dir/$name"
    sudo chown "$service_user:$service_user" "$data_dir/$name"
    sudo chmod 0600 "$data_dir/$name"
  fi
done

if sudo systemctl start "$service" && wait_ready; then
  echo "已回滚到上一版本；本次发布失败：$release" >&2
else
  echo "自动回滚后服务仍未通过健康检查，请立即 SSH 检查 $service" >&2
fi
exit 1
