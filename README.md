# AI Gateway

个人工具与 Agent 共用的轻量 LLM 网关：在页面管理厂商 Key、模型与项目权限，用项目凭证调用模型，并查看请求和响应。

**当前状态：第一版已实现，已转为正式开发项目，仍需完成真实厂商与实际客户端的系统联调。** 正式目录为 `/Users/enna/Projects/apps/ai-gateway`。转正保留原有实现和数据，不代表已完成生产环境验收。

## 已确认的范围和方案

- **先在本地实现，为未来迁移单台 Linux 服务器做好准备。** 现在不部署远程服务，也不引入分布式组件。
- **第一版只做大语言模型。** 提供智谱、MiniMax、DeepSeek 模板与自定义连接，每条连接可配置 Chat Completions、Anthropic Messages 中的一种或两种；百炼 ASR、豆包 ASR、火山视频生成等属于后续候选能力。
- 技术栈固定为 **Go＋React／TypeScript＋Vite＋SQLite**：Go 标准库处理 HTTP 与 SSE，前端嵌入一个可执行文件，SQLite 保存配置和记录。运行时无需 Node 服务。
- 界面采用 A 的整体侧栏结构＋B 的请求检查器，已根据实际使用调整项目列表、接入信息、删除流程和独立滚动。

选择这套方案是为了常驻运行时组成少、便于理解转发过程、便于搬到 Linux；代价是维护 Go 与 TypeScript 两套代码，以及自己处理厂商协议差异。它不构成延迟性能承诺。

## 启动

```bash
cd /Users/enna/Projects/apps/ai-gateway
bash scripts/start.sh
```

打开 [管理页面](http://127.0.0.1:8317/)。本机启动脚本启用自动解锁：已有库完成一次原密码激活后，每次启动即可接收模型调用，无需打开管理页面。管理页可留空登录，“退出管理”不影响调用。首次创建仍需设置管理密码。直接运行二进制默认采用标准密码模式，重启后需人工解锁；详情见 [运行与使用](docs/demo.md)。

修改源码后构建并重启：

```bash
bash scripts/build.sh
bash scripts/start.sh
```

先停止原网关进程，避免占用同一端口。构建需要 Go 1.26+ 与 Node 22.12+ 或兼容新版本；当前项目内 `.tools/go` 已有工具链。脚本从自身位置解析路径，迁移后无需修改全局环境变量。

## 正常流程与核心对象

**配置连接 → 创建模型别名 → 给项目授权 → 复制端点与项目 Token → 程序调用 → 查看请求记录。**

| 对象 | 职责 |
| --- | --- |
| 厂商连接 | 厂商、一种或两种协议各自的端点、共用的加密厂商 Key |
| 模型 | 调用别名、显示名称、上游模型 ID、所属连接、启用的协议与默认参数 |
| 项目 | 独立凭证、启停状态、允许调用的模型 |
| 请求记录与监控 | 项目归属、输入响应、最终结果、TTFT／TTFC、总耗时、Token 与缓存、请求量／并发及估算输出速度 |

后端校验项目凭证与模型授权，解析别名，从配置取得上游地址与 Key，转发请求和响应，并异步记录调用。普通项目凭证无权读取厂商 Key、修改配置或读取管理记录；拥有管理会话或本机数据目录权限的主体属于更高的信任边界。

新增／编辑模型时可点击“获取模型列表”，从连接的指定协议端点获取候选模型，按厂商提供的有效时间从新到旧展示，默认前 10 个，可搜索及切换显示数量；缺少时间时明确标注，接口不支持时仍可手动填写。列表不代表套餐授权或两种协议均可用，保存后可通过模型测试确认。

已实现 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/messages`。同一模型别名可用于两种请求路径，网关按路径选择连接中相应的上游端点。普通与 SSE 调用采用同协议转发，内部按实际厂商、模型和协议适配参数，外部继续使用统一端点与模型别名；保留工具调用及相关内容块，工具由客户端执行。当前已支持 MiniMax M3 的 Messages 思考参数从 `enabled` 转为 `adaptive`，转换记录可在请求详情查看。当前不支持 Responses，也不进行任意协议互转。

公开模型目录为 `GET /api/public/models`，无需 Token 或管理登录，返回全网关已启用且有可用协议的模型别名、显示名称与协议。`GET /v1/models` 仍需项目凭证，仅返回该项目获授权的模型；实际调用也继续校验项目权限。用法见 [模型列表接口](docs/demo.md#模型列表接口)。

左侧「任务记录」支持 WorkBuddy 按一次提问汇总主／子代理调用，展示用户提问、最新主代理回复、调用过程与累计用量；「请求记录」独立展示逐次调用。仅新请求中的有效显式标识用于分组，旧记录不猜测合并。使用与统计边界见 [WorkBuddy 任务分组](docs/workbuddy-tasks.md)。

## 项目自助接入

其他项目或客户端可通过 Skill 自行申请项目，立即领取待启用 Token 并写入自己的配置。你在「项目权限」页面点击「批准」后，同一个 Token 生效；客户端不用等待或再次配置。默认 Chat Completions，可选 Messages。接口、审批行为和 Skill 开发源码见 [项目自助申请与审批](docs/project-enrollment.md)。

## 数据与迁移

本地数据保存在 `.data/`，其中包含真实配置、加密凭据、主密钥解锁材料与请求记录；Git 不跟踪此目录。项目 Token 用摘要鉴权并保存加密副本，方便管理员复制。输入输出记录不等于全库加密。

服务支持配置监听地址、数据目录和外部地址，前端使用同源相对路径；未来 Linux 迁移沿用这些接口和业务逻辑。迁移数据库前正常停止服务或使用一致备份，不能在活跃写入时只复制主数据库文件。Linux 的实际主机运行、HTTPS、服务管理与网络延迟仍需届时验证；交叉构建通过不等于部署通过。

## 开发验证

```bash
bash scripts/test.sh
bash scripts/go.sh build -o bin/gateway ./cmd/gateway
cd web
npm run test:browser
npm run test:local-unlock
```

测试使用临时数据库和本地模拟上游，不读取真实 Key、不调用厂商。实际验证结果与限制见 [交接说明](HANDOFF.md) 和 [运行与使用](docs/demo.md)。

## 文档与目录

- [HANDOFF.md](HANDOFF.md)：当前进度、决定、待验证事项与下一步起点。
- [当前架构与实现逻辑](docs/current-architecture.md)：路由、权限、存储、转发与 Linux 边界。
- [运行与使用](docs/demo.md)：启动、操作、凭证与删除行为、验证记录。
- [配置与项目权限设计](docs/configuration-and-permissions.md)、[当前界面说明](docs/design-directions.md)。
- [项目理解报告](docs/project-understanding-report.md)：2026-09-15 的说明快照，生成方式见 [报告说明](docs/report-assets/README.md)。
- [原始技术选型](docs/archive/technology-options.md)、[三版独立界面方向](docs/archive/ui-directions.md)：历史比较，已被现行方案替代。

`cmd/gateway/` 是服务启动入口，`internal/gateway/` 是后端，`web/src/` 是管理界面，`web/tests/` 是前端与浏览器测试，`scripts/` 是构建与运行脚本。`.tools/`、`.cache/`、`bin/`、`output/` 和验收截图留在本地，不纳入源码仓库。
