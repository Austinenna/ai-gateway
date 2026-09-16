package gateway

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type metricsResult struct {
	Summary metricAggregate `json:"summary"`
	Models  []metricGroup   `json:"models"`
	Recent  []Record        `json:"recent"`
	Buckets []metricBucket  `json:"buckets"`
	Since   int64           `json:"monitoring_since"`
}

func getMetrics(t *testing.T, h *harness, query string) metricsResult {
	t.Helper()
	rr := h.request("GET", "/api/admin/metrics"+query, nil, "", true)
	h.want(rr, 200)
	return parse[metricsResult](t, rr)
}

func TestUsageNormalizationAndMissingValues(t *testing.T) {
	for _, tc := range []struct {
		name, protocol, payload  string
		total, cache, write, out int64
		status                   string
	}{
		{"chat cached", "chat", `{"usage":{"prompt_tokens":10000,"completion_tokens":500,"prompt_tokens_details":{"cached_tokens":8000}}}`, 10000, 8000, -1, 500, "complete"},
		{"chat unknown cache", "chat", `{"usage":{"prompt_tokens":10,"completion_tokens":0}}`, 10, -1, -1, 0, "complete"},
		{"messages cached", "messages", `{"usage":{"input_tokens":2000,"output_tokens":500,"cache_read_input_tokens":8000,"cache_creation_input_tokens":1000}}`, 11000, 8000, 1000, 500, "complete"},
		{"messages missing cache", "messages", `{"usage":{"input_tokens":10,"output_tokens":2}}`, -1, -1, -1, 2, "partial"},
		{"reported zero", "messages", `{"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}`, 0, 0, 0, 0, "complete"},
		{"missing usage", "chat", `{}`, -1, -1, -1, -1, "unknown"},
		{"negative usage", "chat", `{"usage":{"prompt_tokens":-1,"completion_tokens":-2}}`, -1, -1, -1, -1, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := Record{Protocol: tc.protocol, State: "complete"}
			r.readUsage([]byte(tc.payload))
			finalizeUsage(&r)
			value := func(p *int64) int64 {
				if p == nil {
					return -1
				}
				return *p
			}
			if value(r.InputTotal) != tc.total || value(r.CacheRead) != tc.cache || value(r.CacheWrite) != tc.write || r.UsageStatus != tc.status || r.OutputReported != (tc.out >= 0) || (tc.out >= 0 && r.OutputTokens != tc.out) {
				t.Fatalf("wrong normalized usage: %+v", r)
			}
		})
	}
	r := Record{Protocol: "messages", State: "complete"}
	r.readUsage([]byte(`{"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":8,"cache_creation_input_tokens":0,"output_tokens":0}}}`))
	finalizeUsage(&r)
	if r.UsageStatus != "partial" {
		t.Fatal("message_start is not final output usage")
	}
	r.readUsage([]byte(`{"type":"message_delta","usage":{"output_tokens":5}}`))
	r.readUsage([]byte(`{"type":"message_delta","usage":{"output_tokens":9}}`))
	finalizeUsage(&r)
	if r.InputTokens != 10 || r.OutputTokens != 9 || r.UsageStatus != "complete" {
		t.Fatal("stream usage was summed or lost")
	}
}

func TestMetricsStreamTimingsUsageAndHTTP200Error(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-metric-key")
	m := h.model(c, "metric")
	p := h.project("metrics", m.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		reader, writer := io.Pipe()
		go func() {
			defer writer.Close()
			io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n")
			time.Sleep(35 * time.Millisecond)
			io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n")
			time.Sleep(40 * time.Millisecond)
			io.WriteString(writer, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":10,\"prompt_tokens_details\":{\"cached_tokens\":80}}}\n\ndata: [DONE]\n\n")
		}()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader}, nil
	})
	h.want(h.call(m.Alias, p.Token, map[string]any{"stream": true}), 200)
	got := getMetrics(t, h, "")
	r := got.Recent[0]
	if got.Summary.Completed != 1 || r.FirstToken == nil || r.FirstText == nil || *r.FirstText-*r.FirstToken < 25 || r.OutputTPS == nil || r.TPOT == nil || r.UsageStatus != "complete" {
		t.Fatalf("bad stream metrics: %+v", r)
	}
	if math.Abs(*r.OutputTPS**r.TPOT-1000) > .001 || r.Duration-*r.LastToken < 25 {
		t.Fatal("output speed includes trailing usage delay")
	}
	if got.Summary.CacheRatio == nil || *got.Summary.CacheRatio != 80 {
		t.Fatal("wrong token-weighted cache ratio")
	}
	for _, tc := range []struct {
		body   string
		status int
		kind   string
	}{
		{"data: {\"error\":{\"type\":\"rate_limit_error\"}}\n\ndata: [DONE]\n\n", 200, "rate_limit"},
		{"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", 200, "stream_interrupted"},
		{`{"error":{"message":"busy"}}`, 429, "rate_limit"},
	} {
		h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
			return response(tc.body, "text/event-stream", tc.status), nil
		})
		rr := h.call(m.Alias, p.Token, map[string]any{"stream": true})
		h.want(rr, tc.status)
		id := rr.Header().Get("X-Request-ID")
		var data string
		h.g.db.QueryRow("SELECT summary FROM request_metrics WHERE id=?", id).Scan(&data)
		var rec Record
		json.Unmarshal([]byte(data), &rec)
		if rec.State == "complete" || rec.ErrorType != tc.kind || rec.OutputTPS != nil {
			t.Fatalf("error counted as success: %+v", rec)
		}
	}
	h.want(h.request("GET", "/api/admin/metrics", nil, p.Token, false), 401)
}

func TestMetricsEntryConcurrencyFiltersAndPersistence(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-concurrency-key")
	m := h.model(c, "concurrent")
	p := h.project("concurrent", m.ID)
	entered, release := make(chan struct{}), make(chan struct{})
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return response(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":3}}`, "application/json", 200), nil
	})
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() { finished <- h.call(m.Alias, p.Token, nil) }()
	<-entered
	active := getMetrics(t, h, "?project_id="+p.Project.ID+"&connection_id="+c.ID+"&model_id="+m.ID+"&stream=false")
	if active.Summary.Active != 1 || active.Summary.Requests != 1 || active.Summary.Completed != 0 {
		t.Fatalf("active call not counted: %+v", active.Summary)
	}
	detail := parse[Record](t, h.request("GET", "/api/admin/requests/"+active.Recent[0].ID, nil, "", true))
	if detail.State != "running" || detail.ProjectID != p.Project.ID || detail.ConnectionID != c.ID || !detail.RecordMissing {
		t.Fatal("active detail lost routing context")
	}
	close(release)
	h.want(<-finished, 200)
	h.want(h.call(m.Alias, "invalid", nil), 401)
	h.want(h.call("denied", p.Token, nil), 403)
	all := getMetrics(t, h, "")
	if all.Summary.Requests != 3 || all.Summary.Completed != 1 || all.Summary.Failed != 2 || all.Summary.Active != 0 || all.Summary.TTFT.Count != 0 || all.Summary.Duration.Count != 1 {
		t.Fatalf("wrong aggregate: %+v", all.Summary)
	}
	if getMetrics(t, h, "?stream=true").Summary.Requests != 0 || getMetrics(t, h, "?project_id=unknown").Summary.Requests != 1 {
		t.Fatal("filters mismatch")
	}
	// Deleting all body logs must not change monitoring totals or detail metrics.
	h.records(3)
	if _, err := h.g.db.Exec("DELETE FROM requests"); err != nil {
		t.Fatal(err)
	}
	if getMetrics(t, h, "").Summary.Requests != 3 {
		t.Fatal("monitoring depends on body logs")
	}
	rr := h.request("GET", "/api/admin/requests/"+all.Recent[0].ID, nil, "", true)
	h.want(rr, 200)
	if !parse[Record](t, rr).RecordMissing {
		t.Fatal("missing body not explained")
	}
	since := all.Since
	h.g.saveMetric(Record{ID: "abandoned", Started: time.Now().UnixMilli(), State: "running"})
	restartHarness(t, h)
	if err := h.g.db.QueryRow("SELECT count(*) FROM request_metrics").Scan(new(int)); err != nil {
		t.Fatal(err)
	}
	if h.g.monitoringSince != since {
		t.Fatal("monitoring start reset on restart")
	}
	var raw string
	if err := h.g.db.QueryRow("SELECT summary FROM request_metrics WHERE id='abandoned'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var recovered Record
	if json.Unmarshal([]byte(raw), &recovered) != nil || recovered.State != "interrupted" || recovered.ErrorType != "gateway_restart" {
		t.Fatal("restart left a phantom active request")
	}
}

func TestTransportTimeoutIsNotClientCancellation(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-timeout-key")
	m := h.model(c, "timeout")
	p := h.project("timeout", m.ID)
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded })
	h.want(h.call(m.Alias, p.Token, nil), 504)
	got := getMetrics(t, h, "")
	if got.Summary.Failed != 1 || got.Summary.Errors["timeout"] != 1 || got.Summary.Canceled != 0 {
		t.Fatal("timeout classified as cancellation")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := Record{}
	classifyTransport(&rec, ctx, ctx, context.Canceled)
	if rec.State != "canceled" {
		t.Fatal("client cancellation not preserved")
	}
	if strings.Contains(h.request("GET", "/api/admin/metrics", nil, "", true).Body.String(), "fake-timeout-key") {
		t.Fatal("credential in metrics")
	}
}

func TestMetricsAggregationUsesAllRowsAndWeightedCache(t *testing.T) {
	h := newHarness(t)
	now := time.Now().UnixMilli()
	stream := true
	for i := 0; i < 205; i++ {
		input, cache := int64(100), int64(80)
		ttft := int64(i)
		if i == 0 {
			input, cache = 10000, 0
		}
		rec := Record{ID: strings.Repeat("x", i+1), Started: now, State: "complete", Duration: 1000, FirstToken: &ttft, MetricsFields: MetricsFields{MetricsVersion: 1, Stream: &stream, InputTotal: &input, CacheRead: &cache, Forwarded: true, UsageStatus: "complete"}}
		h.g.saveMetric(rec)
	}
	got := getMetrics(t, h, "").Summary
	if got.Requests != 205 || got.TTFT.Count != 205 || *got.TTFT.P50 != 102 || *got.TTFT.P95 != 194 {
		t.Fatalf("limited or wrong percentiles: %+v", got)
	}
	if math.Abs(*got.CacheRatio-100*float64(204*80)/float64(10000+204*100)) > .0001 {
		t.Fatal("cache ratio averaged percentages instead of tokens")
	}
	h.want(h.request("GET", "/api/admin/metrics?window=invalid", nil, "", true), 400)
}
