package gateway

import (
	"encoding/json"
	"strings"
)

func eventData(s string) []byte {
	var lines []string
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "data:") {
			lines = append(lines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	return []byte(strings.Join(lines, "\n"))
}
func tokenValue(v *int64) *int64 {
	if v != nil && *v >= 0 {
		return v
	}
	return nil
}
func (rec *Record) readUsage(data []byte) {
	type usage struct {
		Input      *int64 `json:"input_tokens"`
		Output     *int64 `json:"output_tokens"`
		Prompt     *int64 `json:"prompt_tokens"`
		Completion *int64 `json:"completion_tokens"`
		CacheRead  *int64 `json:"cache_read_input_tokens"`
		CacheWrite *int64 `json:"cache_creation_input_tokens"`
		Details    struct {
			Cached *int64 `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	}
	var v struct {
		Type    string `json:"type"`
		Usage   usage  `json:"usage"`
		Message struct {
			Usage usage `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(data, &v) != nil {
		return
	}
	u := v.Usage
	if v.Type == "message_start" {
		u = v.Message.Usage
	}
	if rec.Protocol == "chat" {
		if n := tokenValue(u.Prompt); n != nil {
			rec.InputTotal = n
			rec.InputTokens = *n
		}
		if n := tokenValue(u.Completion); n != nil {
			rec.OutputTokens = *n
			rec.OutputReported = true
			rec.outputFinal = true
		}
		if n := tokenValue(u.Details.Cached); n != nil {
			rec.CacheRead = n
		}
		if rec.InputTotal != nil && rec.CacheRead != nil && *rec.CacheRead <= *rec.InputTotal {
			n := *rec.InputTotal - *rec.CacheRead
			rec.InputUncached = &n
		}
	} else {
		if n := tokenValue(u.Input); n != nil {
			rec.InputUncached = n
			rec.InputTokens = *n
		}
		if n := tokenValue(u.CacheRead); n != nil {
			rec.CacheRead = n
		}
		if n := tokenValue(u.CacheWrite); n != nil {
			rec.CacheWrite = n
		}
		if n := tokenValue(u.Output); n != nil {
			rec.OutputTokens = *n
			rec.OutputReported = true
			if v.Type != "message_start" {
				rec.outputFinal = true
			}
		}
		// Messages separates ordinary input, cache reads and cache writes. An
		// omitted cache field cannot be assumed to mean zero.
		if rec.InputUncached != nil && rec.CacheRead != nil && rec.CacheWrite != nil {
			n := *rec.InputUncached + *rec.CacheRead + *rec.CacheWrite
			if n >= *rec.InputUncached && n >= *rec.CacheRead && n >= *rec.CacheWrite {
				rec.InputTotal = &n
				rec.InputTokens = n
			}
		}
	}
}

// Do not mistake an HTTP 200 error payload/event for a successful completion.
func responseError(data []byte) string {
	if len(data) == 0 || string(data) == "[DONE]" {
		return ""
	}
	var v struct {
		Type  string          `json:"type"`
		Error json.RawMessage `json:"error"`
		Base  struct {
			Code int `json:"status_code"`
		} `json:"base_resp"`
	}
	if json.Unmarshal(data, &v) != nil {
		return "upstream_protocol"
	}
	if v.Type == "error" || (len(v.Error) > 0 && string(v.Error) != "null") || v.Base.Code != 0 {
		var e struct {
			Type string          `json:"type"`
			Code json.RawMessage `json:"code"`
		}
		_ = json.Unmarshal(v.Error, &e)
		if e.Type == "rate_limit_error" || e.Type == "rate_limit_exceeded" || string(e.Code) == "429" {
			return "rate_limit"
		}
		return "upstream_error"
	}
	return ""
}
