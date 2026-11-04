package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestExtensionsKeepUserVersionForRollback(t *testing.T) {
	h := newHarness(t)
	var version, ext int
	if err := h.g.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 10 {
		t.Fatalf("user_version must stay 10 so the previous release can open the database: %d %v", version, err)
	}
	if err := h.g.db.QueryRow("SELECT CAST(value AS INTEGER) FROM meta WHERE key='schema_ext'").Scan(&ext); err != nil || ext != schemaExtVersion {
		t.Fatalf("schema_ext=%d %v", ext, err)
	}
	for table, column := range map[string]string{"models": "fallback_model_id", "projects": "max_concurrent", "request_metrics": "m_project"} {
		if ok, err := columnExists(h.g.db, table, column); err != nil || !ok {
			t.Fatalf("%s.%s missing", table, column)
		}
	}
	var mode int
	if h.g.db.QueryRow("PRAGMA auto_vacuum").Scan(&mode); mode != 2 {
		t.Fatalf("auto_vacuum=%d, want incremental", mode)
	}
	// The previous release inserts with explicit column lists; additive columns
	// must accept those rows.
	if _, err := h.g.db.Exec("INSERT INTO projects(id,name,enabled,token_digest,token_prefix,monthly_budget) VALUES('old','old',1,'d','gw_old',NULL)"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.g.db.Exec("INSERT INTO request_metrics(id,started,summary) VALUES('old-call',1,'{\"project_id\":\"old\",\"state\":\"complete\"}')"); err != nil {
		t.Fatal(err)
	}
	// Reopening is idempotent.
	h.g.Close()
	g, err := Open(h.dir, "http://gateway.test", true)
	if err != nil {
		t.Fatal(err)
	}
	h.g = g
}

func TestLegacyBodyRowsBackfillSummaries(t *testing.T) {
	dir := t.TempDir()
	g, err := Open(dir, "http://gateway.test", true)
	if err != nil {
		t.Fatal(err)
	}
	rec := Record{ID: "body-only", ProjectID: "p", Started: 5, State: "complete"}
	raw, _ := json.Marshal(rec)
	if _, err = g.db.Exec("INSERT INTO requests(id,project_id,started,summary,record) VALUES(?,?,?,?,?)", rec.ID, rec.ProjectID, rec.Started, string(raw), string(raw)); err != nil {
		t.Fatal(err)
	}
	// Simulate a database from before the extension.
	if _, err = g.db.Exec("DELETE FROM meta WHERE key='schema_ext'"); err != nil {
		t.Fatal(err)
	}
	g.Close()
	if g, err = Open(dir, "http://gateway.test", true); err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	var n int
	if g.db.QueryRow("SELECT count(*) FROM request_metrics WHERE id='body-only'").Scan(&n); n != 1 {
		t.Fatal("legacy body row was not copied into request_metrics")
	}
}

func TestRequestListPagingFiltersAndSearch(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < 120; i++ {
		state, project := "complete", "p1"
		if i%10 == 0 {
			state = "error"
		}
		if i%3 == 0 {
			project = "p2"
		}
		rec := Record{ID: fmt.Sprintf("call-%03d", i), ProjectID: project, ProjectName: project, Alias: "alias-" + project, Started: 1_000_000 + int64(i/2), State: state}
		if i == 7 {
			rec.FallbackFrom = "primary"
		}
		h.g.saveMetric(rec)
		if i == 42 {
			rec.Input = `{"messages":[{"role":"user","content":"needle-in-body"}]}`
			raw, _ := json.Marshal(rec)
			if _, err := h.g.db.Exec("INSERT INTO requests(id,project_id,started,summary,record) VALUES(?,?,?,?,?)", rec.ID, rec.ProjectID, rec.Started, "{}", string(raw)); err != nil {
				t.Fatal(err)
			}
		}
	}
	page := func(query string) requestPage {
		t.Helper()
		rr := h.request("GET", "/api/admin/requests"+query, nil, "", true)
		h.want(rr, 200)
		return parse[requestPage](t, rr)
	}
	seen := map[string]bool{}
	cursor, pages := "", 0
	for {
		p := page("?limit=50&cursor=" + cursor)
		pages++
		if p.Total == nil || *p.Total != 120 {
			t.Fatalf("total=%v", p.Total)
		}
		for i, rec := range p.Items {
			if seen[rec.ID] {
				t.Fatalf("duplicate %s across pages", rec.ID)
			}
			seen[rec.ID] = true
			if i > 0 && rec.Started > p.Items[i-1].Started {
				t.Fatal("page not ordered newest first")
			}
		}
		if p.NextCursor == "" {
			break
		}
		cursor = p.NextCursor
	}
	if len(seen) != 120 || pages != 3 {
		t.Fatalf("paged %d records in %d pages", len(seen), pages)
	}
	// Calls in the same millisecond keep insertion order (newest inserted first).
	first := page("?limit=2").Items
	if first[0].ID != "call-119" || first[1].ID != "call-118" {
		t.Fatalf("tie order %s %s", first[0].ID, first[1].ID)
	}
	if p := page("?project_id=p2&limit=200"); *p.Total != 40 || p.Items[0].ProjectID != "p2" {
		t.Fatalf("project filter total=%d", *p.Total)
	}
	if p := page("?state=failed&limit=200"); *p.Total != 12 {
		t.Fatalf("failed filter total=%d", *p.Total)
	}
	if p := page("?state=fallback"); *p.Total != 1 || p.Items[0].ID != "call-007" {
		t.Fatal("fallback filter")
	}
	if p := page("?model=alias:alias-p1&limit=200"); *p.Total != 80 {
		t.Fatalf("model filter total=%d", *p.Total)
	}
	if p := page("?q=call-11"); *p.Total != 10 {
		t.Fatalf("summary search total=%d", *p.Total)
	}
	if p := page("?q=needle-in-body"); len(p.Items) != 0 {
		t.Fatal("summary search must not read bodies")
	}
	if p := page("?q=needle-in-body&body=1"); len(p.Items) != 1 || p.Items[0].ID != "call-042" || p.BodySearch != "complete" || p.Total != nil {
		t.Fatalf("body search %+v", p)
	}
	if p := page("?q=100%25_"); len(p.Items) != 0 {
		t.Fatal("LIKE wildcards must be escaped")
	}
	h.want(h.request("GET", "/api/admin/requests?cursor=bad", nil, "", true), 400)
	h.want(h.request("GET", "/api/admin/requests?limit=500", nil, "", true), 400)
	h.want(h.request("GET", "/api/admin/requests?state=odd", nil, "", true), 400)
}

func TestRetentionPurgesBodiesAndRollsUpSummaries(t *testing.T) {
	h, m := pricedHarness(t)
	p := h.project("A", m.ID)
	h.want(h.request("PUT", "/api/admin/settings", map[string]any{"body_days": 1, "summary_days": 62}, "", true), 200)
	now := time.Now()
	old := Record{ID: "old-summary", ProjectID: p.Project.ID, ProjectName: "A", ModelID: m.ID, Alias: m.Alias, Protocol: "chat", State: "complete", Started: now.AddDate(0, 0, -70).UnixMilli(), InputTokens: 1_000_000, OutputTokens: 500_000, MetricsFields: MetricsFields{MetricsVersion: 1, Forwarded: true, OutputReported: true, UsageStatus: "complete"}}
	total := int64(1_000_000)
	old.InputTotal = &total
	old.Category = "chat"
	mid := old
	mid.ID, mid.Started = "old-body", now.AddDate(0, 0, -3).UnixMilli()
	fresh := old
	fresh.ID, fresh.Started = "fresh", now.UnixMilli()
	for _, rec := range []Record{old, mid, fresh} {
		h.g.saveMetric(rec)
		raw, _ := json.Marshal(rec)
		if _, err := h.g.db.Exec("INSERT INTO requests(id,project_id,started,summary,record) VALUES(?,?,?,?,?)", rec.ID, rec.ProjectID, rec.Started, string(raw), string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	before := parse[usageReply](t, h.request("GET", "/api/admin/usage?period=all", nil, "", true))
	rr := h.request("POST", "/api/admin/maintenance/cleanup", nil, "", true)
	h.want(rr, 200)
	d := parse[maintenanceDetail](t, rr)
	if d.Bodies != 2 || d.Summaries != 1 || d.RolledDays < 1 || d.Status != "ok" {
		t.Fatalf("cleanup %+v", d)
	}
	var bodies, summaries, rollups int
	h.g.db.QueryRow("SELECT count(*) FROM requests").Scan(&bodies)
	h.g.db.QueryRow("SELECT count(*) FROM request_metrics").Scan(&summaries)
	h.g.db.QueryRow("SELECT count(*) FROM usage_daily").Scan(&rollups)
	if bodies != 1 || summaries != 2 || rollups != 1 {
		t.Fatalf("bodies=%d summaries=%d rollups=%d", bodies, summaries, rollups)
	}
	detail := parse[Record](t, h.request("GET", "/api/admin/requests/old-body", nil, "", true))
	if !detail.RecordMissing || !detail.BodyPurged || detail.InputTokens != 1_000_000 {
		t.Fatalf("purged body detail %+v", detail)
	}
	after := parse[usageReply](t, h.request("GET", "/api/admin/usage?period=all&group_by=project", nil, "", true))
	if after.Total.Requests != before.Total.Requests || !near(after.Total.Cost, before.Total.Cost) || len(after.Groups) != 1 || after.Groups[0].Requests != 3 {
		t.Fatalf("rollup changed totals: before %+v after %+v", before.Total, after)
	}
	sys := h.request("GET", "/api/admin/system", nil, "", true)
	h.want(sys, 200)
	if !strings.Contains(sys.Body.String(), `"kind":"cleanup"`) {
		t.Fatal("cleanup not logged")
	}
	h.want(h.request("PUT", "/api/admin/settings", map[string]any{"summary_days": 30}, "", true), 400)
	h.want(h.request("PUT", "/api/admin/settings", map[string]any{"body_days": 90, "summary_days": 62}, "", true), 400)
}

func TestProjectRateAndConcurrencyLimits(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-limit-secret")
	m := h.model(c, "limited")
	var hits atomic.Int32
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		hits.Add(1)
		return response(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`, "application/json", 200), nil
	})
	p := h.project("defaults", m.ID)
	if positive(p.Project.RateRPM) != 60 || positive(p.Project.MaxConcurrent) != 4 {
		t.Fatalf("new project defaults %+v", p.Project.ProjectLimits)
	}
	two, one := 2, 1
	project := p.Project
	project.RateRPM, project.RateBurst = &two, &two
	h.want(h.request("PUT", "/api/admin/projects/"+project.ID, project, "", true), 200)
	h.want(h.call(m.Alias, p.Token, nil), 200)
	h.want(h.call(m.Alias, p.Token, nil), 200)
	rr := h.call(m.Alias, p.Token, nil)
	h.want(rr, 429)
	if rr.Header().Get("Retry-After") == "" || !strings.Contains(rr.Body.String(), `"code":"project_rate_limit"`) || hits.Load() != 2 {
		t.Fatalf("rate rejection %s hits=%d", rr.Body.String(), hits.Load())
	}
	recs := h.records(3)
	if recs[0].ErrorType != "project_rate_limit" || recs[0].Forwarded || recs[0].Diagnostic == nil || recs[0].Diagnostic.Phase != "admission" {
		t.Fatalf("rejection record %+v", recs[0])
	}
	// Older clients that omit limits keep the stored values.
	omitted := map[string]any{"name": project.Name, "enabled": true, "model_ids": project.ModelIDs}
	h.want(h.request("PUT", "/api/admin/projects/"+project.ID, omitted, "", true), 200)
	h.want(h.call(m.Alias, p.Token, nil), 429)
	// Messages callers get the Anthropic error shape.
	mc := h.connection("https://upstream-msg.test/v1", "messages", "fake-limit-secret")
	mm := h.model(mc, "limited-msg")
	project.ModelIDs = append(project.ModelIDs, mm.ID)
	h.want(h.request("PUT", "/api/admin/projects/"+project.ID, project, "", true), 200)
	msg := h.request("POST", "/v1/messages", map[string]any{"model": mm.Alias, "max_tokens": 8, "messages": []any{map[string]string{"role": "user", "content": "hi"}}}, p.Token, false)
	h.want(msg, 429)
	if !strings.Contains(msg.Body.String(), `"type":"rate_limit_error"`) {
		t.Fatal(msg.Body.String())
	}

	// Concurrency: a second call while the first is still upstream is refused.
	q := h.project("concurrency", m.ID)
	cp := q.Project
	zero := 0
	cp.RateRPM, cp.MaxConcurrent = &zero, &one
	h.want(h.request("PUT", "/api/admin/projects/"+cp.ID, cp, "", true), 200)
	release, entered := make(chan struct{}), make(chan struct{}, 1)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		entered <- struct{}{}
		<-release
		return response(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`, "application/json", 200), nil
	})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); h.call(m.Alias, q.Token, nil) }()
	<-entered
	second := h.call(m.Alias, q.Token, nil)
	h.want(second, 429)
	if !strings.Contains(second.Body.String(), "project_concurrency") {
		t.Fatal(second.Body.String())
	}
	if u := h.g.limitUsage()[cp.ID]; u.Inflight != 1 || u.Limited != 1 {
		t.Fatalf("usage %+v", u)
	}
	close(release)
	wg.Wait()
	if u := h.g.limitUsage()[cp.ID]; u.Inflight != 0 {
		t.Fatal("slot not released")
	}
	bad := cp
	neg := -1
	bad.MaxConcurrent = &neg
	h.want(h.request("PUT", "/api/admin/projects/"+cp.ID, bad, "", true), 400)
}

type fallbackFixture struct {
	h                  *harness
	primary, secondary Model
	primaryHits        atomic.Int32
	primaryStatus      atomic.Int32
}

func newFallbackFixture(t *testing.T) *fallbackFixture {
	f := &fallbackFixture{h: newHarness(t)}
	h := f.h
	ca := h.connection("https://primary.test/v1", "chat", "fake-primary-secret")
	cb := h.connection("https://secondary.test/v1", "chat", "fake-secondary-secret")
	f.primary, f.secondary = h.model(ca, "main"), h.model(cb, "backup")
	f.primaryStatus.Store(429)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "primary.test" {
			f.primaryHits.Add(1)
			status := int(f.primaryStatus.Load())
			if status == 0 {
				return nil, context.DeadlineExceeded
			}
			res := response(`{"error":{"message":"busy"}}`, "application/json", status)
			res.Header.Set("Retry-After", "30")
			return res, nil
		}
		return response(`{"choices":[{"message":{"content":"from backup"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`, "application/json", 200), nil
	})
	f.primary.FallbackModelID = f.secondary.ID
	h.want(h.request("PUT", "/api/admin/models/"+f.primary.ID, f.primary, "", true), 200)
	return f
}

func TestFallbackServesAfterRateLimitAndOpensBreaker(t *testing.T) {
	f := newFallbackFixture(t)
	h := f.h
	p := h.project("both", f.primary.ID, f.secondary.ID)
	rr := h.call(f.primary.Alias, p.Token, nil)
	h.want(rr, 200)
	if rr.Header().Get("X-Gateway-Fallback") != "main -> backup" || !strings.Contains(rr.Body.String(), "from backup") {
		t.Fatalf("fallback response %v %s", rr.Header(), rr.Body.String())
	}
	rec := h.records(1)[0]
	if rec.FallbackFrom != "main" || rec.Alias != "backup" || rec.State != "complete" || len(rec.Attempts) != 2 || rec.Attempts[0].Status != 429 || rec.Attempts[0].Outcome != "failed" || rec.Attempts[1].Outcome != "served" {
		t.Fatalf("fallback record %+v", rec)
	}
	// The 429 opened the breaker: the next call goes straight to the backup.
	h.want(h.call(f.primary.Alias, p.Token, nil), 200)
	if f.primaryHits.Load() != 1 {
		t.Fatalf("breaker did not skip the primary: %d hits", f.primaryHits.Load())
	}
	if recs := h.records(2); recs[0].Attempts[0].Outcome != "skipped_breaker" {
		t.Fatalf("breaker attempt %+v", recs[0].Attempts)
	}
	health := parse[struct{ Connections []ConnectionHealth }](t, h.request("GET", "/api/admin/health", nil, "", true))
	if health.Connections[0].State != "degraded" || health.Connections[0].BreakerUntil == 0 {
		t.Fatalf("health %+v", health.Connections[0])
	}
}

func TestFallbackRequiresGrantAndSkipsRequestErrors(t *testing.T) {
	f := newFallbackFixture(t)
	h := f.h
	only := h.project("primary-only", f.primary.ID)
	rr := h.call(f.primary.Alias, only.Token, nil)
	h.want(rr, 429)
	rec := h.records(1)[0]
	if len(rec.Attempts) != 2 || rec.Attempts[1].Outcome != "not_granted" || rec.FallbackFrom != "" {
		t.Fatalf("not granted record %+v", rec.Attempts)
	}
	// The 429 above opened the primary's breaker; close it to observe the 400.
	h.g.healthMu.Lock()
	h.g.health = map[string]*connHealth{}
	h.g.healthMu.Unlock()
	f.primaryStatus.Store(400)
	both := h.project("both", f.primary.ID, f.secondary.ID)
	h.want(h.call(f.primary.Alias, both.Token, nil), 400)
	if recs := h.records(2); len(recs[0].Attempts) != 0 {
		t.Fatal("a request error must not trigger the fallback")
	}
}

func TestFallbackOnConnectionFailureAndValidation(t *testing.T) {
	f := newFallbackFixture(t)
	h := f.h
	f.primaryStatus.Store(0) // transport error
	p := h.project("both", f.primary.ID, f.secondary.ID)
	h.want(h.call(f.primary.Alias, p.Token, nil), 200)
	self := f.secondary
	self.FallbackModelID = self.ID
	h.want(h.request("PUT", "/api/admin/models/"+self.ID, self, "", true), 400)
	mutual := f.secondary
	mutual.FallbackModelID = f.primary.ID
	h.want(h.request("PUT", "/api/admin/models/"+mutual.ID, mutual, "", true), 400)
	mc := h.connection("https://messages.test/v1", "messages", "fake-messages-secret")
	mm := h.model(mc, "messages-only")
	mixed := f.primary
	mixed.FallbackModelID = mm.ID
	h.want(h.request("PUT", "/api/admin/models/"+mixed.ID, mixed, "", true), 400)
	h.want(h.request("DELETE", "/api/admin/models/"+f.secondary.ID, nil, "", true), 200)
	state := parse[struct{ Models []Model }](t, h.request("GET", "/api/admin/state", nil, "", true))
	for _, m := range state.Models {
		if m.ID == f.primary.ID && m.FallbackModelID != "" {
			t.Fatal("deleting a fallback target left a dangling reference")
		}
	}
}

func TestConnectionHealthStatesAndProbe(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://health.test/v1", "chat", "fake-health-secret")
	state := func() ConnectionHealth {
		t.Helper()
		v, err := h.g.healthView()
		if err != nil {
			t.Fatal(err)
		}
		for _, x := range v {
			if x.ID == c.ID {
				return x
			}
		}
		t.Fatal("connection missing from health view")
		return ConnectionHealth{}
	}
	if s := state(); s.State != "unknown" || !s.ProbeSupported || len(s.Buckets) != healthBuckets {
		t.Fatalf("initial %+v", s)
	}
	for i := 0; i < 3; i++ {
		h.g.observeUpstream(c.ID, 0, true, "")
	}
	if s := state(); s.State != "down" || s.BreakerUntil == 0 {
		t.Fatalf("down %+v", s)
	}
	h.g.observeUpstream(c.ID, 401, false, "")
	if s := state(); s.State != "auth" {
		t.Fatalf("auth %+v", s)
	}
	var probed string
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		probed = r.Method + " " + r.URL.Path
		return response(`{"data":[]}`, "application/json", 200), nil
	})
	rr := h.request("POST", "/api/admin/connections/"+c.ID+"/probe", nil, "", true)
	h.want(rr, 200)
	if res := parse[probeResult](t, rr); !res.OK || probed != "GET /v1/models" {
		t.Fatalf("probe %+v %s", res, probed)
	}
	if s := state(); s.LastProbe == nil || !s.LastProbe.OK {
		t.Fatalf("probe not recorded %+v", s)
	}
	// Probes never become request records.
	if rr := h.request("GET", "/api/admin/requests", nil, "", true); *parse[requestPage](t, rr).Total != 0 {
		t.Fatal("probe created a request record")
	}
	h.g.flushHealth()
	var rows int
	h.g.db.QueryRow("SELECT count(*) FROM connection_health").Scan(&rows)
	if rows == 0 {
		t.Fatal("health buckets not persisted")
	}
	_ = httptest.NewRecorder
}
