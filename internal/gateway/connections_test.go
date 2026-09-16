package gateway

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestConnectionProvidersForwardBothProtocols(t *testing.T) {
	for _, provider := range []string{"zhipu", "minimax", "custom"} {
		for _, protocol := range []string{"chat", "messages"} {
			t.Run(provider+"/"+protocol, func(t *testing.T) {
				h := newHarness(t)
				const secret = "fake-custom-connection-key"
				created := h.request("POST", "/api/admin/connections", Connection{
					Name: "兼容服务", Provider: provider, Protocol: protocol,
					BaseURL: "https://compatible.test/custom/v1/", Token: secret, Enabled: true,
				}, "", true)
				h.want(created, 200)
				c := parse[Connection](t, created)
				if c.Token != "" || !c.HasToken || c.BaseURL != "https://compatible.test/custom/v1" {
					t.Fatal("connection response should hide the key and normalize the endpoint")
				}
				m := h.model(c, "compatible")
				p := h.project("兼容服务项目", m.ID)
				// Editing without a token must preserve the encrypted credential.
				c.Name = "编辑后的连接"
				h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
				state := h.request("GET", "/api/admin/state", nil, "", true)
				h.want(state, 200)
				if strings.Contains(state.Body.String(), secret) || !strings.Contains(state.Body.String(), c.Name) {
					t.Fatal("saved configuration missing or credential exposed")
				}
				path, wrongPath := "/chat/completions", "/messages"
				jsonBody := `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}`
				sseBody := "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"
				if protocol == "messages" {
					path, wrongPath = wrongPath, path
					jsonBody = `{"type":"message","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":2,"output_tokens":1}}`
					sseBody = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
				}
				calls := 0
				h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
					calls++
					if r.URL.String() != c.BaseURL+path || r.Header.Get("Authorization") != "Bearer "+secret {
						t.Error("incorrect endpoint or lost credential after editing")
					}
					if protocol == "messages" && (r.Header.Get("x-api-key") != secret || r.Header.Get("anthropic-version") != "2023-06-01") {
						t.Error("missing Messages headers")
					}
					if protocol == "chat" && r.Header.Get("x-api-key") != "" {
						t.Error("Chat request received Messages authentication")
					}
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					if body["model"] != m.UpstreamModel || body["messages"] == nil {
						t.Error("model mapping or input missing")
					}
					if body["stream"] == true {
						return response(sseBody, "text/event-stream", 200), nil
					}
					return response(jsonBody, "application/json", 200), nil
				})
				for _, stream := range []bool{false, true} {
					body := map[string]any{"model": m.Alias, "messages": []any{map[string]string{"role": "user", "content": "hello"}}, "stream": stream}
					rr := h.request("POST", "/v1"+path, body, p.Token, false)
					h.want(rr, 200)
					want := jsonBody
					if stream {
						want = sseBody
					}
					if rr.Body.String() != want {
						t.Fatal("upstream response was changed")
					}
					h.want(h.request("POST", "/v1"+wrongPath, body, p.Token, false), 400)
				}
				if calls != 2 {
					t.Fatal("a mismatched protocol reached the upstream")
				}
			})
		}
	}
}

func TestExistingConnectionCanChangeProtocolAndBecomeCustom(t *testing.T) {
	h := newHarness(t)
	const secret = "fake-existing-zhipu-key"
	c := h.connection("https://compatible.test/v1", "chat", secret)
	m := h.model(c, "existing")
	p := h.project("原项目", m.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://compatible.test/anthropic/v1/messages" || r.Header.Get("x-api-key") != secret {
			t.Error("protocol change lost endpoint or original key")
		}
		return response(`{"type":"message","content":[{"type":"text","text":"ok"}]}`, "application/json", 200), nil
	})
	c.Protocol, c.BaseURL = "messages", "https://compatible.test/anthropic/v1"
	for _, provider := range []string{"zhipu", "custom"} {
		c.Provider = provider
		h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
		h.want(h.request("POST", "/v1/messages", map[string]any{"model": m.Alias, "messages": []any{map[string]string{"role": "user", "content": "hello"}}}, p.Token, false), 200)
	}
}

func TestCustomConnectionValidation(t *testing.T) {
	h := newHarness(t)
	for _, tc := range []struct {
		name, provider, protocol, endpoint, token string
		status                                    int
	}{
		{"localhost", "custom", "chat", "http://localhost:9999/v1", "fake-key", 200},
		{"loopback", "custom", "messages", "http://127.0.0.1:9999/v1", "fake-key", 200},
		{"remote HTTP", "custom", "chat", "http://remote.test/v1", "fake-key", 400},
		{"URL credential", "custom", "chat", "https://user:pass@remote.test/v1", "fake-key", 400},
		{"query", "custom", "chat", "https://remote.test/v1?key=fake", "fake-key", 400},
		{"missing endpoint", "custom", "chat", "", "fake-key", 400},
		{"missing key", "custom", "messages", "https://remote.test/v1", "", 400},
		{"unknown protocol", "custom", "responses", "https://remote.test/v1", "fake-key", 400},
		{"unknown provider", "other", "chat", "https://remote.test/v1", "fake-key", 400},
		{"demo Messages", "demo", "messages", "demo://local", "", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := h.request("POST", "/api/admin/connections", Connection{Name: tc.name, Provider: tc.provider, Protocol: tc.protocol, BaseURL: tc.endpoint, Token: tc.token, Enabled: true}, "", true)
			if rr.Code != tc.status {
				t.Fatalf("status=%d wanted=%d: %s", rr.Code, tc.status, rr.Body.String())
			}
		})
	}
}
