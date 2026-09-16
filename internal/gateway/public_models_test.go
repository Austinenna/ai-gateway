package gateway

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func publicCatalog(t *testing.T, h *harness) *httptest.ResponseRecorder {
	t.Helper()
	// No API key, session cookie, or admin header is needed.
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, httptest.NewRequest("GET", "http://gateway.test/api/public/models", nil))
	h.want(rr, 200)
	return rr
}

func TestPublicModelsCatalogFiltering(t *testing.T) {
	h := newHarness(t)
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("public discovery must not contact an upstream")
		return nil, nil
	})
	empty := publicCatalog(t, h)
	if strings.TrimSpace(empty.Body.String()) != `{"data":[],"object":"list"}` {
		t.Fatalf("empty catalog must contain an array: %s", empty.Body.String())
	}
	created := h.request("POST", "/api/admin/connections", Connection{Name: "private-connection", Provider: "custom", Endpoints: map[string]string{"chat": "https://private.test/v1", "messages": "https://private.test/anthropic/v1"}, Token: "fake-public-catalog-secret", Enabled: true}, "", true)
	h.want(created, 200)
	c := parse[Connection](t, created)
	z := h.model(c, "z-chat")
	z.Name, z.Protocols = "聊天模型", []string{"chat"}
	h.want(h.request("PUT", "/api/admin/models/"+z.ID, z, "", true), 200)
	a := h.model(c, "a-dual")
	a.Name = "双协议模型"
	h.want(h.request("PUT", "/api/admin/models/"+a.ID, a, "", true), 200)
	disabled := h.model(c, "disabled-model")
	disabled.Enabled = false
	h.want(h.request("PUT", "/api/admin/models/"+disabled.ID, disabled, "", true), 200)
	off := h.connection("https://disabled.test/v1", "chat", "fake-disabled-secret")
	h.model(off, "disabled-connection-model")
	off.Enabled = false
	h.want(h.request("PUT", "/api/admin/connections/"+off.ID, off, "", true), 200)
	// Models are public even before any project has been created or granted access.
	check := func(want []publicModel) {
		t.Helper()
		rr := publicCatalog(t, h)
		got := parse[struct {
			Object string        `json:"object"`
			Data   []publicModel `json:"data"`
		}](t, rr)
		if got.Object != "list" || !reflect.DeepEqual(got.Data, want) {
			t.Fatalf("catalog=%+v want=%+v", got, want)
		}
		// A field allowlist guards against accidentally exposing a full Model/Connection.
		raw := parse[struct {
			Data []map[string]any `json:"data"`
		}](t, rr)
		for _, m := range raw.Data {
			if len(m) != 4 || m["id"] == nil || m["object"] != "model" || m["name"] == nil || m["protocols"] == nil {
				t.Fatalf("unexpected public fields: %v", m)
			}
		}
		for _, private := range []string{c.ID, c.Name, a.ID, a.UpstreamModel, "private.test", "fake-public-catalog-secret", "temperature"} {
			if strings.Contains(rr.Body.String(), private) {
				t.Fatalf("private detail leaked: %s", private)
			}
		}
	}
	check([]publicModel{{ID: "a-dual", Object: "model", Name: "双协议模型", Protocols: []string{"chat", "messages"}}, {ID: "z-chat", Object: "model", Name: "聊天模型", Protocols: []string{"chat"}}})
	delete(c.Endpoints, "chat")
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	// Removing an endpoint removes that protocol, and models with no remaining protocol.
	check([]publicModel{{ID: "a-dual", Object: "model", Name: "双协议模型", Protocols: []string{"messages"}}})
	c.Enabled = false
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	check([]publicModel{})
}

func TestPublicModelsPreservesProjectAuthorization(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-public-auth-secret")
	a, b := h.model(c, "model-a"), h.model(c, "model-b")
	p := h.project("project-a", a.ID)
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("catalog or unauthorized call reached an upstream")
		return nil, nil
	})
	public := publicCatalog(t, h)
	for _, alias := range []string{a.Alias, b.Alias} {
		if !strings.Contains(public.Body.String(), alias) {
			t.Fatal("public catalog incorrectly limited to project grants")
		}
	}
	// Supplying a credential does not turn this public endpoint into a project catalog.
	withToken := h.request("GET", "/api/public/models", nil, p.Token, false)
	h.want(withToken, 200)
	if withToken.Body.String() != public.Body.String() {
		t.Fatal("public catalog changed with project identity")
	}
	h.want(h.request("GET", "/v1/models", nil, "", false), 401)
	h.want(h.request("GET", "/v1/models", nil, "invalid-token", false), 401)
	private := h.request("GET", "/v1/models", nil, p.Token, false)
	h.want(private, 200)
	if !strings.Contains(private.Body.String(), a.Alias) || strings.Contains(private.Body.String(), b.Alias) {
		t.Fatal("project model list stopped respecting grants")
	}
	h.want(h.call(a.Alias, "", nil), 401)
	h.want(h.call(b.Alias, p.Token, nil), 403)
	h.want(h.request("POST", "/v1/messages", map[string]any{"model": a.Alias, "messages": []any{}}, "", false), 401)
	h.want(h.request("GET", "/api/admin/state", nil, "", false), 401)
	h.want(h.request("GET", "/api/admin/requests", nil, "", false), 401)
	h.want(h.request("POST", "/api/admin/lock", nil, "", true), 200)
	if publicCatalog(t, h).Body.String() != public.Body.String() {
		t.Fatal("public catalog should remain readable while the vault is locked")
	}
}
