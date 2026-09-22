package gateway

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
)

const maxASRRequestBytes = 32 * 1024 * 1024

var audioDataURI = regexp.MustCompile(`(?i)data:audio/[^,\s]*,[a-z0-9+/=_\r\n-]*`)
var anyDataURI = regexp.MustCompile(`(?i)data:[^,\s]*,[a-z0-9+/=_\r\n-]*`)

func audioLogSummary(uri string) map[string]any {
	header, data, found := strings.Cut(uri, ",")
	mediaType := strings.SplitN(header[len("data:"):], ";", 2)[0]
	summary := map[string]any{"omitted": "audio", "media_type": mediaType, "encoded_bytes": len(data)}
	if found && strings.Contains(strings.ToLower(header), ";base64") {
		compact := strings.NewReplacer("\r", "", "\n", "").Replace(data)
		summary["bytes"] = base64.RawStdEncoding.DecodedLen(len(strings.TrimRight(compact, "=")))
	}
	return summary
}

// ASR keeps the caller's native DashScope input and parameters. Validation only
// guards the synchronous contract and prevents accidental text-only test calls.
func validateASRRequest(body map[string]json.RawMessage) error {
	if raw, exists := body["stream"]; exists {
		var stream *bool
		if json.Unmarshal(raw, &stream) != nil || stream == nil {
			return errors.New("stream 必须为布尔值")
		}
		if *stream {
			return errors.New("百炼 ASR 当前仅支持同步调用，不支持 stream:true")
		}
	}
	var input struct {
		Messages []struct {
			Role    string `json:"role"`
			Content []struct {
				Audio string `json:"audio"`
			} `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(body["input"], &input) != nil {
		return errors.New("ASR 请求必须包含原生 input.messages 音频输入")
	}
	if raw, exists := body["parameters"]; exists {
		var parameters map[string]json.RawMessage
		if json.Unmarshal(raw, &parameters) != nil || parameters == nil {
			return errors.New("ASR parameters 必须为 JSON 对象")
		}
	}
	for _, message := range input.Messages {
		if message.Role != "user" {
			continue
		}
		for _, content := range message.Content {
			if strings.TrimSpace(content.Audio) != "" {
				return nil
			}
		}
	}
	return errors.New("ASR 请求必须在 input.messages 的 user 内容中提供 audio，不能使用纯文本测试")
}

// Sanitization happens before the log-size cap, so even an upstream response
// echoing a large audio input cannot leak the beginning of a base64 recording.
// The forwarded payload is never modified by this recording-only operation.
func asrLogPayload(raw []byte) []byte {
	var value any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&value) != nil {
		return []byte(`{"recording_note":"ASR 非 JSON 内容未记录"}`)
	}
	var visit func(any, string) any
	visit = func(value any, field string) any {
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				v[key] = visit(child, key)
			}
		case []any:
			for i, child := range v {
				v[i] = visit(child, field)
			}
		case string:
			pattern := audioDataURI
			if field == "audio" {
				pattern = anyDataURI
			}
			trimmed := strings.TrimSpace(v)
			if location := pattern.FindStringIndex(trimmed); location != nil && location[0] == 0 && location[1] == len(trimmed) {
				return audioLogSummary(trimmed)
			}
			// Error messages can embed the URI after explanatory text. Preserve
			// that text, but never persist the echoed audio payload.
			return pattern.ReplaceAllStringFunc(v, func(uri string) string {
				summary, _ := json.Marshal(audioLogSummary(uri))
				return string(summary)
			})
		}
		return value
	}
	out, err := json.Marshal(visit(value, ""))
	if err != nil {
		return []byte(`{"recording_note":"ASR 内容无法记录"}`)
	}
	return out
}

func (rec *Record) readASRUsage(data []byte) {
	var value struct {
		Usage struct {
			Duration *float64 `json:"duration"`
			Seconds  *float64 `json:"seconds"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &value) != nil {
		return
	}
	n := value.Usage.Duration
	if n == nil {
		n = value.Usage.Seconds
	}
	if n != nil && *n >= 0 && !math.IsNaN(*n) && !math.IsInf(*n, 0) {
		rec.AudioSeconds = n
	}
}
