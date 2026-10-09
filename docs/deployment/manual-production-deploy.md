# 手动部署到生产

当用户明确要求“部署到生产”时，按本文执行。当前生产是单台 Ubuntu 24.04 x86_64 服务器，网关由 systemd 管理，Nginx 负责 HTTPS 反向代理。当前 CI/CD 不作为本机手动部署的前置条件。

## 部署边界

- 只上传本次构建出的 Linux amd64 网关二进制压缩包。
- 前端必须先构建；前端资源会嵌入 Go 二进制，不能只替换前端 `dist`。
- 不上传本机 `.data/`，不覆盖生产 `/var/lib/ai-gateway`，不重置项目 Token、厂商 Key 或管理密码。
- 不把私钥、主机指纹、真实项目 Token 或厂商 Key 写入仓库、构建产物和命令输出。
- 生产替换必须通过服务器固定的 `/usr/local/sbin/ai-gateway-deploy`，不要手动覆盖正在运行的二进制。

## 1. 本地预检查

先阅读 `README.md`、`HANDOFF.md` 和本文件，确认当前分支、提交和工作区状态：

```bash
cd /Users/enna/Projects/apps/ai-gateway
git status --short
git branch --show-current
git log -1 --oneline
```

只部署用户当前明确授权的提交。发现无关未提交修改、无法确定部署提交，或项目目录不是正式目录时，先停下处理，不要把这些内容带入生产。

生产地址、SSH 用户、主机指纹和私钥路径从本机私有部署记录与已核对的 SSH 配置取得；不要把真实值补写到公开文档。连接必须使用 `BatchMode=yes`、`StrictHostKeyChecking=yes`，禁止临时 `ssh-keyscan` 接受未知主机。

## 2. 本地测试与构建

在源码目录执行前端测试、前端构建、Go race 测试，并交叉编译 Linux amd64 二进制：

```bash
cd /Users/enna/Projects/apps/ai-gateway
cd web
npm test
npm run build
cd ..
bash scripts/go.sh test -race ./...
rm -f /private/tmp/ai-gateway-linux-amd64 /private/tmp/gateway.gz
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 bash scripts/go.sh build \
  -trimpath -ldflags '-s -w' \
  -o /private/tmp/ai-gateway-linux-amd64 ./cmd/gateway
gzip -n -c /private/tmp/ai-gateway-linux-amd64 > /private/tmp/gateway.gz
shasum -a 256 /private/tmp/ai-gateway-linux-amd64 /private/tmp/gateway.gz
```

任一测试、前端构建或交叉编译失败，都不要上传。记录未压缩 Linux 二进制的 SHA-256，部署后与服务器 `/opt/ai-gateway/bin/gateway` 的 SHA-256 比对。

## 3. 连接生产前只读检查

使用已核对的服务器变量执行，不在命令行中打印私钥内容：

```bash
ssh -i "$SSH_KEY" -p "$DEPLOY_PORT" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  "$DEPLOY_USER@$DEPLOY_HOST" \
  'set -o pipefail
   printf "service="; sudo -n systemctl is-active ai-gateway.service
   printf "enabled="; sudo -n systemctl is-enabled ai-gateway.service
   printf "deploy_script="; sudo -n test -x /usr/local/sbin/ai-gateway-deploy && echo yes || echo no
   printf "binary="; sudo -n test -x /opt/ai-gateway/bin/gateway && echo yes || echo no
   printf "health="; curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8317/healthz
   printf "\n"'
```

如果固定部署脚本、生产二进制、systemd 服务或健康检查不符合预期，先检查服务器，不要直接替换。

## 4. 上传并调用固定部署脚本

release 使用“部署提交的 40 位 SHA-1 加时间戳”，artifact 必须命名为 `gateway.gz`：

```bash
release="$(git rev-parse HEAD)-$(date +%s)"
remote_tmp="$(ssh -i "$SSH_KEY" -p "$DEPLOY_PORT" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  "$DEPLOY_USER@$DEPLOY_HOST" \
  'umask 077 && mktemp -d "$HOME/.ai-gateway-deploy.XXXXXX"')"

scp -q -i "$SSH_KEY" -P "$DEPLOY_PORT" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  /private/tmp/gateway.gz \
  "$DEPLOY_USER@$DEPLOY_HOST:$remote_tmp/gateway.gz"

ssh -i "$SSH_KEY" -p "$DEPLOY_PORT" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  "$DEPLOY_USER@$DEPLOY_HOST" \
  "sudo -n /usr/local/sbin/ai-gateway-deploy '$release' '$remote_tmp/gateway.gz'"
```

服务器固定脚本会依次完成：校验参数、校验 gzip、保存旧二进制、停止服务、备份 `gateway.db`／`gateway.db-wal`／`gateway.db-shm`、安装新二进制、启动服务和本机健康检查。健康检查失败时恢复旧二进制和数据库快照。不要在脚本之外手动删除生产数据库或部署备份。

## 5. 部署后验收

先验证服务器本机服务和二进制，再验证公网入口：

```bash
ssh -i "$SSH_KEY" -p "$DEPLOY_PORT" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  "$DEPLOY_USER@$DEPLOY_HOST" \
  'set -o pipefail
   printf "service="; sudo -n systemctl is-active ai-gateway.service
   printf "enabled="; sudo -n systemctl is-enabled ai-gateway.service
   printf "remote_sha256="; sudo -n sha256sum /opt/ai-gateway/bin/gateway | cut -d" " -f1
   printf "health="; curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8317/healthz
   printf "\n"'

curl --fail --silent --show-error --max-time 15 \
  -o /dev/null -w 'public_root=%{http_code}\n' "https://$DEPLOY_HOST/"
curl --silent --show-error --max-time 15 \
  -o /dev/null -w 'public_models=%{http_code}\n' "https://$DEPLOY_HOST/v1/models"
```

成功标准是：systemd 为 `active` 且 `enabled`，远程二进制 SHA-256 与本地 Linux 二进制一致，`/healthz` 成功，公网首页返回 200。没有项目 Token 时，`/v1/models` 返回 401 是预期的认证结果，不应因此判定部署失败。

如果验收失败，先查看：

```bash
ssh -i "$SSH_KEY" -p "$DEPLOY_PORT" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  "$DEPLOY_USER@$DEPLOY_HOST" \
  'sudo systemctl status ai-gateway.service --no-pager; sudo journalctl -u ai-gateway.service -n 100 --no-pager'
```

固定部署脚本已经执行回滚时，不要再次覆盖数据库；先确认回滚后的服务状态和备份目录，再决定下一步。

## 6. 记录结果

记录实际部署的提交 SHA、release 名称、二进制 SHA-256、服务状态、健康检查、公网状态和任何回滚。部署完成不等于真实厂商调用或客户端体验已验证；后两者需要单独联调。
