package gateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestOutboundProxySettingValidation(t *testing.T) {
	h := newHarness(t)
	for _, bad := range []string{"127.0.0.1:7890", "ftp://127.0.0.1:21", "http://127.0.0.1", "http://user:pass@127.0.0.1:7890", "http://127.0.0.1:7890/path", "http://127.0.0.1:7890?x=1"} {
		h.want(h.request("PUT", "/api/admin/outbound-proxy", map[string]string{"url": bad}, "", true), 400)
	}
	for _, good := range []string{"http://127.0.0.1:7890", "socks5://127.0.0.1:7891", "socks5h://proxy.local:1080"} {
		rr := h.request("PUT", "/api/admin/outbound-proxy", map[string]string{"url": " " + good + "/ "}, "", true)
		h.want(rr, 200)
		if parse[map[string]string](t, rr)["url"] != good {
			t.Fatalf("proxy %q was not normalized", good)
		}
	}
	h.want(h.request("PUT", "/api/admin/outbound-proxy", map[string]string{"url": "http://127.0.0.1:7890"}, "", true), 200)
	restartHarness(t, h)
	state := parse[map[string]any](t, h.request("GET", "/api/admin/state", nil, "", true))
	if state["outbound_proxy"] != "http://127.0.0.1:7890" {
		t.Fatalf("proxy setting lost after restart: %v", state["outbound_proxy"])
	}
	h.want(h.request("PUT", "/api/admin/outbound-proxy", map[string]string{"url": ""}, "", true), 200)
	if h.g.outboundProxy.Load() != nil {
		t.Fatal("clearing the address should fall back to the environment")
	}
	// Anonymous callers cannot change where upstream traffic goes.
	h.cookie = nil
	h.want(h.request("PUT", "/api/admin/outbound-proxy", map[string]string{"url": "http://127.0.0.1:7890"}, "", true), 401)
}

func TestConnectionProxySwitchRoutesUpstreamCalls(t *testing.T) {
	h := newHarness(t)
	proxied := h.connection("https://abroad.test/v1", "chat", "fake-abroad-key")
	direct := h.connection("https://domestic.test/v1", "chat", "fake-domestic-key")
	on := true
	proxied.UseProxy = &on
	saved := parse[Connection](t, h.request("PUT", "/api/admin/connections/"+proxied.ID, proxied, "", true))
	if saved.UseProxy == nil || !*saved.UseProxy {
		t.Fatal("proxy switch not saved")
	}
	// An older admin client that omits use_proxy keeps the saved value.
	legacy := map[string]any{"name": "旧客户端编辑", "provider": proxied.Provider, "endpoints": proxied.Endpoints, "enabled": true}
	if c := parse[Connection](t, h.request("PUT", "/api/admin/connections/"+proxied.ID, legacy, "", true)); c.UseProxy == nil || !*c.UseProxy {
		t.Fatal("omitting use_proxy cleared the switch")
	}
	mp, md := h.model(proxied, "abroad"), h.model(direct, "domestic")
	p := h.project("proxy routing", mp.ID, md.ID)

	seen := map[string]*url.URL{}
	envFallback := map[string]bool{}
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		_, chosen := r.Context().Value(upstreamProxyKey{}).(upstreamProxy)
		envFallback[r.URL.Host] = !chosen
		u, _ := proxyForRequest(r)
		seen[r.URL.Host] = u
		return response(`{"choices":[{"message":{"content":"ok"}}]}`, "application/json", 200), nil
	})
	call := func() {
		h.want(h.call("abroad", p.Token, nil), 200)
		h.want(h.call("domestic", p.Token, nil), 200)
	}
	call()
	if !envFallback["abroad.test"] || !envFallback["domestic.test"] {
		t.Fatal("without a saved address calls must follow the environment proxy settings")
	}
	h.want(h.request("PUT", "/api/admin/outbound-proxy", map[string]string{"url": "socks5://127.0.0.1:7891"}, "", true), 200)
	call()
	if u := seen["abroad.test"]; u == nil || u.String() != "socks5://127.0.0.1:7891" {
		t.Fatalf("proxied connection should use the saved address, got %v", u)
	}
	if envFallback["domestic.test"] || seen["domestic.test"] != nil {
		t.Fatal("connection without the switch must go direct once an address is saved")
	}
}

func TestOutboundProxyTransportUsesChosenProxy(t *testing.T) {
	var proxyHits int
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyHits++
		if r.URL.Host != "upstream.test" {
			t.Errorf("proxy received %q, want an absolute upstream URL", r.URL.String())
		}
		io.WriteString(w, "via proxy")
	}))
	defer proxy.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "direct") }))
	defer upstream.Close()
	g := &Gateway{}
	u, _ := url.Parse(proxy.URL)
	g.outboundProxy.Store(u)
	client := newHTTPClient()
	get := func(target string, useProxy bool) string {
		req, _ := http.NewRequestWithContext(g.withUpstreamProxy(context.Background(), useProxy), "GET", target, nil)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return string(b)
	}
	if got := get("http://upstream.test/v1/models", true); got != "via proxy" || proxyHits != 1 {
		t.Fatalf("proxied request bypassed the proxy: %q", got)
	}
	if got := get(upstream.URL, false); got != "direct" || proxyHits != 1 {
		t.Fatalf("direct request went through the proxy: %q", got)
	}
}

func TestConnectionProxyV8Migration(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://mock.test/v1", "chat", "fake-proxy-migration")
	if _, err := h.g.db.Exec("ALTER TABLE connections DROP COLUMN use_proxy; PRAGMA user_version=8;"); err != nil {
		t.Fatal(err)
	}
	restartHarness(t, h)
	cs, err := h.g.connections()
	if err != nil || len(cs) != 1 || cs[0].ID != c.ID || cs[0].UseProxy == nil || *cs[0].UseProxy {
		t.Fatalf("migration should keep the connection and default to direct: %v", err)
	}
	var version int
	if err = h.g.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 9 {
		t.Fatalf("version=%d err=%v", version, err)
	}
}
