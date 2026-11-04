# 运行保障：分页、保留、健康、备用与限速

2026-11-04 加入。本文说明这五项功能的规则和实现位置；回滚方法见 [手动部署到生产](deployment/manual-production-deploy.md#回滚到本次升级前)。

## 数据库扩展（schema_ext 11）

`PRAGMA user_version` 保持 10，新增结构记在 `meta.schema_ext=11`。改动只增不改：

- `request_metrics` 增加虚拟生成列 `m_project`、`m_model`、`m_alias`、`m_provider`、`m_state`，以及对应索引，用于列表筛选。虚拟列不占存储。
- `models.fallback_model_id`、`projects.rate_rpm／rate_burst／max_concurrent`，旧行默认空（不限、无备用）。
- 新表 `usage_daily`（按天汇总）、`connection_health`（30 分钟健康桶）、`maintenance_log`（清理与回收记录）。
- 首次升级把只有正文行、没有监控摘要的旧记录复制进 `request_metrics`。此后它是唯一的摘要来源，成本、任务和列表都只读它；`requests` 只存正文。
- 首次升级切换为增量回收（`auto_vacuum=INCREMENTAL`），这需要一次全量 `VACUUM`，在开始接收调用前完成，记入清理记录。

上一版二进制只检查 `user_version`，所以能直接打开升级后的库。它不认识的列和表会被忽略，它写入的行在新版本里照常可用。实现：`internal/gateway/schema_ext.go`。

## 请求列表：服务端分页与检索

`GET /api/admin/requests` 返回 `{items, next_cursor, total, body_search}`。

| 参数 | 说明 |
| --- | --- |
| `limit` | 1–200，默认 50 |
| `cursor` | 上一页的 `next_cursor`，格式 `started:rowid`；同一毫秒内的调用按写入顺序排列 |
| `from`／`to` | 毫秒时间戳 |
| `project_id`、`model`、`provider` | `project_id=none` 表示未识别项目；`model` 支持 `id:…`、`alias:…`、`unknown`；`provider=unknown` 表示未记录厂商 |
| `state` | `all`、`success`、`unfinished`、`running`、`failed`、`truncated`、`fallback`、`limited` |
| `q` | 匹配请求 ID 或摘要（别名、项目名、错误信息、提问摘录），`%`／`_` 按字面匹配 |
| `body=1` | 同时扫描正文，最多 10 秒；超时只返回摘要匹配，`body_search=timeout`，此时不返回 `total` |

页面每 5 秒刷新第一页，已经加载的更早页面保留。任务列表支持 `before=<毫秒>` 翻页，返回 `next_before`。实现：`requests_list.go`、`tasks.go`。

## 数据保留

| 数据 | 默认 | 到期后 |
| --- | --- | --- |
| 请求正文 `requests` | 30 天 | 删除；详情显示“正文已过期清理”，摘要和指标仍在 |
| 监控摘要 `request_metrics` | 180 天（不少于 62 天） | 先按天、项目、模型、用途汇总进 `usage_daily`，再删除 |
| 按天汇总 `usage_daily` | 永久 | 成本统计按项目／模型／用途／天分组时自动合并；按任务和单次调用的统计只覆盖摘要保留期 |

清理在启动 30 秒后运行一次，之后每天 `cleanup_hour`（默认 4 点，按成本时区）运行，每批 500 行，批间让出数据库连接；结束后增量回收空闲页并截断 WAL。设置、占用、清理记录在“数据与系统”页面，接口为 `GET /api/admin/system`、`PUT /api/admin/settings`、`POST /api/admin/maintenance/cleanup`、`POST /api/admin/maintenance/vacuum`。实现：`maintenance.go`、`settings.go`。

## 连接健康

- 被动检查：每次上游交换记录结果。2xx 正常，429 限流，401／403 Key 失效，5xx、连接失败、响应头前超时记为失败；400 等请求错误不计入。
- 状态：最近一次是 401／403 → `auth`；连续失败达到 `down_streak`（默认 3）→ `down`；窗口（默认 10 分钟）内有 429，或失败率超过 `degraded_ratio`（默认 0.3）→ `degraded`；没有数据 → `unknown`。
- 主动探测：连接超过 `probe_idle_minutes`（默认 10）既没有调用也没有探测时，用该连接的 Chat 或 Messages 端点 `GET /models`。只看状态码，不进请求记录和成本；没有这两个端点的连接只做被动检查。管理员也可以手动探测：`POST /api/admin/connections/{id}/probe`。
- 熔断：429 后熔断 `breaker_seconds`（默认 60 秒，上游给了 `Retry-After` 则按它），连续失败达到故障阈值也会熔断。熔断只影响配置了可用备用模型的请求：它们直接走备用，不再先试主模型。
- 每 30 分钟一个桶，保存最近 24 小时，持久化到 `connection_health`，保留 7 天。熔断状态和窗口事件只在内存里，重启后从“未知”重新开始。

实现：`health.go`，接口 `GET /api/admin/health`。

## 备用模型

- 模型可设置一个备用模型，只切换一次。不能指向自己，两个模型不能互为备用，并且要有共同的调用协议；被删除的备用目标会自动清空引用。
- 只在还没向客户端写出任何内容时切换：连接失败、响应头前超时、429、401、403、500、502、503、504、529。400／404／413／422 等请求错误，以及流式开始后的中断，按原样返回。
- 项目也必须被授权使用备用模型；没有授权时返回主模型的错误，记录里写明 `not_granted`。
- 记录：`attempts` 按顺序列出每次尝试（`served`、`failed`、`skipped_breaker`、`not_granted`、`unavailable`），`fallback_from` 是调用方请求的别名，模型、连接、用量和费用按实际服务的模型记录。响应头带 `X-Gateway-Fallback: 主 -> 备`。每次尝试都按备用模型的厂商规则重新补默认参数和兼容改写。
- 换厂商后提示词缓存不会命中；带思考签名的多轮对话交给另一家可能被拒，这时返回备用模型的错误。
- 管理员模型测试、对话调试不走备用。

实现：`fallback.go`、`proxy.go`。

## 项目限速

- 每个项目可设每分钟请求数 `rate_rpm`、突发量 `rate_burst`（默认 `rpm/4`）、同时进行的请求 `max_concurrent`。`null` 或 0 表示不限。
- 顺序：鉴权 → 限速与并发 → 读取请求体与授权 → 预算 → 转发。超限的请求不读取请求体、不消耗厂商额度。
- 超限返回 429 和 `Retry-After`。Messages 调用方收到 `{"type":"error","error":{"type":"rate_limit_error",…}}`，其他协议收到 `{"error":{"type":"rate_limit_exceeded","code":"project_rate_limit|project_concurrency",…}}`，官方 SDK 会自动退避重试。记录的错误类型为 `project_rate_limit`／`project_concurrency`，不计入厂商健康。
- 新建项目和接入申请创建的项目使用设置里的默认值（60 次/分、4 并发）；升级前已有的项目保持不限。编辑项目时留空表示不限；不带这几个字段的旧客户端保存时保留原值。
- 限速状态在内存中，重启后重新计数。实时用量见 `GET /api/admin/runtime` 的 `limits`。

实现：`limits.go`。
