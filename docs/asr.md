# 百炼 ASR 接入

网关在原有 LLM 调用之外增加百炼同步语音转写。连接保存百炼 Key，模型配置上游 ID 和调用别名，项目只持有自己的网关 Token。此次只修改网关；Dustoff 的代码、运行配置和凭据保持原状，后续由用户自行切换。

## 配置与调用

1. 在“厂商连接”新建“阿里百炼”连接，启用“百炼 ASR”，填写账号对应的百炼 Key。默认基础端点为 `https://dashscope.aliyuncs.com/api/v1`。
2. 在“模型配置”创建模型，手动填写实际开通的上游模型 ID。Dustoff 现有选型为 `qwen-audio-3.0-asr-flash`，例如将网关调用别名设为 `qwen-asr`。ASR 不使用 LLM 的 temperature、max_tokens 或思考默认参数，也不通过 `/models` 猜测厂商目录。
3. 在“项目权限”给需要转写的项目授权该模型。原项目 Token 可继续使用，无须重置；仅授权新模型不会改变已有模型授权。
4. 项目通过 `POST http://127.0.0.1:8317/v1/asr/transcriptions` 发送 JSON，使用 `Authorization: Bearer <项目 Token>`。管理页的模型测试及项目试调用支持选择音频文件和填写可选热词。

协议标识为 `dashscope-asr`。网关给连接基础端点追加 `/services/aigc/multimodal-generation/generation`，使用连接的厂商 Key 认证，并把请求中的模型别名替换为上游模型 ID。

这是 **DashScope 原生 JSON 协议**，不是 OpenAI 的 multipart `/audio/transcriptions` 协议。首版只提供同步调用，不启用 SSE，也不引入异步任务或文件上传服务。

## 请求示例

下面的 `…` 代表音频 Base64 数据，需用实际文件内容替换。热词放在 system 文本中，音频格式与文件一致；额外厂商参数沿用原生结构。

```json
{
  "model": "qwen-asr",
  "input": {
    "messages": [
      {"role": "system", "content": [{"text": "AI Gateway、Dustoff、TypeScript"}]},
      {"role": "user", "content": [{"audio": "data:audio/mp3;base64,…"}]}
    ]
  },
  "parameters": {
    "format": "mp3",
    "asr_options": {"language": "zh", "enable_itn": true}
  }
}
```

响应保持厂商原生结构。现有 Qwen Audio 请求的转写文本取自 `output.text`，词时间戳取自 `output.sentence` 内的 `words`，音频用量取自 `usage.duration`；兼容旧 Qwen ASR 的 `output.choices` 和 `usage.seconds`。网关不会将音频秒数换算为 Token。

上游 HTTP 状态和错误正文保留，包括“无人声”等 ASR 业务结果；客户端应按现有业务规则处理，不能把网关连通性与转写成功混为一谈。

## 记录与限制

- 单次 ASR JSON 请求上限为 **32 MiB**；管理页单文件上限为 **20 MiB**，为 Base64 编码和 JSON 保留空间。厂商自身的时长、格式和账号限制仍由上游判定。
- 请求记录保留热词、参数和音频摘要，去除音频 Data URI 的 Base64 正文；上游回显的音频也不写入记录。发送给厂商的音频原文不受影响。
- 转写文本、时间戳和厂商用量保留在响应记录中，沿用现有正文记录大小上限。页面展示总耗时及 `audio_seconds`，不把它计入 LLM Token、缓存、TTFT／TTFC 或输出速度统计。
- 仍然校验项目、模型、连接的启用状态与协议授权。给项目授予 ASR 模型不等于允许其读取厂商 Key。
- 沿用普通调用的错误分类、取消和超时机制。无须数据库版本迁移；新增音频用量存入既有 JSON 记录与监控摘要。

## 验证边界

自动化验证使用临时数据库、虚构凭据及本机模拟上游，覆盖协议配置、项目权限、音频转发、原生响应与错误、记录去除音频、用量和管理界面。真实百炼 Key、套餐权限和真实语音效果须在用户配置后验证；本次不调用真实厂商，也不修改 Dustoff。
