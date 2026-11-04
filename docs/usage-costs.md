# 用量、成本与项目预算

网关按「用量 × 模型单价」估算每次调用的费用，可以看整体、项目、任务、单次四个层级；每个项目可以设月预算，用完后网关拒绝该项目的新请求。各项目用自己的 Token 查询本项目的用量和预算。

费用是按管理员填写的单价估算的，不是厂商账单。币种为人民币；「今天」「本月」和月预算都按 Asia/Shanghai 的自然日、自然月计算。

## 单价怎么配

在「模型配置」里编辑模型，填写「单价（人民币）」：

| 模型协议 | 单价字段 | 单位 |
| --- | --- | --- |
| Chat Completions / Messages | 输入、输出、缓存读取、缓存写入 | 元 / 百万 Token |
| 百炼 ASR | 音频 | 元 / 分钟 |
| DeepSeek 搜索 / 抓取 | 每次调用 | 元 / 次 |

- 单价按版本保存，每个版本有一个生效日期。生效日期留空表示适用于全部历史调用。
- **价格变了**：点「添加价格变动」，填新的生效日期和新价格。之前的调用继续按旧价算，生效日 0 点之后开始的调用按新价算。
- **价格填错了**：直接改那一个版本。费用是查询时现算的，所以这个版本生效期内的历史费用会跟着改正。
- 缓存读取、缓存写入不填时按输入价算。
- **分时段价格**：每个价格版本可以勾选「高峰时段另计价」，选择高峰日（周一到周日），填写北京时间的时间段（如 `09:00-12:00, 14:00-18:00`，结束时刻不含），再填高峰单价。调用开始时间落在高峰时段内就按高峰价算，没填的高峰单价沿用平时价。网关不知道法定节假日，节假日的白天也按高峰价估算，估出来的费用会略高。请求详情里会标出“高峰价”。
- 文本模型必须同时有输入价和输出价才算已定价。
- 删除模型时不会删它的单价，旧调用的费用照样能算。

管理接口：`PUT /api/admin/models/{id}` 的请求体可以带 `prices` 数组，传了就整体替换；不传就保留原有单价。

```json
"prices": [
  { "effective_from": 0, "input_per_mtok": 2, "output_per_mtok": 8, "cache_read_per_mtok": 0.5 },
  { "effective_from": 1796140800000, "input_per_mtok": 1.6, "output_per_mtok": 6.4 }
]
```

带高峰价的版本：

```json
{ "effective_from": 0, "input_per_mtok": 1, "output_per_mtok": 4, "cache_read_per_mtok": 0.02,
  "peak": { "weekdays": [1,2,3,4,5], "hours": ["09:00-12:00", "14:00-18:00"],
            "input_per_mtok": 2, "output_per_mtok": 8, "cache_read_per_mtok": 0.04 } }
```

`effective_from` 是毫秒时间戳。

## 每次调用怎么算钱

| 情况 | 状态 `cost.status` | 计入金额 |
| --- | --- | --- |
| 没有到达厂商（鉴权失败、未授权、超预算被拒等） | `none` | 不计，也不算在调用次数里 |
| 用量完整，且有单价 | `priced` | 未缓存输入 × 输入价 ＋ 缓存读取 × 缓存读价 ＋ 缓存写入 × 缓存写价 ＋ 输出 × 输出价 |
| 只报告了一部分用量（比如流式中断，没收到最终输出量） | `partial` | 按已报告部分计算，是下限 |
| 厂商没有报告用量 | `usage_unknown` | 计 0，单独计数 |
| 模型在调用时没有生效的单价 | `unpriced` | 计 0，单独计数 |

- ASR 按厂商返回的音频秒数 ÷ 60 × 每分钟单价计算。
- 「每次调用」单价只对状态为成功（complete）的调用收取。
- 汇总结果里会单独列出 `unpriced`、`usage_unknown`、`usage_partial` 三类次数，不会把它们悄悄当成 0。看到这些数时，要么补单价，要么检查厂商是否返回了用量。

## 调用方怎么标记用途和任务

调用 `/v1/chat/completions`、`/v1/messages`、`/v1/asr/transcriptions`、`/v1/tools/*` 时，可以加两个请求头（都可选）：

| 请求头 | 含义 | 例子 |
| --- | --- | --- |
| `X-Gateway-Category` | 这次调用的用途，按用途统计费用 | `note`、`router`、`asr` |
| `X-Gateway-Task-ID` | 业务任务 ID，同一个 ID 的多次调用会归成一个任务 | 作品 ID `BV1xx411c7mD`、`note:12345` |

- 每个请求头只能有一个值，长度 1–128，只能用字母、数字和 `._:-`。格式不对时，网关返回 400 并说明是哪个请求头有问题，不会静默忽略。
- 这两个请求头只用于统计，不影响鉴权和路由，也不会转发给厂商。
- 带了 `X-Gateway-Task-ID` 的调用会出现在「任务记录」里，任务 ID 只在本项目内有效。WorkBuddy 自带的分组请求头优先；同时带了两套时，`X-Gateway-Task-ID` 仍然记作 `task_ref`，用于按任务统计费用。

## 项目查询接口

```
GET /v1/usage
Authorization: Bearer <项目 Token>
```

只能查本项目。传入其他项目的 `project_id` 会返回 403。

| 参数 | 说明 |
| --- | --- |
| `period` | `today`、`month`（默认）、`last_month`、`7d`、`30d`、`all` |
| `from` / `to` | 自定义区间，含 from、不含 to。可以写 `2026-11-01`（按北京时间当天 0 点）、RFC3339 或毫秒时间戳。不能和 `period` 同时用 |
| `group_by` | `category`、`task`、`model`、`day`、`request`（逐次列出）、`project`（仅管理接口有意义） |
| `category` / `task` / `model` / `request_id` | 只统计匹配的调用。`task` 填调用时传的 `X-Gateway-Task-ID`，`model` 填调用别名，`request_id` 填响应头 `X-Request-ID` 的值 |
| `limit` | `group_by=request` 时最多返回多少条，1–1000，默认 200（按时间倒序） |

响应示例（`group_by=category`）：

```json
{
  "currency": "CNY",
  "timezone": "Asia/Shanghai",
  "from": 1793462400000,
  "to": 1793764643604,
  "project_id": "prj_…",
  "total": {
    "requests": 36, "cost": 2.748364,
    "priced": 36, "usage_partial": 0, "usage_unknown": 0, "unpriced": 0,
    "input_tokens": 512000, "cache_read_tokens": 258109, "cache_write_tokens": 0,
    "output_tokens": 83543, "audio_seconds": 0
  },
  "group_by": "category",
  "groups": [
    { "key": "note", "label": "note", "requests": 24, "cost": 2.51, "...": "字段同 total" },
    { "key": "", "label": "未标记", "requests": 12, "cost": 0.23 }
  ],
  "budget": { "monthly_budget": 30, "month_spent": 2.748364, "remaining": 27.251636, "exceeded": false }
}
```

- `input_tokens` 是未命中缓存的输入。总输入 = `input_tokens + cache_read_tokens + cache_write_tokens`。
- `group_by=request` 时返回 `requests` 数组，每项包含 `id`、`started`、`model`、`protocol`、`category`、`task`、`state` 和 `cost`。`has_more` 表示被 `limit` 截断了。
- `budget` 始终是本月的预算状态，和查询的时间区间无关。没设预算时 `monthly_budget` 和 `remaining` 为 `null`。
- 单次调用的费用：用响应头 `X-Request-ID` 的值查 `GET /v1/usage?request_id=<id>`。

常见用法：

```bash
# 今天、本月按用途汇总
curl -H "Authorization: Bearer $TOKEN" "$BASE/v1/usage?period=today&group_by=category"
curl -H "Authorization: Bearer $TOKEN" "$BASE/v1/usage?period=month&group_by=category"
# 某一篇作品花了多少
curl -H "Authorization: Bearer $TOKEN" "$BASE/v1/usage?period=all&task=BV1xx411c7mD"
```

管理端用 `GET /api/admin/usage`，参数相同，另外可以按 `project_id` 筛选；不带 `project_id` 时统计全部项目。管理页「成本统计」页面使用的就是这个接口。

## 月预算

在「项目权限」里编辑项目，填写「月预算（元）」。留空表示不限。

- 每次请求通过鉴权和模型授权、准备转发之前，网关会检查本项目本月已经估算的费用。已用 ≥ 预算时，直接返回 HTTP 402，不联系厂商：

```json
{"error":{"type":"budget_exceeded","code":"budget_exceeded","message":"项目「dustoff」本月预算 ¥30 已用完（已用 ¥30.12），网关已拒绝本次请求。请在网关管理页提高预算，或等下月 1 日自动恢复。","monthly_budget":30,"month_spent":30.12,"currency":"CNY"}}
```

- 选 402 而不是 429，是因为 OpenAI / Anthropic 的 SDK 遇到 429 会自动重试，遇到 402 不会。
- 被拒绝的请求会出现在请求记录和「异常与诊断」里，错误类型为「项目预算已用完」，不计费。
- 提高预算或修改单价后立即生效；每月 1 日 0 点（北京时间）自动重新计算。
- 正在进行中的调用要等结束后才计入已用金额，所以多个请求并发时可能稍微超出预算。
- 未定价和用量未知的调用按 0 计，不会触发预算拒绝。设了预算的项目，应该给它用到的模型都配上单价。

## 实现位置

- `internal/gateway/costs.go`：单价版本、费用计算、查询接口、预算检查和本月已用金额缓存。
- `internal/gateway/tasks.go` 的 `captureUsageTags`：读取两个标记请求头。
- SQLite v10 新增 `model_prices` 表（按模型和生效时间保存价格 JSON），并在 `projects` 表加了 `monthly_budget` 列。
- 前端：`web/src/CostPage.tsx`（成本统计页）、`ModelPriceFields.tsx`（模型单价编辑）、`costs.ts`（类型和格式化）。
