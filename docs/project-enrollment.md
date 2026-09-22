# 项目自助申请与审批

客户端通过 Skill 创建自己的项目，**立即领取尚未启用的项目 Token 并完成配置**。管理员随后在「项目权限」页面点击「批准」，同一个 Token 即刻生效；客户端不必等待审批、重新领 Token 或重写配置。拒绝后 Token 保持不可用。

默认接入 OpenAI Chat Completions；按客户端需要选择 Anthropic Messages 或百炼 ASR。当前不支持 Responses。成本、速度和模型效果选型不在这次范围。

## 正常流程

1. Skill 识别目标项目和客户端真正读取的配置、网关根地址与协议。
2. 客户端生成并私密保存一个随机申请回执，调用 `POST /api/project-applications`。网关事务内创建停用项目、所申请模型的授权和加密项目 Token。
3. 客户端立即保存响应中的 Token、端点和模型；调用只读的 `/api/project-access` 验证为 `pending` 后结束。待批准 Token 不能读取授权目录或调用模型。
4. 管理页的侧栏显示待批准数量，其他页面出现入口提示；项目列表显示客户端、用途、申请模型和「批准 / 拒绝」。管理员批准时复核模型仍启用、支持所选协议且授权未变化，事务内更新申请状态并启用项目。
5. 此后客户端使用已经保存的原 Token。正常项目停用、权限编辑、Token 重置和删除规则继续有效。

未指定模型时，网关按别名排序选择第一个可用且支持所选协议的模型，只作为初始配置，不是推荐排名。指定多个模型时全部作为申请授权，首个作为客户端默认模型。待审批或已拒绝项目不能绕过审批通过普通编辑启用，也不能在审批前重置 Token；可拒绝或删除，批准后可照常编辑权限。

## 接口

### 申请并立即领取

`POST /api/project-applications` 不需要管理员登录。必须带 `X-Gateway-Enrollment: 1` 和 `Authorization: Bearer <gr_申请回执>`；回执为 `gr_` 加 32 随机字节的 Base64URL（无填充，共 46 字符）。浏览器跨站请求被拒绝。

```json
{"name":"项目名称","client":"客户端名称","protocol":"chat","models":["coding"],"note":"可选用途"}
```

`protocol` 默认 `chat`；可用值为 `chat`、`messages` 和 `dashscope-asr`。`models` 可省略，最多 20 个；`note` 最多 500 字。网关需已解锁，以便加密保存项目 Token。

响应为 201，包含 `application`（申请 ID、项目 ID、状态、协议、申请模型）、`token`、`model`、`base_url`、`endpoint` 和 `approval_url`。同一回执和相同内容在 24 小时内重试返回 200，复用同一 Token 和项目；不同内容返回 409。回执过期、申请拒绝、项目删除或 Token 重置后返回 410，不生成替代项目。24 小时只限制重新领取，不限制已保存 Token 的使用，也不使待批准申请自动失效。

每个网关最多保留 50 个未处理项目，每 24 小时最多创建 100 份申请；达到限制返回 429。删除项目保留申请回执的摘要记录，避免丢失响应的客户端重试时意外重建同一项目。

### 查询自己的状态

`GET /api/project-access` 使用项目 Token，待批准 Token 也可访问。只返回该项目的状态、协议和接入地址；状态为 `pending`、`active`、`rejected` 或 `disabled`。`requested_models` 是原始申请内容；批准后的当前授权以 `GET /v1/models` 为准。此接口不调用厂商。

### 审批

`POST /api/admin/applications/{id}/decision`，请求体为 `{"decision":"approve"}` 或 `{"decision":"reject"}`。沿用管理员会话、同源与管理请求头校验。普通申请回执或项目 Token 不能审批。重复同一决定幂等，已处理后不能通过另一决定改变结果；已批准项目随后使用现有权限管理。

`GET /api/admin/state` 增加 `applications` 字段，仅包含申请元数据，没有完整项目 Token、回执或摘要。

## 客户端端点

| 协议 | SDK 常用 base URL | 完整地址 |
| --- | --- | --- |
| Chat Completions | 网关根地址 + `/v1` | 网关根地址 + `/v1/chat/completions` |
| Messages | 网关根地址 | 网关根地址 + `/v1/messages` |
| 百炼 ASR | 网关根地址 + `/v1` | 网关根地址 + `/v1/asr/transcriptions` |

以客户端实际字段含义为准，不重复追加 `/v1`。仅支持 Responses 的客户端不能直接使用本网关。远程机器或容器内的 `127.0.0.1` 指向它自身，需要明确可达的网关地址。

ASR 客户端应直接向完整 `endpoint` 发送 [DashScope 原生 JSON](asr.md)，不使用 OpenAI 的 multipart 转写接口。独立 Skill 的脚本已接受 `--protocol dashscope-asr`；客户端配置字段要求完整 URL 时使用 `--url-kind endpoint`，将 `endpoint` 写入 `--base-field` 指定的字段。默认 `--url-kind base` 仍写入基础地址，兼容原有 Chat 与 Messages 用法。

## Skill 源码与验证

开发源码位于 `~/Projects/skills/connect-ai-gateway/`，入口为 `SKILL.md`。按用户授权，在 Codex 的 `~/.codex/skills/connect-ai-gateway/` 和 WorkBuddy 的 `~/.workbuddy/skills/connect-ai-gateway/` 安装经过验证的独立稳定副本，不使用软链接；后续仍从开发源码修改、验证后再发布。其他客户端可按源码路径读取使用。脚本只依赖 Python 3 标准库，在 macOS／Linux 使用文件锁避免并发重复申请。

Skill 根据用途选择 Chat、Messages 或 ASR；ASR 的原生请求、热词、响应及用量说明在技能内的 `references/asr.md`。同一项目和客户端的已有申请不能直接切换协议重新提交；已批准的 LLM 项目若要沿用 Token，应由管理员增加 ASR 模型授权，再更新客户端的 ASR 配置。不要为绕过已有申请而随意新建项目。

`scripts/connect.py` 支持实际环境文件和普通 JSON 对象中的指定字段；其他客户端格式由 Skill 先核对其配置规则，再从私有状态文件读取 Token 写入。不能把任意 `.env.local` 文件的生成当作客户端已经会加载它。脚本拒绝向 Git 已跟踪文件写 Token，未跟踪配置加入本地 Git 排除，配置／状态／备份权限为 0600；不会在输出中打印凭证，不会登录管理或代替用户批准，不轮询审批、不发起真实推理验证。

SQLite 升级至 v7，新建 `project_applications` 表；兼容现行 v5 与已撤销价格功能曾使用的 v6，不重写配置、凭据或历史请求。测试使用临时库和模拟上游，包含批准前拒绝、批准后原 Token 可用、拒绝、重试、并发申请、重启、模型变化及普通管理接口不可绕过审批。
