package gateway

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func rawDefaults(t *testing.T, value string) map[string]json.RawMessage {
	t.Helper()
	var body map[string]json.RawMessage
	if err := json.Unmarshal([]byte(value), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestModelDefaultsValidation(t *testing.T) {
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{`{}`, true},
		{`{"temperature":0,"max_tokens":131072,"reasoning_split":false,"thinking":{"type":"disabled"}}`, true},
		{`{"reasoning_split":true,"thinking":{"type":"adaptive"}}`, true},
		{`{"reasoning_split":"true"}`, false},
		{`{"reasoning_split":null}`, false},
		{`{"thinking":true}`, false},
		{`{"thinking":null}`, false},
		{`{"thinking":{}}`, false},
		{`{"thinking":{"type":"enabled"}}`, false},
		{`{"thinking":{"type":"adaptive","budget_tokens":1024}}`, false},
		{`{"thinking":{"type":"adaptive","extra":"value"}}`, false},
		{`{"temperature":null}`, false},
		{`{"temperature":2.1}`, false},
		{`{"max_tokens":1.5}`, false},
		{`{"max_tokens":0}`, false},
		{`{"api_key":"not-allowed"}`, false},
	} {
		t.Run(tc.body, func(t *testing.T) {
			if err := validateModelDefaults(rawDefaults(t, tc.body)); (err == nil) != tc.valid {
				t.Fatalf("valid=%v: %v", tc.valid, err)
			}
		})
	}
}

func TestModelDefaultsProviderAndProtocolScope(t *testing.T) {
	defaults := rawDefaults(t, `{"temperature":0.7,"max_tokens":64,"reasoning_split":true,"thinking":{"type":"adaptive"}}`)
	for _, provider := range []string{"minimax", "zhipu", "custom", "demo"} {
		for _, protocol := range []string{"chat", "messages"} {
			t.Run(provider+"/"+protocol, func(t *testing.T) {
				body := rawDefaults(t, `{"temperature":0}`)
				applyModelDefaults(body, defaults, provider, protocol)
				if string(body["temperature"]) != "0" || string(body["max_tokens"]) != "64" {
					t.Fatalf("shared defaults or caller priority changed: %s", body)
				}
				_, split := body["reasoning_split"]
				_, thinking := body["thinking"]
				if split != (provider == "minimax" && protocol == "chat") || thinking != (provider == "minimax" && protocol == "messages") {
					t.Fatalf("protocol/provider defaults leaked: %s", body)
				}
				// Explicit values (including null and cross-protocol fields) remain caller-owned.
				for _, original := range []string{`{"reasoning_split":false,"thinking":{"type":"disabled"}}`, `{"reasoning_split":null,"thinking":null}`} {
					body = rawDefaults(t, original)
					applyModelDefaults(body, defaults, provider, protocol)
					for key, value := range rawDefaults(t, original) {
						if string(body[key]) != string(value) {
							t.Fatalf("overrode caller %s", key)
						}
					}
				}
			})
		}
	}
}

func TestMiniMaxDefaultsSavedAndForwarded(t *testing.T) {
	h := newHarness(t)
	rr := h.request("POST", "/api/admin/connections", Connection{Name: "MiniMax mock", Provider: "minimax", Endpoints: map[string]string{"chat": "https://mock.test/v1", "messages": "https://mock.test/anthropic/v1"}, Token: "fake-defaults-key", Enabled: true}, "", true)
	h.want(rr, 200)
	c := parse[Connection](t, rr)
	m := h.model(c, "defaults-test")
	m.Defaults = rawDefaults(t, `{"temperature":0.7,"max_tokens":128,"reasoning_split":true,"thinking":{"type":"adaptive"}}`)
	rr = h.request("PUT", "/api/admin/models/"+m.ID, m, "", true)
	h.want(rr, 200)
	if !reflect.DeepEqual(parse[Model](t, rr).Defaults, m.Defaults) {
		t.Fatal("defaults did not roundtrip")
	}
	p := h.project("defaults test", m.ID)
	var captured map[string]any
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatal(err)
		}
		if captured["stream"] == true {
			if r.URL.Path == "/v1/chat/completions" {
				return response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\",\"index\":0}]}\n\n", "text/event-stream", 200), nil
			}
			return response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", "text/event-stream", 200), nil
		}
		return response(`{"content":[{"type":"text","text":"ok"}]}`, "application/json", 200), nil
	})
	for _, protocol := range []string{"chat", "messages"} {
		for _, stream := range []bool{false, true} {
			for _, override := range []bool{false, true} {
				body := map[string]any{"model": m.Alias, "messages": []any{map[string]string{"role": "user", "content": "hello"}}, "stream": stream}
				if override {
					body["reasoning_split"] = false
					body["thinking"] = map[string]any{"type": "disabled", "caller_field": "preserved"}
				}
				path := "/v1/chat/completions"
				if protocol == "messages" {
					path = "/v1/messages"
				}
				captured = nil
				h.want(h.request("POST", path, body, p.Token, false), 200)
				want := map[string]any{"model": m.UpstreamModel, "messages": []any{map[string]any{"role": "user", "content": "hello"}}, "stream": stream, "temperature": 0.7, "max_tokens": float64(128)}
				if override {
					want["reasoning_split"] = false
					want["thinking"] = body["thinking"]
				} else if protocol == "chat" {
					want["reasoning_split"] = true
				} else {
					want["thinking"] = map[string]any{"type": "adaptive"}
				}
				if !reflect.DeepEqual(captured, want) {
					t.Fatalf("%s stream=%v override=%v: got %#v want %#v", protocol, stream, override, captured, want)
				}
			}
		}
	}
	// An invalid update must not replace the persisted working configuration.
	m.Defaults["reasoning_split"] = json.RawMessage(`"true"`)
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 400)
	var persisted string
	if err := h.g.db.QueryRow("SELECT defaults_json FROM models WHERE id=?", m.ID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if string(rawDefaults(t, persisted)["reasoning_split"]) != "true" {
		t.Fatal("invalid update changed saved defaults")
	}
}
