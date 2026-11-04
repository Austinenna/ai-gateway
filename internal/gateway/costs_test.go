package gateway

import (
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func f(v float64) *float64 { return &v }
func n(v int64) *int64     { return &v }

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestCostOfProtocolsAndVersions(t *testing.T) {
	book := priceBook{
		"chat": {{EffectiveFrom: 0, Input: f(2), Output: f(8), CacheRead: f(0.5)}, {EffectiveFrom: 1000, Input: f(4), Output: f(16)}},
		"msg":  {{EffectiveFrom: 0, Input: f(3), Output: f(15), CacheRead: f(0.3), CacheWrite: f(3.75)}},
		"asr":  {{EffectiveFrom: 0, AudioMinute: f(0.6)}},
		"web":  {{EffectiveFrom: 0, PerCall: f(0.02)}},
	}
	done := func(rec Record) Record {
		rec.Forwarded, rec.State, rec.MetricsVersion = true, "complete", 1
		return rec
	}
	// Chat: prompt total includes cached tokens.
	chat := done(Record{ModelID: "chat", Protocol: "chat", Started: 10, OutputTokens: 1_000_000, MetricsFields: MetricsFields{InputTotal: n(3_000_000), CacheRead: n(1_000_000), InputUncached: n(2_000_000), OutputReported: true}})
	if c := costOf(chat, book); c.Status != "priced" || !near(c.Amount, 2*2+0.5+8) || *c.PriceFrom != 0 {
		t.Fatalf("chat cost %+v", c)
	}
	// A later version applies from its effective time; missing cache price falls back to input.
	chat.Started = 1000
	if c := costOf(chat, book); !near(c.Amount, 2*4+4+16) {
		t.Fatalf("versioned cost %+v", c)
	}
	msg := done(Record{ModelID: "msg", Protocol: "messages", OutputTokens: 100_000, MetricsFields: MetricsFields{InputUncached: n(1_000_000), CacheRead: n(2_000_000), CacheWrite: n(1_000_000), OutputReported: true}})
	if c := costOf(msg, book); c.Status != "priced" || !near(c.Amount, 3+0.6+3.75+1.5) {
		t.Fatalf("messages cost %+v", c)
	}
	asr := done(Record{ModelID: "asr", Protocol: "dashscope-asr", MetricsFields: MetricsFields{AudioSeconds: f(90)}})
	if c := costOf(asr, book); c.Status != "priced" || !near(c.Amount, 0.9) {
		t.Fatalf("asr cost %+v", c)
	}
	web := done(Record{ModelID: "web", Protocol: "deepseek-search"})
	if c := costOf(web, book); c.Status != "priced" || !near(c.Amount, 0.02) {
		t.Fatalf("web cost %+v", c)
	}
	web.State = "error"
	if c := costOf(web, book); c.Status != "priced" || c.Amount != 0 {
		t.Fatalf("failed web call should be free %+v", c)
	}
	// Interrupted stream: input known, output never reported.
	partial := done(Record{ModelID: "chat", Protocol: "chat", Started: 10, MetricsFields: MetricsFields{InputTotal: n(1_000_000), InputUncached: n(1_000_000)}})
	if c := costOf(partial, book); c.Status != "partial" || !near(c.Amount, 2) {
		t.Fatalf("partial cost %+v", c)
	}
	unknown := done(Record{ModelID: "chat", Protocol: "chat", Started: 10})
	if c := costOf(unknown, book); c.Status != "usage_unknown" {
		t.Fatalf("unknown usage %+v", c)
	}
	if c := costOf(done(Record{ModelID: "other", Protocol: "chat"}), book); c.Status != "unpriced" {
		t.Fatalf("unpriced %+v", c)
	}
	if c := costOf(Record{ModelID: "chat", Protocol: "chat", State: "rejected"}, book); c.Status != "none" {
		t.Fatalf("not forwarded %+v", c)
	}
}

func TestUsageRangePeriods(t *testing.T) {
	now := time.Date(2026, 3, 15, 1, 0, 0, 0, time.UTC) // 09:00 in Shanghai
	r, err := parseUsageRange(map[string][]string{"period": {"today"}}, now)
	if err != nil || r.from != time.Date(2026, 3, 15, 0, 0, 0, 0, costZone).UnixMilli() {
		t.Fatalf("today %v %v", r, err)
	}
	r, err = parseUsageRange(map[string][]string{"period": {"last_month"}}, now)
	if err != nil || r.from != time.Date(2026, 2, 1, 0, 0, 0, 0, costZone).UnixMilli() || r.to != time.Date(2026, 3, 1, 0, 0, 0, 0, costZone).UnixMilli() {
		t.Fatalf("last month %v %v", r, err)
	}
	r, err = parseUsageRange(map[string][]string{"from": {"2026-03-01"}, "to": {"2026-03-02"}}, now)
	if err != nil || r.to-r.from != 24*3600*1000 {
		t.Fatalf("dates %v %v", r, err)
	}
	if _, err = parseUsageRange(map[string][]string{"period": {"month"}, "from": {"2026-03-01"}}, now); err == nil {
		t.Fatal("period with from should be rejected")
	}
}

type usageReply struct {
	Total  CostTotals   `json:"total"`
	Groups []usageGroup `json:"groups"`
	Calls  []usageCall  `json:"requests"`
	Budget BudgetStatus `json:"budget"`
}

func (h *harness) taggedCall(alias, token, category, task string) *httptest.ResponseRecorder {
	h.t.Helper()
	body := `{"model":"` + alias + `","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "http://gateway.test/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if category != "" {
		req.Header.Set("X-Gateway-Category", category)
	}
	if task != "" {
		req.Header.Set("X-Gateway-Task-ID", task)
	}
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, req)
	return rr
}

func pricedHarness(t *testing.T) (*harness, Model) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-cost-secret")
	m := h.model(c, "priced")
	m.Prices = []ModelPrice{{EffectiveFrom: 0, Input: f(1), Output: f(2)}}
	rr := h.request("PUT", "/api/admin/models/"+m.ID, m, "", true)
	h.want(rr, 200)
	if saved := parse[Model](t, rr); len(saved.Prices) != 1 || *saved.Prices[0].Output != 2 {
		t.Fatalf("prices not saved: %+v", saved.Prices)
	}
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		// 1M input + 0.5M output = ¥2 per call.
		return response(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000000,"completion_tokens":500000}}`, "application/json", 200), nil
	})
	return h, m
}

func TestUsageAPIGroupsAndProjectIsolation(t *testing.T) {
	h, m := pricedHarness(t)
	a := h.project("A", m.ID)
	b := h.project("B", m.ID)
	h.want(h.taggedCall(m.Alias, a.Token, "note", "work-1"), 200)
	h.want(h.taggedCall(m.Alias, a.Token, "note", "work-2"), 200)
	h.want(h.taggedCall(m.Alias, a.Token, "router", "work-1"), 200)
	h.want(h.taggedCall(m.Alias, b.Token, "", ""), 200)
	h.records(4)

	rr := h.request("GET", "/v1/usage?period=month&group_by=category", nil, a.Token, false)
	h.want(rr, 200)
	got := parse[usageReply](t, rr)
	if got.Total.Requests != 3 || !near(got.Total.Cost, 6) || len(got.Groups) != 2 || got.Groups[0].Key != "note" || !near(got.Groups[0].Cost, 4) {
		t.Fatalf("category usage %+v", got)
	}
	rr = h.request("GET", "/v1/usage?group_by=task&task=work-1", nil, a.Token, false)
	h.want(rr, 200)
	if got = parse[usageReply](t, rr); got.Total.Requests != 2 || len(got.Groups) != 1 || got.Groups[0].Key != "work-1" {
		t.Fatalf("task usage %+v", got)
	}
	rr = h.request("GET", "/v1/usage?group_by=request&limit=1", nil, a.Token, false)
	h.want(rr, 200)
	if got = parse[usageReply](t, rr); len(got.Calls) != 1 || got.Calls[0].ProjectID != a.Project.ID || !near(got.Calls[0].Cost.Amount, 2) {
		t.Fatalf("request usage %+v", got)
	}
	h.want(h.request("GET", "/v1/usage?project_id="+b.Project.ID, nil, a.Token, false), 403)
	h.want(h.request("GET", "/v1/usage", nil, "", false), 401)

	rr = h.request("GET", "/api/admin/usage?period=all&group_by=project", nil, "", true)
	h.want(rr, 200)
	if got = parse[usageReply](t, rr); got.Total.Requests != 4 || len(got.Groups) != 2 || got.Groups[0].Label != "A" {
		t.Fatalf("admin usage %+v", got)
	}
	// The task workspace groups header-tagged calls and shows their cost.
	rr = h.request("GET", "/api/admin/request-tasks", nil, "", true)
	h.want(rr, 200)
	tasks := parse[struct{ Tasks []RequestTask }](t, rr).Tasks
	if len(tasks) != 2 || tasks[0].Cost == nil {
		t.Fatalf("tasks %+v", tasks)
	}
	if rec := h.records(4)[0]; rec.Cost == nil || rec.Cost.Status != "priced" {
		t.Fatalf("record cost %+v", rec.Cost)
	}
}

func TestInvalidUsageTagRejected(t *testing.T) {
	h, m := pricedHarness(t)
	p := h.project("A", m.ID)
	rr := h.taggedCall(m.Alias, p.Token, "bad tag!", "")
	h.want(rr, 400)
	if !strings.Contains(rr.Body.String(), "X-Gateway-Category") {
		t.Fatal(rr.Body.String())
	}
}

func TestMonthlyBudgetRejectsAndRecovers(t *testing.T) {
	h, m := pricedHarness(t)
	p := h.project("A", m.ID)
	project := p.Project
	project.MonthlyBudget = f(3)
	h.want(h.request("PUT", "/api/admin/projects/"+project.ID, project, "", true), 200)
	h.want(h.taggedCall(m.Alias, p.Token, "", ""), 200) // spent 2
	h.want(h.taggedCall(m.Alias, p.Token, "", ""), 200) // spent 4, over budget afterwards
	rr := h.taggedCall(m.Alias, p.Token, "", "")
	h.want(rr, 402)
	if !strings.Contains(rr.Body.String(), "budget_exceeded") || !strings.Contains(rr.Body.String(), "本月预算 ¥3") {
		t.Fatal(rr.Body.String())
	}
	rr = h.request("GET", "/v1/usage", nil, p.Token, false)
	h.want(rr, 200)
	if b := parse[usageReply](t, rr).Budget; !b.Exceeded || !near(b.MonthSpent, 4) || *b.Remaining != 0 {
		t.Fatalf("budget status %+v", b)
	}
	recs := h.records(3)
	if recs[0].ErrorType != "budget_exceeded" || recs[0].Diagnostic == nil || recs[0].Diagnostic.Code != "budget_exceeded" || recs[0].Forwarded {
		t.Fatalf("rejection record %+v", recs[0])
	}
	project.MonthlyBudget = f(10)
	h.want(h.request("PUT", "/api/admin/projects/"+project.ID, project, "", true), 200)
	h.want(h.taggedCall(m.Alias, p.Token, "", ""), 200)
	project.MonthlyBudget = f(-1)
	h.want(h.request("PUT", "/api/admin/projects/"+project.ID, project, "", true), 400)
}

func TestPriceValidation(t *testing.T) {
	h, m := pricedHarness(t)
	for _, prices := range [][]ModelPrice{
		{{EffectiveFrom: 0}},
		{{EffectiveFrom: 0, Input: f(-1)}},
		{{EffectiveFrom: 5, Input: f(1)}, {EffectiveFrom: 5, Input: f(2)}},
	} {
		m.Prices = prices
		h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 400)
	}
	// Omitting prices keeps the stored versions.
	m.Prices = nil
	rr := h.request("PUT", "/api/admin/models/"+m.ID, m, "", true)
	h.want(rr, 200)
	if saved := parse[Model](t, rr); len(saved.Prices) != 1 {
		t.Fatalf("prices dropped: %+v", saved.Prices)
	}
}

func TestCostsV9Migration(t *testing.T) {
	h := newHarness(t)
	p := h.project("old")
	if _, err := h.g.db.Exec("DROP TABLE model_prices; ALTER TABLE projects DROP COLUMN monthly_budget; PRAGMA user_version=9;"); err != nil {
		t.Fatal(err)
	}
	restartHarness(t, h)
	ps, err := h.g.projects()
	if err != nil || len(ps) != 1 || ps[0].ID != p.Project.ID || ps[0].MonthlyBudget != nil {
		t.Fatalf("migration should keep projects without budgets: %v %+v", err, ps)
	}
	var version int
	if err = h.g.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 10 {
		t.Fatalf("version=%d err=%v", version, err)
	}
}
