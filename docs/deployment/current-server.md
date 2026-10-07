# 当前 Linux 服务器部署记录

最后核对：2026-10-07（Asia/Taipei）。这份记录描述服务器结构和连接方式，不保存私钥、厂商 Key、项目 Token 或网关数据库。

## 连接

- 公网 IPv4：`<SERVER_IPV4>`
- SSH 用户：`<SSH_USER>`
- SSH 端口：`22`
- 服务器主机公钥指纹：`<SSH_HOST_KEY_SHA256>`（ED25519）
- 本机连接命令：

  ```bash
  SSH_KEY="/path/to/enna.pem"
  ssh -i "$SSH_KEY" <SSH_USER>@<SERVER_IPV4>
  ```

  私钥只保留在本机，不放入仓库或 GitHub Secrets 以外的地方；连接前应核对上面的主机指纹。

## 主机与服务

- 操作系统：Ubuntu 24.04，x86_64
- systemd：255
- 观测到的根盘：50 GiB，总剩余约 42 GiB（部署时）
- 观测到的可用内存：约 1.5 GiB（部署时）
- 网关二进制：`/opt/ai-gateway/bin/gateway`
- 网关运行用户：`ubuntu`
- 数据目录：`/var/lib/ai-gateway`
- systemd 单元：`/etc/systemd/system/ai-gateway.service`
- 服务名称：`ai-gateway.service`
- 服务状态：已启用，部署后验证为 `active`
- 网关监听：`127.0.0.1:8317`
- 对外地址：`https://<SERVER_IPV4>`

网关不直接监听公网端口。Nginx 负责 TLS 和反向代理，把请求转发到本机的 8317。

## Nginx 与 HTTPS

- Nginx 配置：`/etc/nginx/sites-available/ai-gateway`
- 启用链接：`/etc/nginx/sites-enabled/ai-gateway`
- HTTP：80 仅用于 ACME 验证，其余请求跳转 HTTPS
- HTTPS：443 终止 TLS 后转发到 `127.0.0.1:8317`
- 证书目录：`/etc/letsencrypt/live/<SERVER_IPV4>/`
- Certbot：Snap `5.8.0`
- 证书类型：包含公网 IP 的 Let’s Encrypt 短周期证书
- 当前证书到期日：以服务器实际证书为准
- 续期：Certbot timer 自动续期；续期 deploy hook 会 reload Nginx

公网 API 入口为：

```text
https://<SERVER_IPV4>/v1
```

管理页面和管理 API 由 Nginx 白名单限制，目前允许的来源为：

- `<ADMIN_SOURCE_IP_1>`
- `<ADMIN_SOURCE_IP_2>`

新增 Agent 时，优先只增加它的固定公网 IP；需要面向任意来源时，才考虑扩大 443 的安全组范围，并保持管理路径白名单不变。

## 当前网络边界

- `8317`：不开放公网，只允许服务器本机访问
- `443`：云安全组当前已开放；Nginx 仍对管理路径执行 IP 白名单
- `80`：云安全组当前已开放，用于证书验证和跳转
- `22`：云安全组当前允许 SSH；后续应收紧到个人固定出口 IP
- UFW：部署检查时为 inactive；云安全组是当前外层防火墙

## 数据与初始化

部署时没有上传本机 `.data/`。服务器使用独立的 `/var/lib/ai-gateway` 数据库；首次启动创建空库，之后由管理页面设置管理密码并保存服务器端配置。厂商连接、项目 Token 和请求记录以服务器数据目录为准，不进入 Git。

## 代码同步

本地仓库已包含：

- `.github/workflows/ci.yml`：测试、构建 Linux amd64/arm64 artifact，并在 `main` push 后触发 production 部署
- `deploy/systemd/ai-gateway.service`：服务器 systemd 单元模板
- `deploy/remote-deploy.sh`：生产部署、健康检查与失败回滚脚本

GitHub Actions 的生产部署说明见 [GitHub 推送后自动部署](github-actions-cd.md)。

部署时验证的 Linux amd64 二进制 SHA-256：

```text
3eac370e0578bb3696c2eea4e4cb313aa5c4a172778896974e110b62b73fbb86
```

服务器具体 IP、主机指纹和管理白名单保存在本机私有部署记录中；此公开模板不保存这些值。

## 常用检查

```bash
sudo systemctl status ai-gateway.service --no-pager
sudo systemctl status nginx --no-pager
sudo ss -lntup | grep -E '(:443|:8317)'
curl -I https://<SERVER_IPV4>/
curl -i https://<SERVER_IPV4>/v1/models
```

没有项目 Token 时，`/v1/models` 返回 401 是预期行为；这只证明 HTTPS 和网关入口可达，不代表模型已配置。
