package gateway

import (
	"encoding/json"
	"math"
	"net/http"
	"testing"
	"time"
)

func priceNumber(n float64) *float64 { return &n }
func testPricing() *ModelPricing {
	return &ModelPricing{Mode: "token", Currency: "CNY", CacheMode: "separate", Input: priceNumber(2), Output: priceNumber(8), CacheRead: priceNumber(.2), CacheWrite: priceNumber(2.5)}
}

func TestRequestCostAccounting(t *testing.T) {
	for _, tc := range []struct {
		name, protocol, usage, state string
		mode                         string
		modify                       func(*Record, *ModelPricing)
		status                       string
		amount                       *float64
	}{
		{name: "chat cache not double counted", protocol: "chat", usage: `{"usage":{"prompt_tokens":10000,"completion_tokens":1000,"prompt_tokens_details":{"cached_tokens":8000}}}`, status: "complete", amount: priceNumber(.0136)},
		{name: "DeepSeek native cache", protocol: "chat", usage: `{"usage":{"prompt_tokens":10000,"completion_tokens":1000,"prompt_cache_hit_tokens":8000}}`, status: "complete", amount: priceNumber(.0136)},
		{name: "messages creation", protocol: "messages", usage: `{"usage":{"input_tokens":2000,"cache_read_input_tokens":8000,"cache_creation_input_tokens":1000,"output_tokens":1000}}`, status: "complete", amount: priceNumber(.0161)},
		{name: "M3 automatic cache", protocol: "messages", usage: `{"usage":{"input_tokens":2000,"cache_read_input_tokens":8000,"output_tokens":1000}}`, modify: func(r *Record, p *ModelPricing) { r.Provider = "minimax"; r.UpstreamModel = "MiniMax-M3" }, status: "complete", amount: priceNumber(.0136)},
		{name: "uniform unknown cache", protocol: "chat", mode: "uniform", usage: `{"usage":{"prompt_tokens":10000,"completion_tokens":1000}}`, status: "complete", amount: priceNumber(.028)},
		{name: "missing cache split", protocol: "chat", usage: `{"usage":{"prompt_tokens":10000,"completion_tokens":1000}}`, status: "partial", amount: priceNumber(.008)},
		{name: "missing cache price", protocol: "chat", usage: `{"usage":{"prompt_tokens":10000,"completion_tokens":1000,"prompt_tokens_details":{"cached_tokens":8000}}}`, modify: func(r *Record, p *ModelPricing) { p.CacheRead = nil }, status: "partial", amount: priceNumber(.012)},
		{name: "zero cache needs no price", protocol: "chat", usage: `{"usage":{"prompt_tokens":10000,"completion_tokens":1000,"prompt_tokens_details":{"cached_tokens":0}}}`, modify: func(r *Record, p *ModelPricing) { p.CacheRead = nil }, status: "complete", amount: priceNumber(.028)},
		{name: "explicit zero", protocol: "chat", mode: "uniform", usage: `{"usage":{"prompt_tokens":0,"completion_tokens":0}}`, status: "complete", amount: priceNumber(0)},
		{name: "missing usage", protocol: "chat", usage: `{}`, status: "unknown"},
		{name: "failed calls can cost", protocol: "chat", mode: "uniform", state: "error", usage: `{"usage":{"prompt_tokens":10000,"completion_tokens":1000}}`, status: "partial", amount: priceNumber(.028)},
		{name: "start usage not final", protocol: "messages", usage: `{"type":"message_start","message":{"usage":{"input_tokens":2000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}}`, status: "partial", amount: priceNumber(.004)},
		{name: "inconsistent cache", protocol: "chat", usage: `{"usage":{"prompt_tokens":1,"completion_tokens":1000,"prompt_tokens_details":{"cached_tokens":10}}}`, status: "partial", amount: priceNumber(.008)},
		{name: "subscription not free", protocol: "chat", usage: `{}`, modify: func(r *Record, p *ModelPricing) { p.Mode = "subscription" }, status: "subscription"},
		{name: "unpriced", protocol: "chat", usage: `{}`, modify: func(r *Record, p *ModelPricing) { p.Mode = "unconfigured" }, status: "unconfigured"},
		{name: "preflight rejection", protocol: "chat", usage: `{}`, modify: func(r *Record, p *ModelPricing) { r.Forwarded = false }, status: "not_forwarded"},
		{name: "demo", protocol: "chat", usage: `{}`, modify: func(r *Record, p *ModelPricing) { r.Provider = "demo" }, status: "demo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := testPricing()
			if tc.mode != "" {
				p.CacheMode = tc.mode
			}
			r := Record{Protocol: tc.protocol, State: "complete", MetricsFields: MetricsFields{Forwarded: true}, Cost: &RequestCost{Pricing: p}}
			if tc.state != "" {
				r.State = tc.state
			}
			if tc.modify != nil {
				tc.modify(&r, p)
			}
			r.readUsage([]byte(tc.usage))
			finalizeUsage(&r)
			c := calculateCost(&r)
			if c.Status != tc.status || (c.Amount == nil) != (tc.amount == nil) || (c.Amount != nil && math.Abs(*c.Amount-*tc.amount) > 1e-9) {
				t.Fatalf("got %+v amount %v, expected %s %v", c, c.Amount, tc.status, tc.amount)
			}
		})
	}
}

func TestPricingValidation(t *testing.T) {
	for _, mutate := range []func(*ModelPricing){
		func(p *ModelPricing) { p.Input = nil }, func(p *ModelPricing) { p.Input = priceNumber(-1) }, func(p *ModelPricing) { p.Output = priceNumber(math.Inf(1)) }, func(p *ModelPricing) { p.Currency = "EUR" }, func(p *ModelPricing) { p.Source = "javascript:alert(1)" }, func(p *ModelPricing) { p.Source = "https://name:password@example.com" }, func(p *ModelPricing) { p.CacheMode = "guess" }, func(p *ModelPricing) { p.Mode = "free" },
	} {
		p := testPricing()
		mutate(p)
		if _, err := preparePricing(p, nil); err == nil {
			t.Fatal("accepted invalid price")
		}
	}
	p := testPricing()
	p.Input = priceNumber(0)
	p.Source = "https://example.com/pricing"
	got, err := preparePricing(p, nil)
	if err != nil || got.UpdatedAt == 0 {
		t.Fatal("valid zero rejected", err)
	}
	old := *got
	copy := *got
	copy.UpdatedAt = 1
	got, err = preparePricing(&copy, &old)
	if err != nil || got.UpdatedAt != old.UpdatedAt {
		t.Fatal("unchanged price version lost")
	}
}

func TestPricingSnapshotsFiltersAndRestart(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-price-key")
	m := h.model(c, "cost-model")
	p := h.project("费用项目", m.ID)
	m.Pricing = testPricing()
	m.Pricing.CacheMode = "uniform"
	save := func() {
		rr := h.request("PUT", "/api/admin/models/"+m.ID, m, "", true)
		h.want(rr, 200)
		m = parse[Model](t, rr)
	}
	save()
	var calls int
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			m.Pricing.Input = priceNumber(20)
			save()
		} // Edit while the old request is in flight.
		return response(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10000,"completion_tokens":1000}}`, "application/json", 200), nil
	})
	first := h.call(m.Alias, p.Token, nil)
	h.want(first, 200)
	firstID := first.Header().Get("X-Request-ID")
	h.want(h.call(m.Alias, p.Token, nil), 200)
	m.Pricing.Currency = "USD"
	save()
	h.want(h.call(m.Alias, p.Token, nil), 200)
	m.Pricing = &ModelPricing{Mode: "subscription", Note: "已有套餐"}
	save()
	h.want(h.call(m.Alias, p.Token, nil), 200)
	m.Pricing = &ModelPricing{Mode: "unconfigured"}
	save()
	h.want(h.call(m.Alias, p.Token, nil), 200)
	h.want(h.call(m.Alias, "invalid", nil), 401)
	h.g.saveMetric(Record{ID: "historical-cost", ProjectID: p.Project.ID, ProjectName: p.Project.Name, ModelID: m.ID, Started: time.Now().UnixMilli(), State: "complete", MetricsFields: MetricsFields{MetricsVersion: 1, Forwarded: true, ConnectionID: c.ID}})
	h.records(6)
	check := func() {
		got := getMetrics(t, h, "?window=all&project_id="+p.Project.ID)
		cost := got.Summary.Cost
		if cost.Complete != 3 || cost.Subscription != 1 || cost.Unconfigured != 1 || cost.Historical != 1 || cost.Eligible != 6 || math.Abs(cost.Amounts["CNY"]-.236) > 1e-9 || math.Abs(cost.Amounts["USD"]-.208) > 1e-9 {
			t.Fatalf("wrong cost aggregate %+v", cost)
		}
		rr := h.request("GET", "/api/admin/requests/"+firstID, nil, "", true)
		h.want(rr, 200)
		rec := parse[Record](t, rr)
		if rec.Cost == nil || rec.Cost.Amount == nil || *rec.Cost.Amount != .028 || *rec.Cost.Pricing.Input != 2 {
			t.Fatalf("historical snapshot changed %+v", rec.Cost)
		}
		var result struct {
			Projects []metricProject `json:"projects"`
		}
		json.Unmarshal(h.request("GET", "/api/admin/metrics?window=all&project_id="+p.Project.ID, nil, "", true).Body.Bytes(), &result)
		if len(result.Projects) != 1 || result.Projects[0].Cost.Complete != 3 {
			t.Fatal("project costs missing")
		}
		if getMetrics(t, h, "?stream=true").Summary.Cost.Eligible != 0 {
			t.Fatal("cost filters diverged")
		}
	}
	check()
	restartHarness(t, h)
	check()
	h.want(h.request("GET", "/api/admin/metrics", nil, p.Token, false), 401)
}

func TestPricingUpgradeAndOmittedEdits(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-price-key")
	m := h.model(c, "price-migrate")
	if _, err := h.g.db.Exec("ALTER TABLE models DROP COLUMN pricing_json; PRAGMA user_version=5;"); err != nil {
		t.Fatal(err)
	}
	restartHarness(t, h)
	models, err := h.g.models()
	if err != nil || len(models) != 1 || models[0].Pricing != nil {
		t.Fatal("migration did not preserve model", err)
	}
	m.Pricing = testPricing()
	rr := h.request("PUT", "/api/admin/models/"+m.ID, m, "", true)
	h.want(rr, 200)
	m.Pricing = nil
	m.Name = "改名保留价格"
	rr = h.request("PUT", "/api/admin/models/"+m.ID, m, "", true)
	h.want(rr, 200)
	if parse[Model](t, rr).Pricing == nil {
		t.Fatal("old client erased pricing")
	}
	m.UpstreamModel = "different-model"
	rr = h.request("PUT", "/api/admin/models/"+m.ID, m, "", true)
	h.want(rr, 200)
	if parse[Model](t, rr).Pricing != nil {
		t.Fatal("old price carried to different upstream")
	}
}

func TestCostAggregateUnknownRecoveryAndZero(t *testing.T) {
	a := CostAggregate{}
	a.add(Record{State: "interrupted", MetricsFields: MetricsFields{MetricsVersion: 1}})
	a.add(Record{State: "rejected", MetricsFields: MetricsFields{MetricsVersion: 1}})
	a.add(Record{State: "running"})
	a.add(Record{State: "complete", MetricsFields: MetricsFields{MetricsVersion: 1, Forwarded: true}, Cost: &RequestCost{Status: "complete", Currency: "CNY", Amount: priceNumber(0)}})
	if a.Eligible != 2 || a.Unknown != 1 || a.Complete != 1 || a.Historical != 0 || a.Pending != 1 {
		t.Fatalf("interrupted/unknown misclassified: %+v", a)
	}
	if amount, present := a.Amounts["CNY"]; !present || amount != 0 {
		t.Fatal("explicit zero disappeared from currency totals")
	}
}
