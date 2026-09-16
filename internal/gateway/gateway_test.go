package gateway

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testPassword = "only-a-test-password-2026"

type harness struct {
	t       *testing.T
	g       *Gateway
	handler http.Handler
	cookie  *http.Cookie
	dir     string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	g, e := Open(dir, "http://gateway.test", true)
	if e != nil {
		t.Fatal(e)
	}
	h := &harness{t: t, g: g, handler: g.Handler(nil), dir: dir}
	rr := h.request("POST", "/api/setup", map[string]any{"password": testPassword}, "", false)
	h.want(rr, 200)
	cookies := rr.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe admin cookie")
	}
	h.cookie = cookies[0]
	t.Cleanup(func() {
		if h.g != nil {
			h.g.Close()
		}
	})
	return h
}
func (h *harness) request(method, path string, body any, token string, admin bool) *httptest.ResponseRecorder {
	h.t.Helper()
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, "http://gateway.test"+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gateway-Admin", "1")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if admin && h.cookie != nil {
		req.AddCookie(h.cookie)
	}
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, req)
	return rr
}
func (h *harness) want(rr *httptest.ResponseRecorder, status int) {
	h.t.Helper()
	if rr.Code != status {
		h.t.Fatalf("status=%d wanted=%d: %s", rr.Code, status, rr.Body.String())
	}
}
func parse[T any](t *testing.T, rr *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if e := json.Unmarshal(rr.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func (h *harness) connection(base, protocol, secret string) Connection {
	h.t.Helper()
	provider := "zhipu"
	if protocol == "messages" {
		provider = "minimax"
	}
	rr := h.request("POST", "/api/admin/connections", Connection{Name: "测试连接", Provider: provider, Protocol: protocol, BaseURL: base, Token: secret, Enabled: true}, "", true)
	h.want(rr, 200)
	return parse[Connection](h.t, rr)
}
func (h *harness) model(c Connection, alias string) Model {
	h.t.Helper()
	rr := h.request("POST", "/api/admin/models", Model{Name: alias, Alias: alias, ConnectionID: c.ID, UpstreamModel: "upstream-test-model", Defaults: map[string]json.RawMessage{"temperature": json.RawMessage("0.7")}, Enabled: true}, "", true)
	h.want(rr, 200)
	return parse[Model](h.t, rr)
}

type projectCreated struct {
	Project Project `json:"project"`
	Token   string  `json:"token"`
}

func (h *harness) project(name string, models ...string) projectCreated {
	h.t.Helper()
	rr := h.request("POST", "/api/admin/projects", Project{Name: name, Enabled: true, ModelIDs: models}, "", true)
	h.want(rr, 200)
	return parse[projectCreated](h.t, rr)
}
func (h *harness) call(alias, token string, extra map[string]any) *httptest.ResponseRecorder {
	b := map[string]any{"model": alias, "messages": []any{map[string]string{"role": "user", "content": "hello"}}}
	for k, v := range extra {
		b[k] = v
	}
	return h.request("POST", "/v1/chat/completions", b, token, false)
}

type doerFunc func(*http.Request) (*http.Response, error)

func (f doerFunc) Do(r *http.Request) (*http.Response, error) { return f(r) }
func response(body, contentType string, status int) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(body))}
}
func (h *harness) records(n int) []Record {
	h.t.Helper()
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		rr := h.request("GET", "/api/admin/requests", nil, "", true)
		h.want(rr, 200)
		list := parse[[]Record](h.t, rr)
		if len(list) >= n {
			return list
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatal("request log not persisted")
	return nil
}

func TestProjectAuthorizationAndCredentialSeparation(t *testing.T) {
	h := newHarness(t)
	secret := "fake-vendor-secret-not-a-real-key"
	c := h.connection("https://upstream.test/v1", "chat", secret)
	a := h.model(c, "coding")
	b := h.model(c, "writing")
	pa := h.project("A", a.ID)
	pb := h.project("B", b.ID)
	var forwarded atomic.Int32
	var upstreamBody map[string]any
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		forwarded.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Error("wrong upstream credential")
		}
		if r.Header.Get("Cookie") != "" {
			t.Error("admin cookie leaked")
		}
		_ = json.NewDecoder(r.Body).Decode(&upstreamBody)
		return response(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`, "application/json", 200), nil
	})
	h.want(h.call(b.Alias, pa.Token, map[string]any{"project_id": pb.Project.ID}), 403)
	if forwarded.Load() != 0 {
		t.Fatal("unauthorized request reached upstream")
	}
	h.want(h.call(a.Alias, pa.Token, map[string]any{"project_id": pb.Project.ID, "connection_id": c.ID, "temperature": 0, "tools": []any{map[string]any{"type": "function", "function": map[string]string{"name": "read_file"}}}}), 200)
	if upstreamBody["model"] != "upstream-test-model" || upstreamBody["temperature"] != float64(0) || upstreamBody["project_id"] != nil || upstreamBody["connection_id"] != nil || upstreamBody["tools"] == nil {
		t.Fatal("routing, defaults, or tool passthrough failed")
	}
	logs := h.records(2) // The preceding authorization rejection is now recorded too.
	if logs[0].ProjectID != pa.Project.ID || logs[0].InputTokens != 3 {
		t.Fatal("log ownership or usage incorrect")
	}
	listed := h.request("GET", "/v1/models", nil, pa.Token, false)
	h.want(listed, 200)
	if strings.Contains(listed.Body.String(), b.Alias) || !strings.Contains(listed.Body.String(), a.Alias) {
		t.Fatal("model list leaked unauthorized model")
	}
	for _, path := range []string{"/api/admin/state", "/api/admin/requests", "/api/admin/requests/" + logs[0].ID} {
		h.want(h.request("GET", path, nil, pa.Token, false), 401)
	}
	h.want(h.request("POST", "/api/admin/connections/"+c.ID+"/reveal", map[string]string{"password": testPassword}, pa.Token, false), 401)
	h.want(h.request("POST", "/api/admin/models", a, pa.Token, false), 401)
	if strings.Contains(h.request("GET", "/api/admin/state", nil, "", true).Body.String(), secret) {
		t.Fatal("admin list exposed plaintext credential")
	}
}

func TestProjectRevocationDisableAndDefaultDeny(t *testing.T) {
	h := newHarness(t)
	rr := h.request("POST", "/api/admin/demo", map[string]any{}, "", true)
	h.want(rr, 200)
	demo := parse[map[string]string](t, rr)
	models, _ := h.g.models()
	m := models[0]
	empty := h.project("empty")
	h.want(h.call(m.Alias, empty.Token, nil), 403)
	rotated := h.request("POST", "/api/admin/projects/"+demo["project_id"]+"/rotate", map[string]any{}, "", true)
	h.want(rotated, 200)
	token := parse[map[string]string](t, rotated)["token"]
	h.want(h.call(m.Alias, demo["token"], nil), 401)
	h.want(h.call(m.Alias, token, nil), 200)
	m.Name = "只改显示名称"
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	h.want(h.call(m.Alias, token, nil), 200)
	old := m.Alias
	m.Alias = "new-alias"
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	h.want(h.call(old, token, nil), 403)
	h.want(h.call(m.Alias, token, nil), 200)
	p := Project{ID: demo["project_id"], Name: "Demo", Enabled: false, ModelIDs: []string{m.ID}}
	h.want(h.request("PUT", "/api/admin/projects/"+p.ID, p, "", true), 200)
	h.want(h.call(m.Alias, token, nil), 401)
	p.Enabled = true
	p.ModelIDs = nil
	h.want(h.request("PUT", "/api/admin/projects/"+p.ID, p, "", true), 200)
	h.want(h.call(m.Alias, token, nil), 403)
}

func TestEncryptedPersistenceRestartAndLock(t *testing.T) {
	h := newHarness(t)
	secret := "fake-vendor-secret-for-storage"
	c := h.connection("https://upstream.test/v1", "chat", secret)
	m := h.model(c, "persist")
	p := h.project("persistent", m.ID)
	c.Name = "编辑但保留凭据"
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	reveal := h.request("POST", "/api/admin/connections/"+c.ID+"/reveal", map[string]string{"password": testPassword}, "", true)
	h.want(reveal, 200)
	if parse[map[string]string](t, reveal)["token"] != secret {
		t.Fatal("blank update erased secret")
	}
	h.want(h.request("POST", "/api/admin/connections/"+c.ID+"/reveal", map[string]string{"password": "wrong"}, "", true), 401)
	h.g.Close()
	h.g = nil
	raw, e := os.ReadFile(filepath.Join(h.dir, "gateway.db"))
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range []string{secret, p.Token, testPassword} {
		if bytes.Contains(raw, []byte(v)) {
			t.Fatal("plaintext secret found in database")
		}
	}
	h.g, e = Open(h.dir, "http://gateway.test", true)
	if e != nil {
		t.Fatal(e)
	}
	h.handler = h.g.Handler(nil)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Fatal("restored secret mismatch")
		}
		return response(`{"choices":[{"message":{"content":"restored"}}]}`, "application/json", 200), nil
	})
	h.want(h.call(m.Alias, p.Token, nil), 503)
	h.want(h.request("POST", "/api/login", map[string]string{"password": "wrong"}, "", false), 401)
	login := h.request("POST", "/api/login", map[string]string{"password": testPassword}, "", false)
	h.want(login, 200)
	h.cookie = login.Result().Cookies()[0]
	h.want(h.call(m.Alias, p.Token, nil), 200)
	h.want(h.request("POST", "/api/admin/lock", map[string]any{}, "", true), 200)
	h.want(h.request("GET", "/api/admin/state", nil, "", true), 401)
	h.want(h.call(m.Alias, p.Token, nil), 503)
}

func TestAdminOriginAndCSRF(t *testing.T) {
	h := newHarness(t)
	for _, tc := range []struct{ host, origin, header string }{{"gateway.test", "https://evil.test", "1"}, {"evil.test", "", "1"}, {"gateway.test", "", ""}} {
		r := httptest.NewRequest("POST", "http://"+tc.host+"/api/admin/lock", strings.NewReader("{}"))
		r.AddCookie(h.cookie)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-Gateway-Admin", tc.header)
		rr := httptest.NewRecorder()
		h.handler.ServeHTTP(rr, r)
		h.want(rr, 403)
	}
	h.want(h.request("POST", "/api/setup", map[string]string{"password": testPassword}, "", false), 409)
}

func TestMessagesProtocolPreservesContentAndRejectsWrongEndpoint(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/anthropic/v1", "messages", "fake-messages-secret")
	m := h.model(c, "messages-model")
	p := h.project("messages", m.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/anthropic/v1/messages" || r.Header.Get("x-api-key") != "fake-messages-secret" || r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Error("Messages route or auth mismatch")
		}
		var b map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&b)
		if !bytes.Contains(b["messages"], []byte(`"thinking"`)) || !bytes.Contains(b["messages"], []byte(`"tool_result"`)) {
			t.Error("required content blocks were lost")
		}
		return response(`{"type":"message","content":[{"type":"thinking","thinking":"test"},{"type":"tool_use","id":"t1","name":"read_file","input":{}}],"usage":{"input_tokens":9,"output_tokens":4}}`, "application/json", 200), nil
	})
	h.want(h.call(m.Alias, p.Token, nil), 400)
	body := map[string]any{"model": m.Alias, "messages": []any{map[string]any{"role": "assistant", "content": []any{map[string]string{"type": "thinking", "thinking": "keep"}}}, map[string]any{"role": "user", "content": []any{map[string]string{"type": "tool_result", "tool_use_id": "t1", "content": "file"}}}}}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "http://gateway.test/v1/messages", bytes.NewReader(b))
	req.Header.Set("x-api-key", p.Token)
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, req)
	h.want(rr, 200)
	if !strings.Contains(rr.Body.String(), `"type":"thinking"`) || !strings.Contains(rr.Body.String(), `"type":"tool_use"`) {
		t.Fatal("response blocks altered")
	}
}

func TestSSEImmediateForwardingAndCancellation(t *testing.T) {
	h := newHarness(t)
	upCanceled := make(chan struct{})
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			close(upCanceled)
		case <-release:
			io.WriteString(w, "data: [DONE]\n\n")
		}
	}))
	defer upstream.Close()
	defer close(release)
	c := h.connection(upstream.URL+"/v1", "chat", "fake-stream-secret")
	m := h.model(c, "stream")
	p := h.project("stream-project", m.ID)
	server := httptest.NewServer(h.handler)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/v1/chat/completions", strings.NewReader(`{"model":"stream","messages":[{"role":"user","content":"hi"}],"stream":true}`))
	req.Header.Set("Authorization", "Bearer "+p.Token)
	client := &http.Client{Timeout: 3 * time.Second}
	res, e := client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	reader := bufio.NewReader(res.Body)
	line, e := reader.ReadString('\n')
	if e != nil || !strings.Contains(line, "first") {
		t.Fatalf("first event not forwarded: %q %v", line, e)
	}
	cancel()
	res.Body.Close()
	select {
	case <-upCanceled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was not canceled")
	}
	logs := h.records(1)
	if logs[0].State != "canceled" || logs[0].FirstText == nil {
		t.Fatal("cancel state / TTFT incorrect", logs[0])
	}
}

func TestRedirectAndLogRedaction(t *testing.T) {
	h := newHarness(t)
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer upstream.Close()
	c := h.connection(upstream.URL+"/v1", "chat", "fake-redaction-secret")
	m := h.model(c, "redirect")
	p := h.project("redirect-project", m.ID)
	h.want(h.call(m.Alias, p.Token, nil), 502)
	if hits.Load() != 0 {
		t.Fatal("redirect leaked request")
	}
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		return response(`{"error":{"message":"fake-redaction-secret"}}`, "application/json", 401), nil
	})
	rr := h.call(m.Alias, p.Token, nil)
	h.want(rr, 401)
	if strings.Contains(rr.Body.String(), "fake-redaction-secret") {
		t.Fatal("upstream error exposed credential")
	}
	logs := h.records(2)
	for _, rec := range logs {
		detail := h.request("GET", "/api/admin/requests/"+rec.ID, nil, "", true)
		if strings.Contains(detail.Body.String(), "fake-redaction-secret") || strings.Contains(detail.Body.String(), p.Token) {
			t.Fatal("log exposed credentials")
		}
	}
}

func TestSSECompletionAndUsage(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-sse-secret")
	m := h.model(c, "sse")
	p := h.project("sse", m.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		return response("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"text\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n", "text/event-stream", 200), nil
	})
	rr := h.call(m.Alias, p.Token, map[string]any{"stream": true})
	h.want(rr, 200)
	if !rr.Flushed || !strings.Contains(rr.Body.String(), "reasoning_content") {
		t.Fatal("SSE was buffered or modified")
	}
	rec := h.records(1)[0]
	if rec.State != "complete" || rec.InputTokens != 7 || rec.OutputTokens != 5 || rec.FirstText == nil {
		t.Fatal("bad SSE metrics", rec)
	}
	text, _, _, _, _ := eventStats("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hidden\"}}]}\n\n", "chat")
	if text {
		t.Fatal("reasoning counted as visible first text")
	}
}

func TestConnectionDisableAndDuplicateAlias(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-disabled-secret")
	m := h.model(c, "unique")
	p := h.project("client", m.ID)
	duplicate := m
	duplicate.ID = ""
	h.want(h.request("POST", "/api/admin/models", duplicate, "", true), 409)
	c.Enabled = false
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	h.want(h.call(m.Alias, p.Token, nil), 403)
	rr := h.request("GET", "/v1/models", nil, p.Token, false)
	h.want(rr, 200)
	if strings.Contains(rr.Body.String(), "unique") {
		t.Fatal("disabled connection model still listed")
	}
	c.BaseURL = "http://remote.test/v1"
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 400)
}

func TestMigrateV1RequestSummary(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,started INTEGER NOT NULL,record TEXT NOT NULL); PRAGMA user_version=1;`)
	if err != nil {
		t.Fatal(err)
	}
	record := Record{ID: "req_old", ProjectID: "old", Started: 1, Input: "private input", Output: "private output"}
	b, _ := json.Marshal(record)
	_, err = db.Exec("INSERT INTO requests VALUES(?,?,?,?)", record.ID, record.ProjectID, record.Started, string(b))
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	g, err := Open(dir, "http://gateway.test", true)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	var summary, original string
	if err = g.db.QueryRow("SELECT summary,record FROM requests WHERE id='req_old'").Scan(&summary, &original); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(summary, "private") || !strings.Contains(original, "private input") {
		t.Fatal("migration leaked content into summary or lost original data")
	}
	var version int
	_ = g.db.QueryRow("PRAGMA user_version").Scan(&version)
	if version != 4 {
		t.Fatal("migration version not updated")
	}
}
