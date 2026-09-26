package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestContextWindowPersistenceAndDiscovery(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://mock.test/v1", "chat", "fake-context-key")
	m := h.model(c, "long-context")
	m.ContextWindow = 1048576
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	other := h.model(c, "not-authorized")
	p := h.project("context client", m.ID)
	restartHarness(t, h)
	models, err := h.g.models()
	if err != nil || !reflect.DeepEqual(models[0], m) {
		t.Fatalf("model capacity/defaults did not persist: %v", err)
	}
	for _, path := range []string{"/v1/models", "/api/public/models"} {
		rr := h.request("GET", path, nil, p.Token, false)
		h.want(rr, 200)
		catalog := parse[struct {
			Data []map[string]any `json:"data"`
		}](t, rr)
		found := false
		for _, item := range catalog.Data {
			if item["id"] == m.Alias {
				found = true
				if item["context_window"] != float64(m.ContextWindow) {
					t.Fatal("missing configured context window")
				}
			} else if item["id"] == other.Alias {
				if path == "/v1/models" {
					t.Fatal("project catalog leaked unauthorized model")
				}
				if _, exists := item["context_window"]; exists {
					t.Fatal("unspecified capacity must be omitted")
				}
			}
			for _, key := range []string{"connection_id", "upstream_model", "defaults", "token"} {
				if _, exists := item[key]; exists {
					t.Fatalf("private catalog field %s", key)
				}
			}
		}
		if !found {
			t.Fatal("configured model missing from catalog")
		}
	}
	// Older management clients can edit a name without clearing capacity.
	raw, _ := json.Marshal(m)
	var legacy map[string]any
	json.Unmarshal(raw, &legacy)
	delete(legacy, "context_window")
	legacy["name"] = "renamed"
	rr := h.request("PUT", "/api/admin/models/"+m.ID, legacy, "", true)
	h.want(rr, 200)
	if parse[Model](t, rr).ContextWindow != m.ContextWindow {
		t.Fatal("legacy edit cleared capacity")
	}
	legacy["upstream_model"] = "different-model"
	rr = h.request("PUT", "/api/admin/models/"+m.ID, legacy, "", true)
	h.want(rr, 200)
	if parse[Model](t, rr).ContextWindow != 0 {
		t.Fatal("capacity inherited by different upstream")
	}
	// Explicit zero clears a configured value, including from discovery.
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	m.ContextWindow = 0
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	if strings.Contains(h.request("GET", "/v1/models", nil, p.Token, false).Body.String(), "context_window") {
		t.Fatal("cleared capacity still advertised")
	}
}

func TestContextWindowValidationAndASR(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://mock.test/v1", "chat", "fake-context-validation")
	m := h.model(c, "validate-capacity")
	raw, _ := json.Marshal(m)
	var body map[string]any
	json.Unmarshal(raw, &body)
	for _, value := range []any{-1, 1.5, "1000000", int64(maxContextWindow) + 1} {
		body["context_window"] = value
		h.want(h.request("PUT", "/api/admin/models/"+m.ID, body, "", true), 400)
	}
	for _, value := range []int{0, 204800, 1000000, 1048576} {
		body["context_window"] = value
		h.want(h.request("PUT", "/api/admin/models/"+m.ID, body, "", true), 200)
	}
	rr := h.request("POST", "/api/admin/connections", Connection{Name: "ASR", Provider: "dashscope", Endpoints: map[string]string{"dashscope-asr": "https://mock.test/api/v1"}, Token: "fake-asr-context", Enabled: true}, "", true)
	h.want(rr, 200)
	asr := h.model(parse[Connection](t, rr), "asr-capacity")
	asr.ContextWindow = 1000000
	rr = h.request("PUT", "/api/admin/models/"+asr.ID, asr, "", true)
	h.want(rr, 200)
	if parse[Model](t, rr).ContextWindow != 0 {
		t.Fatal("ASR must not advertise a text window")
	}
}

func TestContextWindowV7Migration(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://mock.test/v1", "chat", "fake-context-migration")
	m := h.model(c, "existing-model")
	p := h.project("existing-project", m.ID)
	if _, err := h.g.db.Exec("ALTER TABLE models DROP COLUMN context_window; PRAGMA user_version=7;"); err != nil {
		t.Fatal(err)
	}
	restartHarness(t, h)
	models, err := h.g.models()
	if err != nil || len(models) != 1 || !reflect.DeepEqual(models[0], m) {
		t.Fatalf("migration lost model: %v", err)
	}
	h.want(h.request("GET", "/v1/models", nil, p.Token, false), 200)
	m.ContextWindow = 1000000
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	restartHarness(t, h)
	models, err = h.g.models()
	if err != nil || models[0].ContextWindow != 1000000 {
		t.Fatal("reopening reset migrated capacity")
	}
}

func TestLongContextForwardingPreservesContentAndOutputBudget(t *testing.T) {
	h := newHarness(t)
	rr := h.request("POST", "/api/admin/connections", Connection{Name: "long context", Provider: "custom", Endpoints: map[string]string{"chat": "https://mock.test/v1", "messages": "https://mock.test/anthropic/v1"}, Token: "fake-large-key", Enabled: true}, "", true)
	h.want(rr, 200)
	m := h.model(parse[Connection](t, rr), "large-request")
	m.ContextWindow = 1000000
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	p := h.project("long requests", m.ID)
	content := strings.Repeat("长上下文", 256*1024) // 3 MiB, beyond the old 2 MiB limit.
	var received map[string]json.RawMessage
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		return response(`{"ok":true}`, "application/json", 200), nil
	})
	for _, path := range []string{"/v1/chat/completions", "/v1/messages"} {
		for _, budget := range []int{0, 8192} {
			body := map[string]any{"model": m.Alias, "messages": []map[string]string{{"role": "user", "content": content}}}
			if budget > 0 {
				body["max_tokens"] = budget
			}
			h.want(h.request("POST", path, body, p.Token, false), 200)
			var messages []map[string]string
			json.Unmarshal(received["messages"], &messages)
			if len(messages) != 1 || messages[0]["content"] != content {
				t.Fatal("long input was truncated or changed")
			}
			if _, exists := received["context_window"]; exists {
				t.Fatal("capacity metadata reached upstream")
			}
			wantBudget := ""
			if budget > 0 {
				wantBudget = "8192"
			} else if path == "/v1/messages" {
				wantBudget = "1024"
			}
			if string(received["max_tokens"]) != wantBudget {
				t.Fatal("output budget changed")
			}
		}
	}
}

type spaceReader struct{}

func (spaceReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	return len(p), nil
}

func TestLLMRequestSizeBoundaries(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://mock.test/v1", "chat", "fake-request-limit")
	m := h.model(c, "limit-test")
	p := h.project("request limits", m.ID)
	calls := 0
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return response(`{"ok":true}`, "application/json", 200), nil
	})
	prefix := `{"model":"limit-test","messages":[{"role":"user","content":"hi"}]}`
	for _, tc := range []struct {
		path   string
		size   int64
		status int
	}{
		{"/v1/chat/completions", maxLLMRequestBytes, 200},
		{"/v1/chat/completions", maxLLMRequestBytes + 1, 413},
		{"/v1/messages", maxLLMRequestBytes + 1, 413},
		{"/v1/asr/transcriptions", maxASRRequestBytes + 1, 413},
	} {
		body := io.MultiReader(strings.NewReader(prefix), io.LimitReader(spaceReader{}, tc.size-int64(len(prefix))))
		req := httptest.NewRequest("POST", "http://gateway.test"+tc.path, body)
		req.Header.Set("Authorization", "Bearer "+p.Token)
		rr := httptest.NewRecorder()
		h.handler.ServeHTTP(rr, req)
		h.want(rr, tc.status)
	}
	if calls != 1 {
		t.Fatal("oversized input reached upstream")
	}
}
