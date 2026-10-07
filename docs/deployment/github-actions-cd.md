# GitHub 推送后自动部署

仓库的 GitHub Actions 在 `main` 分支 push 后先运行测试和 Linux 构建，构建通过后再通过 SSH 部署到生产服务器。部署过程由服务器上的 `deploy/remote-deploy.sh` 完成：

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

当前仓库版本为了减少第一次接入步骤，会把经过版本控制的部署脚本临时上传到服务器，并要求 `DEPLOY_USER` 能以 `sudo -n` 管理 `ai-gateway.service`、`/opt/ai-gateway` 和 `/var/lib/ai-gateway`。脚本把服务名、目录和健康地址锁定为本服务器的固定值，但这仍然是较宽的部署权限，不能视为最小权限模型。流程跑通后，建议在服务器预装 root:root 的固定部署脚本，再用 sudoers 只允许该脚本，GitHub workflow 只上传二进制并调用固定路径。

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
- 服务器必须允许该 SSH 用户使用 `sudo -n` 管理 systemd、`/opt/ai-gateway` 和 `/var/lib/ai-gateway`。
- 部署期间网关会短暂停止，当前流程没有做双机或无停机切换。
- 自动回滚用于“新二进制无法启动或本机健康检查失败”。真实厂商调用仍需单独验证。
- 如果数据库结构未来发生不可逆迁移，应先把迁移设计成可回滚，再依赖自动回滚；当前脚本会在部署前保留数据库快照。
