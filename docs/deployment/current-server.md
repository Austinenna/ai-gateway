# 当前 Linux 服务器部署记录

访问控制最后核对：2026-10-12（Asia/Taipei）；标注“部署时”的资源信息仍为初次部署快照。这份记录描述服务器结构和连接方式，不保存私钥、厂商 Key、项目 Token 或网关数据库。

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

2026-10-12 按用户决定移除 Nginx 管理路径的来源 IP 白名单。当前访问控制分为两层：

- 云端防火墙／安全组限制能够连接 TCP 443 的来源 IP。
- 网关负责应用认证：管理接口要求有效的管理员登录会话，`/v1/` 调用要求有效的项目 Token，并校验项目权限。

通过云端来源限制的客户端可以加载管理登录页，但不能在未登录时读取管理数据或执行管理操作。生产免密管理模式保持关闭；服务自动解锁不等于管理员登录。

新增客户端或直连公网出口变化时，只在云端防火墙／安全组中维护相应来源，无需再修改 Nginx。Nginx 继续负责 HTTPS 和反向代理；后续部署应保留这一访问边界，不重新引入管理来源白名单。

## 当前网络边界

- `8317`：不开放公网，只允许服务器本机访问
- `443`：云端防火墙／安全组按来源 IP 放行；Nginx 不再另设来源 IP 白名单
- `80`：云安全组当前已开放，用于证书验证和跳转
- `22`：云安全组当前允许 SSH；后续应收紧到个人固定出口 IP
- UFW：部署检查时为 inactive；云安全组是当前外层防火墙

## 数据与初始化

部署时没有上传本机 `.data/`。服务器使用独立的 `/var/lib/ai-gateway` 数据库；首次启动创建空库，之后由管理页面设置管理密码并保存服务器端配置。首次成功登录管理页后，服务会在同一数据目录生成仅供服务进程读取的 `service-unlock.key`，后续 systemd 重启无需再次解锁即可接收项目请求；管理页面仍需管理密码。厂商连接、项目 Token 和请求记录以服务器数据目录为准，不进入 Git。

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

服务器具体 IP、主机指纹、云端允许来源和历次 Nginx 访问规则变更保存在本机私有部署记录中；此公开模板不保存这些值。

2026-10-12 访问控制变更验收：备份原站点配置后移除 Nginx 的来源允许与默认拒绝规则，`nginx -t` 和平滑重载通过。原先不在 Nginx 白名单中的服务器回环来源现可通过 HTTPS 加载首页（200）；该来源及用户公网直连的匿名管理接口均返回 401，未带 Token 的 `/v1/models` 均返回 401。运行状态确认已设置管理密码、免密模式关闭；Nginx 主进程和网关进程未重启，健康检查通过。本轮未修改云端规则、应用代码或生产数据，未调用真实厂商。

## 常用检查

```bash
sudo systemctl status ai-gateway.service --no-pager
sudo systemctl status nginx --no-pager
sudo ss -lntup | grep -E '(:443|:8317)'
curl -I https://<SERVER_IPV4>/
curl -i https://<SERVER_IPV4>/v1/models
```

没有项目 Token 时，`/v1/models` 返回 401 是预期行为；这只证明 HTTPS 和网关入口可达，不代表模型已配置。
