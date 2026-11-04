# 百炼 TTS 接入

网关转发百炼的非实时语音合成（Qwen-Audio-TTS，`SpeechSynthesizer`），供 text-to-speech skill 等配音工具使用。项目只持有网关 Token，百炼 Key 保存在厂商连接里。2026-11-04 加入。

## 配置

1. 在「厂商连接」给阿里百炼连接勾选「百炼 TTS」，或新建一条连接。基础端点填**业务空间专属域名**加 `/api/v1`，例如 `https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1`。旧域名 `https://dashscope.aliyuncs.com/api/v1` 自 2026-09-30 起不再保证新模型可用。连接上的 Key 必须是北京地域、能访问该业务空间的 Key；和 ASR 用的不是同一个 Key 时，单独建一条连接。
2. 在「模型配置」新建模型，只勾选「百炼 TTS」，上游模型 ID 手填，例如 `qwen-audio-3.1-tts-flash`，别名例如 `tts`。单价填「语音合成 · 元／万字符」。
3. 把模型授权给需要配音的项目。

## 调用

协议标识 `dashscope-tts`，网关入口 `POST /v1/tts/speech`，转发到连接端点 + `/services/audio/tts/SpeechSynthesizer`。请求体就是百炼原生格式，只把地址、模型和凭证换成网关的：

```http
POST http://127.0.0.1:8317/v1/tts/speech
Authorization: Bearer <项目 Token>
Content-Type: application/json

{"model": "tts", "input": {"text": "要合成的文字", "voice": "anmingyuan_v3.1", "format": "mp3", "sample_rate": 24000}}
```

响应保持百炼原样：音频在 `output.audio.data`（Base64）或 `output.audio.url`（有时效的下载地址），计费字符数在 `usage.characters`。

- 只支持同步调用，`stream:true` 返回 400；`input.text` 和 `input.voice` 必填，缺了直接 400，不发给厂商。
- 请求体上限 256 KiB；百炼单次文本上限仍由厂商校验，调用方应按句切分（text-to-speech skill 每段 300 字以内）。
- 可以带 `X-Gateway-Category: tts` 和 `X-Gateway-Task-ID` 归集成本。

## 记录与计费

- 请求记录保存文字和音色；响应里的 Base64 音频替换为 `{"omitted":"audio","bytes":…}` 摘要，不写入数据库。`output.audio.url` 原样记录。
- 用量取自 `usage.characters`，保存在记录的 `tts_characters`；费用 = 字符数 ÷ 10000 × 单价。不计入 Token 用量完整率、首字时间和输出速度。
- 模型目录不支持自动获取，`/v1/models` 会列出 TTS 模型别名。
- 豆包语音（火山 openspeech）认证头和流式响应格式不同，暂未接入。
