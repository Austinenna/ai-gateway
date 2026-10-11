package gateway

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func keepAdminSessionWhileLocked(h *harness) {
	h.t.Helper()
	h.g.mu.Lock()
	h.g.sessions[digest(h.cookie.Value)] = session{Expires: time.Now().Add(time.Hour)}
	h.g.mu.Unlock()
}

func TestLockedRequestPersistsStructuredDiagnostic(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-diagnostic-key")
	m := h.model(c, "diagnostic-model")
	p := h.project("diagnostic-project", m.ID)
	h.g.clearMaster()
	keepAdminSessionWhileLocked(h)

	rr := h.call(m.Alias, p.Token, nil)
	h.want(rr, 503)
	var responseBody struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &responseBody); err != nil {
		t.Fatal(err)
	}
	if responseBody.Error.Type != "gateway_error" || responseBody.Error.Message != "网关已锁定，请在管理页面解锁" {
		t.Fatalf("unexpected downstream error: %+v", responseBody.Error)
	}

	list := h.records(1)
	if list[0].Diagnostic == nil || list[0].Diagnostic.Code != "gateway_locked" || list[0].Diagnostic.Message != responseBody.Error.Message {
		t.Fatalf("structured diagnostic was not persisted: %+v", list[0].Diagnostic)
	}
	if list[0].Diagnostic.UpstreamContacted || !list[0].Diagnostic.Retryable || list[0].Diagnostic.RecommendedAction != "admin_login" {
		t.Fatalf("incorrect locked diagnostic metadata: %+v", list[0].Diagnostic)
	}

	detail := parse[Record](t, h.request("GET", "/api/admin/requests/"+list[0].ID, nil, "", true))
	if detail.Diagnostic == nil || detail.Diagnostic.Code != "gateway_locked" {
		t.Fatalf("detail lost diagnostic: %+v", detail.Diagnostic)
	}
}

func TestDiagnosticsAggregatesRepeatedFailures(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-diagnostic-group-key")
	m := h.model(c, "diagnostic-group-model")
	p := h.project("diagnostic-group-project", m.ID)
	h.g.clearMaster()
	keepAdminSessionWhileLocked(h)
	h.want(h.call(m.Alias, p.Token, nil), 503)
	h.want(h.call(m.Alias, p.Token, nil), 503)
	h.records(2)

	rr := h.request("GET", "/api/admin/diagnostics?window=all", nil, "", true)
	h.want(rr, 200)
	var result diagnosticsResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Summary.Failed != 2 || result.Summary.Groups != 1 || len(result.Groups) != 1 {
		t.Fatalf("wrong diagnostics summary: %+v groups=%+v", result.Summary, result.Groups)
	}
	group := result.Groups[0]
	if group.Code != "gateway_locked" || group.Count != 2 || group.Status != 503 || group.ExampleID == "" {
		t.Fatalf("wrong diagnostic group: %+v", group)
	}
	if result.Runtime["locked"] != true {
		t.Fatalf("runtime lock state missing: %+v", result.Runtime)
	}
	if len(result.Recent) != 2 || result.Recent[0].Diagnostic == nil {
		t.Fatalf("recent diagnostic records missing: %+v", result.Recent)
	}
	h.want(h.request("GET", "/api/admin/diagnostics", nil, p.Token, false), 401)
}

func TestUpstreamFailurePersistsContactAndRetryDiagnostic(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-upstream-diagnostic-key")
	m := h.model(c, "upstream-diagnostic-model")
	p := h.project("upstream-diagnostic-project", m.ID)
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		return response(`{"error":{"type":"rate_limit_error"}}`, "application/json", 429), nil
	})

	h.want(h.call(m.Alias, p.Token, nil), 429)
	list := h.records(1)
	diagnostic := list[0].Diagnostic
	if diagnostic == nil || diagnostic.Code != "upstream_rate_limit" || diagnostic.UpstreamContacted != true || !diagnostic.Retryable {
		t.Fatalf("incorrect upstream diagnostic: %+v", diagnostic)
	}
	if diagnostic.Message != "上游返回 HTTP 429，可能触发限流" || diagnostic.RecommendedAction != "retry_later" {
		t.Fatalf("incorrect upstream diagnostic message/action: %+v", diagnostic)
	}
}
