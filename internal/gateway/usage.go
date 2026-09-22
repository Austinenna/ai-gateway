package gateway

import (
	"encoding/json"
	"math"
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
	if rec.Protocol == "dashscope-asr" {
		rec.readASRUsage(data)
		return
	}
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
		rec.normalizeMessagesInput()
	}
}

func (rec *Record) minimaxAutoCache() bool {
	return rec.Provider == "minimax" && rec.Protocol == "messages" && strings.EqualFold(rec.UpstreamModel, "MiniMax-M3")
}

// M3 automatic caching counts new input at the ordinary input rate; it does
// not require a separately reported cache creation bucket. Preserve the raw
// missing/zero distinction instead of fabricating a cache write measurement.
// https://platform.minimax.io/docs/api-reference/text-prompt-caching
func (rec *Record) normalizeMessagesInput() {
	rec.InputTotal, rec.InputTotalBasis = nil, ""
	auto := rec.minimaxAutoCache() && (rec.CacheWrite == nil || *rec.CacheWrite == 0)
	if auto {
		rec.InputTotalBasis = "minimax_auto_cache"
	}
	if rec.InputUncached == nil || rec.CacheRead == nil || (!auto && rec.CacheWrite == nil) {
		return
	}
	parts := []*int64{rec.InputUncached, rec.CacheRead}
	if rec.CacheWrite != nil {
		parts = append(parts, rec.CacheWrite)
	}
	var total int64
	for _, part := range parts {
		if *part < 0 || *part > math.MaxInt64-total {
			return
		}
		total += *part
	}
	rec.InputTotal, rec.InputTokens = &total, total
}

// Recompute only derived input fields when reading existing monitored M3
// records. Do not rewrite raw responses or infer final output from an old
// summary: older versions did not persist the output-final flag.
func (rec *Record) normalizeStoredUsage() {
	if rec.MetricsVersion > 0 && rec.minimaxAutoCache() {
		rec.normalizeMessagesInput()
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
