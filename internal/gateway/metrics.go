package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// Metrics are persisted separately from the bounded, asynchronous body log.
// Missing usage is represented by nil, never silently converted to zero.
type MetricsFields struct {
	MetricsVersion int      `json:"metrics_version,omitempty"`
	ConnectionID   string   `json:"connection_id,omitempty"`
	ConnectionName string   `json:"connection_name,omitempty"`
	Provider       string   `json:"provider,omitempty"`
	Stream         *bool    `json:"stream"`
	Forwarded      bool     `json:"forwarded"`
	ForwardOffset  int64    `json:"forward_offset_ms"`
	LastToken      *int64   `json:"last_token_ms"`
	ContentChunks  int      `json:"content_chunks"`
	ErrorType      string   `json:"error_type,omitempty"`
	UpstreamStatus int      `json:"upstream_status,omitempty"`
	InputTotal     *int64   `json:"input_total_tokens"`
	InputUncached  *int64   `json:"input_uncached_tokens"`
	CacheRead      *int64   `json:"cache_read_tokens"`
	CacheWrite     *int64   `json:"cache_write_tokens"`
	OutputReported bool     `json:"output_reported"`
	UsageStatus    string   `json:"usage_status"`
	OutputTPS      *float64 `json:"output_tps"`
	TPOT           *float64 `json:"tpot_ms"`
	RecordMissing  bool     `json:"record_missing,omitempty"`
	outputFinal    bool
}

type callKey struct{}
type callTrace struct {
	rec   Record
	start time.Time
}

func (g *Gateway) initMetrics() error {
	_, err := g.db.Exec(`CREATE TABLE IF NOT EXISTS request_metrics(id TEXT PRIMARY KEY, started INTEGER NOT NULL, summary TEXT NOT NULL);
	 CREATE INDEX IF NOT EXISTS idx_metrics_started ON request_metrics(started DESC);
	 INSERT OR IGNORE INTO meta(key,value) VALUES('monitoring_since',?);
	 UPDATE request_metrics SET summary=json_set(summary,'$.state','interrupted','$.error_type','gateway_restart','$.usage_status','unknown') WHERE json_extract(summary,'$.state')='running';`, strconv.FormatInt(time.Now().UnixMilli(), 10))
	if err != nil {
		return err
	}
	var since string
	if err = g.db.QueryRow("SELECT value FROM meta WHERE key='monitoring_since'").Scan(&since); err != nil {
		return err
	}
	g.monitoringSince, err = strconv.ParseInt(since, 10, 64)
	g.inflight = make(map[string]Record)
	return err
}

func metricSummary(rec Record) Record { rec.Input, rec.Output = "", ""; return rec }
func (g *Gateway) saveMetric(rec Record) {
	b, err := json.Marshal(metricSummary(rec))
	if err == nil {
		_, err = g.db.Exec("INSERT INTO request_metrics(id,started,summary) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary", rec.ID, rec.Started, string(b))
	}
	if err != nil {
		g.metricsErrors.Add(1)
	}
}

// The wrapper preserves ResponseController access to flushing and deadlines.
type metricWriter struct {
	http.ResponseWriter
	status int
}

func (w *metricWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *metricWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *metricWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(p)
}

func traceOf(r *http.Request) *callTrace { return r.Context().Value(callKey{}).(*callTrace) }
func (g *Gateway) snapshotCall(t *callTrace) {
	g.metricsMu.Lock()
	defer g.metricsMu.Unlock()
	g.inflight[t.rec.ID] = metricSummary(t.rec)
}
func (g *Gateway) observeCall(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t := &callTrace{start: time.Now()}
		t.rec = Record{ID: id("req_"), Started: t.start.UnixMilli(), ProjectName: "未识别项目", State: "running", TimingVersion: 1, MetricsFields: MetricsFields{MetricsVersion: 1, UsageStatus: "unknown"}}
		if r.URL.Path == "/v1/messages" {
			t.rec.Protocol = "messages"
		} else {
			t.rec.Protocol = "chat"
		}
		w.Header().Set("X-Request-ID", t.rec.ID)
		g.snapshotCall(t)
		g.saveMetric(t.rec)
		mw := &metricWriter{ResponseWriter: w}
		defer func() {
			rec := &t.rec
			rec.Duration = time.Since(t.start).Milliseconds()
			rec.Status = mw.status
			if rec.Status == 0 {
				rec.Status = 500
			}
			if rec.State == "running" {
				rec.State = "error"
				if rec.Status >= 400 && rec.Status < 500 {
					rec.State = "rejected"
				}
			}
			if rec.ErrorType == "" && rec.State != "complete" {
				switch rec.Status {
				case 401:
					rec.ErrorType = "authentication"
				case 403:
					rec.ErrorType = "permission"
				case 400, 413:
					rec.ErrorType = "invalid_request"
				default:
					rec.ErrorType = "gateway_error"
				}
			}
			finalizeUsage(rec)
			g.metricsMu.Lock()
			g.saveMetric(*rec)
			delete(g.inflight, rec.ID)
			g.metricsMu.Unlock()
			g.enqueue(*rec)
		}()
		next(mw, r.WithContext(context.WithValue(r.Context(), callKey{}, t)))
	}
}

func classifyTransport(rec *Record, caller, upstream context.Context, err error) {
	var timeout net.Error
	switch {
	case errors.Is(caller.Err(), context.Canceled):
		rec.State = "canceled"
		rec.ErrorType = "client_canceled"
	case errors.Is(caller.Err(), context.DeadlineExceeded), errors.Is(upstream.Err(), context.DeadlineExceeded), errors.Is(err, context.DeadlineExceeded), errors.As(err, &timeout) && timeout.Timeout():
		rec.State = "timeout"
		rec.ErrorType = "timeout"
	default:
		rec.State = "error"
		rec.ErrorType = "upstream_connection"
	}
}
func isTimeout(err error) bool {
	var e net.Error
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &e) && e.Timeout())
}

func finalizeUsage(rec *Record) {
	rec.UsageStatus = "unknown"
	if rec.InputTotal != nil || rec.InputUncached != nil || rec.OutputReported || rec.CacheRead != nil || rec.CacheWrite != nil {
		rec.UsageStatus = "partial"
	}
	if rec.State == "complete" && rec.InputTotal != nil && rec.OutputReported && rec.outputFinal {
		rec.UsageStatus = "complete"
	}
	if rec.UsageStatus == "complete" && rec.Stream != nil && *rec.Stream && rec.ContentChunks > 1 && rec.OutputTokens > 1 && rec.FirstToken != nil && rec.LastToken != nil && *rec.LastToken > *rec.FirstToken {
		span := float64(*rec.LastToken - *rec.FirstToken)
		tps := float64(rec.OutputTokens-1) * 1000 / span
		tpot := span / float64(rec.OutputTokens-1)
		rec.OutputTPS, rec.TPOT = &tps, &tpot
	}
}

type metricDistribution struct {
	Count int      `json:"count"`
	P50   *float64 `json:"p50"`
	P95   *float64 `json:"p95"`
}

func distribution(values []float64) metricDistribution {
	d := metricDistribution{Count: len(values)}
	if len(values) == 0 {
		return d
	}
	sort.Float64s(values)
	a, b := values[int(math.Ceil(float64(len(values))*.5))-1], values[int(math.Ceil(float64(len(values))*.95))-1]
	d.P50, d.P95 = &a, &b
	return d
}

type metricAggregate struct {
	Requests                    int                `json:"requests"`
	Completed                   int                `json:"completed"`
	Failed                      int                `json:"failed"`
	Canceled                    int                `json:"canceled"`
	Active                      int                `json:"active"`
	SuccessRate                 *float64           `json:"success_rate"`
	RPM                         float64            `json:"rpm"`
	Errors                      map[string]int     `json:"errors"`
	InputTokens                 int64              `json:"input_tokens"`
	OutputTokens                int64              `json:"output_tokens"`
	CacheRead                   int64              `json:"cache_read_tokens"`
	CacheWrite                  int64              `json:"cache_write_tokens"`
	InputSamples                int                `json:"input_samples"`
	OutputSamples               int                `json:"output_samples"`
	CacheSamples                int                `json:"cache_samples"`
	CacheWriteSamples           int                `json:"cache_write_samples"`
	UsageComplete               int                `json:"usage_complete"`
	UsageEligible               int                `json:"usage_eligible"`
	CacheRatio                  *float64           `json:"cache_ratio"`
	TTFT                        metricDistribution `json:"ttft"`
	TTFC                        metricDistribution `json:"ttfc"`
	Duration                    metricDistribution `json:"duration"`
	Speed                       metricDistribution `json:"speed"`
	ttft, ttfc, duration, speed []float64
	cacheInput                  int64
}

func newAggregate() metricAggregate { return metricAggregate{Errors: map[string]int{}} }
func (a *metricAggregate) add(rec Record) {
	a.Requests++
	if rec.State == "running" {
		a.Active++
		return
	}
	switch rec.State {
	case "complete":
		a.Completed++
	case "canceled":
		a.Canceled++
	default:
		a.Failed++
		a.Errors[rec.ErrorType]++
	}
	if rec.Forwarded {
		a.UsageEligible++
	}
	if rec.UsageStatus == "complete" {
		a.UsageComplete++
	}
	if rec.InputTotal != nil {
		a.InputTokens += *rec.InputTotal
		a.InputSamples++
	}
	if rec.OutputReported {
		a.OutputTokens += rec.OutputTokens
		a.OutputSamples++
	}
	if rec.CacheWrite != nil {
		a.CacheWrite += *rec.CacheWrite
		a.CacheWriteSamples++
	}
	if rec.CacheRead != nil && rec.InputTotal != nil && *rec.CacheRead <= *rec.InputTotal {
		a.CacheRead += *rec.CacheRead
		a.cacheInput += *rec.InputTotal
		a.CacheSamples++
	}
	if rec.State != "complete" {
		return
	}
	a.duration = append(a.duration, float64(rec.Duration))
	if rec.Stream != nil && *rec.Stream {
		if rec.FirstToken != nil {
			a.ttft = append(a.ttft, float64(*rec.FirstToken))
		}
		if rec.FirstText != nil {
			a.ttfc = append(a.ttfc, float64(*rec.FirstText))
		}
		if rec.OutputTPS != nil {
			a.speed = append(a.speed, *rec.OutputTPS)
		}
	}
}
func (a *metricAggregate) finish(minutes float64) {
	if a.Completed+a.Failed > 0 {
		v := 100 * float64(a.Completed) / float64(a.Completed+a.Failed)
		a.SuccessRate = &v
	}
	if minutes > 0 {
		a.RPM = float64(a.Requests) / minutes
	}
	if a.cacheInput > 0 {
		v := 100 * float64(a.CacheRead) / float64(a.cacheInput)
		a.CacheRatio = &v
	}
	a.TTFT, a.TTFC, a.Duration, a.Speed = distribution(a.ttft), distribution(a.ttfc), distribution(a.duration), distribution(a.speed)
}

type metricOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type metricGroup struct {
	ModelID        string `json:"model_id"`
	Alias          string `json:"alias"`
	ConnectionID   string `json:"connection_id"`
	ConnectionName string `json:"connection_name"`
	metricAggregate
}
type metricBucket struct {
	Started  int64   `json:"started"`
	Requests int     `json:"requests"`
	Failed   int     `json:"failed"`
	Canceled int     `json:"canceled"`
	RPM      float64 `json:"rpm"`
}

func (g *Gateway) metrics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	window := q.Get("window")
	var span time.Duration
	switch window {
	case "1h":
		span = time.Hour
	case "", "24h":
		span = 24 * time.Hour
	case "7d":
		span = 7 * 24 * time.Hour
	case "all":
		// Use the persisted monitoring start, including data from previous runs.
	default:
		problem(w, 400, "不支持的监控时间范围")
		return
	}
	mode := q.Get("stream")
	if mode != "" && mode != "true" && mode != "false" {
		problem(w, 400, "无效的流式筛选")
		return
	}
	// Serialize the snapshot with final persistence so a just-finished request is
	// never counted both as a saved record and an active request.
	g.metricsMu.Lock()
	now := time.Now().UnixMilli()
	from := g.monitoringSince
	if window != "all" {
		from = max(from, now-span.Milliseconds())
	}
	rows, err := g.db.QueryContext(r.Context(), "SELECT summary FROM request_metrics WHERE started>=? AND started<=? ORDER BY started DESC,id", from, now)
	if err != nil {
		g.metricsMu.Unlock()
		problem(w, 500, "读取监控统计失败")
		return
	}
	records := []Record{}
	seen := map[string]bool{}
	for rows.Next() {
		var b string
		var rec Record
		if err = rows.Scan(&b); err != nil {
			break
		}
		if err = json.Unmarshal([]byte(b), &rec); err != nil {
			break
		}
		if active, ok := g.inflight[rec.ID]; ok {
			rec = active
		}
		records = append(records, rec)
		seen[rec.ID] = true
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	for id, rec := range g.inflight {
		if !seen[id] {
			records = append(records, rec)
		}
	}
	g.metricsMu.Unlock()
	if err != nil {
		problem(w, 500, "读取监控统计失败")
		return
	}
	options := map[string]map[string]string{"projects": {}, "connections": {}, "models": {}}
	agg := newAggregate()
	groups := map[string]*metricGroup{}
	recent := []Record{}
	const n = 24
	buckets := make([]metricBucket, n)
	width := float64(now-from+1) / n
	for i := range buckets {
		buckets[i].Started = from + int64(float64(i)*width)
	}
	for _, rec := range records {
		options["projects"][rec.ProjectID] = rec.ProjectName
		if rec.ConnectionID != "" {
			options["connections"][rec.ConnectionID] = rec.ConnectionName
		}
		if rec.ModelID != "" {
			options["models"][rec.ModelID] = rec.Alias
		}
		if p := q.Get("project_id"); p != "" && p != rec.ProjectID && !(p == "unknown" && rec.ProjectID == "") {
			continue
		}
		if c := q.Get("connection_id"); c != "" && c != rec.ConnectionID {
			continue
		}
		if m := q.Get("model_id"); m != "" && m != rec.ModelID {
			continue
		}
		if mode != "" && (rec.Stream == nil || strconv.FormatBool(*rec.Stream) != mode) {
			continue
		}
		// Concurrency is instantaneous and includes calls started before the window.
		if rec.Started < from || rec.Started > now {
			if rec.State == "running" {
				agg.Active++
			}
			continue
		}
		agg.add(rec)
		key := rec.ModelID + "/" + rec.ConnectionID
		if groups[key] == nil {
			groups[key] = &metricGroup{ModelID: rec.ModelID, Alias: rec.Alias, ConnectionID: rec.ConnectionID, ConnectionName: rec.ConnectionName, metricAggregate: newAggregate()}
		}
		groups[key].add(rec)
		index := min(n-1, int(float64(rec.Started-from)/width))
		buckets[index].Requests++
		if rec.State == "canceled" {
			buckets[index].Canceled++
		} else if rec.State != "running" && rec.State != "complete" {
			buckets[index].Failed++
		}
		recent = append(recent, rec)
	}
	minutes := float64(now-from) / 60000
	agg.finish(minutes)
	groupList := []metricGroup{}
	for _, v := range groups {
		v.finish(minutes)
		groupList = append(groupList, *v)
	}
	sort.Slice(groupList, func(i, j int) bool {
		if groupList[i].Requests == groupList[j].Requests {
			return groupList[i].Alias < groupList[j].Alias
		}
		return groupList[i].Requests > groupList[j].Requests
	})
	for i := range buckets {
		buckets[i].RPM = float64(buckets[i].Requests) * 60000 / width
	}
	sort.Slice(recent, func(i, j int) bool { return recent[i].Started > recent[j].Started })
	if len(recent) > 8 {
		recent = recent[:8]
	}
	filterOptions := map[string][]metricOption{}
	for k, m := range options {
		out := []metricOption{}
		for id, name := range m {
			if id == "" {
				id = "unknown"
			}
			out = append(out, metricOption{ID: id, Name: name})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
		filterOptions[k] = out
	}
	writeJSON(w, 200, map[string]any{"from": from, "to": now, "monitoring_since": g.monitoringSince, "summary": agg, "models": groupList, "buckets": buckets, "recent": recent, "options": filterOptions, "metrics_errors": g.metricsErrors.Load(), "dropped_records": g.dropped.Load()})
}
