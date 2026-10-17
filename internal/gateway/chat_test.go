package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminChatForwardingAndRecords(t *testing.T) {
	h := newHarness(t)
	c := parse[Connection](t, h.request("POST", "/api/admin/connections", Connection{
		Name: "对话测试连接", Provider: "minimax", Endpoints: map[string]string{"chat": "https://mock.test/v1", "messages": "https://mock.test/anthropic/v1"}, Token: "fake-chat-secret", Enabled: true,
	}, "", true))
	m := h.model(c, "debug-chat")
	m.UpstreamModel = "MiniMax-M3"
	m.Defaults = map[string]json.RawMessage{"temperature": json.RawMessage("0.7"), "max_tokens": json.RawMessage("256"), "reasoning_split": json.RawMessage("true"), "thinking": json.RawMessage(`{"type":"adaptive"}`)}
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	var calls int
	for _, protocol := range []string{"chat", "messages"} {
		for _, stream := range []bool{true, false} {
			t.Run(protocol+map[bool]string{true: "-stream", false: "-json"}[stream], func(t *testing.T) {
				h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
					calls++
					var payload map[string]any
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Fatal(err)
					}
					wantTemperature, wantMax := 0.7, float64(256)
					if !stream {
						wantTemperature, wantMax = 0, 17
					}
					if payload["model"] != "MiniMax-M3" || payload["temperature"] != wantTemperature || payload["max_tokens"] != wantMax || payload["stream"] != stream || payload["protocol"] != nil {
						t.Fatalf("wrong forwarding payload: %#v", payload)
					}
					if r.Header.Get("Authorization") != "Bearer fake-chat-secret" || r.Header.Get("Cookie") != "" {
						t.Fatal("credentials were not isolated")
					}
					messages := payload["messages"].([]any)
					if protocol == "chat" {
						if r.URL.Path != "/v1/chat/completions" || len(messages) != 4 || messages[0].(map[string]any)["role"] != "system" || payload["system"] != nil || payload["reasoning_split"] != true || payload["thinking"] != nil {
							t.Fatalf("wrong Chat request: %#v", payload)
						}
						messages = messages[1:]
					} else if r.URL.Path != "/anthropic/v1/messages" || len(messages) != 3 || payload["system"] != "只回复中文" || payload["reasoning_split"] != nil || payload["thinking"] == nil || r.Header.Get("anthropic-version") == "" {
						t.Fatalf("wrong Messages request: %#v", payload)
					}
					if messages[1].(map[string]any)["content"] != "之前的回答" || messages[2].(map[string]any)["content"] != "继续说明" {
						t.Fatal("conversation history was lost")
					}
					if protocol == "messages" {
						if stream {
							return response("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", "text/event-stream", 200), nil
						}
						return response(`{"content":[{"type":"text","text":"你好"}],"usage":{"input_tokens":8,"output_tokens":2},"stop_reason":"end_turn"}`, "application/json", 200), nil
					}
					if stream {
						return response("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", "text/event-stream", 200), nil
					}
					return response(`{"choices":[{"message":{"role":"assistant","content":"你好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}`, "application/json", 200), nil
				})
				in := map[string]any{"model": m.Alias, "protocol": protocol, "system": "只回复中文", "messages": []chatMessage{{"user", "你好"}, {"assistant", "之前的回答"}, {"user", "继续说明"}}}
				if !stream {
					in["stream"], in["temperature"], in["max_tokens"] = false, 0, 17
				}
				rr := h.request("POST", "/api/admin/chat", in, "", true)
				h.want(rr, 200)
				id := rr.Header().Get("X-Request-ID")
				if id == "" || !strings.Contains(rr.Body.String(), "你好") {
					t.Fatal("missing result or request ID")
				}
				h.records(calls)
				record := parse[Record](t, h.request("GET", "/api/admin/requests/"+id, nil, "", true))
				if record.ProjectID != "admin-chat" || record.ProjectName != "对话调试" || record.Alias != m.Alias || record.Protocol != protocol || record.State != "complete" || record.Stream == nil || *record.Stream != stream {
					t.Fatalf("wrong conversation record: %+v", record)
				}
				if !strings.Contains(record.Input, "之前的回答") || strings.Contains(record.Input+record.Output, "fake-chat-secret") {
					t.Fatal("record lost context or exposed credentials")
				}
			})
		}
	}
	state := parse[struct {
		Models []Model `json:"models"`
	}](t, h.request("GET", "/api/admin/state", nil, "", true))
	if len(state.Models) != 1 || string(state.Models[0].Defaults["temperature"]) != "0.7" || string(state.Models[0].Defaults["max_tokens"]) != "256" {
		t.Fatal("conversation overrides modified model defaults")
	}
}

func TestAdminChatValidationAndAuthorization(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://mock.test/v1", "chat", "fake-chat-key")
	m := h.model(c, "chat-guards")
	p := h.project("unprivileged", m.ID)
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid request reached upstream")
		return nil, nil
	})
	valid := map[string]any{"model": m.Alias, "protocol": "chat", "messages": []chatMessage{{"user", "hello"}}}
	h.want(h.request("POST", "/api/admin/chat", valid, "", false), 401)
	h.want(h.request("POST", "/api/admin/chat", valid, p.Token, false), 401)
	for _, test := range []struct {
		name, field string
		value       any
	}{
		{"asr", "protocol", "dashscope-asr"}, {"missing protocol", "protocol", ""}, {"disabled protocol", "protocol", "messages"},
		{"no model", "model", "missing"}, {"no messages", "messages", []any{}}, {"null messages", "messages", nil},
		{"system role", "messages", []chatMessage{{"system", "injected"}, {"user", "hi"}}},
		{"blank", "messages", []chatMessage{{"user", "  "}}}, {"assistant last", "messages", []chatMessage{{"user", "hi"}, {"assistant", "reply"}}},
		{"structured content", "messages", []any{map[string]any{"role": "user", "content": []any{map[string]string{"type": "text", "text": "hello"}}}}},
		{"temperature range", "temperature", 3}, {"temperature null", "temperature", nil},
		{"fractional tokens", "max_tokens", 1.5}, {"zero tokens", "max_tokens", 0}, {"tokens null", "max_tokens", nil},
		{"stream text", "stream", "true"}, {"stream null", "stream", nil}, {"routing override", "base_url", "https://other.test"},
	} {
		t.Run(test.name, func(t *testing.T) {
			in := map[string]any{}
			for k, v := range valid {
				in[k] = v
			}
			in[test.field] = test.value
			h.want(h.request("POST", "/api/admin/chat", in, "", true), 400)
		})
	}
	payload, _ := json.Marshal(valid)
	for _, kind := range []string{"cross-site", "missing-header"} {
		req := httptest.NewRequest("POST", "http://gateway.test/api/admin/chat", bytes.NewReader(payload))
		req.AddCookie(h.cookie)
		if kind == "cross-site" {
			req.Header.Set("X-Gateway-Admin", "1")
			req.Header.Set("Origin", "https://other.test")
		}
		rr := httptest.NewRecorder()
		h.handler.ServeHTTP(rr, req)
		h.want(rr, 403)
	}
	m.Enabled = false
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	h.want(h.request("POST", "/api/admin/chat", valid, "", true), 400)
	m.Enabled = true
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	c.Enabled = false
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	h.want(h.request("POST", "/api/admin/chat", valid, "", true), 400)
}

func TestAdminChatUpstreamFailureAndCancellation(t *testing.T) {
	h := newHarness(t)
	m := h.model(h.connection("https://mock.test/v1", "chat", "fake-chat-key"), "chat-errors")
	in := map[string]any{"model": m.Alias, "protocol": "chat", "messages": []chatMessage{{"user", "hi"}}}
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		return response(`{"error":{"message":"slow down"}}`, "application/json", 429), nil
	})
	rr := h.request("POST", "/api/admin/chat", in, "", true)
	h.want(rr, 429)
	if !strings.Contains(rr.Body.String(), "slow down") {
		t.Fatal("upstream error was lost")
	}
	h.records(1)
	record := parse[Record](t, h.request("GET", "/api/admin/requests/"+rr.Header().Get("X-Request-ID"), nil, "", true))
	if record.ErrorType != "rate_limit" {
		t.Fatalf("unexpected error record: %+v", record)
	}
	entered, finished := make(chan struct{}), make(chan struct{})
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	payload, _ := json.Marshal(in)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("POST", "http://gateway.test/api/admin/chat", io.NopCloser(bytes.NewReader(payload))).WithContext(ctx)
	req.AddCookie(h.cookie)
	req.Header.Set("X-Gateway-Admin", "1")
	canceled := httptest.NewRecorder()
	go func() { h.handler.ServeHTTP(canceled, req); close(finished) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not reach mock")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream cancellation did not propagate")
	}
	h.records(2)
	record = parse[Record](t, h.request("GET", "/api/admin/requests/"+canceled.Header().Get("X-Request-ID"), nil, "", true))
	if record.State != "canceled" || record.ProjectID != "admin-chat" {
		t.Fatalf("wrong canceled record: %+v", record)
	}
}
