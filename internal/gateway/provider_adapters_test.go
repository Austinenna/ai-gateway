package gateway

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func TestMinimaxAdaptationBoundaries(t *testing.T) {
	for _, thinking := range []string{`null`, `false`, `"enabled"`, `[]`, `{}`, `{"type":null}`, `{"type":"disabled","budget_tokens":8192}`, `{"type":"adaptive","budget_tokens":8192}`, `{"type":"unknown"}`} {
		t.Run(thinking, func(t *testing.T) {
			body := rawDefaults(t, `{"thinking":`+thinking+`}`)
			if changes := adaptProviderRequest(body, "minimax", "MiniMax-M3", "messages"); len(changes) != 0 || string(body["thinking"]) != thinking {
				t.Fatalf("unexpected rewrite: %s, %v", body["thinking"], changes)
			}
		})
	}
	body := rawDefaults(t, `{"thinking":{"type":"enabled","budget_tokens":8192,"display":"summarized"},"max_tokens":40192}`)
	changes := adaptProviderRequest(body, "minimax", "MiniMax-M3", "messages")
	if len(changes) != 1 || !reflect.DeepEqual(changes[0].RemovedFields, []string{"thinking.budget_tokens"}) {
		t.Fatalf("missing adaptation record: %v", changes)
	}
	if !reflect.DeepEqual(rawDefaults(t, string(body["thinking"])), rawDefaults(t, `{"type":"adaptive","display":"summarized"}`)) || string(body["max_tokens"]) != "40192" {
		t.Fatalf("unrelated parameters changed: %s", body)
	}
	if len(adaptProviderRequest(body, "minimax", "MiniMax-M3", "messages")) != 0 {
		t.Fatal("adaptation is not idempotent")
	}
}

func TestProviderAdaptationSharedProjectForwarding(t *testing.T) {
	h := newHarness(t)
	models := map[string]Model{}
	var modelIDs []string
	for _, route := range []struct{ provider, model, alias string }{
		{"minimax", "MiniMax-M3", "custom-reasoner"},
		{"minimax", "MiniMax-M2.7", "older-model"},
		{"zhipu", "glm-5", "MiniMax-M3"}, // The public alias must never select a vendor adapter.
		{"custom", "MiniMax-M3", "custom-upstream"},
	} {
		rr := h.request("POST", "/api/admin/connections", Connection{
			Name: route.alias, Provider: route.provider, Token: "fake-adapter-key", Enabled: true,
			Endpoints: map[string]string{"chat": "https://mock.test/v1", "messages": "https://mock.test/anthropic/v1"},
		}, "", true)
		h.want(rr, 200)
		c := parse[Connection](t, rr)
		m := h.model(c, route.alias)
		m.UpstreamModel = route.model
		m.Defaults = rawDefaults(t, `{"temperature":0.7,"max_tokens":1024}`)
		h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
		models[route.alias] = m
		modelIDs = append(modelIDs, m.ID)
	}
	p := h.project("one client, multiple vendors", modelIDs...)
	var captured map[string]any
	var returned string
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		captured = nil
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatal(err)
		}
		if captured["stream"] == true {
			returned = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"mock reasoning\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
			return response(returned, "text/event-stream", 200), nil
		}
		returned = `{"content":[{"type":"thinking","thinking":"mock reasoning"},{"type":"text","text":"ok"}]}`
		return response(returned, "application/json", 200), nil
	})
	seen := map[string]bool{}
	cases := []struct {
		alias, protocol, thinking string
		stream, adapted           bool
	}{
		{"custom-reasoner", "messages", `{"type":"enabled","budget_tokens":8192}`, false, true},
		{"custom-reasoner", "messages", `{"type":"enabled","budget_tokens":8192}`, true, true},
		{"custom-reasoner", "messages", `{"type":"enabled"}`, false, true},
		{"custom-reasoner", "messages", `{"type":"disabled"}`, false, false},
		{"custom-reasoner", "messages", `{"type":"adaptive"}`, false, false},
		{"custom-reasoner", "messages", `null`, false, false},
		{"custom-reasoner", "messages", ``, false, false},
		{"custom-reasoner", "chat", `{"type":"enabled","budget_tokens":8192}`, false, false},
		{"older-model", "messages", `{"type":"enabled","budget_tokens":8192}`, false, false},
		{"MiniMax-M3", "messages", `{"type":"enabled","budget_tokens":8192}`, false, false},
		{"custom-upstream", "messages", `{"type":"enabled","budget_tokens":8192}`, false, false},
	}
	for i, tc := range cases {
		t.Run(tc.alias+"/"+tc.protocol+"/"+tc.thinking, func(t *testing.T) {
			body := map[string]any{
				"model": tc.alias, "stream": tc.stream, "max_tokens": 40192,
				"messages": []any{map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "thinking", "thinking": "preserve history", "signature": "mock-signature"}}}, map[string]any{"role": "user", "content": "hello"}},
				"tools":    []any{map[string]any{"name": "lookup", "input_schema": map[string]any{"type": "object"}}},
			}
			if tc.thinking != "" {
				body["thinking"] = json.RawMessage(tc.thinking)
			}
			original, _ := json.Marshal(body)
			var want, wantInput map[string]any
			json.Unmarshal(original, &want)
			json.Unmarshal(original, &wantInput)
			want["model"] = models[tc.alias].UpstreamModel
			want["temperature"] = 0.7
			if tc.adapted {
				want["thinking"] = map[string]any{"type": "adaptive"}
			}
			path := "/v1/messages"
			if tc.protocol == "chat" {
				path = "/v1/chat/completions"
			}
			rr := h.request("POST", path, body, p.Token, false)
			h.want(rr, 200)
			if !reflect.DeepEqual(captured, want) {
				t.Fatalf("upstream payload mismatch: got %#v want %#v", captured, want)
			}
			if rr.Body.String() != returned {
				t.Fatal("upstream response was changed")
			}
			var summary Record
			for _, record := range h.records(i + 1) {
				if !seen[record.ID] {
					summary = record
					seen[record.ID] = true
				}
			}
			detail := h.request("GET", "/api/admin/requests/"+summary.ID, nil, "", true)
			h.want(detail, 200)
			record := parse[Record](t, detail)
			if (len(record.Adaptations) == 1) != tc.adapted || !reflect.DeepEqual(summary.Adaptations, record.Adaptations) {
				t.Fatalf("incorrect persisted adaptation: %#v", record.Adaptations)
			}
			var input map[string]any
			json.Unmarshal([]byte(record.Input), &input)
			if !reflect.DeepEqual(input, wantInput) || record.Output != returned || record.State != "complete" {
				t.Fatal("original request, response or completion state not preserved")
			}
		})
	}
}
