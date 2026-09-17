package gateway

import (
	"bytes"
	"net/http/httptest"
	"strings"
	"testing"
)

func restartHarness(t *testing.T, h *harness) {
	t.Helper()
	if err := h.g.Close(); err != nil {
		t.Fatal(err)
	}
	h.g = nil
	g, err := Open(h.dir, "http://gateway.test", true)
	if err != nil {
		t.Fatal(err)
	}
	h.g, h.handler = g, g.Handler(nil)
	rr := h.request("POST", "/api/login", map[string]string{"password": testPassword}, "", false)
	h.want(rr, 200)
	h.cookie = rr.Result().Cookies()[0]
}

func TestProjectCredentialEncryptedCopyAndAdminBoundary(t *testing.T) {
	h := newHarness(t)
	p := h.project("copy-project")
	path := "/api/admin/projects/" + p.Project.ID + "/credential"
	if !p.Project.HasSavedToken {
		t.Fatal("created token must be stored")
	}
	var enc []byte
	if err := h.g.db.QueryRow("SELECT credential FROM project_credentials WHERE project_id=?", p.Project.ID).Scan(&enc); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(enc, []byte(p.Token)) {
		t.Fatal("plaintext token in credential storage")
	}
	key := h.g.key()
	if _, err := unseal(key, enc, "project:another-project"); err == nil {
		t.Fatal("ciphertext not bound to project")
	}
	if _, err := unseal(key, enc, p.Project.ID); err == nil {
		t.Fatal("credential domains must be separated")
	}
	wipe(key)
	state := h.request("GET", "/api/admin/state", nil, "", true)
	h.want(state, 200)
	if strings.Contains(state.Body.String(), p.Token) || strings.Contains(state.Body.String(), digest(p.Token)) {
		t.Fatal("list leaked project token")
	}
	h.want(h.request("POST", path, nil, "", false), 401)
	h.want(h.request("POST", path, nil, p.Token, false), 401)
	h.want(h.request("POST", path+"/save", map[string]string{"token": p.Token}, p.Token, false), 401)
	for _, route := range []string{path, path + "/save"} {
		for _, crossOrigin := range []bool{false, true} {
			req := httptest.NewRequest("POST", "http://gateway.test"+route, nil)
			req.AddCookie(h.cookie)
			if crossOrigin {
				req.Header.Set("X-Gateway-Admin", "1")
				req.Header.Set("Origin", "https://external.test")
			}
			rr := httptest.NewRecorder()
			h.handler.ServeHTTP(rr, req)
			h.want(rr, 403)
		}
	}
	assertToken := func() {
		t.Helper()
		rr := h.request("POST", path, nil, "", true)
		h.want(rr, 200)
		if parse[map[string]string](t, rr)["token"] != p.Token {
			t.Fatal("retrieved token mismatch")
		}
		if !strings.Contains(rr.Header().Get("Cache-Control"), "no-store") {
			t.Fatal("secret response is cacheable")
		}
	}
	assertToken()
	restartHarness(t, h)
	assertToken()
	h.g.mu.Lock()
	wipe(h.g.master)
	h.g.master = nil
	h.g.mu.Unlock()
	h.want(h.request("POST", path, nil, "", true), 423)
	h.want(h.request("POST", path+"/save", map[string]string{"token": p.Token}, "", true), 423)
	h.want(h.request("POST", "/api/admin/projects/"+p.Project.ID+"/rotate", nil, "", true), 423)
}

func TestLegacyProjectTokenMigrationAndBackfill(t *testing.T) {
	h := newHarness(t)
	p := h.project("legacy-project")
	other := h.project("other-project")
	if _, err := h.g.db.Exec("DROP TABLE project_credentials; ALTER TABLE connections DROP COLUMN endpoints_json; ALTER TABLE models DROP COLUMN protocols_json; PRAGMA user_version=2;"); err != nil {
		t.Fatal(err)
	}
	restartHarness(t, h)
	var version int
	if err := h.g.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 5 {
		t.Fatal("v2 migration failed")
	}
	projects, err := h.g.projects()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range projects {
		if v.HasSavedToken {
			t.Fatal("migration invented token plaintext")
		}
	}
	path := "/api/admin/projects/" + p.Project.ID + "/credential"
	h.want(h.request("POST", path, nil, "", true), 409)
	h.want(h.request("GET", "/v1/models", nil, p.Token, false), 200)
	h.want(h.request("POST", path+"/save", map[string]string{"token": other.Token}, "", true), 400)
	h.want(h.request("POST", path+"/save", map[string]string{"token": "gw_partial"}, "", true), 400)
	h.want(h.request("POST", "/api/admin/projects/missing/credential/save", map[string]string{"token": p.Token}, "", true), 404)
	h.want(h.request("POST", path+"/save", map[string]string{"token": "  " + p.Token + "\n"}, "", true), 200)
	rr := h.request("POST", path, nil, "", true)
	h.want(rr, 200)
	if parse[map[string]string](t, rr)["token"] != p.Token {
		t.Fatal("backfill changed current token")
	}
	h.want(h.request("GET", "/v1/models", nil, p.Token, false), 200)
	h.want(h.request("GET", "/v1/models", nil, other.Token, false), 200)
	restartHarness(t, h)
	rr = h.request("POST", path, nil, "", true)
	h.want(rr, 200)
	if parse[map[string]string](t, rr)["token"] != p.Token {
		t.Fatal("backfilled token lost after restart")
	}
}

func TestProjectCredentialRotationAtomicityAndDeletion(t *testing.T) {
	h := newHarness(t)
	p := h.project("rotation-project")
	base := "/api/admin/projects/" + p.Project.ID
	if _, err := h.g.db.Exec(`CREATE TRIGGER fail_token_write BEFORE INSERT ON project_credentials BEGIN SELECT RAISE(ABORT,'test storage failure'); END;`); err != nil {
		t.Fatal(err)
	}
	h.want(h.request("POST", base+"/rotate", nil, "", true), 500)
	h.want(h.request("POST", "/api/admin/projects", Project{Name: "must rollback", Enabled: true}, "", true), 500)
	h.want(h.request("POST", "/api/admin/demo", nil, "", true), 500)
	var projects, connections int
	if err := h.g.db.QueryRow("SELECT count(*) FROM projects").Scan(&projects); err != nil || projects != 1 {
		t.Fatal("failed creation left a project")
	}
	if err := h.g.db.QueryRow("SELECT count(*) FROM connections").Scan(&connections); err != nil || connections != 0 {
		t.Fatal("failed demo left a connection")
	}
	h.want(h.request("GET", "/v1/models", nil, p.Token, false), 200)
	rr := h.request("POST", base+"/credential", nil, "", true)
	h.want(rr, 200)
	if parse[map[string]string](t, rr)["token"] != p.Token {
		t.Fatal("failed rotation changed stored token")
	}
	if _, err := h.g.db.Exec("DROP TRIGGER fail_token_write"); err != nil {
		t.Fatal(err)
	}
	rr = h.request("POST", base+"/rotate", nil, "", true)
	h.want(rr, 200)
	rotated := parse[map[string]string](t, rr)["token"]
	if rotated == p.Token {
		t.Fatal("rotation did not change token")
	}
	h.want(h.request("GET", "/v1/models", nil, p.Token, false), 401)
	h.want(h.request("GET", "/v1/models", nil, rotated, false), 200)
	h.want(h.request("POST", base+"/credential/save", map[string]string{"token": p.Token}, "", true), 400)
	rr = h.request("POST", base+"/credential", nil, "", true)
	h.want(rr, 200)
	if parse[map[string]string](t, rr)["token"] != rotated {
		t.Fatal("rotation did not update encrypted copy")
	}
	h.want(h.request("DELETE", base, nil, "", true), 200)
	var count int
	if err := h.g.db.QueryRow("SELECT count(*) FROM project_credentials WHERE project_id=?", p.Project.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("deletion left saved credential")
	}
	h.want(h.request("POST", base+"/credential", nil, "", true), 404)
	rr = h.request("POST", "/api/admin/demo", nil, "", true)
	h.want(rr, 200)
	demo := parse[map[string]string](t, rr)
	rr = h.request("POST", "/api/admin/projects/"+demo["project_id"]+"/credential", nil, "", true)
	h.want(rr, 200)
	if parse[map[string]string](t, rr)["token"] != demo["token"] {
		t.Fatal("demo token not stored")
	}
}
