package gateway

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type applicationResult struct {
	Application ProjectApplication `json:"application"`
	Token       string             `json:"token"`
	BaseURL     string             `json:"base_url"`
	Endpoint    string             `json:"endpoint"`
	Model       string             `json:"model"`
}

func apply(h *harness, in applicationInput, receipt string) *httptest.ResponseRecorder {
	data, _ := json.Marshal(in)
	req := httptest.NewRequest("POST", "http://gateway.test/api/project-applications", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+receipt)
	req.Header.Set("X-Gateway-Enrollment", "1")
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, req)
	return rr
}
func fixtureApplication(h *harness, protocol string) (applicationInput, string, Model) {
	c := h.connection("https://upstream.test/v1", protocol, "fake-enrollment-vendor-key")
	m := h.model(c, "enrollment-model")
	return applicationInput{Name: "New project", Client: "Test client", Protocol: protocol, Models: []string{m.Alias}}, "gr_" + strings.Repeat("a", 43), m
}
func TestApplicationImmediateTokenAndApproval(t *testing.T) {
	for _, protocol := range []string{"chat", "messages"} {
		t.Run(protocol, func(t *testing.T) {
			h := newHarness(t)
			in, receipt, m := fixtureApplication(h, protocol)
			rr := apply(h, in, receipt)
			h.want(rr, 201)
			out := parse[applicationResult](t, rr)
			if out.Application.Status != "pending" || len(out.Token) != 46 || out.Model != m.Alias {
				t.Fatal("must issue pending credential immediately")
			}
			base, endpoint := h.g.applicationEndpoints(protocol)
			if out.BaseURL != base || out.Endpoint != endpoint {
				t.Fatal("wrong client endpoints")
			}
			h.want(h.request("GET", "/v1/models", nil, out.Token, false), 401)
			path := "/v1/chat/completions"
			if protocol == "messages" {
				path = "/v1/messages"
			}
			body := map[string]any{"model": m.Alias, "messages": []any{map[string]string{"role": "user", "content": "test"}}, "max_tokens": 1}
			h.want(h.request("POST", path, body, out.Token, false), 401)
			status := h.request("GET", "/api/project-access", nil, out.Token, false)
			h.want(status, 200)
			if !strings.Contains(status.Body.String(), `"status":"pending"`) || strings.Contains(status.Body.String(), out.Token) {
				t.Fatal("invalid pending status")
			}
			h.want(h.request("GET", "/api/admin/state", nil, out.Token, false), 401)
			decisionPath := "/api/admin/applications/" + out.Application.ID + "/decision"
			h.want(h.request("POST", decisionPath, map[string]string{"decision": "approve"}, out.Token, false), 401)
			h.want(h.request("PUT", "/api/admin/projects/"+out.Application.ProjectID, Project{Name: "bypass", Enabled: true, ModelIDs: []string{m.ID}}, "", true), 409)
			h.want(h.request("POST", "/api/admin/projects/"+out.Application.ProjectID+"/rotate", map[string]any{}, "", true), 409)
			state := h.request("GET", "/api/admin/state", nil, "", true)
			if strings.Contains(state.Body.String(), out.Token) || strings.Contains(state.Body.String(), receipt) {
				t.Fatal("state leaked credentials")
			}
			h.want(h.request("POST", decisionPath, map[string]string{"decision": "approve"}, "", true), 200)
			h.want(h.request("POST", decisionPath, map[string]string{"decision": "approve"}, "", true), 200)
			h.want(h.request("GET", "/v1/models", nil, out.Token, false), 200)
			if s := h.request("GET", "/api/project-access", nil, out.Token, false); !strings.Contains(s.Body.String(), `"status":"active"`) {
				t.Fatal("same token not active")
			}
			h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
				return response(`{"id":"test","choices":[{"message":{"content":"ok"}}]}`, "application/json", 200), nil
			})
			h.want(h.request("POST", path, body, out.Token, false), 200)
			h.want(h.request("POST", "/api/admin/projects", Project{Name: "forbidden", Enabled: true}, out.Token, false), 401)
			replay := apply(h, in, receipt)
			h.want(replay, 200)
			if again := parse[applicationResult](t, replay); again.Token != out.Token || again.Application.ProjectID != out.Application.ProjectID {
				t.Fatal("retry replaced token/project")
			}
			h.want(h.request("POST", "/api/admin/projects/"+out.Application.ProjectID+"/rotate", map[string]any{}, "", true), 200)
			h.want(apply(h, in, receipt), 410)
			h.want(h.request("GET", "/api/project-access", nil, out.Token, false), 401)
		})
	}
}
func TestApplicationRejectionDeletionAndIdempotency(t *testing.T) {
	h := newHarness(t)
	in, receipt, _ := fixtureApplication(h, "chat")
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 4)
	for range 4 {
		wg.Add(1)
		go func() { defer wg.Done(); results <- apply(h, in, receipt) }()
	}
	wg.Wait()
	close(results)
	var first applicationResult
	for rr := range results {
		if rr.Code != 200 && rr.Code != 201 {
			t.Fatalf("concurrent apply: %d", rr.Code)
		}
		out := parse[applicationResult](t, rr)
		if first.Token == "" {
			first = out
		}
		if first.Token != out.Token || first.Application.ID != out.Application.ID {
			t.Fatal("duplicate projects")
		}
	}
	in.Name = "Different"
	h.want(apply(h, in, receipt), 409)
	in.Name = "New project"
	decision := "/api/admin/applications/" + first.Application.ID + "/decision"
	h.want(h.request("POST", decision, map[string]string{"decision": "reject"}, "", true), 200)
	h.want(h.request("POST", decision, map[string]string{"decision": "approve"}, "", true), 409)
	h.want(h.request("GET", "/v1/models", nil, first.Token, false), 401)
	if status := h.request("GET", "/api/project-access", nil, first.Token, false); !strings.Contains(status.Body.String(), `"status":"rejected"`) {
		t.Fatal("rejection missing")
	}
	h.want(apply(h, in, receipt), 410)
	h.want(h.request("DELETE", "/api/admin/projects/"+first.Application.ProjectID, nil, "", true), 200)
	h.want(apply(h, in, receipt), 410)
	h.want(h.request("GET", "/api/project-access", nil, first.Token, false), 401)
	var count int
	_ = h.g.db.QueryRow("SELECT COUNT(*) FROM projects").Scan(&count)
	if count != 0 {
		t.Fatal("deleted project resurrected")
	}
}
func TestApplicationValidationAndChangedModels(t *testing.T) {
	h := newHarness(t)
	in, receipt, m := fixtureApplication(h, "chat")
	h.want(h.request("POST", "/api/project-applications", in, receipt, false), 403)
	h.want(apply(h, in, "gw_"+strings.Repeat("a", 43)), 400)
	raw, _ := json.Marshal(in)
	req := httptest.NewRequest("POST", "http://gateway.test/api/project-applications", bytes.NewReader(raw))
	req.Header.Set("Origin", "https://evil.test")
	req.Header.Set("X-Gateway-Enrollment", "1")
	req.Header.Set("Authorization", "Bearer "+receipt)
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, req)
	h.want(rr, 403)
	in.Protocol = "responses"
	h.want(apply(h, in, receipt), 400)
	in.Protocol = "messages"
	h.want(apply(h, in, receipt), 400)
	in.Protocol = "chat"
	in.Models = []string{"missing"}
	h.want(apply(h, in, receipt), 400)
	in.Models = nil
	rr = apply(h, in, receipt)
	h.want(rr, 201)
	out := parse[applicationResult](t, rr)
	if out.Model != m.Alias {
		t.Fatal("default must be one available chat model")
	}
	m.Enabled = false
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	h.want(h.request("POST", "/api/admin/applications/"+out.Application.ID+"/decision", map[string]string{"decision": "approve"}, "", true), 409)
	h.want(h.request("GET", "/v1/models", nil, out.Token, false), 401)
	_, err := h.g.db.Exec("UPDATE project_applications SET created=?", time.Now().Add(-25*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	h.want(apply(h, in, receipt), 410)
}
func TestApplicationMigrationAndRestart(t *testing.T) {
	h := newHarness(t)
	in, receipt, _ := fixtureApplication(h, "chat")
	// Exercise the real v5 upgrade while retaining existing projects/credentials.
	p := h.project("Existing")
	if _, err := h.g.db.Exec("DROP TABLE project_applications; PRAGMA user_version=5"); err != nil {
		t.Fatal(err)
	}
	if err := h.g.Close(); err != nil {
		t.Fatal(err)
	}
	h.g = nil
	g, err := Open(h.dir, "http://gateway.test", true)
	if err != nil {
		t.Fatal(err)
	}
	h.g = g
	h.handler = g.Handler(nil)
	h.want(h.request("POST", "/api/login", map[string]string{"password": testPassword}, "", false), 200)
	h.want(h.request("GET", "/v1/models", nil, p.Token, false), 200)
	rr := apply(h, in, receipt)
	h.want(rr, 201)
	out := parse[applicationResult](t, rr)
	g.Close()
	h.g = nil
	g, err = Open(h.dir, "http://gateway.test", true)
	if err != nil {
		t.Fatal(err)
	}
	h.g = g
	h.handler = g.Handler(nil)
	h.want(h.request("GET", "/api/project-access", nil, out.Token, false), 200)
	login := h.request("POST", "/api/login", map[string]string{"password": testPassword}, "", false)
	h.want(login, 200)
	h.cookie = login.Result().Cookies()[0]
	replay := apply(h, in, receipt)
	h.want(replay, 200)
	if parse[applicationResult](t, replay).Token != out.Token {
		t.Fatal("restart lost pending credential")
	}
	h.want(h.request("POST", "/api/admin/applications/"+out.Application.ID+"/decision", map[string]string{"decision": "approve"}, "", true), 200)
	h.want(h.request("GET", "/v1/models", nil, out.Token, false), 200)
	var version int
	_ = g.db.QueryRow("PRAGMA user_version").Scan(&version)
	if version != 7 {
		t.Fatal("migration version")
	}
}
