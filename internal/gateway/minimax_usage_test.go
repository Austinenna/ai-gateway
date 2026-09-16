package gateway

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestMinimaxM3UsageNormalization(t *testing.T) {
	for _, tc := range []struct {
		name, provider, model, payload string
		total                          int64
		auto                           bool
	}{
		{"omitted write", "minimax", "MiniMax-M3", `{"input_tokens":117,"cache_read_input_tokens":18721,"output_tokens":185}`, 18838, true},
		{"explicit zero", "minimax", "MiniMax-M3", `{"input_tokens":117,"cache_read_input_tokens":18721,"cache_creation_input_tokens":0,"output_tokens":185}`, 18838, true},
		{"no hit", "minimax", "MiniMax-M3", `{"input_tokens":117,"cache_read_input_tokens":0,"output_tokens":185}`, 117, true},
		{"all zero", "minimax", "MiniMax-M3", `{"input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}`, 0, true},
		{"positive write preserved", "minimax", "MiniMax-M3", `{"input_tokens":117,"cache_read_input_tokens":18721,"cache_creation_input_tokens":50,"output_tokens":185}`, 18888, false},
		{"missing read", "minimax", "MiniMax-M3", `{"input_tokens":117,"output_tokens":185}`, -1, true},
		{"missing ordinary", "minimax", "MiniMax-M3", `{"cache_read_input_tokens":18721,"output_tokens":185}`, -1, true},
		{"different vendor", "custom", "MiniMax-M3", `{"input_tokens":117,"cache_read_input_tokens":18721,"output_tokens":185}`, -1, false},
		{"different model", "minimax", "MiniMax-M2.7", `{"input_tokens":117,"cache_read_input_tokens":18721,"output_tokens":185}`, -1, false},
		{"overflow", "minimax", "MiniMax-M3", `{"input_tokens":9223372036854775807,"cache_read_input_tokens":1,"output_tokens":185}`, -1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := Record{Protocol: "messages", UpstreamModel: tc.model, Alias: "MiniMax-M3", State: "complete", MetricsFields: MetricsFields{Provider: tc.provider}}
			r.readUsage([]byte(`{"usage":` + tc.payload + `}`))
			finalizeUsage(&r)
			if tc.total < 0 && r.InputTotal != nil || tc.total >= 0 && (r.InputTotal == nil || *r.InputTotal != tc.total || r.InputTokens != tc.total || r.UsageStatus != "complete") {
				t.Fatalf("unexpected input normalization: %+v", r)
			}
			if (r.InputTotalBasis == "minimax_auto_cache") != tc.auto {
				t.Fatal("wrong calculation basis")
			}
			var usage map[string]any
			json.Unmarshal([]byte(tc.payload), &usage)
			if _, reported := usage["cache_creation_input_tokens"]; !reported && r.CacheWrite != nil {
				t.Fatal("missing cache writes were fabricated")
			}
		})
	}
}

func TestMinimaxM3StreamUsageReplacesInitialCounts(t *testing.T) {
	for _, initial := range []string{
		`{"input_tokens":0,"output_tokens":0}`,
		`{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":25497}`,
	} {
		stream, first, last := true, int64(662), int64(1267)
		r := Record{Protocol: "messages", UpstreamModel: "MiniMax-M3", State: "complete", FirstToken: &first, MetricsFields: MetricsFields{Provider: "minimax", Stream: &stream, LastToken: &last, ContentChunks: 52}}
		r.readUsage([]byte(`{"type":"message_start","message":{"usage":` + initial + `}}`))
		finalizeUsage(&r)
		if r.UsageStatus == "complete" || r.OutputTPS != nil {
			t.Fatal("initial usage is not final")
		}
		final := []byte(`{"type":"message_delta","usage":{"input_tokens":25252,"output_tokens":403,"cache_read_input_tokens":245}}`)
		r.readUsage(final)
		r.readUsage(final) // cumulative usage must never be added twice
		finalizeUsage(&r)
		if r.InputTotal == nil || *r.InputTotal != 25497 || *r.CacheRead != 245 || r.OutputTokens != 403 || r.UsageStatus != "complete" || r.OutputTPS == nil || math.Abs(*r.OutputTPS-402000.0/605) > .001 {
			t.Fatalf("wrong final stream usage: %+v", r)
		}
	}
}

func TestMinimaxHistoricalUsageVisibleWithoutDatabaseRewrite(t *testing.T) {
	h := newHarness(t)
	ordinary, cached := int64(117), int64(18721)
	r := Record{
		ID: "historical-m3", ProjectID: "old-project", Started: time.Now().UnixMilli(),
		Protocol: "messages", UpstreamModel: "MiniMax-M3", Alias: "custom-alias", State: "complete",
		InputTokens: 117, OutputTokens: 185, Input: `{"messages":[]}`, Output: `{"original":"preserved"}`,
		MetricsFields: MetricsFields{MetricsVersion: 1, Provider: "minimax", InputUncached: &ordinary, CacheRead: &cached, OutputReported: true, UsageStatus: "partial", Forwarded: true},
	}
	raw, _ := json.Marshal(r)
	summary, _ := json.Marshal(metricSummary(r))
	if _, err := h.g.db.Exec("INSERT INTO requests(id,project_id,started,summary,record) VALUES(?,?,?,?,?)", r.ID, r.ProjectID, r.Started, string(summary), string(raw)); err != nil {
		t.Fatal(err)
	}
	h.g.saveMetric(r)
	check := func(got Record) {
		t.Helper()
		if got.InputTotal == nil || *got.InputTotal != 18838 || got.InputTokens != 18838 || got.CacheWrite != nil || got.InputTotalBasis != "minimax_auto_cache" {
			t.Fatalf("historical input still missing: %+v", got)
		}
		if got.UsageStatus != "partial" || got.OutputTPS != nil {
			t.Fatal("historical final output was guessed")
		}
	}
	list := h.request("GET", "/api/admin/requests", nil, "", true)
	h.want(list, 200)
	check(parse[[]Record](t, list)[0])
	detail := h.request("GET", "/api/admin/requests/"+r.ID, nil, "", true)
	h.want(detail, 200)
	got := parse[Record](t, detail)
	check(got)
	if got.Input != r.Input || got.Output != r.Output {
		t.Fatal("original request or response changed")
	}
	metrics := getMetrics(t, h, "?window=all")
	check(metrics.Recent[0])
	if metrics.Summary.InputTokens != 18838 || metrics.Summary.CacheRead != 18721 || metrics.Summary.CacheRatio == nil || math.Abs(*metrics.Summary.CacheRatio-100*18721.0/18838) > .001 {
		t.Fatalf("historical totals excluded from overview: %+v", metrics.Summary)
	}
	var storedSummary, storedRecord, storedMetric string
	h.g.db.QueryRow("SELECT summary,record FROM requests WHERE id=?", r.ID).Scan(&storedSummary, &storedRecord)
	h.g.db.QueryRow("SELECT summary FROM request_metrics WHERE id=?", r.ID).Scan(&storedMetric)
	if storedSummary != string(summary) || storedMetric != string(summary) || storedRecord != string(raw) {
		t.Fatal("read-time normalization rewrote stored history")
	}
	// The request body may be unavailable while its independent metrics survive.
	r.ID = "metrics-only-m3"
	h.g.saveMetric(r)
	fallback := h.request("GET", "/api/admin/requests/"+r.ID, nil, "", true)
	h.want(fallback, 200)
	got = parse[Record](t, fallback)
	check(got)
	if !got.RecordMissing {
		t.Fatal("missing body flag lost")
	}
	// Legacy records without monitored input buckets retain their old meaning.
	r.MetricsVersion, r.InputTotal = 0, nil
	r.normalizeStoredUsage()
	if r.InputTotal != nil {
		t.Fatal("unmonitored legacy record changed")
	}
}
