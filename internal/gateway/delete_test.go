package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDeleteConnectionProtectsReferencesAndRequiresAdmin(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-delete-test-secret")
	m := h.model(c, "delete-test")
	p := h.project("project-delete-test", m.ID)
	for _, path := range []string{"/api/admin/connections/" + c.ID, "/api/admin/models/" + m.ID, "/api/admin/projects/" + p.Project.ID} {
		h.want(h.request("DELETE", path, nil, p.Token, false), 401)
		for _, origin := range []string{"", "https://untrusted.test"} {
			req := httptest.NewRequest("DELETE", "http://gateway.test"+path, nil)
			req.AddCookie(h.cookie)
			if origin != "" {
				req.Header.Set("Origin", origin)
				req.Header.Set("X-Gateway-Admin", "1")
			}
			rr := httptest.NewRecorder()
			h.handler.ServeHTTP(rr, req)
			h.want(rr, 403)
		}
	}
	path := "/api/admin/connections/" + c.ID
	h.want(h.request("DELETE", path, nil, "", true), 409)
	m.Enabled = false
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	h.want(h.request("DELETE", path, nil, "", true), 409)
	other := h.connection("https://other.test/v1", "chat", "another-fake-secret")
	m.ConnectionID = other.ID
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	h.want(h.request("DELETE", path, nil, "", true), 200)
	h.want(h.request("DELETE", path, nil, "", true), 404)
	h.want(h.request("PUT", path, c, "", true), 404)
	var count int
	if err := h.g.db.QueryRow("SELECT count(*) FROM connections WHERE id=?", c.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("deleted connection or its credential remains", err)
	}
	models, err := h.g.models()
	if err != nil || len(models) != 1 || models[0].ConnectionID != other.ID {
		t.Fatal("deleting a connection changed the moved model", err)
	}
}

func TestDeleteModelRemovesGrantsAtomicallyAndKeepsHistory(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-delete-test-secret")
	m := h.model(c, "remove-model")
	other := h.model(c, "keep-model")
	a := h.project("A", m.ID, other.ID)
	b := h.project("B", m.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		return response(`{"choices":[{"message":{"content":"before deletion"}}]}`, "application/json", 200), nil
	})
	h.want(h.call(m.Alias, a.Token, nil), 200)
	record := h.records(1)[0]
	// A failed delete must roll back the preceding grant removal.
	if _, err := h.g.db.Exec(`CREATE TRIGGER fail_model_delete BEFORE DELETE ON models BEGIN SELECT RAISE(ABORT, 'test failure'); END;`); err != nil {
		t.Fatal(err)
	}
	path := "/api/admin/models/" + m.ID
	h.want(h.request("DELETE", path, nil, "", true), 500)
	var grants int
	if err := h.g.db.QueryRow("SELECT count(*) FROM project_models WHERE model_id=?", m.ID).Scan(&grants); err != nil || grants != 2 {
		t.Fatal("failed deletion did not preserve grants", err)
	}
	if _, err := h.g.db.Exec("DROP TRIGGER fail_model_delete"); err != nil {
		t.Fatal(err)
	}
	h.want(h.request("DELETE", path, nil, "", true), 200)
	h.want(h.request("DELETE", path, nil, "", true), 404)
	h.want(h.request("PUT", path, m, "", true), 404)
	h.want(h.call(m.Alias, a.Token, nil), 403)
	h.want(h.call(m.Alias, b.Token, nil), 403)
	list := h.request("GET", "/v1/models", nil, a.Token, false)
	h.want(list, 200)
	if strings.Contains(list.Body.String(), m.Alias) || !strings.Contains(list.Body.String(), other.Alias) {
		t.Fatal("model list has incorrect grants after deletion")
	}
	// Reusing a deleted alias must not restore earlier grants to the new model.
	h.model(c, m.Alias)
	h.want(h.call(m.Alias, a.Token, nil), 403)
	h.want(h.call(other.Alias, a.Token, nil), 200)
	saved := h.request("GET", "/api/admin/requests/"+record.ID, nil, "", true)
	h.want(saved, 200)
	r := parse[Record](t, saved)
	if r.ProjectName != "A" || r.Alias != m.Alias || !strings.Contains(r.Output, "before deletion") {
		t.Fatal("historical request changed after model deletion")
	}
}

func TestDeleteProjectRevokesCredentialAndPreservesOthersAndHistory(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-delete-test-secret")
	m := h.model(c, "shared-model")
	a := h.project("delete-A", m.ID)
	b := h.project("keep-B", m.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		return response(`{"choices":[{"message":{"content":"history"}}]}`, "application/json", 200), nil
	})
	h.want(h.call(m.Alias, a.Token, nil), 200)
	record := h.records(1)[0]
	path := "/api/admin/projects/" + a.Project.ID
	h.want(h.request("DELETE", path, nil, "", true), 200)
	h.want(h.request("DELETE", path, nil, "", true), 404)
	h.want(h.request("PUT", path, a.Project, "", true), 404)
	h.want(h.request("POST", path+"/rotate", nil, "", true), 404)
	h.want(h.call(m.Alias, a.Token, nil), 401)
	h.want(h.request("GET", "/v1/models", nil, a.Token, false), 401)
	h.want(h.call(m.Alias, b.Token, nil), 200)
	var count int
	if err := h.g.db.QueryRow("SELECT count(*) FROM project_models WHERE project_id=?", a.Project.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("deleted project left model grants", err)
	}
	rr := h.request("GET", "/api/admin/requests/"+record.ID, nil, "", true)
	h.want(rr, 200)
	if parse[Record](t, rr).ProjectName != a.Project.Name {
		t.Fatal("historical project identity was lost")
	}
	filtered := h.request("GET", "/api/admin/requests?project_id="+a.Project.ID, nil, "", true)
	h.want(filtered, 200)
	if len(parse[[]Record](t, filtered)) != 1 {
		t.Fatal("deleted project history cannot be queried")
	}
}

func TestCascadeConnectionChecksReviewedModelsAndRollsBack(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-cascade-secret")
	a := h.model(c, "cascade-a")
	b := h.model(c, "cascade-b")
	b.Enabled = false
	h.want(h.request("PUT", "/api/admin/models/"+b.ID, b, "", true), 200)
	other := h.connection("https://other.test/v1", "chat", "fake-other-secret")
	keep := h.model(other, "keep")
	p := h.project("shared-project", a.ID, b.ID, keep.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		return response(`{"choices":[{"message":{"content":"preserved history"}}]}`, "application/json", 200), nil
	})
	h.want(h.call(a.Alias, p.Token, nil), 200)
	record := h.records(1)[0]
	path := "/api/admin/connections/" + c.ID + "?cascade=true"
	body := map[string]any{"model_ids": []string{a.ID, b.ID}}
	h.want(h.request("DELETE", path, body, p.Token, false), 401)
	h.want(h.request("DELETE", path, map[string]any{"model_ids": []string{a.ID}}, "", true), 409)
	h.want(h.request("DELETE", path, map[string]any{"model_ids": []string{a.ID, b.ID, keep.ID}}, "", true), 409)
	h.want(h.request("DELETE", path, map[string]any{"model_ids": []string{a.ID, a.ID}}, "", true), 409)
	if _, err := h.g.db.Exec(`CREATE TRIGGER fail_connection_delete BEFORE DELETE ON connections BEGIN SELECT RAISE(ABORT, 'test failure'); END;`); err != nil {
		t.Fatal(err)
	}
	h.want(h.request("DELETE", path, body, "", true), 500)
	var grants, models int
	if err := h.g.db.QueryRow("SELECT count(*) FROM project_models WHERE project_id=?", p.Project.ID).Scan(&grants); err != nil || grants != 3 {
		t.Fatal("cascade failure lost project grants", err)
	}
	if err := h.g.db.QueryRow("SELECT count(*) FROM models WHERE connection_id=?", c.ID).Scan(&models); err != nil || models != 2 {
		t.Fatal("cascade failure lost models", err)
	}
	if _, err := h.g.db.Exec("DROP TRIGGER fail_connection_delete"); err != nil {
		t.Fatal(err)
	}
	h.want(h.request("DELETE", path, body, "", true), 200)
	h.want(h.request("DELETE", path, body, "", true), 404)
	h.want(h.call(a.Alias, p.Token, nil), 403)
	h.want(h.call(keep.Alias, p.Token, nil), 200)
	ps, err := h.g.projects()
	if err != nil || len(ps) != 1 || len(ps[0].ModelIDs) != 1 || ps[0].ModelIDs[0] != keep.ID {
		t.Fatal("cascade affected an unrelated model or deleted a project", err)
	}
	h.want(h.request("GET", "/api/admin/requests/"+record.ID, nil, "", true), 200)
	cs, err := h.g.connections()
	if err != nil || len(cs) != 1 || cs[0].ID != other.ID {
		t.Fatal("cascade did not remove only the selected connection", err)
	}
}
