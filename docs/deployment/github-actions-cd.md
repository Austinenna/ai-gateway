# GitHub 推送后自动部署

仓库的 GitHub Actions 在 `main` 分支 push 后先运行测试和 Linux 构建，构建通过后再通过 SSH 部署到生产服务器。服务器需要先安装一次固定的 root-owned `/usr/local/sbin/ai-gateway-deploy`，之后 workflow 只上传二进制并调用这个固定脚本。

部署过程由固定脚本完成：

1. 上传 amd64 二进制到版本目录；
2. 停止 `ai-gateway.service`，备份 SQLite 的 `gateway.db`、`gateway.db-wal` 和 `gateway.db-shm`；
3. 原子替换 `/opt/ai-gateway/bin/gateway` 并启动服务；
4. 从服务器本机访问 `http://127.0.0.1:8317/healthz`，连续等待最多 60 秒；
5. 检查失败时恢复上一个二进制和数据库快照，并重新启动服务。

厂商 Key、项目 Token、管理密码和 SQLite 数据始终留在服务器上，不会进入构建产物或 GitHub Actions 日志。

## 第一次配置 GitHub

在仓库打开 **Settings → Environments → New environment**，创建环境 `production`。可以先不设置 Required reviewers，这样 push 后会全自动执行；如果之后希望生产部署需要人工批准，在该环境中增加 Required reviewers 即可。

在 `production` 环境的 **Environment secrets** 中新增以下 5 项：

| Secret | 内容 |
| --- | --- |
| `DEPLOY_HOST` | 服务器公网 IPv4 或 DNS 名称 |
| `DEPLOY_USER` | SSH 用户，本服务器为 `ubuntu` |
| `DEPLOY_PORT` | SSH 端口，本服务器为 `22` |
| `DEPLOY_SSH_KEY` | SSH 私钥完整内容，仅保存于 GitHub Secret |
| `DEPLOY_KNOWN_HOSTS` | 服务器主机公钥行，必须是预先核对过的指纹 |

`DEPLOY_KNOWN_HOSTS` 不要在 GitHub Runner 中用 `ssh-keyscan` 临时生成。应在本机先核对服务器指纹，再保存类似下面的完整一行：

```text
<SERVER_IPV4> ssh-ed25519 AAAA...
```

私钥和主机公钥是两件不同的东西。私钥放入 `DEPLOY_SSH_KEY`，主机公钥行放入 `DEPLOY_KNOWN_HOSTS`；不要把私钥、真实指纹或真实 IP 写进仓库文件。

## 第一次服务器配置

在本机核对过 SSH 主机指纹后，手动安装固定部署脚本。下面的 `<SERVER_IPV4>` 只替换为服务器地址，不要把它写回仓库：

```bash
SERVER_IPV4='<SERVER_IPV4>'
SSH_KEY='<SSH_KEY_PATH>'
scp -i "$SSH_KEY" -P 22 deploy/remote-deploy.sh "ubuntu@$SERVER_IPV4:/tmp/ai-gateway-deploy"
ssh -i "$SSH_KEY" -p 22 "ubuntu@$SERVER_IPV4" \
  'sudo install -o root -g root -m 0755 /tmp/ai-gateway-deploy /usr/local/sbin/ai-gateway-deploy && sudo rm -f /tmp/ai-gateway-deploy'
ssh -i "$SSH_KEY" -p 22 "ubuntu@$SERVER_IPV4" \
  'printf "%s\\n" "ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/ai-gateway-deploy *" | sudo tee /etc/sudoers.d/ai-gateway-deploy >/dev/null && sudo chmod 0440 /etc/sudoers.d/ai-gateway-deploy && sudo visudo -cf /etc/sudoers.d/ai-gateway-deploy'
```

然后确认固定脚本和服务条件：

```bash
ssh -i "$SSH_KEY" -p 22 "ubuntu@$SERVER_IPV4" \
  'sudo -n /usr/local/sbin/ai-gateway-deploy 2>&1 || test $? -eq 2; sudo systemctl is-enabled ai-gateway.service; sudo test -x /opt/ai-gateway/bin/gateway'
```

上面的第一次调用只检查参数用法，不会部署；`sudoers` 规则只允许调用固定脚本。若服务器已有更宽的 `ubuntu` sudo 权限，GitHub workflow 本身仍应视为高信任入口；后续可以再收紧 SSH 用户的其他 sudo 权限。

## 如何验证

第一次配置完成后，只需把已经审核过的代码推送到 `main`：

```bash
git push origin main
```

打开 GitHub 的 **Actions → CI → test-build**，确认测试、构建和部署三个阶段都成功。部署成功后，服务器上的二进制会位于 `/opt/ai-gateway/bin/gateway`，旧版本和部署快照会保留在 `/opt/ai-gateway/releases/` 与 `/var/lib/ai-gateway/backups/`。

如果部署阶段失败，Actions 日志只应显示版本号和健康检查结果，不会显示任何厂商 Key 或项目 Token。服务器上可以检查：

```bash
sudo systemctl status ai-gateway.service --no-pager
sudo journalctl -u ai-gateway.service -n 100 --no-pager
```

## 需要知道的边界

- 只有 push 到 `main` 才会部署；Pull Request 只运行 CI。
- 服务器必须已安装固定的 `/usr/local/sbin/ai-gateway-deploy`，并允许该 SSH 用户用 `sudo -n` 调用它。
- 部署期间网关会短暂停止，当前流程没有做双机或无停机切换。
- 自动回滚用于“新二进制无法启动或本机健康检查失败”。真实厂商调用仍需单独验证。
- 如果数据库结构未来发生不可逆迁移，应先把迁移设计成可回滚，再依赖自动回滚；当前脚本会在部署前保留数据库快照。
