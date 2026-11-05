package gateway

import (
	"context"
	"database/sql"
	"net/http"
	"sort"
	"time"
)

// Signals answer "is something off even though no error says so". Failure rate,
// missing usage and fallback follow the selected range. Latency and traffic are
// always the last hour against the seven days before it, because a slowdown or
// a runaway client is about now, whatever range is on screen.

const (
	signalBaselineHours = 7 * 24
	signalScanHours     = 8 * 24
	slowMinSamples      = 5
	slowMinBaseline     = 20
	slowRatio           = 2.0
	slowMinDeltaMS      = 1000
	signalModelRows     = 8
	surgeMinRequests    = 20
	surgeRatio          = 2
	silentActiveDays    = 3
	cleanupOverdue      = 48 * time.Hour
	diskLowRatio        = 0.1
	diskLowBytes        = 1 << 30
)

type failurePoint struct {
	Started  int64 `json:"started"`
	Requests int   `json:"requests"`
	Failed   int   `json:"failed"`
}

type failureSignal struct {
	Requests     int            `json:"requests"`
	Failed       int            `json:"failed"`
	Rate         *float64       `json:"rate"`
	PrevRequests int            `json:"prev_requests"`
	PrevFailed   int            `json:"prev_failed"`
	PrevRate     *float64       `json:"prev_rate"`
	BucketMS     int64          `json:"bucket_ms"`
	Buckets      []failurePoint `json:"buckets"`
}

type modelSignal struct {
	ModelID     string   `json:"model_id"`
	Alias       string   `json:"alias"`
	Samples     int      `json:"samples"`
	P50         *float64 `json:"ttft_p50"`
	BaseSamples int      `json:"base_samples"`
	BaseP50     *float64 `json:"base_ttft_p50"`
	Ratio       *float64 `json:"ratio"`
	Slow        bool     `json:"slow"`
}

type projectSignal struct {
	ProjectID  string `json:"project_id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"` // surge | silent
	LastHour   int    `json:"last_hour"`
	PeakHour   int    `json:"peak_hour"`
	ActiveDays int    `json:"active_days"`
	LastSeen   int64  `json:"last_seen"`
}

type fallbackSignal struct {
	Total  int `json:"total"`
	Served int `json:"served"`
}

type backgroundSignal struct {
	LastCleanup    *maintenanceEntry `json:"last_cleanup"`
	LastCleanupOK  int64             `json:"last_cleanup_ok"`
	CleanupOverdue bool              `json:"cleanup_overdue"`
	DBBytes        int64             `json:"db_bytes"`
	DBGrowth7D     *int64            `json:"db_growth_7d"`
	DiskFreeBytes  *int64            `json:"disk_free_bytes"`
	DiskTotalBytes *int64            `json:"disk_total_bytes"`
	DiskLow        bool              `json:"disk_low"`
	MetricsErrors  int64             `json:"metrics_errors"`
	DroppedRecords int64             `json:"dropped_records"`
	StartedAt      int64             `json:"started_at"`
}

type signalsResponse struct {
	From         int64            `json:"from"`
	To           int64            `json:"to"`
	Failure      failureSignal    `json:"failure"`
	Models       []modelSignal    `json:"models"`
	Projects     []projectSignal  `json:"projects"`
	Fallback     fallbackSignal   `json:"fallback"`
	UsageMissing int              `json:"usage_missing"`
	Background   backgroundSignal `json:"background"`
}

func signalBucket(window string) time.Duration {
	switch window {
	case "1h":
		return 5 * time.Minute
	case "7d":
		return 6 * time.Hour
	case "all":
		return 24 * time.Hour
	}
	return time.Hour
}

func failedState(state string) bool {
	return state != "complete" && state != "canceled" && state != "running"
}

func failureRate(requests, failed int) *float64 {
	if requests == 0 {
		return nil
	}
	v := 100 * float64(failed) / float64(requests)
	return &v
}

// Every query below drains its rows before the next one starts: the database
// has a single connection, so a nested query would wait on itself.
func (g *Gateway) failureSignal(ctx context.Context, window string, from, now int64) (failureSignal, error) {
	size := signalBucket(window).Milliseconds()
	count := max(1, (now-from+size-1)/size)
	f := failureSignal{BucketMS: size, Buckets: make([]failurePoint, count)}
	for i := range f.Buckets {
		f.Buckets[i].Started = from + int64(i)*size
	}
	rows, err := g.db.QueryContext(ctx, "SELECT (started-?)/?,m_state,count(*) FROM request_metrics WHERE started>=? AND started<=? GROUP BY 1,2", from, size, from, now)
	if err != nil {
		return f, err
	}
	defer rows.Close()
	for rows.Next() {
		var index int64
		var state sql.NullString
		var n int
		if err = rows.Scan(&index, &state, &n); err != nil {
			return f, err
		}
		if state.String == "canceled" || state.String == "running" || index >= count {
			continue
		}
		f.Requests += n
		f.Buckets[index].Requests += n
		if failedState(state.String) {
			f.Failed += n
			f.Buckets[index].Failed += n
		}
	}
	if err = rows.Err(); err != nil {
		return f, err
	}
	rows.Close()
	f.Rate = failureRate(f.Requests, f.Failed)
	// ALL has no earlier period, and the first day of monitoring has none either.
	if from <= g.monitoringSince {
		return f, nil
	}
	prior, err := g.db.QueryContext(ctx, "SELECT m_state,count(*) FROM request_metrics WHERE started>=? AND started<? GROUP BY 1", max(g.monitoringSince, from-(now-from)), from)
	if err != nil {
		return f, err
	}
	defer prior.Close()
	for prior.Next() {
		var state sql.NullString
		var n int
		if err = prior.Scan(&state, &n); err != nil {
			return f, err
		}
		if state.String == "canceled" || state.String == "running" {
			continue
		}
		f.PrevRequests += n
		if failedState(state.String) {
			f.PrevFailed += n
		}
	}
	f.PrevRate = failureRate(f.PrevRequests, f.PrevFailed)
	return f, prior.Err()
}

type signalModelScan struct {
	alias          string
	current, basis []float64
}

type signalProjectScan struct {
	hours    [signalBaselineHours + 1]int
	days     [8]bool
	lastSeen int64
}

func hourAge(now, started int64) int { return int((now - started) / time.Hour.Milliseconds()) }

// scanRecent reads the last eight days once for both latency and traffic.
func (g *Gateway) scanRecent(ctx context.Context, now int64) (map[string]*signalModelScan, map[string]*signalProjectScan, error) {
	models, projects := map[string]*signalModelScan{}, map[string]*signalProjectScan{}
	rows, err := g.db.QueryContext(ctx, `SELECT started,m_project,m_model,m_alias,m_state,json_extract(summary,'$.stream'),json_extract(summary,'$.first_token_ms') FROM request_metrics WHERE started>=? AND started<=?`, now-signalScanHours*time.Hour.Milliseconds(), now)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var started int64
		var project, model, alias, state sql.NullString
		var stream sql.NullBool
		var ttft sql.NullFloat64
		if err = rows.Scan(&started, &project, &model, &alias, &state, &stream, &ttft); err != nil {
			return nil, nil, err
		}
		age := hourAge(now, started)
		if project.String != "" {
			p := projects[project.String]
			if p == nil {
				p = &signalProjectScan{}
				projects[project.String] = p
			}
			if age <= signalBaselineHours {
				p.hours[age]++
			}
			if day := age / 24; day >= 1 && day < len(p.days) {
				p.days[day] = true
			}
			p.lastSeen = max(p.lastSeen, started)
		}
		if model.String == "" || state.String != "complete" || !stream.Bool || !ttft.Valid || age > signalBaselineHours {
			continue
		}
		m := models[model.String]
		if m == nil {
			m = &signalModelScan{}
			models[model.String] = m
		}
		m.alias = alias.String
		if age == 0 {
			m.current = append(m.current, ttft.Float64)
		} else {
			m.basis = append(m.basis, ttft.Float64)
		}
	}
	return models, projects, rows.Err()
}

func modelSignals(scan map[string]*signalModelScan) []modelSignal {
	out := []modelSignal{}
	for id, m := range scan {
		if len(m.current) == 0 {
			continue
		}
		cur, base := distribution(m.current), distribution(m.basis)
		s := modelSignal{ModelID: id, Alias: m.alias, Samples: cur.Count, P50: cur.P50, BaseSamples: base.Count, BaseP50: base.P50}
		if base.P50 != nil && *base.P50 > 0 {
			ratio := *cur.P50 / *base.P50
			s.Ratio = &ratio
			s.Slow = cur.Count >= slowMinSamples && base.Count >= slowMinBaseline && ratio >= slowRatio && *cur.P50-*base.P50 >= slowMinDeltaMS
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Slow != out[j].Slow {
			return out[i].Slow
		}
		if out[i].Samples != out[j].Samples {
			return out[i].Samples > out[j].Samples
		}
		return out[i].Alias < out[j].Alias
	})
	return out[:min(len(out), signalModelRows)]
}

func (g *Gateway) projectSignals(ctx context.Context, scan map[string]*signalProjectScan) ([]projectSignal, error) {
	rows, err := g.db.QueryContext(ctx, "SELECT id,name FROM projects WHERE enabled=1")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []projectSignal{}
	for rows.Next() {
		var id, name string
		if err = rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		p := scan[id]
		if p == nil {
			continue
		}
		peak, activeDays, lastDay := 0, 0, 0
		for _, n := range p.hours[1:] {
			peak = max(peak, n)
		}
		for _, active := range p.days {
			if active {
				activeDays++
			}
		}
		for _, n := range p.hours[:24] {
			lastDay += n
		}
		s := projectSignal{ProjectID: id, Name: name, LastHour: p.hours[0], PeakHour: peak, ActiveDays: activeDays, LastSeen: p.lastSeen}
		// The baseline is the busiest hour, not the average, so a normal working
		// hour never reads as a spike against a week of quiet nights.
		switch {
		case p.hours[0] >= surgeMinRequests && p.hours[0] > surgeRatio*peak:
			s.Kind = "surge"
		case lastDay == 0 && activeDays >= silentActiveDays:
			s.Kind = "silent"
		default:
			continue
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind == "surge"
		}
		return out[i].Name < out[j].Name
	})
	return out, rows.Err()
}

func (g *Gateway) fallbackSignal(ctx context.Context, from, now int64) (fallbackSignal, error) {
	var f fallbackSignal
	rows, err := g.db.QueryContext(ctx, "SELECT m_state,count(*) FROM request_metrics WHERE started>=? AND started<=? AND COALESCE(json_extract(summary,'$.fallback_from'),'')<>'' GROUP BY 1", from, now)
	if err != nil {
		return f, err
	}
	defer rows.Close()
	for rows.Next() {
		var state sql.NullString
		var n int
		if err = rows.Scan(&state, &n); err != nil {
			return f, err
		}
		f.Total += n
		if state.String == "complete" {
			f.Served += n
		}
	}
	return f, rows.Err()
}

// usageMissing counts successful calls that reported no usage, so their cost is
// understated. Web tools never report usage and are billed per call.
func (g *Gateway) usageMissing(ctx context.Context, from, now int64) (int, error) {
	rows, err := g.db.QueryContext(ctx, "SELECT json_extract(summary,'$.protocol'),count(*) FROM request_metrics WHERE started>=? AND started<=? AND m_state='complete' AND json_extract(summary,'$.usage_status')<>'complete' GROUP BY 1", from, now)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	total := 0
	for rows.Next() {
		var protocol sql.NullString
		var n int
		if err = rows.Scan(&protocol, &n); err != nil {
			return 0, err
		}
		if !isWebTool(protocol.String) {
			total += n
		}
	}
	return total, rows.Err()
}

func (g *Gateway) backgroundSignal(now int64) (backgroundSignal, error) {
	b := backgroundSignal{DBBytes: g.dbFileSize(), MetricsErrors: g.metricsErrors.Load(), DroppedRecords: g.dropped.Load(), StartedAt: g.startedAt.UnixMilli()}
	logs, err := g.maintenanceLog(200)
	if err != nil {
		return b, err
	}
	weekAgo := now - 7*24*time.Hour.Milliseconds()
	for i := range logs {
		e := &logs[i]
		if e.Kind != "cleanup" {
			continue
		}
		if b.LastCleanup == nil {
			b.LastCleanup = e
		}
		if b.LastCleanupOK == 0 && e.Detail.Status == "ok" {
			b.LastCleanupOK = e.Started
		}
		if b.DBGrowth7D == nil && e.Started <= weekAgo && e.Detail.SizeAfterBytes > 0 {
			growth := b.DBBytes - e.Detail.SizeAfterBytes
			b.DBGrowth7D = &growth
		}
	}
	// A new gateway has run no cleanup yet; only a stale success is overdue.
	b.CleanupOverdue = b.LastCleanupOK > 0 && now-b.LastCleanupOK > cleanupOverdue.Milliseconds()
	if free, total, ok := diskSpace(g.dataDir); ok {
		b.DiskFreeBytes, b.DiskTotalBytes = &free, &total
		b.DiskLow = free < diskLowBytes || float64(free) < diskLowRatio*float64(total)
	}
	return b, nil
}

func (g *Gateway) computeSignals(ctx context.Context, window string, now int64) (signalsResponse, error) {
	var out signalsResponse
	from, err := diagnosticRange(window, now, g.monitoringSince)
	if err != nil {
		return out, err
	}
	out.From, out.To = from, now
	if out.Failure, err = g.failureSignal(ctx, window, from, now); err != nil {
		return out, err
	}
	models, projects, err := g.scanRecent(ctx, now)
	if err != nil {
		return out, err
	}
	out.Models = modelSignals(models)
	if out.Projects, err = g.projectSignals(ctx, projects); err != nil {
		return out, err
	}
	if out.Fallback, err = g.fallbackSignal(ctx, from, now); err != nil {
		return out, err
	}
	if out.UsageMissing, err = g.usageMissing(ctx, from, now); err != nil {
		return out, err
	}
	out.Background, err = g.backgroundSignal(now)
	return out, err
}

func (g *Gateway) signals(w http.ResponseWriter, r *http.Request) {
	window := r.URL.Query().Get("window")
	if _, err := diagnosticRange(window, 0, 0); err != nil {
		problem(w, 400, err.Error())
		return
	}
	out, err := g.computeSignals(r.Context(), window, time.Now().UnixMilli())
	if err != nil {
		problem(w, 500, "读取异常信号失败")
		return
	}
	writeJSON(w, 200, out)
}
