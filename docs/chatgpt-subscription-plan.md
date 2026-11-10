# 方案：用 ChatGPT／Codex 订阅账号接入 GPT 模型

状态：方案待确认，未开始开发。日期：2026-11-10。

## 目标与边界

- 网关新增一种连接「ChatGPT 订阅」，用 OAuth 登录 ChatGPT 账号，不用 OpenAI API Key。
- 项目照常用 `/v1/chat/completions`（第一期）和 `/v1/messages`（第二期）调用，模型别名、项目授权、记录、监控、备用模型全部沿用。
- 只给作者自己的项目用，属于个人自用；不转售，不对外开放。
- 不是 OpenAI 官方保证的用法，上游接口和要求可能随时变化；出问题时靠备用模型兜底，不承诺稳定。

## 上游是什么

订阅额度只能通过 Codex 后台使用（以下细节在开发时对照 Codex CLI 开源代码逐项核实，不凭记忆写死）：

| 项 | 内容 |
| --- | --- |
| 认证 | `auth.openai.com` 的 OAuth（PKCE），得到 `access_token`、`refresh_token`、`id_token`；`account_id` 从 `id_token` 取 |
| 接口 | `https://chatgpt.com/backend-api/codex/responses`，**Responses 协议** |
| 请求头 | `Authorization: Bearer <access_token>`、`chatgpt-account-id`，以及 Codex 客户端会带的标识头 |
| 限制 | 只接受流式；`store: false`；`instructions` 有格式要求；部分采样参数（如 `temperature`、`max_output_tokens`）可能不被接受 |
| 额度 | 5 小时窗口和每周上限；响应头里带已用百分比；用完返回 429 |

## 关键决定

### 1. 网关自己登录，不导入 `~/.codex/auth.json`（推荐）

OpenAI 的 `refresh_token` 是**一次性轮换**的：谁先刷新，另一份就失效。网关如果复制本机 Codex 的登录文件，两边总有一边会被挤掉登录。所以网关单独走一次 OAuth 登录，拿自己的一套令牌，和本机 Codex 互不影响（额度仍共用）。

查证（2026-11-10）：Codex 源码 `codex-rs/login/src/auth/` 处理 `auth.openai.com/oauth/token` 返回的 `refresh_token_reused` 错误（“Your refresh token has already been used to generate a new access token”），提示重新登录；官方 CI/CD 认证文档要求一台机器或一条串行任务流用一份 `auth.json`，不要跨机器或并发共用，并把“另一台机器先轮换了令牌”列为需要重新导入的情况。“各自登录的令牌互相独立”是标准 OAuth 行为，官方文档没有明说，真实联调时验证：网关刷新后本机 Codex 仍可用。

登录方式：

- **本机网关**：管理页点「登录 ChatGPT」，打开 OpenAI 登录页，回调到网关后保存。Codex 的 OAuth 客户端只允许回调到 `localhost:1455`，网关登录时临时监听这个端口，完成后关闭。
- **生产服务器**（后续）：服务器上收不到浏览器回调，改用设备码登录（页面显示一个码，你在任意设备上输入），开发时确认 Codex 当前是否提供设备码流程；不行就用「把回调网址粘贴回管理页」的方式。

### 2. 令牌保管与刷新

- 令牌整体（JSON）作为这条连接的厂商凭据，沿用现有主密钥加密存储，**不新增明文字段**。
- 过期前 5 分钟，或上游返回 401 时，刷新一次；同一连接加互斥锁，并发请求只刷新一次，刷新结果写回数据库。
- 刷新失败（例如在 ChatGPT 网页上退出了所有设备）时，连接标为「需要重新登录」，请求按现有逻辑走备用模型；管理页给出明确提示。
- 记录和日志里对 access／refresh token 做脱敏，沿用 `redact`。

### 3. 协议转换（工作量主体）

外部入口不变，网关内部把请求转成 Responses，再把 Responses 事件转回原协议：

**第一期：Chat Completions ↔ Responses**

| Chat Completions | Responses |
| --- | --- |
| `system`／`developer` 消息 | `instructions` 加 `developer` 输入项 |
| `user`／`assistant` 文本与图片 | `input` 中的 message 项 |
| `assistant.tool_calls` | `function_call` 项 |
| `tool` 消息 | `function_call_output` 项 |
| `tools`、`tool_choice` | 扁平化的 function 工具定义与 `tool_choice` |
| `response_format` | `text.format` |
| `reasoning_effort` | `reasoning.effort` |

- 流式：Responses 的 `output_text.delta`、`function_call_arguments.delta`、`completed` 等事件转成 `chat.completion.chunk`，最后补 usage（客户端要 `stream_options.include_usage` 时）和 `[DONE]`。
- 非流式：上游强制流式，网关在内部收完整个流，拼成一个 `chat.completion` 返回。
- 不支持的参数（`n>1`、`logprobs` 等）返回 400 并说明，不静默丢弃；上游不接受的采样参数删掉，并写进请求记录的「转换」里，可在请求详情看到。
- 推理内容：只转发可见摘要（如有），不把加密推理内容暴露给 Chat 客户端。

**第二期：Messages ↔ Responses**

文本、图片、`tool_use`／`tool_result` 映射到 Responses 对应项，事件转回 `message_start`、`content_block_*`、`message_delta`、`message_stop`。`thinking` 参数映射为 `reasoning.effort`。等第一期在实际客户端里跑稳再做。

**可选：`/v1/responses` 直通**

只对这类连接开放，给本身就说 Responses 的客户端用，网关只换鉴权、补固定字段。需要时再加。

### 4. 记录、成本、额度

- 请求记录照常保存：输入存客户端原始请求，输出存客户端实际收到的内容，转换步骤记在 `adaptations` 里。
- 成本：订阅调用不设单价，估算费用为 0，Token 用量照常统计；月预算对它不起作用，靠项目并发和每分钟请求数限制控制用量。
- 额度：读取响应头里的额度百分比，在连接页显示「5 小时已用 / 本周已用」和重置时间；额度用完返回 429，走现有熔断和备用模型。
- 健康检查不对这类连接发真实请求，避免消耗额度，只检查令牌是否有效。

### 5. 模型

Codex 后台可用的模型 ID（如 GPT-5 系列的 Codex 版本）开发时从上游确认；能拿到模型列表就接进「获取模型列表」，拿不到就手填，并用模型测试验证。

## 改动范围

| 位置 | 改动 |
| --- | --- |
| `internal/gateway/` 新增 `chatgpt_oauth.go` | OAuth（PKCE）登录、回调、令牌刷新与互斥 |
| 新增 `responses_chat.go` | Chat Completions ↔ Responses 请求与事件转换，含非流式聚合 |
| `proxy.go` 的 `forward` | 识别 `chatgpt` 厂商：取令牌、换上游路径与请求头、接入转换 |
| `admin.go` | 允许 `chatgpt` 厂商；登录、退出、状态接口 |
| `health.go` | 这类连接只检查令牌 |
| `web/src` | 厂商模板「ChatGPT 订阅」、登录按钮与状态、额度显示 |
| 数据库 | 预计不需要改表（令牌存在现有加密凭据里）；额度信息先放内存，需要持久化时再按 `schema_ext` 只增不改 |
| 文档 | README、`docs/current-architecture.md`、新增使用说明 |

## 测试

- 全部用临时数据库和模拟上游：模拟 OAuth 令牌接口（含刷新轮换、刷新失败）和模拟 Codex Responses 事件流。
- 覆盖：文本、多轮、工具调用（含并行）、图片、流式中断、429 额度用完切备用、401 刷新后重试一次、并发刷新只发一次、令牌脱敏。
- 真实联调最后做：需要你用自己的账号在本机网关登录一次，我只发少量测试请求，确认后再接实际客户端。

## 分期

1. **第一期**（本机）：OAuth 登录与刷新、Chat Completions 转换、记录与额度显示、模拟上游测试、真实联调。
2. **第二期**：Messages 转换；按需加 `/v1/responses` 直通。
3. **第三期**：生产服务器启用（设备码或粘贴回调登录），确认后按部署文档上线。

## 需要你确认

1. 登录方式：网关单独登录（推荐），还是导入本机 `~/.codex/auth.json`（会和本机 Codex 互相挤掉登录）。
2. 第一期只做 Chat Completions，Messages 放第二期，可以吗？你主要想用 GPT 的客户端说哪种协议？
3. 先只在本机网关启用，生产以后再说，可以吗？
