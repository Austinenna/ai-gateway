package gateway

import (
	"bytes"
	"net/http/httptest"
	"testing"
)

func TestLocalPasswordlessMigrationRestartAndRestore(t *testing.T) {
	h := newHarness(t)
	secret := "fake-local-unlock-vendor-token"
	c := h.connection("https://upstream.test/v1", "chat", secret)
	p := h.project("local-unlock-project")
	h.want(h.request("POST", "/api/admin/lock", nil, "", true), 200)
	h.want(h.request("POST", "/api/login", map[string]string{"password": ""}, "", false), 401)
	h.g.origin = "http://127.0.0.1:8317"
	if err := h.g.EnableLocalPasswordless(); err != nil {
		t.Fatal(err)
	}
	// The harness uses a synthetic host; allow it only after checking the real
	// configuration gate so requests can continue through the existing harness.
	h.g.origin = "http://gateway.test"
	if h.g.localUnlockReady() {
		t.Fatal("locked vault cannot invent an unlock key")
	}
	h.want(h.request("POST", "/api/login", map[string]string{"password": ""}, "", false), 409)
	h.want(h.request("POST", "/api/login", map[string]string{"password": "wrong"}, "", false), 401)
	if h.g.localUnlockReady() {
		t.Fatal("wrong password created local unlock material")
	}
	var originalWrapper []byte
	if err := h.g.db.QueryRow("SELECT value FROM meta WHERE key='wrapped_master'").Scan(&originalWrapper); err != nil {
		t.Fatal(err)
	}
	login := h.request("POST", "/api/login", map[string]string{"password": testPassword}, "", false)
	h.want(login, 200)
	h.cookie = login.Result().Cookies()[0]
	if !h.g.localUnlockReady() {
		t.Fatal("local unlock setup missing")
	}
	var wrapperAfter []byte
	if err := h.g.db.QueryRow("SELECT value FROM meta WHERE key='wrapped_master'").Scan(&wrapperAfter); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(originalWrapper, wrapperAfter) {
		t.Fatal("original password was changed")
	}
	checkTokens := func() {
		t.Helper()
		rr := h.request("POST", "/api/admin/projects/"+p.Project.ID+"/credential", nil, "", true)
		h.want(rr, 200)
		if parse[map[string]string](t, rr)["token"] != p.Token {
			t.Fatal("project token changed")
		}
		rr = h.request("POST", "/api/admin/connections/"+c.ID+"/reveal", map[string]string{"password": ""}, "", true)
		h.want(rr, 200)
		if parse[map[string]string](t, rr)["token"] != secret {
			t.Fatal("vendor token changed")
		}
	}
	checkTokens()
	h.want(h.request("POST", "/api/admin/lock", nil, "", true), 200)
	h.want(h.request("GET", "/api/admin/state", nil, "", true), 401)
	login = h.request("POST", "/api/login", map[string]string{"password": ""}, "", false)
	h.want(login, 200)
	h.cookie = login.Result().Cookies()[0]
	checkTokens()
	if err := h.g.Close(); err != nil {
		t.Fatal(err)
	}
	h.g = nil
	g, err := Open(h.dir, "http://127.0.0.1:8317", true)
	if err != nil {
		t.Fatal(err)
	}
	h.g = g
	if err = g.EnableLocalPasswordless(); err != nil {
		t.Fatal(err)
	}
	g.origin = "http://gateway.test"
	h.handler = g.Handler(nil)
	status := parse[map[string]any](t, h.request("GET", "/api/status", nil, "", false))
	if status["locked"] != true {
		t.Fatal("restarted service should remain locked until login")
	}
	login = h.request("POST", "/api/login", map[string]string{"password": ""}, "", false)
	h.want(login, 200)
	h.cookie = login.Result().Cookies()[0]
	checkTokens()
	h.want(h.request("GET", "/v1/models", nil, p.Token, false), 200)
	h.want(h.request("POST", "/api/admin/lock", nil, "", true), 200)
	if err = g.DisableLocalPasswordless(); err != nil {
		t.Fatal(err)
	}
	h.want(h.request("POST", "/api/login", map[string]string{"password": ""}, "", false), 401)
	var count int
	if err = g.db.QueryRow("SELECT count(*) FROM meta WHERE key='local_wrapped_master'").Scan(&count); err != nil || count != 0 {
		t.Fatal("temporary unlock wrapper not removed")
	}
	login = h.request("POST", "/api/login", map[string]string{"password": testPassword}, "", false)
	h.want(login, 200)
}

func TestLocalPasswordlessOriginAndCSRF(t *testing.T) {
	for _, tc := range []struct {
		origin  string
		local   bool
		allowed bool
	}{
		{"http://127.0.0.1:8317", true, true}, {"http://localhost:8317", true, true}, {"http://[::1]:8317", true, true},
		{"https://gateway.example", true, false}, {"http://127.0.0.1:8317", false, false},
	} {
		g, err := Open(t.TempDir(), tc.origin, tc.local)
		if err != nil {
			t.Fatal(err)
		}
		err = g.EnableLocalPasswordless()
		g.Close()
		if (err == nil) != tc.allowed {
			t.Fatalf("local mode gate incorrect: %s", tc.origin)
		}
	}
	h := newHarness(t)
	h.g.localPasswordless = true
	key := h.g.key()
	if err := h.g.saveLocalUnlock(key); err != nil {
		t.Fatal(err)
	}
	wipe(key)
	h.g.lock()
	for _, crossOrigin := range []bool{false, true} {
		req := httptest.NewRequest("POST", "http://gateway.test/api/login", bytes.NewBufferString(`{"password":""}`))
		if crossOrigin {
			req.Header.Set("X-Gateway-Admin", "1")
			req.Header.Set("Origin", "https://external.test")
		}
		rr := httptest.NewRecorder()
		h.handler.ServeHTTP(rr, req)
		h.want(rr, 403)
	}
	h.want(h.request("GET", "/api/admin/state", nil, "", false), 401)
	h.want(h.request("POST", "/api/login", map[string]string{"password": "wrong"}, "", false), 401)
	h.want(h.request("POST", "/api/login", map[string]string{"password": ""}, "", false), 200)
}
