package gateway

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestSingleAliasRoutesBothProtocols(t *testing.T) {
	h := newHarness(t)
	const secret = "fake-dual-protocol-secret"
	created := h.request("POST", "/api/admin/connections", Connection{Name: "双协议连接", Provider: "custom", Endpoints: map[string]string{"chat": "https://chat.example.test/tenant/v1/", "messages": "https://messages.example.test/anthropic/v1/"}, Token: secret, Enabled: true}, "", true)
	h.want(created, 200)
	c := parse[Connection](t, created)
	m := h.model(c, "one-model")
	p := h.project("双协议项目", m.ID)
	if len(m.Protocols) != 2 || c.Protocol != "" || c.BaseURL != "" {
		t.Fatal("canonical configuration is not multi-protocol")
	}
	listed := h.request("GET", "/v1/models", nil, p.Token, false)
	h.want(listed, 200)
	if strings.Count(listed.Body.String(), `"id":"one-model"`) != 1 {
		t.Fatal("the model alias should only be listed once")
	}
	calls := 0
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Error("wrong shared upstream credential")
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if string(body["model"]) != `"upstream-test-model"` {
			t.Error("model alias was not mapped")
		}
		stream := string(body["stream"]) == "true"
		switch r.URL.String() {
		case "https://chat.example.test/tenant/v1/chat/completions":
			if r.Header.Get("x-api-key") != "" || !bytes.Contains(body["messages"], []byte(`"role":"system"`)) {
				t.Error("Chat request format/auth changed")
			}
			if stream {
				return response("data: {\"choices\":[{\"delta\":{\"content\":\"chat-ok\"}}]}\n\ndata: [DONE]\n\n", "text/event-stream", 200), nil
			}
			return response(`{"choices":[{"message":{"content":"chat-ok"}}]}`, "application/json", 200), nil
		case "https://messages.example.test/anthropic/v1/messages":
			if r.Header.Get("x-api-key") != secret || r.Header.Get("anthropic-version") == "" || string(body["system"]) != `"messages-system"` {
				t.Error("Messages request format/auth changed")
			}
			if stream {
				return response("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"messages-ok\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", "text/event-stream", 200), nil
			}
			return response(`{"type":"message","content":[{"type":"text","text":"messages-ok"}]}`, "application/json", 200), nil
		default:
			t.Fatalf("unexpected upstream URL: %s", r.URL)
			return nil, nil
		}
	})
	bodies := map[string]map[string]any{
		"chat":     {"model": m.Alias, "messages": []any{map[string]string{"role": "system", "content": "chat-system"}, map[string]string{"role": "user", "content": "hello"}}},
		"messages": {"model": m.Alias, "system": "messages-system", "messages": []any{map[string]string{"role": "user", "content": "hello"}}},
	}
	paths := map[string]string{"chat": "/v1/chat/completions", "messages": "/v1/messages"}
	for _, protocol := range supportedProtocols {
		for _, stream := range []bool{false, true} {
			bodies[protocol]["stream"] = stream
			rr := h.request("POST", paths[protocol], bodies[protocol], p.Token, false)
			h.want(rr, 200)
			if !strings.Contains(rr.Body.String(), protocol+"-ok") {
				t.Fatal("wrong protocol response")
			}
		}
	}
	records := h.records(4)
	counts := map[string]int{}
	for _, record := range records {
		if record.Alias != m.Alias || record.ConnectionID != c.ID {
			t.Fatal("record attribution changed")
		}
		counts[record.Protocol]++
	}
	if counts["chat"] != 2 || counts["messages"] != 2 {
		t.Fatal("actual request protocol not recorded")
	}
	other := h.project("未授权项目")
	h.want(h.request("POST", paths["messages"], bodies["messages"], other.Token, false), 403)
	// A dual-protocol model test must name its protocol, never guess one.
	h.want(h.request("POST", "/api/admin/models/"+m.ID+"/test", map[string]string{"message": "hello"}, "", true), 400)
	// Restricting the model and removing an endpoint must never fall back or convert.
	m.Protocols = []string{"chat"}
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	h.want(h.request("POST", paths["messages"], bodies["messages"], p.Token, false), 400)
	delete(c.Endpoints, "chat")
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	h.want(h.request("POST", paths["chat"], bodies["chat"], p.Token, false), 400)
	listed = h.request("GET", "/v1/models", nil, p.Token, false)
	h.want(listed, 200)
	if strings.Contains(listed.Body.String(), m.Alias) {
		t.Fatal("model with no usable protocols should not be listed")
	}
	if calls != 4 {
		t.Fatal("a rejected request reached an upstream")
	}
}

func TestProtocolEndpointValidationAndModelTests(t *testing.T) {
	h := newHarness(t)
	for _, endpoints := range []map[string]string{{}, {"chat": ""}, {"chat": "https://upstream.test/v1", "messages": "http://remote.test/v1"}, {"responses": "https://upstream.test/v1"}} {
		h.want(h.request("POST", "/api/admin/connections", Connection{Name: "invalid", Provider: "custom", Endpoints: endpoints, Token: "fake-key", Enabled: true}, "", true), 400)
	}
	created := h.request("POST", "/api/admin/connections", Connection{Name: "dual", Provider: "custom", Endpoints: map[string]string{"chat": "https://upstream.test/v1", "messages": "https://upstream.test/anthropic/v1"}, Token: "fake-key", Enabled: true}, "", true)
	h.want(created, 200)
	c := parse[Connection](t, created)
	legacy := Connection{Name: "old-client", Provider: "custom", Protocol: "chat", BaseURL: "https://other.test/v1", Enabled: true}
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, legacy, "", true), 400)
	cs, err := h.g.connections()
	if err != nil || len(cs[0].Endpoints) != 2 {
		t.Fatal("legacy edit erased an endpoint")
	}
	m := h.model(c, "dual-test")
	for _, protocols := range [][]string{{}, {"chat", "chat"}, {"responses"}} {
		bad := m
		bad.Protocols = protocols
		h.want(h.request("PUT", "/api/admin/models/"+m.ID, bad, "", true), 400)
	}
	for _, protocol := range supportedProtocols {
		h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
			path := "/chat/completions"
			if protocol == "messages" {
				path = "/messages"
			}
			if r.URL.String() != c.Endpoints[protocol]+path {
				t.Error("model test selected the wrong protocol")
			}
			return response(`{"ok":true}`, "application/json", 200), nil
		})
		h.want(h.request("POST", "/api/admin/models/"+m.ID+"/test", map[string]string{"protocol": protocol}, "", true), 200)
	}
}

func TestMigrateV4ProtocolEndpointsPreservesCredentialsAndGrants(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://legacy.test/anthropic/v1", "messages", "fake-migration-key")
	m := h.model(c, "legacy-model")
	p := h.project("legacy-project", m.ID)
	var beforeKey, beforeProjectKey []byte
	if err := h.g.db.QueryRow("SELECT credential FROM connections WHERE id=?", c.ID).Scan(&beforeKey); err != nil {
		t.Fatal(err)
	}
	if err := h.g.db.QueryRow("SELECT credential FROM project_credentials WHERE project_id=?", p.Project.ID).Scan(&beforeProjectKey); err != nil {
		t.Fatal(err)
	}
	// Recreate the v4 schema using only this isolated database.
	if _, err := h.g.db.Exec(`UPDATE connections SET protocol='messages',base_url='https://legacy.test/anthropic/v1'; ALTER TABLE connections DROP COLUMN endpoints_json; ALTER TABLE models DROP COLUMN protocols_json; PRAGMA user_version=4;`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		restartHarness(t, h)
		var version int
		if err := h.g.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 5 {
			t.Fatal("schema version did not persist")
		}
		connections, err := h.g.connections()
		if err != nil {
			t.Fatal(err)
		}
		models, err := h.g.models()
		if err != nil {
			t.Fatal(err)
		}
		if len(connections) != 1 || connections[0].ID != c.ID || len(connections[0].Endpoints) != 1 || connections[0].Endpoints["messages"] != "https://legacy.test/anthropic/v1" {
			t.Fatal("legacy connection was not preserved")
		}
		if len(models) != 1 || models[0].ID != m.ID || len(models[0].Protocols) != 1 || models[0].Protocols[0] != "messages" {
			t.Fatal("legacy model changed protocols or identity")
		}
		var afterKey, afterProjectKey []byte
		_ = h.g.db.QueryRow("SELECT credential FROM connections WHERE id=?", c.ID).Scan(&afterKey)
		_ = h.g.db.QueryRow("SELECT credential FROM project_credentials WHERE project_id=?", p.Project.ID).Scan(&afterProjectKey)
		if !bytes.Equal(beforeKey, afterKey) || !bytes.Equal(beforeProjectKey, afterProjectKey) {
			t.Fatal("migration changed encrypted credentials")
		}
		h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
			if r.URL.String() != "https://legacy.test/anthropic/v1/messages" || r.Header.Get("x-api-key") != "fake-migration-key" {
				t.Error("legacy routing or credential changed")
			}
			return response(`{"type":"message","content":[{"type":"text","text":"ok"}]}`, "application/json", 200), nil
		})
		h.want(h.request("POST", "/v1/messages", map[string]any{"model": m.Alias, "messages": []any{}}, p.Token, false), 200)
		h.want(h.call(m.Alias, p.Token, nil), 400)
	}
}
