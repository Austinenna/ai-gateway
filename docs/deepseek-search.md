# DeepSeek 搜索与抓取接入

网关转发 DeepSeek 的 Search 和 Fetch 接口（2026-10-17 开放），供 Kairos 等项目做联网搜索。项目只持有网关 Token，DeepSeek Key 仍保存在厂商连接里。

## 结构

Search 和 Fetch 是 DeepSeek 账号下的独立服务，和 `deepseek-flash` 这类模型平级，不属于任何模型。网关目前只有“模型”这一种可授权条目，所以借用一个模型条目（例如别名 `web-search`）承载它们：只用它的别名、项目授权和所属连接，不用上游模型 ID、上下文窗口和默认参数。以后没有模型的服务变多时，再考虑把“模型”扩展成“可授权服务”。

| 协议标识 | 网关入口 | 上游地址 |
| --- | --- | --- |
| `deepseek-search` | `POST /v1/tools/search` | 连接端点 + `/tools/search` |
| `deepseek-fetch` | `POST /v1/tools/fetch` | 连接端点 + `/tools/fetch` |

## 配置

1. 在 DeepSeek 连接上配置两个协议的端点，均为 `https://api.deepseek.com/v1`，沿用原连接的 Key。
2. 新建模型，例如别名 `web-search`，选择该连接，只勾选这两个协议。上游模型 ID 不会发给 DeepSeek，可填 `deepseek-web-tools` 作为说明。
3. 把该模型授权给需要联网搜索的项目。

新建模型不指定协议时，默认只启用连接上的对话类协议，不会自动带上搜索和抓取，避免能对话的项目顺带获得搜索权限。

## 调用

请求体与直接调用 DeepSeek 相同，地址和凭证换成网关的：

```http
POST http://127.0.0.1:8317/v1/tools/search
Authorization: Bearer <项目 Token>
Content-Type: application/json

{"query": "DeepSeek Search API 价格", "count": 5}
```

```http
POST http://127.0.0.1:8317/v1/tools/fetch
Authorization: Bearer <项目 Token>
Content-Type: application/json

{"url": "https://api-docs.deepseek.com/guides/search/"}
```

- 请求不带 `model` 时，网关在项目已授权、启用了对应协议的模型中查找：找到一个就使用；没有返回 403；多于一个返回 400，此时需在请求中写 `model` 指定。
- 带 `model` 时按别名路由。无论哪种方式，转发前都会删除 `model`，不补默认参数，其余字段原样转发。
- 参数（`query` 1～128 字、`count` 1～50、`url` 等）由 DeepSeek 校验，上游状态码和错误正文原样返回。网关只拒绝 `stream:true`。
- 请求体上限 64 KiB；响应沿用普通 JSON 的 8 MiB 上限与超时设置。

## 记录与统计

- 请求记录保存查询词和返回结果，沿用正文 1 MiB 截断。
- 没有 Token 用量，用量状态保持未知，不计入 Token 用量完整率、缓存、首字时间和输出速度统计。DeepSeek 按成功且有结果的请求计费（每 1000 次 0.75 美元），网关暂不单独统计计费次数。
- 只启用搜索或抓取协议的模型不出现在 `GET /v1/models` 中，避免客户端把它当成对话模型；公开目录 `/api/public/models` 照常列出协议。
- 管理页“测试模型”选择这两个协议时，发送示例请求：搜索 `DeepSeek`，抓取 `https://api-docs.deepseek.com/`；测试框文字可替换查询词或网址。
- 无数据库迁移。

## 管理页

- 厂商连接：DeepSeek 和自定义连接可勾选“DeepSeek 搜索”“DeepSeek 抓取”，DeepSeek 模板预填 `https://api.deepseek.com/v1`。
- 模型配置：新建模型和切换连接时默认不勾选这两个协议；只勾选它们时，表单只显示“上游模型 ID（不会发送）”，不显示模型目录、上下文窗口和默认参数。
- 测试与试调用：管理员测试发送示例请求；“以项目身份试调用”把输入框内容作为查询词或网址。结果按“标题、网址、摘要”整理显示，抓取显示标题和 Markdown 正文。
- 项目接入信息：显示完整端点和原生请求示例，复制配置时附带请求示例。
- 请求详情：消息页显示查询词或网址及整理后的结果，性能页只显示耗时和结果，Token 相关指标显示“不适用”。

## 验证边界

自动化测试使用临时数据库和模拟上游：Go 测试覆盖按协议查找模型、原样转发、删除 `model`、记录、模型列表过滤、未授权与流式拒绝；前端测试覆盖请求体、结果整理，以及连接模板、默认不勾选、单独建模型和测试的页面流程。搜索响应的顶层字段名按 `results`（兼容 `data`）整理，未按真实响应核对；真实 DeepSeek 调用需在生产配置 Key 后验证。
