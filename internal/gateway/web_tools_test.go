package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func webToolFixture(t *testing.T) (*harness, Connection, Model, Model) {
	t.Helper()
	h := newHarness(t)
	rr := h.request("POST", "/api/admin/connections", Connection{
		Name: "DeepSeek", Provider: "deepseek", Enabled: true, Token: "fake-deepseek-key",
		Endpoints: map[string]string{"chat": "https://api.deepseek.test", "deepseek-search": "https://api.deepseek.test/v1", "deepseek-fetch": "https://api.deepseek.test/v1"},
	}, "", true)
	h.want(rr, 200)
	c := parse[Connection](t, rr)
	chat := h.model(c, "deepseek-flash")
	rr = h.request("POST", "/api/admin/models", Model{
		Name: "联网搜索", Alias: "web-search", UpstreamModel: "deepseek-web-tools", ConnectionID: c.ID,
		Protocols: []string{"deepseek-search", "deepseek-fetch"}, Enabled: true,
		Defaults: map[string]json.RawMessage{"temperature": json.RawMessage("0.7")},
	}, "", true)
	h.want(rr, 200)
	return h, c, chat, parse[Model](t, rr)
}

func TestWebToolsForwardNativeBodyWithoutModel(t *testing.T) {
	h, c, chat, web := webToolFixture(t)
	p := h.project("Kairos", chat.ID, web.ID)
	searchResponse := `{"results":[{"title":"Search & Fetch","url":"https://api-docs.deepseek.com/guides/search/"}]}`
	var gotURL, gotAuth, gotBody string
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(r.Body)
		gotURL, gotAuth, gotBody = r.URL.String(), r.Header.Get("Authorization"), string(raw)
		return response(searchResponse, "application/json", 200), nil
	})

	// No model in the body: the gateway finds web-search through the project's grants.
	rr := h.request("POST", "/v1/tools/search", map[string]any{"query": "DeepSeek 价格", "count": 5}, p.Token, false)
	h.want(rr, 200)
	if rr.Body.String() != searchResponse {
		t.Fatal("search response was altered")
	}
	if gotURL != c.Endpoints["deepseek-search"]+"/tools/search" || gotAuth != "Bearer fake-deepseek-key" {
		t.Fatalf("wrong upstream route or credential: %s", gotURL)
	}
	if gotBody != `{"count":5,"query":"DeepSeek 价格"}` {
		t.Fatalf("upstream body must stay DeepSeek-native without model or defaults: %s", gotBody)
	}

	// An explicit model also works and is still removed before forwarding.
	rr = h.request("POST", "/v1/tools/fetch", map[string]any{"model": "web-search", "url": "https://example.com/"}, p.Token, false)
	h.want(rr, 200)
	if gotURL != c.Endpoints["deepseek-fetch"]+"/tools/fetch" || gotBody != `{"url":"https://example.com/"}` {
		t.Fatalf("fetch forwarded wrongly: %s %s", gotURL, gotBody)
	}

	h.records(2)
	rr = h.request("GET", "/api/admin/requests/"+rr.Header().Get("X-Request-ID"), nil, "", true)
	h.want(rr, 200)
	rec := parse[Record](t, rr)
	if rec.Protocol != "deepseek-fetch" || rec.Alias != "web-search" || rec.ProjectID != p.Project.ID || rec.State != "complete" || rec.UsageStatus != "unknown" {
		t.Fatalf("web tool record wrong: %+v", rec)
	}
	a := newAggregate()
	a.add(rec)
	if a.Completed != 1 || a.UsageEligible != 0 {
		t.Fatal("web tool calls must not count toward token usage completeness")
	}

	// web-search is not a chat model, so the model list leaves it out.
	rr = h.request("GET", "/v1/models", nil, p.Token, false)
	h.want(rr, 200)
	if list := rr.Body.String(); !strings.Contains(list, `"deepseek-flash"`) || strings.Contains(list, `"web-search"`) {
		t.Fatalf("model list should only contain chat models: %s", list)
	}

	// The admin test button sends a sample query.
	h.want(h.request("POST", "/api/admin/models/"+web.ID+"/test", map[string]any{"protocol": "deepseek-search"}, "", true), 200)
	if gotBody != `{"count":3,"query":"DeepSeek"}` {
		t.Fatalf("admin test sent wrong sample: %s", gotBody)
	}
}

func TestWebToolsRejectUngrantedProjectAndStream(t *testing.T) {
	h, _, chat, web := webToolFixture(t)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		t.Fatal("rejected requests must not reach DeepSeek")
		return nil, nil
	})
	chatOnly := h.project("只对话", chat.ID)
	h.want(h.request("POST", "/v1/tools/search", map[string]any{"query": "x"}, chatOnly.Token, false), 403)

	p := h.project("Kairos", web.ID)
	h.want(h.request("POST", "/v1/tools/search", map[string]any{"query": "x", "stream": true}, p.Token, false), 400)
}
