package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestGeneratedContentTimingKinds(t *testing.T) {
	for _, tc := range []struct {
		name, protocol, payload string
		text, token             bool
	}{
		{"chat role", "chat", `{"choices":[{"delta":{"role":"assistant","content":""}}]}`, false, false},
		{"chat thinking", "chat", `{"choices":[{"delta":{"reasoning_content":"thinking"}}]}`, false, true},
		{"chat reasoning", "chat", `{"choices":[{"delta":{"reasoning":"thinking"}}]}`, false, true},
		{"chat text", "chat", `{"choices":[{"delta":{"content":"hello"}}]}`, true, true},
		{"chat tool", "chat", `{"choices":[{"delta":{"tool_calls":[{"function":{"name":"lookup","arguments":""}}]}}]}`, false, true},
		{"chat tool arguments", "chat", `{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{}"}}]}}]}`, false, true},
		{"chat tool metadata", "chat", `{"choices":[{"delta":{"tool_calls":[{"id":"call_1","type":"function","index":0}]}}]}`, false, false},
		{"chat nonstream", "chat", `{"choices":[{"message":{"content":"hello"}}]}`, true, true},
		{"chat nonstream tool", "chat", `{"choices":[{"message":{"tool_calls":[{"function":{"name":"lookup","arguments":"{}"}}]}}]}`, false, true},
		{"messages start", "messages", `{"type":"message_start","message":{"role":"assistant","content":[]}}`, false, false},
		{"messages empty block", "messages", `{"type":"content_block_start","content_block":{"type":"text","text":""}}`, false, false},
		{"messages thinking", "messages", `{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"thinking"}}`, false, true},
		{"messages text", "messages", `{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}`, true, true},
		{"messages tool", "messages", `{"type":"content_block_start","content_block":{"type":"tool_use","id":"call_1","name":"lookup","input":{}}}`, false, true},
		{"messages arguments", "messages", `{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}`, false, true},
		{"messages signature", "messages", `{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"opaque"}}`, false, false},
		{"messages nonstream thinking", "messages", `{"content":[{"type":"thinking","thinking":"thinking"}]}`, false, true},
		{"messages nonstream text", "messages", `{"content":[{"type":"text","text":"hello"}]}`, true, true},
		{"usage", "chat", `{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}`, false, false},
		{"heartbeat", "messages", `{"type":"ping"}`, false, false},
		{"malformed", "chat", `{`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text, token, _, _, _ := jsonStats([]byte(tc.payload), tc.protocol)
			if text != tc.text || token != tc.token {
				t.Fatalf("text/token = %v/%v, want %v/%v", text, token, tc.text, tc.token)
			}
		})
	}
}

func TestStreamFirstTokenPrecedesText(t *testing.T) {
	for _, protocol := range []string{"chat", "messages"} {
		t.Run(protocol, func(t *testing.T) {
			h := newHarness(t)
			c := h.connection("https://upstream.test/v1", protocol, "fake-timing-secret")
			m := h.model(c, "timing")
			p := h.project("timing", m.ID)
			h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
				reader, writer := io.Pipe()
				go func() {
					defer writer.Close()
					thinking := `{"choices":[{"delta":{"reasoning_content":"thinking"}}]}`
					text := `{"choices":[{"delta":{"content":"hello"}}]}`
					end := "[DONE]"
					if protocol == "messages" {
						thinking = `{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"thinking"}}`
						text = `{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}`
						end = `{"type":"message_stop"}`
					}
					io.WriteString(writer, "data: "+thinking+"\n\n")
					time.Sleep(60 * time.Millisecond)
					io.WriteString(writer, "data: "+text+"\n\ndata: "+end+"\n\n")
				}()
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader}, nil
			})
			path := "/v1/chat/completions"
			if protocol == "messages" {
				path = "/v1/messages"
			}
			h.want(h.request("POST", path, map[string]any{"model": m.Alias, "messages": []any{}, "stream": true}, p.Token, false), 200)
			rec := h.records(1)[0]
			if rec.TimingVersion != 1 || rec.FirstToken == nil || rec.FirstText == nil || *rec.FirstText-*rec.FirstToken < 40 || rec.State != "complete" {
				t.Fatalf("timing order not preserved: %+v", rec)
			}
			detail := parse[Record](t, h.request("GET", "/api/admin/requests/"+rec.ID, nil, "", true))
			if detail.FirstToken == nil || *detail.FirstToken != *rec.FirstToken || detail.TimingVersion != 1 {
				t.Fatal("detail and summary timing differ")
			}
		})
	}
}

func TestLegacyRecordHasNoFirstTokenMeasurement(t *testing.T) {
	var rec Record
	if err := json.Unmarshal([]byte(`{"id":"old","first_text_ms":25123}`), &rec); err != nil {
		t.Fatal(err)
	}
	if rec.FirstToken != nil || rec.TimingVersion != 0 || rec.FirstText == nil || *rec.FirstText != 25123 {
		t.Fatal("legacy record must retain text timing without inventing token timing")
	}
}
