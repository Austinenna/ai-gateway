package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestModelCatalogDiscovery(t *testing.T) {
	h := newHarness(t)
	const secret = "fake-catalog-key"
	c := h.connection("https://catalog.test/tenant/v1", "chat", secret)
	c.Endpoints["messages"] = "https://catalog.test/anthropic/v1"
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	path := "/api/admin/connections/" + c.ID + "/models"
	for _, protocol := range supportedProtocols {
		calls := 0
		h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.Method != "GET" || r.URL.Scheme+"://"+r.URL.Host+r.URL.Path != c.Endpoints[protocol]+"/models" || r.Header.Get("Authorization") != "Bearer "+secret || r.Header.Get("Cookie") != "" || r.Header.Get("X-Gateway-Admin") != "" {
				t.Fatal("incorrect discovery destination, method or credentials")
			}
			if protocol == "messages" {
				if r.Header.Get("x-api-key") != secret || r.Header.Get("anthropic-version") != "2023-06-01" || r.URL.Query().Get("limit") != "1000" {
					t.Fatal("missing Messages authentication or pagination")
				}
				if calls == 1 {
					return response(`{"data":[{"id":"old","created_at":"2024-01-01T00:00:00Z"}],"has_more":true,"last_id":"old"}`, "application/json", 200), nil
				}
				if r.URL.Query().Get("after_id") != "old" {
					t.Fatal("incorrect next-page cursor")
				}
			} else if r.Header.Get("x-api-key") != "" || r.URL.RawQuery != "" {
				t.Fatal("Chat received Messages headers or pagination")
			}
			return response(`{"data":[{"id":"unknown-z","created":0},{"id":"old","created":1704067200},{"id":"new","display_name":"最新模型","created_at":"2025-01-01T00:00:00Z"},{"id":"unknown-a","created":1704067200000},{"id":"new","created":1735689600},{"id":"unknown-b","created_at":"invalid"}]}`, "application/json", 200), nil
		})
		rr := h.request("POST", path, map[string]string{"protocol": protocol}, "", true)
		h.want(rr, 200)
		out := parse[modelCatalog](t, rr)
		if len(out.Models) != 5 || out.Protocol != protocol || out.Truncated || out.Models[0].ID != "new" || out.Models[0].DisplayName != "最新模型" || out.Models[1].ID != "old" || out.Models[2].ID != "unknown-a" || out.Models[4].ID != "unknown-z" {
			t.Fatalf("catalog did not merge and sort complete results: %+v", out)
		}
		if protocol == "messages" && calls != 2 || protocol == "chat" && calls != 1 {
			t.Fatal("unexpected discovery request count")
		}
		if strings.Contains(rr.Body.String(), secret) {
			t.Fatal("catalog exposed the credential")
		}
	}
	var models, records int
	h.g.db.QueryRow("SELECT count(*) FROM models").Scan(&models)
	h.g.db.QueryRow("SELECT count(*) FROM requests").Scan(&records)
	if models != 0 || records != 0 {
		t.Fatal("discovery created model configuration or inference records")
	}
}

func TestModelCatalogErrorsAndAccess(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://catalog.test/v1", "chat", "fake-catalog-secret")
	path := "/api/admin/connections/" + c.ID + "/models"
	in := map[string]string{"protocol": "chat"}
	calls := 0
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) { calls++; return nil, errors.New("must not call") })
	h.want(h.request("POST", path, in, "project-token-is-not-admin", false), 401)
	h.want(h.request("POST", path, map[string]string{"protocol": "messages"}, "", true), 400)
	h.want(h.request("POST", path, map[string]string{"protocol": "responses"}, "", true), 400)
	h.want(h.request("POST", path, map[string]string{"protocol": "chat", "endpoint": "https://wrong.test"}, "", true), 400)
	h.want(h.request("POST", "/api/admin/connections/missing/models", in, "", true), 404)
	req := httptest.NewRequest("POST", "http://gateway.test"+path, strings.NewReader(`{"protocol":"chat"}`))
	req.AddCookie(h.cookie)
	req.Header.Set("X-Gateway-Admin", "1")
	req.Header.Set("Origin", "https://wrong.test")
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, req)
	h.want(rr, 403)
	c.Enabled = false
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	h.want(h.request("POST", path, in, "", true), 400)
	if calls != 0 {
		t.Fatal("rejected request contacted upstream")
	}
	c.Enabled = true
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	for _, status := range []int{401, 403, 404, 405, 429, 500, 501, 302} {
		h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
			return response("fake-catalog-secret private upstream body", "text/html", status), nil
		})
		rr := h.request("POST", path, in, "", true)
		h.want(rr, 502)
		if strings.Contains(rr.Body.String(), "fake-catalog-secret") || !strings.Contains(rr.Body.String(), "手动填写") {
			t.Fatal("error leaked upstream content or omitted manual fallback")
		}
	}
	for _, body := range []string{`{"error":{"message":"fake-catalog-secret"}}`, `{"data":null}`, `<html>fake-catalog-secret</html>`, strings.Repeat("x", catalogPageBytes+1)} {
		h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) { return response(body, "application/json", 200), nil })
		rr := h.request("POST", path, in, "", true)
		h.want(rr, 502)
		if strings.Contains(rr.Body.String(), "fake-catalog-secret") {
			t.Fatal("parse error exposed upstream content")
		}
	}
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) { return nil, errors.New("fake-catalog-secret") })
	rr = h.request("POST", path, in, "", true)
	h.want(rr, 502)
	if strings.Contains(rr.Body.String(), "fake-catalog-secret") {
		t.Fatal("transport error exposed sensitive text")
	}
	h.g.mu.Lock()
	wipe(h.g.master)
	h.g.master = nil
	h.g.mu.Unlock()
	h.want(h.request("POST", path, in, "", true), 423)
}

func TestModelCatalogBoundsAndCancellation(t *testing.T) {
	h := newHarness(t)
	for _, protocol := range supportedProtocols {
		calls := 0
		h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			return response(`{"data":[{"id":"model","created":1}],"has_more":true,"last_id":"model"}`, "application/json", 200), nil
		})
		out, err := h.g.fetchModelCatalog(context.Background(), "https://catalog.test/v1", protocol, "fake-key")
		if err != nil || !out.Truncated || len(out.Models) != 1 || out.Models[0].CreatedAt != 0 || calls > 2 {
			t.Fatal("partial list or repeated cursor was not bounded")
		}
	}
	items := make([]map[string]any, catalogModelLimit+1)
	for i := range items {
		items[i] = map[string]any{"id": fmt.Sprintf("model-%05d", i)}
	}
	body, _ := json.Marshal(map[string]any{"data": items})
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		return response(string(body), "application/json", 200), nil
	})
	out, err := h.g.fetchModelCatalog(context.Background(), "https://catalog.test/v1", "chat", "fake-key")
	if err != nil || !out.Truncated || len(out.Models) != catalogModelLimit {
		t.Fatal("model count not bounded or truncation omitted")
	}
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if _, ok := r.Context().Deadline(); !ok {
			t.Error("missing timeout")
		}
		return nil, r.Context().Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	cancel()
	_, err = h.g.fetchModelCatalog(ctx, "https://catalog.test/v1", "chat", "fake-key")
	if err == nil || !strings.Contains(err.Error(), "取消") {
		t.Fatal("cancellation not respected")
	}
}

func TestModelCatalogDoesNotFollowRedirects(t *testing.T) {
	h := newHarness(t)
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.Write([]byte(`{"data":[]}`)) }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer upstream.Close()
	c := h.connection(upstream.URL, "chat", "fake-key")
	h.want(h.request("POST", "/api/admin/connections/"+c.ID+"/models", map[string]string{"protocol": "chat"}, "", true), 502)
	if hits != 0 {
		t.Fatal("redirect target received a request")
	}
}
