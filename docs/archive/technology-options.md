# 原始技术选型比较（归档）

**已废弃，仅供参考：未采用的 Node.js、Python、Rust 后端，以及 Vue、HTMX 等替代组合不再作为当前开发方案。** 以下保留 2026-09-15 转正前的比较原文，其中包含已采用方案的推荐理由；正式方案已确定为 Go＋React／TypeScript＋Vite＋SQLite。

现行目标、技术栈和范围以 [项目说明](../../README.md) 与 [交接说明](../../HANDOFF.md) 为准，不因保留这些选项而重新开放选型。

## 5. 后端技术选型依据：已选择 Go

以下是针对本项目的工程判断，不是性能实测排名。四种方案均可部署到 Linux，也都能实现流式 HTTP；当前最需要比较的是开发成本、运行依赖、维护方式和个人学习目标。

| 方案 | 优点 | 缺点与成本 | Linux 部署 | 适合的优先目标 |
| --- | --- | --- | --- | --- |
| **Go＋标准库 net/http** | HTTP、连接池、取消传播等能力集中；可以把前端静态文件嵌入程序；运行与交付结构清楚 | 前后端使用不同语言；厂商协议适配需要自己维护；仍有 GC；涉及 CGO、SQLite 驱动或钥匙串库时需验证构建依赖 | 为目标系统和架构构建可执行文件，配数据目录与服务配置 | 长期常驻、轻量运行、理解网络转发、方便搬迁 |
| **TypeScript＋Node.js＋Fastify** | 前后端同一种语言；共享类型方便；对熟悉 JS/TS 的开发者，迭代界面和 API 较直接；支持流响应 | 需要管理 Node 运行时和 npm 依赖；类型在运行时不自动验证；同步大 JSON 处理、文件操作会阻塞事件循环 | 安装约定的 Node 版本，部署构建产物和依赖；含原生模块时需为 Linux 重建 | 优先快速做出第一版、前后端统一语言 |
| **Python＋FastAPI＋HTTPX** | 对 Python 使用者容易理解；厂商示例和实验代码接入方便；数据校验、接口文档方便 | Python、虚拟环境和服务运行依赖需要管理；同步 SDK 混入异步路径可能阻塞；需管理长期存活的 HTTP 客户端 | Python 环境＋锁定依赖＋ASGI 服务；可使用容器固化环境 | 已熟悉 Python、希望频繁试模型和处理实验数据 |
| **Rust＋Axum＋Tokio** | 可以精细控制内存与资源；无需 GC；类型系统能提前发现部分生命周期和并发错误 | 所有权、异步类型与错误处理的学习成本较高；改动和编译反馈通常比轻量脚本流程复杂；厂商适配仍需维护 | 为 Linux 构建，处理目标架构及系统库／TLS依赖 | 明确希望学习 Rust，或已有严格的资源与尾延迟目标 |

技术依据：Go 的 [HTTP Transport](https://pkg.go.dev/net/http#Transport) 支持复用连接，客户端与 Transport 应复用；[embed](https://pkg.go.dev/embed) 可将静态文件放入程序。平台构建目标见 [Go 官方说明](https://go.dev/doc/install/source)。

Fastify 支持直接发送流，参见 [Reply / Streams](https://fastify.dev/docs/latest/Reference/Reply/#streams)。事件循环阻塞影响请求处理，参见 [Node.js 官方解释](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)。

FastAPI 提供 [StreamingResponse](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse)，同步和异步第三方调用要按其 [异步使用说明](https://fastapi.tiangolo.com/async/) 组织。Axum 提供 [SSE 响应](https://docs.rs/axum/latest/axum/response/sse/)，底层运行方式参见 [Axum 文档](https://docs.rs/axum/latest/axum/)。

### 5.1 主推荐：Go

推荐依据是用户已经表达的目标：工具专注、常驻轻量、以后移到 Linux，同时希望通过网关理解模型通信。

1. **部署组成少。** 前端构建成静态资源并嵌入程序后，运行环境主要是网关可执行文件、配置与数据。前端构建需要的 Node 不必成为运行时服务。
2. **网关功能与语言能力匹配。** 第一版以 HTTP 转发、SSE、取消和连接复用为主，可以通过较直接的代码看到请求经过的步骤。
3. **平台相关部分容易隔离。** 把密钥解锁和服务启动独立出来，核心逻辑可以在 Mac 与 Linux 复用。具体依赖仍需跨平台验证。
4. **便于维持小的产品范围。** 标准库先完成必要路由与转发，根据真实需求再补充依赖。

代价：需要同时维护 Go 和前端 TypeScript；请求校验、模型参数映射及跨语言契约仍需设计，不能依赖 AI 自动保证一致。如果用户已经熟悉 JS/TS 且把开发速度置于部署组成之前，Node.js＋Fastify 可以升为首选。

Go 的推荐不等于已经证明其首字延迟最低。在个人 LLM 网关负载下，正确的流式处理和连接复用通常比语言选型更值得先验证。Go、Node、Python、Rust 都需要用同一测试条件评估，而不是引用不同网关的宣传数字比较。

## 6. 管理界面选型依据：已选择 React／TypeScript＋Vite

| 方案 | 优点 | 缺点与成本 | 本项目判断 |
| --- | --- | --- | --- |
| **React＋TypeScript＋Vite** | 组件方式适合筛选列表、消息详情、JSON 展开和实时内容；后端语言可独立选择；可构建静态页面 | 需要理解 JSX、状态和副作用；路由、数据获取等要选择约定；依赖选择容易过多 | 已选定，适合把请求查看器作为核心界面 |
| **Vue 3＋TypeScript＋Vite** | 模板和响应式写法对部分开发者更直观；单文件组件集中表达页面；同样可构建静态界面 | 需要掌握 Vue 响应式规则；已有 React 组件不能直接复用；同样要维护构建依赖 | 与 React 同级可行；更熟悉 Vue 时优先 Vue |
| **服务端 HTML 模板＋少量 JS／HTMX** | 表单和列表可以保持简单；无需采用完整 SPA 框架；与 Go 服务打包直接 | 复杂的实时 JSON 查看、局部状态联动和前端交互增长时，需要更多手工协调 | 若首版界面只需配置与基础记录列表，可以优先考虑 |

React 的选择是界面维护判断，不决定模型调用延迟。React 和 Vue 的差异不足以单独成为网关后端选型理由。首版管理界面无需搜索引擎收录或服务端渲染，静态页面即可；可先使用组件局部状态，出现明确共享状态需求再增加状态管理库。

官方能力说明见 [React 使用构建工具创建应用](https://react.dev/learn/build-a-react-app-from-scratch)、[Vue 简介](https://vuejs.org/guide/introduction.html) 与 [HTMX 文档](https://htmx.org/docs/)。

## 7. 存储：SQLite 为主推荐

| 方案 | 优点 | 缺点 | 本项目判断 |
| --- | --- | --- | --- |
| **SQLite** | 无需独立数据库服务；适合单机配置与调用检索；数据迁移直接 | 写入并发受限；备份要保证一致性；运行目录应使用可靠的本机磁盘 | 首版和初期单机 Linux 都采用它即可 |
| **PostgreSQL** | 适合更复杂查询、多实例访问和更高写入并发 | 多出数据库服务、连接与运维配置；当前需求没有体现其必要性 | 实际出现多实例或写入瓶颈后再评估 |
| **JSON／YAML＋JSONL 文件** | 人能直接阅读配置，启动验证很方便；JSONL 适合追加事件 | 筛选、关联、更新、分页与数据迁移要自行补齐 | 可用于配置导出或事件文件，不作为完整管理系统的唯一数据库 |

SQLite 可保存连接、模型、项目、调用索引与适量的内容；较大的调用事件记录可单独落文件，并在数据库中保存引用。事件拆分以实际体积和查询需要决定，不要求首版建立对象存储。

SQLite 官方说明了它与客户端／服务器数据库的适用边界，参见 [Appropriate Uses For SQLite](https://sqlite.org/whentouse.html)。数据库本身不默认提供本项目所需的凭据加密，敏感凭据需单独加密处理，项目访问凭证使用摘要鉴权，并另存加密副本，供已解锁管理员主动复制；列表不返回原文。

## 8. 已选组合及备选说明

**用户已选定：Go＋React／TypeScript＋Vite＋SQLite。** 后续实现按此组合推进。下列备选方案保留为选型依据，不再作为待定事项。

**快速迭代备选：Node.js／TypeScript＋Fastify＋React 或 Vue＋SQLite。** 若当前首要目标是用熟悉的 JS/TS 尽快做出可用版本，这是合理选择；不能仅因为 Go 能生成可执行文件就忽略统一语言带来的开发收益。

**Python 备选：FastAPI＋HTTPX＋静态管理界面＋SQLite。** 适合 Python 熟练度明显更高、后续偏模型实验的情况。第一版仍使用原生 HTTP／SSE 适配，不因 Python 生态而自动引入 Agent 编排框架。

Rust 作为有明确语言学习目标或资源指标时的选择。现阶段没有性能实测证明它能为本项目带来足以抵消开发成本的收益。

Docker、Next.js、Redis、消息队列与 Kubernetes 均不作为默认组成。后续确有部署、渲染或负载需求时，再按具体问题引入。
