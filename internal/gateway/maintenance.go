package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Retention keeps three layers: request bodies (short), per-call summaries
// (medium) and per-day usage rollups (permanent). Deletes run in small
// batches because the database has a single connection shared with live calls.

const cleanupBatch = 500

type maintenanceDetail struct {
	Trigger         string `json:"trigger"` // schedule | startup | manual | migration
	Bodies          int64  `json:"bodies"`
	Summaries       int64  `json:"summaries"`
	RolledDays      int    `json:"rolled_days"`
	ReclaimedBytes  int64  `json:"reclaimed_bytes"`
	SizeBeforeBytes int64  `json:"size_before_bytes"`
	SizeAfterBytes  int64  `json:"size_after_bytes"`
	DurationMS      int64  `json:"duration_ms"`
	Status          string `json:"status"`
	Error           string `json:"error,omitempty"`
}

type maintenanceEntry struct {
	ID      int64             `json:"id"`
	Started int64             `json:"started"`
	Kind    string            `json:"kind"`
	Detail  maintenanceDetail `json:"detail"`
}

func (g *Gateway) dbFileSize() int64 { return dbFileSizeAt(g.dataDir) }

func dbFileSizeAt(dataDir string) int64 {
	var total int64
	for _, name := range []string{"gateway.db", "gateway.db-wal"} {
		if st, err := os.Stat(filepath.Join(dataDir, name)); err == nil {
			total += st.Size()
		}
	}
	return total
}

func (g *Gateway) logMaintenance(kind string, started time.Time, d maintenanceDetail) {
	raw, _ := json.Marshal(d)
	_, _ = g.db.Exec("INSERT INTO maintenance_log(started,kind,detail_json) VALUES(?,?,?)", started.UnixMilli(), kind, string(raw))
	_, _ = g.db.Exec("DELETE FROM maintenance_log WHERE id NOT IN (SELECT id FROM maintenance_log ORDER BY id DESC LIMIT 200)")
}

// dayStart is local midnight in the cost time zone, so rollups never split a day.
func dayStart(t time.Time) time.Time {
	t = t.In(costZone)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, costZone)
}

// retentionCutoffs returns the oldest body and summary start time to keep.
func retentionCutoffs(s Settings, now time.Time) (int64, int64) {
	today := dayStart(now)
	return today.AddDate(0, 0, -s.BodyDays).UnixMilli(), today.AddDate(0, 0, -s.SummaryDays).UnixMilli()
}

func (g *Gateway) deleteBatches(ctx context.Context, query string, args ...any) (int64, error) {
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		res, err := g.db.ExecContext(ctx, query, args...)
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
		if n < cleanupBatch {
			return total, nil
		}
		// Let queued request writes take the connection between batches.
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

type dailyKey struct{ day, projectID, modelID, alias, category string }
type dailyRow struct {
	projectName string
	totals      CostTotals
}

// rollupDay folds every summary of one finished day into usage_daily and
// deletes those summaries in the same transaction.
func (g *Gateway) rollupDay(from int64, book priceBook) (int64, error) {
	to := time.UnixMilli(from).In(costZone).AddDate(0, 0, 1).UnixMilli()
	rows, err := g.db.Query("SELECT summary FROM request_metrics WHERE started>=? AND started<?", from, to)
	if err != nil {
		return 0, err
	}
	agg := map[dailyKey]*dailyRow{}
	for rows.Next() {
		var raw string
		var rec Record
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal([]byte(raw), &rec)
		}
		if err != nil {
			rows.Close()
			return 0, err
		}
		rec.normalizeStoredUsage()
		c := costOf(rec, book)
		if c.Status == "none" || c.Status == "running" {
			continue
		}
		k := dailyKey{time.UnixMilli(from).In(costZone).Format("2006-01-02"), rec.ProjectID, rec.ModelID, rec.Alias, rec.Category}
		if agg[k] == nil {
			agg[k] = &dailyRow{projectName: rec.ProjectName}
		}
		agg[k].totals.add(c)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	tx, err := g.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	for k, v := range agg {
		var old string
		existing := CostTotals{}
		if tx.QueryRow("SELECT totals_json FROM usage_daily WHERE day=? AND project_id=? AND model_id=? AND alias=? AND category=?", k.day, k.projectID, k.modelID, k.alias, k.category).Scan(&old) == nil {
			_ = json.Unmarshal([]byte(old), &existing)
		}
		merged := mergeTotals(existing, v.totals)
		raw, _ := json.Marshal(merged)
		if _, err = tx.Exec(`INSERT INTO usage_daily(day,project_id,project_name,model_id,alias,category,totals_json) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(day,project_id,model_id,alias,category) DO UPDATE SET totals_json=excluded.totals_json,project_name=excluded.project_name`,
			k.day, k.projectID, v.projectName, k.modelID, k.alias, k.category, string(raw)); err != nil {
			return 0, err
		}
	}
	res, err := tx.Exec("DELETE FROM request_metrics WHERE started>=? AND started<?", from, to)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if _, err = tx.Exec("DELETE FROM requests WHERE started>=? AND started<?", from, to); err != nil {
		return 0, err
	}
	return n, tx.Commit()
}

func mergeTotals(a, b CostTotals) CostTotals {
	a.Requests += b.Requests
	a.Cost += b.Cost
	a.InputTokens += b.InputTokens
	a.CacheRead += b.CacheRead
	a.CacheWrite += b.CacheWrite
	a.OutputTokens += b.OutputTokens
	a.AudioSeconds += b.AudioSeconds
	a.Characters += b.Characters
	a.Priced += b.Priced
	a.Partial += b.Partial
	a.UsageUnknown += b.UsageUnknown
	a.Unpriced += b.Unpriced
	return a
}

var errCleanupBusy = errors.New("清理正在进行")

// runCleanup applies the retention policy once.
func (g *Gateway) runCleanup(ctx context.Context, trigger string) (maintenanceDetail, error) {
	if !g.cleanupMu.TryLock() {
		return maintenanceDetail{}, errCleanupBusy
	}
	defer g.cleanupMu.Unlock()
	started := time.Now()
	d := maintenanceDetail{Trigger: trigger, SizeBeforeBytes: g.dbFileSize(), Status: "ok"}
	err := func() error {
		s := g.currentSettings()
		bodyCutoff, summaryCutoff := retentionCutoffs(s, started)
		n, err := g.deleteBatches(ctx, "DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE started<? LIMIT ?)", bodyCutoff, cleanupBatch)
		d.Bodies = n
		if err != nil {
			return err
		}
		var oldest sql.NullInt64
		if err = g.db.QueryRow("SELECT min(started) FROM request_metrics WHERE started<?", summaryCutoff).Scan(&oldest); err != nil {
			return err
		}
		if oldest.Valid {
			book, err := g.loadPrices()
			if err != nil {
				return err
			}
			for day := dayStart(time.UnixMilli(oldest.Int64)); day.UnixMilli() < summaryCutoff; day = day.AddDate(0, 0, 1) {
				if err = ctx.Err(); err != nil {
					return err
				}
				n, err := g.rollupDay(day.UnixMilli(), book)
				if err != nil {
					return err
				}
				d.Summaries += n
				d.RolledDays++
			}
			g.invalidateSpend()
		}
		_, _ = g.db.Exec("DELETE FROM connection_health WHERE bucket<?", started.Add(-7*24*time.Hour).UnixMilli())
		if _, err = g.db.Exec("PRAGMA incremental_vacuum"); err != nil {
			return err
		}
		_, _ = g.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
		return nil
	}()
	d.SizeAfterBytes = g.dbFileSize()
	d.ReclaimedBytes = max(0, d.SizeBeforeBytes-d.SizeAfterBytes)
	d.DurationMS = time.Since(started).Milliseconds()
	if err != nil {
		d.Status, d.Error = "error", err.Error()
	}
	g.logMaintenance("cleanup", started, d)
	return d, err
}

// nextCleanup is the next CleanupHour in the cost time zone.
func nextCleanup(s Settings, now time.Time) time.Time {
	local := now.In(costZone)
	next := time.Date(local.Year(), local.Month(), local.Day(), s.CleanupHour, 0, 0, 0, costZone)
	if !next.After(local) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}

func (g *Gateway) wakeMaintenance() {
	select {
	case g.maintWake <- struct{}{}:
	default:
	}
}

// background runs the cleanup schedule, health persistence and idle probes.
func (g *Gateway) background(ctx context.Context) {
	defer g.bg.Done()
	startup := time.NewTimer(30 * time.Second)
	defer startup.Stop()
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	next := nextCleanup(g.currentSettings(), time.Now())
	for {
		select {
		case <-ctx.Done():
			g.flushHealth()
			return
		case <-startup.C:
			_, _ = g.runCleanup(ctx, "startup")
		case <-g.maintWake:
			next = nextCleanup(g.currentSettings(), time.Now())
		case now := <-tick.C:
			g.flushHealth()
			g.probeIdle(ctx)
			if !now.Before(next) {
				_, _ = g.runCleanup(ctx, "schedule")
				next = nextCleanup(g.currentSettings(), time.Now())
			}
		}
	}
}

type storageStats struct {
	FileBytes     int64  `json:"file_bytes"`
	PageBytes     int64  `json:"page_bytes"`
	FreeBytes     int64  `json:"free_bytes"`
	BodyBytes     int64  `json:"body_bytes"`
	BodyRows      int64  `json:"body_rows"`
	SummaryBytes  int64  `json:"summary_bytes"`
	SummaryRows   int64  `json:"summary_rows"`
	RollupBytes   int64  `json:"rollup_bytes"`
	RollupDays    int64  `json:"rollup_days"`
	OldestBody    int64  `json:"oldest_body,omitempty"`
	OldestSummary int64  `json:"oldest_summary,omitempty"`
	AutoVacuum    string `json:"auto_vacuum"`
}

func (g *Gateway) storage() (storageStats, error) {
	var s storageStats
	var pages, free, size, mode int64
	q := func(query string, dst ...any) error { return g.db.QueryRow(query).Scan(dst...) }
	if err := q("PRAGMA page_count", &pages); err != nil {
		return s, err
	}
	_ = q("PRAGMA freelist_count", &free)
	_ = q("PRAGMA page_size", &size)
	_ = q("PRAGMA auto_vacuum", &mode)
	s.FileBytes, s.PageBytes, s.FreeBytes = g.dbFileSize(), pages*size, free*size
	s.AutoVacuum = map[int64]string{0: "none", 1: "full", 2: "incremental"}[mode]
	// dbstat gives exact on-disk table sizes; fall back to payload lengths.
	if q("SELECT COALESCE(sum(pgsize),0) FROM dbstat WHERE name IN ('requests','idx_requests_started','idx_requests_project_started','idx_requests_task')", &s.BodyBytes) != nil {
		_ = q("SELECT COALESCE(sum(length(record)+length(summary)),0) FROM requests", &s.BodyBytes)
	}
	if q("SELECT COALESCE(sum(pgsize),0) FROM dbstat WHERE name LIKE '%metrics%'", &s.SummaryBytes) != nil {
		_ = q("SELECT COALESCE(sum(length(summary)),0) FROM request_metrics", &s.SummaryBytes)
	}
	if q("SELECT COALESCE(sum(pgsize),0) FROM dbstat WHERE name LIKE '%usage_daily%'", &s.RollupBytes) != nil {
		_ = q("SELECT COALESCE(sum(length(totals_json)),0) FROM usage_daily", &s.RollupBytes)
	}
	_ = q("SELECT count(*),COALESCE(min(started),0) FROM requests", &s.BodyRows, &s.OldestBody)
	_ = q("SELECT count(*),COALESCE(min(started),0) FROM request_metrics", &s.SummaryRows, &s.OldestSummary)
	_ = q("SELECT count(DISTINCT day) FROM usage_daily", &s.RollupDays)
	return s, nil
}

func (g *Gateway) maintenanceLog(limit int) ([]maintenanceEntry, error) {
	rows, err := g.db.Query("SELECT id,started,kind,detail_json FROM maintenance_log ORDER BY id DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []maintenanceEntry{}
	for rows.Next() {
		var e maintenanceEntry
		var raw string
		if err = rows.Scan(&e.ID, &e.Started, &e.Kind, &raw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(raw), &e.Detail)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (g *Gateway) systemAPI(w http.ResponseWriter, r *http.Request) {
	st, err := g.storage()
	if err != nil {
		problem(w, 500, "读取存储信息失败")
		return
	}
	logs, err := g.maintenanceLog(20)
	if err != nil {
		problem(w, 500, "读取清理记录失败")
		return
	}
	s := g.currentSettings()
	bodyCutoff, summaryCutoff := retentionCutoffs(s, time.Now())
	writeJSON(w, 200, map[string]any{
		"settings": s, "storage": st, "log": logs,
		"next_cleanup": nextCleanup(s, time.Now()).UnixMilli(),
		"body_cutoff":  bodyCutoff, "summary_cutoff": summaryCutoff,
		"schema_ext": schemaExtVersion,
	})
}

func (g *Gateway) cleanupAPI(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	d, err := g.runCleanup(ctx, "manual")
	if errors.Is(err, errCleanupBusy) {
		problem(w, 409, err.Error())
		return
	}
	if err != nil {
		problem(w, 500, "清理失败："+d.Error)
		return
	}
	writeJSON(w, 200, d)
}

func (g *Gateway) vacuumAPI(w http.ResponseWriter, r *http.Request) {
	if !g.cleanupMu.TryLock() {
		problem(w, 409, errCleanupBusy.Error())
		return
	}
	defer g.cleanupMu.Unlock()
	started := time.Now()
	d := maintenanceDetail{Trigger: "manual", SizeBeforeBytes: g.dbFileSize(), Status: "ok"}
	_, err := g.db.Exec("PRAGMA incremental_vacuum")
	if err == nil {
		_, err = g.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	}
	d.SizeAfterBytes = g.dbFileSize()
	d.ReclaimedBytes = max(0, d.SizeBeforeBytes-d.SizeAfterBytes)
	d.DurationMS = time.Since(started).Milliseconds()
	if err != nil {
		d.Status, d.Error = "error", err.Error()
	}
	g.logMaintenance("vacuum", started, d)
	if err != nil {
		problem(w, 500, "回收空间失败")
		return
	}
	writeJSON(w, 200, d)
}

type dailyUsage struct {
	Day         string
	ProjectID   string
	ProjectName string
	ModelID     string
	Alias       string
	Category    string
	Totals      CostTotals
}

// dailyRollups returns rollup days overlapping the range. Rollups only exist
// for days whose summaries were already removed, so they never double count.
func (g *Gateway) dailyRollups(rng usageRange, projectID string) ([]dailyUsage, error) {
	from := time.UnixMilli(rng.from).In(costZone).Format("2006-01-02")
	to := time.UnixMilli(rng.to - 1).In(costZone).Format("2006-01-02")
	query := "SELECT day,project_id,project_name,model_id,alias,category,totals_json FROM usage_daily WHERE day>=? AND day<=?"
	args := []any{from, to}
	if projectID != "" {
		query += " AND project_id=?"
		args = append(args, projectID)
	}
	rows, err := g.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []dailyUsage{}
	for rows.Next() {
		var d dailyUsage
		var raw string
		if err = rows.Scan(&d.Day, &d.ProjectID, &d.ProjectName, &d.ModelID, &d.Alias, &d.Category, &raw); err != nil {
			return nil, err
		}
		if json.Unmarshal([]byte(raw), &d.Totals) != nil {
			continue
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
