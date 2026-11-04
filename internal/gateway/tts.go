package gateway

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

// DashScope speech synthesis (Qwen TTS). Callers send the native body
// {model, input:{text, voice, ...}}; the gateway swaps the alias, credential and
// address. The response is DashScope's own: an audio URL and/or base64 data.
const maxTTSRequestBytes = 256 * 1024

func validateTTSRequest(body map[string]json.RawMessage) error {
	if raw, exists := body["stream"]; exists && string(raw) == "true" {
		return errors.New("百炼 TTS 当前仅支持同步调用，不支持 stream:true")
	}
	var input struct {
		Text  string `json:"text"`
		Voice string `json:"voice"`
	}
	if json.Unmarshal(body["input"], &input) != nil || strings.TrimSpace(input.Text) == "" {
		return errors.New("TTS 请求必须包含原生 input.text")
	}
	if strings.TrimSpace(input.Voice) == "" {
		return errors.New("TTS 请求必须在 input.voice 指定音色")
	}
	return nil
}

// ttsLogPayload drops the synthesized audio from the stored response and keeps
// its size, so request records stay small and never hold the recording itself.
func ttsLogPayload(raw []byte) []byte {
	var value map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&value) != nil {
		return raw
	}
	output, _ := value["output"].(map[string]any)
	audio, _ := output["audio"].(map[string]any)
	data, _ := audio["data"].(string)
	if data == "" {
		return raw
	}
	compact := strings.TrimRight(data, "=")
	audio["data"] = map[string]any{"omitted": "audio", "encoded_bytes": len(data), "bytes": base64.RawStdEncoding.DecodedLen(len(compact))}
	out, err := json.Marshal(value)
	if err != nil {
		return []byte(`{"recording_note":"TTS 内容无法记录"}`)
	}
	return out
}

// Qwen-Audio 3.0 TTS reports billable characters; 3.1 models are billed by
// tokens and also report input_tokens / output_tokens.
func (rec *Record) readTTSUsage(data []byte) {
	var value struct {
		Usage struct {
			Characters *int64 `json:"characters"`
			Input      *int64 `json:"input_tokens"`
			Output     *int64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &value) != nil {
		return
	}
	u := value.Usage
	if u.Characters != nil && *u.Characters >= 0 {
		rec.TTSCharacters = u.Characters
	}
	if n := tokenValue(u.Input); n != nil {
		rec.InputTotal = n
	}
	if n := tokenValue(u.Output); n != nil {
		rec.OutputTokens, rec.OutputReported = *n, true
	}
}

// Sample request for the admin "test model" button.
func ttsTestBody(alias json.RawMessage, text, voice string) map[string]json.RawMessage {
	if text == "" {
		text = "网关语音合成测试。"
	}
	input, _ := json.Marshal(map[string]string{"text": text, "voice": voice})
	return map[string]json.RawMessage{"model": alias, "input": input}
}

// usesTokens reports whether a protocol's usage is counted in LLM tokens.
func usesTokens(protocol string) bool {
	return protocol != "dashscope-asr" && protocol != "dashscope-tts" && !isWebTool(protocol)
}
