package gateway

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// The service key is provisioned by a normal password login. Later restarts
// restore project traffic without creating an administrator session or
// allowing a blank management login.
func TestServiceAutoUnlockRestoresProjectTraffic(t *testing.T) {
	h := newHarness(t)
	if err := h.g.EnableServiceAutoUnlock(); err != nil {
		t.Fatal(err)
	}
	secret := "fake-service-unlock-vendor-token"
	c := h.connection("https://upstream.test/v1", "chat", secret)
	m := h.model(c, "service-unlock-model")
	p := h.project("service-unlock-project", m.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Fatal("service auto-unlock did not restore the vendor credential")
		}
		return response(`{"choices":[{"message":{"content":"ok"}}]}`, "application/json", 200), nil
	})

	// Existing databases need one normal password login to provision the
	// service key; this is separate from the per-browser admin session.
	h.g.clearMaster()
	h.want(h.call(m.Alias, p.Token, nil), 503)
	login := h.request("POST", "/api/login", map[string]string{"password": testPassword}, "", false)
	h.want(login, 200)
	h.cookie = login.Result().Cookies()[0]
	keyPath := filepath.Join(h.dir, "service-unlock.key")
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("service key permissions=%o, want 600", info.Mode().Perm())
	}
	h.want(h.request("POST", "/api/admin/logout", nil, "", true), 200)
	h.want(h.call(m.Alias, p.Token, nil), 200)

	if err := h.g.Close(); err != nil {
		t.Fatal(err)
	}
	h.g = nil
	g, err := Open(h.dir, "http://gateway.test", true)
	if err != nil {
		t.Fatal(err)
	}
	h.g = g
	if err = g.EnableServiceAutoUnlock(); err != nil {
		t.Fatal(err)
	}
	g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Fatal("restarted service used the wrong vendor credential")
		}
		return response(`{"choices":[{"message":{"content":"after-restart"}}]}`, "application/json", 200), nil
	})
	h.handler = g.Handler(nil)
	status := parse[map[string]any](t, h.request("GET", "/api/status", nil, "", false))
	if status["locked"] != false || status["authenticated"] != false {
		t.Fatalf("service restart status=%v, want unlocked without an admin session", status)
	}
	h.want(h.request("GET", "/api/admin/state", nil, "", true), 401)
	h.want(h.request("POST", "/api/login", map[string]string{"password": ""}, "", false), 401)
	h.want(h.call(m.Alias, p.Token, nil), 200)
}
