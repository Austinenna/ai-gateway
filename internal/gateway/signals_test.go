package gateway

import (
	"context"
	"fmt"
	"testing"
	"time"
)

type signalSeed struct {
	h *harness
	n int
}

func (s *signalSeed) add(rec Record) {
	s.n++
	rec.ID = fmt.Sprintf("signal-%d", s.n)
	if rec.State == "" {
		rec.State = "complete"
	}
	s.h.g.saveMetric(rec)
}

func (s *signalSeed) streamed(modelID string, started, ttft int64) {
	stream := true
	s.add(Record{ModelID: modelID, Alias: modelID, Started: started, FirstToken: &ttft, MetricsFields: MetricsFields{Stream: &stream}})
}

func signalHarness(t *testing.T, now int64) (*harness, *signalSeed) {
	h := newHarness(t)
	h.g.monitoringSince = now - 30*24*time.Hour.Milliseconds()
	return h, &signalSeed{h: h}
}

func computed(t *testing.T, h *harness, window string, now int64) signalsResponse {
	t.Helper()
	out, err := h.g.computeSignals(context.Background(), window, now)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestFailureSignalComparesRateWithPriorPeriod(t *testing.T) {
	now := time.Now().UnixMilli()
	h, seed := signalHarness(t, now)
	hour := time.Hour.Milliseconds()
	for i := range 8 {
		seed.add(Record{Started: now - hour - int64(i)*1000})
	}
	seed.add(Record{Started: now - hour, State: "error"})
	seed.add(Record{Started: now - hour, State: "timeout"})
	// Caller cancels and running calls are not failures and not in the denominator.
	seed.add(Record{Started: now - hour, State: "canceled"})
	seed.add(Record{Started: now - hour, State: "running"})
	seed.add(Record{Started: now - 30*hour, State: "error"})
	for i := range 9 {
		seed.add(Record{Started: now - 30*hour - int64(i)*1000})
	}

	f := computed(t, h, "24h", now).Failure
	if f.Requests != 10 || f.Failed != 2 || f.Rate == nil || *f.Rate != 20 {
		t.Fatalf("current period: %+v", f)
	}
	if f.PrevRequests != 10 || f.PrevFailed != 1 || f.PrevRate == nil || *f.PrevRate != 10 {
		t.Fatalf("prior period: %+v", f)
	}
	if len(f.Buckets) != 24 || f.BucketMS != hour {
		t.Fatalf("buckets: %d x %d", len(f.Buckets), f.BucketMS)
	}
	total := 0
	for _, b := range f.Buckets {
		total += b.Failed
	}
	if total != 2 {
		t.Fatalf("bucket failures %d: %+v", total, f.Buckets)
	}
	if all := computed(t, h, "all", now).Failure; all.PrevRate != nil || all.Requests != 20 {
		t.Fatalf("ALL has no prior period: %+v", all)
	}
}

func TestModelSignalFlagsOnlyRealSlowdowns(t *testing.T) {
	now := time.Now().UnixMilli()
	h, seed := signalHarness(t, now)
	hour := time.Hour.Milliseconds()
	for i := range 20 {
		for _, id := range []string{"slow", "fast-base", "few", "stable"} {
			base := int64(1000)
			if id == "fast-base" {
				base = 100
			}
			seed.streamed(id, now-2*hour-int64(i)*hour, base)
		}
	}
	for i := range 5 {
		seed.streamed("slow", now-int64(i)*1000, 2500)
		seed.streamed("fast-base", now-int64(i)*1000, 400) // 4x, but only 300 ms more
		seed.streamed("stable", now-int64(i)*1000, 1100)
	}
	seed.streamed("few", now-1000, 9000) // one slow call is not a trend
	// Non-streaming calls have no comparable first-token time.
	seed.add(Record{ModelID: "slow", Alias: "slow", Started: now - 1000})

	got := map[string]modelSignal{}
	models := computed(t, h, "24h", now).Models
	for _, m := range models {
		got[m.ModelID] = m
	}
	if len(got) != 4 || models[0].ModelID != "slow" {
		t.Fatalf("slow model must sort first: %+v", models)
	}
	if s := got["slow"]; !s.Slow || s.Samples != 5 || s.BaseSamples != 20 || *s.P50 != 2500 || *s.BaseP50 != 1000 || *s.Ratio != 2.5 {
		t.Fatalf("slow: %+v", s)
	}
	for _, id := range []string{"fast-base", "few", "stable"} {
		if got[id].Slow {
			t.Fatalf("%s must not be flagged: %+v", id, got[id])
		}
	}
}

func TestProjectSignalsFindSurgesAndSilence(t *testing.T) {
	now := time.Now().UnixMilli()
	h, seed := signalHarness(t, now)
	hour := time.Hour.Milliseconds()
	surge := h.project("surge-project")
	busy := h.project("busy-project")
	quiet := h.project("quiet-project")
	sparse := h.project("sparse-project")
	paused := h.project("paused-project")
	hit := func(id string, started int64, n int) {
		for i := range n {
			seed.add(Record{ProjectID: id, Started: started - int64(i)})
		}
	}
	hit(surge.Project.ID, now-5*hour, 10)
	hit(surge.Project.ID, now-1000, 21)
	hit(busy.Project.ID, now-5*hour, 15)
	hit(busy.Project.ID, now-1000, 25) // above the minimum, but under twice its busiest hour
	for day := int64(2); day <= 4; day++ {
		hit(quiet.Project.ID, now-day*24*hour, 2)
		hit(paused.Project.ID, now-day*24*hour, 2)
	}
	hit(sparse.Project.ID, now-2*24*hour, 2)
	if _, err := h.g.db.Exec("UPDATE projects SET enabled=0 WHERE id=?", paused.Project.ID); err != nil {
		t.Fatal(err)
	}

	projects := computed(t, h, "24h", now).Projects
	if len(projects) != 2 {
		t.Fatalf("want surge and silent only: %+v", projects)
	}
	if s := projects[0]; s.ProjectID != surge.Project.ID || s.Kind != "surge" || s.LastHour != 21 || s.PeakHour != 10 {
		t.Fatalf("surge: %+v", s)
	}
	if s := projects[1]; s.ProjectID != quiet.Project.ID || s.Kind != "silent" || s.ActiveDays != 3 || s.LastSeen == 0 {
		t.Fatalf("silent: %+v", s)
	}
}

func TestSignalsCountFallbackAndMissingUsage(t *testing.T) {
	now := time.Now().UnixMilli()
	h, seed := signalHarness(t, now)
	for range 250 {
		seed.add(Record{Started: now - 1000, FallbackFrom: "primary", MetricsFields: MetricsFields{UsageStatus: "complete"}})
	}
	seed.add(Record{Started: now - 1000, State: "error", FallbackFrom: "primary"})
	seed.add(Record{Started: now - 1000, Protocol: "chat", MetricsFields: MetricsFields{UsageStatus: "unknown"}})
	seed.add(Record{Started: now - 1000, Protocol: "deepseek-search", MetricsFields: MetricsFields{UsageStatus: "unknown"}})
	seed.add(Record{Started: now - 1000, Protocol: "chat", State: "error", MetricsFields: MetricsFields{UsageStatus: "unknown"}})
	seed.add(Record{Started: now - 1000, Protocol: "chat", MetricsFields: MetricsFields{UsageStatus: "complete"}})

	out := computed(t, h, "1h", now)
	if out.Fallback.Total != 251 || out.Fallback.Served != 250 {
		t.Fatalf("fallback must not stop at one page: %+v", out.Fallback)
	}
	if out.UsageMissing != 1 {
		t.Fatalf("usage missing: %d", out.UsageMissing)
	}
}

func TestBackgroundSignalReportsCleanupAndGrowth(t *testing.T) {
	now := time.Now().UnixMilli()
	h, _ := signalHarness(t, now)
	clean := func() {
		if _, err := h.g.db.Exec("DELETE FROM maintenance_log"); err != nil {
			t.Fatal(err)
		}
	}
	clean()
	b := computed(t, h, "24h", now).Background
	if b.CleanupOverdue || b.LastCleanup != nil || b.DBGrowth7D != nil {
		t.Fatalf("a gateway with no cleanup yet is not overdue: %+v", b)
	}
	if b.DiskFreeBytes == nil || b.DiskTotalBytes == nil || *b.DiskTotalBytes <= 0 {
		t.Fatalf("disk space: %+v", b)
	}

	day := 24 * time.Hour
	h.g.logMaintenance("cleanup", time.UnixMilli(now).Add(-10*day), maintenanceDetail{Status: "ok", SizeAfterBytes: 1000})
	h.g.logMaintenance("cleanup", time.UnixMilli(now).Add(-3*day), maintenanceDetail{Status: "ok"})
	h.g.logMaintenance("cleanup", time.UnixMilli(now).Add(-time.Hour), maintenanceDetail{Status: "error", Error: "disk I/O error"})
	b = computed(t, h, "24h", now).Background
	if b.LastCleanup == nil || b.LastCleanup.Detail.Status != "error" || !b.CleanupOverdue {
		t.Fatalf("failed cleanup after a stale success: %+v", b)
	}
	if b.DBGrowth7D == nil || *b.DBGrowth7D != b.DBBytes-1000 {
		t.Fatalf("growth: %+v", b.DBGrowth7D)
	}
	h.g.logMaintenance("cleanup", time.UnixMilli(now).Add(-time.Minute), maintenanceDetail{Status: "ok"})
	if b = computed(t, h, "24h", now).Background; b.CleanupOverdue {
		t.Fatalf("recent success: %+v", b)
	}
}

func TestSignalsEndpoint(t *testing.T) {
	h := newHarness(t)
	h.want(h.request("GET", "/api/admin/diagnostics/signals?window=2h", nil, "", true), 400)
	h.want(h.request("GET", "/api/admin/diagnostics/signals", nil, "", false), 401)
	out := parse[signalsResponse](t, h.request("GET", "/api/admin/diagnostics/signals?window=7d", nil, "", true))
	if len(out.Failure.Buckets) == 0 || out.Models == nil || out.Projects == nil {
		t.Fatalf("empty gateway must keep arrays non-null: %+v", out)
	}
}

func TestSpeedStatisticsSkipBurstReplies(t *testing.T) {
	first, burst, long := int64(100), int64(103), int64(2100)
	tps := 50.0
	rec := Record{FirstToken: &first, MetricsFields: MetricsFields{LastToken: &burst, OutputTPS: &tps}}
	if speedMeasurable(rec) {
		t.Fatal("a 3 ms burst has no meaningful speed")
	}
	rec.LastToken = &long
	if !speedMeasurable(rec) {
		t.Fatal("a two-second reply must count")
	}
}
