package gateway

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Costs are estimates from administrator-entered unit prices, not vendor bills.
// They are derived when read, so correcting a price version reprices history.
// A price change is a new version with a later effective time.
const costCurrency = "CNY"

// Days, months and budgets follow China Standard Time (no daylight saving).
var costZone = time.FixedZone("Asia/Shanghai", 8*3600)

const (
	maxUnitPrice    = 1e6
	maxBudget       = 1e9
	maxPriceHistory = 100
)

// ModelPrice is one price version. Token prices are per million tokens.
type ModelPrice struct {
	EffectiveFrom int64    `json:"effective_from"`
	Input         *float64 `json:"input_per_mtok"`
	Output        *float64 `json:"output_per_mtok"`
	CacheRead     *float64 `json:"cache_read_per_mtok"`
	CacheWrite    *float64 `json:"cache_write_per_mtok"`
	AudioMinute   *float64 `json:"audio_per_minute"`
	Chars10K      *float64 `json:"per_10k_characters"`
	PerCall       *float64 `json:"per_call"`
	// Optional peak-hour rates, e.g. DeepSeek charges double on weekday
	// working hours. Unset peak fields fall back to the base rates.
	Peak *PeakPrice `json:"peak,omitempty"`
}

// PeakPrice applies on the listed weekdays (1=Monday … 7=Sunday) within the
// listed Asia/Shanghai time ranges, end exclusive. Public holidays are not
// known to the gateway and are treated as ordinary days.
type PeakPrice struct {
	Weekdays    []int    `json:"weekdays"`
	Hours       []string `json:"hours"`
	Input       *float64 `json:"input_per_mtok"`
	Output      *float64 `json:"output_per_mtok"`
	CacheRead   *float64 `json:"cache_read_per_mtok"`
	CacheWrite  *float64 `json:"cache_write_per_mtok"`
	AudioMinute *float64 `json:"audio_per_minute"`
	Chars10K    *float64 `json:"per_10k_characters"`
	PerCall     *float64 `json:"per_call"`
}

func parseClock(s string) (int, bool) {
	t, err := time.Parse("15:04", s)
	if err != nil || len(s) != 5 {
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}

// parseRange accepts "09:00-12:00"; "24:00" may end a range.
func parseRange(s string) (int, int, bool) {
	from, to, ok := strings.Cut(s, "-")
	if !ok {
		return 0, 0, false
	}
	start, ok1 := parseClock(from)
	end, ok2 := parseClock(to)
	if to == "24:00" {
		end, ok2 = 24*60, true
	}
	return start, end, ok1 && ok2 && start < end
}

func (p *PeakPrice) covers(started int64) bool {
	t := time.UnixMilli(started).In(costZone)
	day := int(t.Weekday())
	if day == 0 {
		day = 7
	}
	if !slices.Contains(p.Weekdays, day) {
		return false
	}
	minute := t.Hour()*60 + t.Minute()
	for _, r := range p.Hours {
		if start, end, ok := parseRange(r); ok && minute >= start && minute < end {
			return true
		}
	}
	return false
}

func (p *PeakPrice) validate() error {
	if len(p.Weekdays) == 0 || len(p.Weekdays) > 7 || len(p.Hours) == 0 || len(p.Hours) > 8 {
		return errors.New("高峰时段需要选择星期并填写 1 到 8 个时间段")
	}
	seen := map[int]bool{}
	for _, d := range p.Weekdays {
		if d < 1 || d > 7 || seen[d] {
			return errors.New("高峰时段的星期无效或重复")
		}
		seen[d] = true
	}
	for _, r := range p.Hours {
		if _, _, ok := parseRange(r); !ok {
			return fmt.Errorf("高峰时间段 %q 格式应为 09:00-12:00", r)
		}
	}
	set := false
	for _, v := range []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite, p.AudioMinute, p.Chars10K, p.PerCall} {
		if !validPrice(v) {
			return fmt.Errorf("单价必须为 0 到 %g 之间的数字", maxUnitPrice)
		}
		set = set || v != nil
	}
	if !set {
		return errors.New("高峰时段至少填写一项单价")
	}
	return nil
}

// rateAt returns the rates in force at a moment: peak fields override base ones.
func (p ModelPrice) rateAt(started int64) (ModelPrice, bool) {
	if p.Peak == nil || !p.Peak.covers(started) {
		return p, false
	}
	pick := func(peak, base *float64) *float64 {
		if peak != nil {
			return peak
		}
		return base
	}
	k := p.Peak
	p.Input, p.Output, p.CacheRead = pick(k.Input, p.Input), pick(k.Output, p.Output), pick(k.CacheRead, p.CacheRead)
	p.CacheWrite, p.AudioMinute, p.PerCall = pick(k.CacheWrite, p.CacheWrite), pick(k.AudioMinute, p.AudioMinute), pick(k.PerCall, p.PerCall)
	p.Chars10K = pick(k.Chars10K, p.Chars10K)
	return p, true
}

func migrateCosts(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Prices outlive a deleted model so its past calls keep their cost.
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS model_prices(model_id TEXT NOT NULL,effective_from INTEGER NOT NULL,price_json TEXT NOT NULL,PRIMARY KEY(model_id,effective_from))`); err != nil {
		return err
	}
	var exists int
	if err = tx.QueryRow("SELECT count(*) FROM pragma_table_info('projects') WHERE name='monthly_budget'").Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		if _, err = tx.Exec("ALTER TABLE projects ADD COLUMN monthly_budget REAL"); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("PRAGMA user_version=10"); err != nil {
		return err
	}
	return tx.Commit()
}

func validPrice(v *float64) bool {
	return v == nil || !math.IsNaN(*v) && *v >= 0 && *v <= maxUnitPrice
}

func validatePrices(prices []ModelPrice) error {
	if len(prices) > maxPriceHistory {
		return errors.New("价格版本过多")
	}
	seen := map[int64]bool{}
	for _, p := range prices {
		if p.EffectiveFrom < 0 || seen[p.EffectiveFrom] {
			return errors.New("价格生效时间无效或重复")
		}
		seen[p.EffectiveFrom] = true
		values := []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite, p.AudioMinute, p.Chars10K, p.PerCall}
		set := false
		for _, v := range values {
			if !validPrice(v) {
				return fmt.Errorf("单价必须为 0 到 %g 之间的数字", maxUnitPrice)
			}
			set = set || v != nil
		}
		if !set {
			return errors.New("每个价格版本至少填写一项单价")
		}
		if p.Peak != nil {
			if err := p.Peak.validate(); err != nil {
				return err
			}
		}
	}
	return nil
}

type execer interface {
	Exec(string, ...any) (sql.Result, error)
}

func replacePrices(tx execer, modelID string, prices []ModelPrice) error {
	if _, err := tx.Exec("DELETE FROM model_prices WHERE model_id=?", modelID); err != nil {
		return err
	}
	for _, p := range prices {
		b, _ := json.Marshal(p)
		if _, err := tx.Exec("INSERT INTO model_prices(model_id,effective_from,price_json) VALUES(?,?,?)", modelID, p.EffectiveFrom, string(b)); err != nil {
			return err
		}
	}
	return nil
}

// priceBook maps a model ID to its versions, oldest first.
type priceBook map[string][]ModelPrice

func (g *Gateway) loadPrices() (priceBook, error) {
	rows, err := g.db.Query("SELECT model_id,price_json FROM model_prices ORDER BY model_id,effective_from")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	book := priceBook{}
	for rows.Next() {
		var modelID, raw string
		var p ModelPrice
		if err = rows.Scan(&modelID, &raw); err == nil {
			err = json.Unmarshal([]byte(raw), &p)
		}
		if err != nil {
			return nil, err
		}
		book[modelID] = append(book[modelID], p)
	}
	return book, rows.Err()
}

func (b priceBook) at(modelID string, started int64) *ModelPrice {
	versions := b[modelID]
	for i := len(versions) - 1; i >= 0; i-- {
		if versions[i].EffectiveFrom <= started {
			return &versions[i]
		}
	}
	return nil
}

// RecordCost explains how one call was priced.
// Status: none (never reached the vendor), running, priced, partial (some usage
// was not reported, the amount is a lower bound), usage_unknown, unpriced.
type RecordCost struct {
	Status        string  `json:"status"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency"`
	PriceFrom     *int64  `json:"price_effective_from,omitempty"`
	Peak          bool    `json:"peak,omitempty"`
	InputTokens   int64   `json:"input_tokens,omitempty"`
	CacheRead     int64   `json:"cache_read_tokens,omitempty"`
	CacheWrite    int64   `json:"cache_write_tokens,omitempty"`
	OutputTokens  int64   `json:"output_tokens,omitempty"`
	AudioSeconds  float64 `json:"audio_seconds,omitempty"`
	TTSCharacters int64   `json:"tts_characters,omitempty"`
	BillableCalls int     `json:"billable_calls,omitempty"`
}

func orPrice(v, fallback *float64) *float64 {
	if v != nil {
		return v
	}
	return fallback
}

func costOf(rec Record, book priceBook) RecordCost {
	c := RecordCost{Status: "none", Currency: costCurrency}
	if rec.State == "running" {
		c.Status = "running"
		return c
	}
	if !rec.Forwarded {
		return c
	}
	version := book.at(rec.ModelID, rec.Started)
	if version == nil {
		c.Status = "unpriced"
		return c
	}
	c.PriceFrom = &version.EffectiveFrom
	rates, peak := version.rateAt(rec.Started)
	p := &rates
	c.Peak = peak
	known, complete := false, true
	switch {
	case rec.Protocol == "dashscope-asr":
		if p.AudioMinute == nil {
			c.Status = "unpriced"
			return c
		}
		if rec.AudioSeconds != nil {
			c.AudioSeconds = *rec.AudioSeconds
			c.Amount += *rec.AudioSeconds / 60 * *p.AudioMinute
			known = true
		}
	case rec.Protocol == "dashscope-tts":
		// Token prices win when set (Qwen-Audio 3.1); otherwise characters (3.0).
		switch {
		case p.Input != nil && p.Output != nil:
			if rec.InputTotal != nil {
				c.InputTokens = *rec.InputTotal
				c.Amount += float64(c.InputTokens) / 1e6 * *p.Input
				known = true
			} else {
				complete = false
			}
			if rec.OutputReported {
				c.OutputTokens = rec.OutputTokens
				c.Amount += float64(c.OutputTokens) / 1e6 * *p.Output
				known = true
			} else {
				complete = false
			}
		case p.Chars10K != nil:
			if rec.TTSCharacters != nil {
				c.TTSCharacters = *rec.TTSCharacters
				c.Amount += float64(*rec.TTSCharacters) / 1e4 * *p.Chars10K
				known = true
			}
		default:
			c.Status = "unpriced"
			return c
		}
	case isWebTool(rec.Protocol):
		if p.PerCall == nil {
			c.Status = "unpriced"
			return c
		}
		known = true
	default:
		if p.Input == nil || p.Output == nil {
			c.Status = "unpriced"
			return c
		}
		var uncached *int64
		if rec.InputUncached != nil {
			uncached = rec.InputUncached
		} else if rec.InputTotal != nil {
			n := *rec.InputTotal
			if rec.CacheRead != nil && *rec.CacheRead <= n {
				n -= *rec.CacheRead
			}
			uncached = &n
		} else if rec.MetricsVersion == 0 && rec.InputTokens > 0 {
			uncached = &rec.InputTokens
		}
		if uncached != nil {
			c.InputTokens = *uncached
			known = true
		} else {
			complete = false
		}
		if rec.CacheRead != nil {
			c.CacheRead = *rec.CacheRead
		}
		if rec.CacheWrite != nil {
			c.CacheWrite = *rec.CacheWrite
		}
		if rec.OutputReported || rec.MetricsVersion == 0 && rec.OutputTokens > 0 {
			c.OutputTokens = rec.OutputTokens
			known = true
		} else {
			complete = false
		}
		// Without a separate cache price, cached input is charged as ordinary input.
		c.Amount += float64(c.InputTokens) / 1e6 * *p.Input
		c.Amount += float64(c.CacheRead) / 1e6 * *orPrice(p.CacheRead, p.Input)
		c.Amount += float64(c.CacheWrite) / 1e6 * *orPrice(p.CacheWrite, p.Input)
		c.Amount += float64(c.OutputTokens) / 1e6 * *p.Output
	}
	// Per-call fees apply to calls the vendor completed.
	if p.PerCall != nil && rec.State == "complete" {
		c.BillableCalls = 1
		c.Amount += *p.PerCall
	}
	switch {
	case known && complete:
		c.Status = "priced"
	case known:
		c.Status = "partial"
	default:
		c.Status = "usage_unknown"
	}
	return c
}

func (g *Gateway) priceRecord(rec *Record, book priceBook) {
	c := costOf(*rec, book)
	c.Amount = roundCost(c.Amount)
	rec.Cost = &c
}

// priceStored prices a single record; a price lookup failure leaves it unpriced
// rather than failing the whole detail view.
func (g *Gateway) priceStored(rec *Record) {
	if book, err := g.loadPrices(); err == nil {
		g.priceRecord(rec, book)
	}
}

func costTotalsOf(records []Record, book priceBook) *CostTotals {
	t := CostTotals{}
	for _, rec := range records {
		t.add(costOf(rec, book))
	}
	t = t.rounded()
	return &t
}

// CostTotals aggregates forwarded calls; calls rejected before reaching the
// vendor never cost anything and are not counted here.
type CostTotals struct {
	Requests     int     `json:"requests"`
	Cost         float64 `json:"cost"`
	Priced       int     `json:"priced"`
	Partial      int     `json:"usage_partial"`
	UsageUnknown int     `json:"usage_unknown"`
	Unpriced     int     `json:"unpriced"`
	InputTokens  int64   `json:"input_tokens"`
	CacheRead    int64   `json:"cache_read_tokens"`
	CacheWrite   int64   `json:"cache_write_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	AudioSeconds float64 `json:"audio_seconds"`
	Characters   int64   `json:"tts_characters"`
}

func (t *CostTotals) add(c RecordCost) {
	if c.Status == "none" || c.Status == "running" {
		return
	}
	t.Requests++
	t.Cost += c.Amount
	t.InputTokens += c.InputTokens
	t.CacheRead += c.CacheRead
	t.CacheWrite += c.CacheWrite
	t.OutputTokens += c.OutputTokens
	t.AudioSeconds += c.AudioSeconds
	t.Characters += c.TTSCharacters
	switch c.Status {
	case "priced":
		t.Priced++
	case "partial":
		t.Partial++
	case "usage_unknown":
		t.UsageUnknown++
	case "unpriced":
		t.Unpriced++
	}
}

func roundCost(v float64) float64 { return math.Round(v*1e6) / 1e6 }
func (t CostTotals) rounded() CostTotals {
	t.Cost, t.AudioSeconds = roundCost(t.Cost), math.Round(t.AudioSeconds*1000)/1000
	return t
}

// costRecords reads finished calls started in [from,to), including body-log
// records that predate the metrics table.
func (g *Gateway) costRecords(from, to int64, projectID string) ([]Record, error) {
	where := " WHERE started>=? AND started<?"
	args := []any{from, to}
	metricsWhere := where
	if projectID != "" {
		metricsWhere += " AND json_extract(summary,'$.project_id')=?"
		where += " AND project_id=?"
		args = append(args, projectID)
	}
	query := "SELECT summary FROM request_metrics" + metricsWhere + " UNION ALL SELECT summary FROM requests" + where + " AND NOT EXISTS(SELECT 1 FROM request_metrics m WHERE m.id=requests.id)"
	rows, err := g.db.Query(query, append(args, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		var raw string
		var rec Record
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal([]byte(raw), &rec)
		}
		if err != nil {
			return nil, err
		}
		rec.normalizeStoredUsage()
		out = append(out, rec)
	}
	return out, rows.Err()
}

func monthStart(t time.Time) time.Time {
	t = t.In(costZone)
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, costZone)
}

type usageRange struct{ from, to int64 }

func parseUsageTime(s string) (int64, error) {
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n, nil
	}
	if t, err := time.ParseInLocation("2006-01-02", s, costZone); err == nil {
		return t.UnixMilli(), nil
	}
	t, err := time.Parse(time.RFC3339, s)
	return t.UnixMilli(), err
}

func parseUsageRange(q map[string][]string, now time.Time) (usageRange, error) {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	local := now.In(costZone)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, costZone)
	r := usageRange{to: now.UnixMilli() + 1}
	period, from, to := get("period"), get("from"), get("to")
	if period != "" && (from != "" || to != "") {
		return r, errors.New("period 与 from/to 不能同时使用")
	}
	switch period {
	case "today":
		r.from = today.UnixMilli()
	case "", "month":
		if period == "" && from != "" {
			break
		}
		r.from = monthStart(now).UnixMilli()
	case "last_month":
		end := monthStart(now)
		r.from, r.to = monthStart(end.AddDate(0, 0, -1)).UnixMilli(), end.UnixMilli()
	case "7d":
		r.from = today.AddDate(0, 0, -6).UnixMilli()
	case "30d":
		r.from = today.AddDate(0, 0, -29).UnixMilli()
	case "all":
		r.from = 0
	default:
		return r, errors.New("period 只支持 today、month、last_month、7d、30d、all")
	}
	var err error
	if from != "" {
		if r.from, err = parseUsageTime(from); err != nil {
			return r, errors.New("from 格式无效")
		}
	}
	if to != "" {
		if r.to, err = parseUsageTime(to); err != nil {
			return r, errors.New("to 格式无效")
		}
	}
	if r.from >= r.to {
		return r, errors.New("from 必须早于 to")
	}
	return r, nil
}

type usageGroup struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	CostTotals
}
type usageCall struct {
	ID          string     `json:"id"`
	Started     int64      `json:"started"`
	ProjectID   string     `json:"project_id"`
	ProjectName string     `json:"project_name"`
	ModelAlias  string     `json:"model"`
	Protocol    string     `json:"protocol"`
	Category    string     `json:"category"`
	Task        string     `json:"task"`
	State       string     `json:"state"`
	Cost        RecordCost `json:"cost"`
}
type BudgetStatus struct {
	MonthlyBudget *float64 `json:"monthly_budget"`
	MonthSpent    float64  `json:"month_spent"`
	Remaining     *float64 `json:"remaining"`
	Exceeded      bool     `json:"exceeded"`
}

func usageTask(rec Record) string {
	if rec.TaskRef != "" {
		return rec.TaskRef
	}
	return rec.TaskID
}

var usageGroupings = map[string]bool{"project": true, "model": true, "category": true, "task": true, "day": true, "request": true}

// usageReport serves both the project API (scope fixed to one project) and the
// management API (all projects, optionally filtered).
func (g *Gateway) usageReport(w http.ResponseWriter, r *http.Request, projectID string, admin bool) {
	q := r.URL.Query()
	rng, err := parseUsageRange(q, time.Now())
	if err != nil {
		problem(w, 400, err.Error())
		return
	}
	if admin {
		projectID = q.Get("project_id")
	} else if q.Has("project_id") && q.Get("project_id") != projectID {
		problem(w, 403, "项目凭证只能查询本项目用量")
		return
	}
	groupBy := q.Get("group_by")
	if groupBy != "" && !usageGroupings[groupBy] {
		problem(w, 400, "group_by 只支持 project、model、category、task、day、request")
		return
	}
	limit := 200
	if v := q.Get("limit"); v != "" {
		if limit, err = strconv.Atoi(v); err != nil || limit < 1 || limit > 1000 {
			problem(w, 400, "limit 必须为 1 到 1000")
			return
		}
	}
	book, err := g.loadPrices()
	if err == nil {
		var records []Record
		if records, err = g.costRecords(rng.from, rng.to, projectID); err == nil {
			g.writeUsage(w, q, rng, projectID, admin, groupBy, limit, book, records)
			return
		}
	}
	problem(w, 500, "读取用量失败")
}

func (g *Gateway) writeUsage(w http.ResponseWriter, q map[string][]string, rng usageRange, projectID string, admin bool, groupBy string, limit int, book priceBook, records []Record) {
	filters := map[string]func(Record) string{
		"model":      func(r Record) string { return r.Alias },
		"category":   func(r Record) string { return r.Category },
		"task":       usageTask,
		"request_id": func(r Record) string { return r.ID },
	}
	total := CostTotals{}
	groups := map[string]*usageGroup{}
	calls := []usageCall{}
	for _, rec := range records {
		skip := false
		for k, field := range filters {
			if v, ok := q[k]; ok && field(rec) != v[0] {
				skip = true
			}
		}
		if skip {
			continue
		}
		c := costOf(rec, book)
		if c.Status == "none" || c.Status == "running" {
			continue
		}
		total.add(c)
		var key, label string
		switch groupBy {
		case "project":
			key, label = rec.ProjectID, rec.ProjectName
		case "model":
			key, label = rec.ModelID, rec.Alias
		case "category":
			key, label = rec.Category, rec.Category
		case "task":
			key, label = usageTask(rec), usageTask(rec)
			if rec.TaskRef == "" && rec.Question != "" {
				label = excerpt(rec.Question)
			}
		case "day":
			key = time.UnixMilli(rec.Started).In(costZone).Format("2006-01-02")
			label = key
		case "request":
			calls = append(calls, usageCall{ID: rec.ID, Started: rec.Started, ProjectID: rec.ProjectID, ProjectName: rec.ProjectName, ModelAlias: rec.Alias, Protocol: rec.Protocol, Category: rec.Category, Task: usageTask(rec), State: rec.State, Cost: c})
			continue
		default:
			continue
		}
		if label == "" {
			label = "未标记"
		}
		if groups[key] == nil {
			groups[key] = &usageGroup{Key: key, Label: label}
		}
		groups[key].add(c)
	}
	out := map[string]any{"currency": costCurrency, "timezone": costZone.String(), "from": rng.from, "to": rng.to, "total": total.rounded()}
	if groupBy != "" && groupBy != "request" {
		list := make([]usageGroup, 0, len(groups))
		for _, v := range groups {
			v.CostTotals = v.CostTotals.rounded()
			list = append(list, *v)
		}
		sort.Slice(list, func(i, j int) bool {
			if groupBy == "day" {
				return list[i].Key < list[j].Key
			}
			if list[i].Cost != list[j].Cost {
				return list[i].Cost > list[j].Cost
			}
			if list[i].Requests != list[j].Requests {
				return list[i].Requests > list[j].Requests
			}
			return list[i].Key < list[j].Key
		})
		out["group_by"], out["groups"] = groupBy, list
	}
	if groupBy == "request" {
		sort.Slice(calls, func(i, j int) bool { return calls[i].Started > calls[j].Started })
		out["has_more"] = len(calls) > limit
		if len(calls) > limit {
			calls = calls[:limit]
		}
		for i := range calls {
			calls[i].Cost.Amount = roundCost(calls[i].Cost.Amount)
		}
		out["group_by"], out["requests"] = groupBy, calls
	}
	if projectID != "" {
		if status, err := g.budgetStatus(projectID); err == nil {
			out["budget"] = status
		}
	}
	if !admin {
		out["project_id"] = projectID
	}
	writeJSON(w, 200, out)
}

func (g *Gateway) adminUsage(w http.ResponseWriter, r *http.Request) {
	g.usageReport(w, r, "", true)
}

func (g *Gateway) projectUsage(w http.ResponseWriter, r *http.Request) {
	p, ok := g.project(r)
	if !ok {
		problem(w, 401, "项目凭证无效或项目已停用")
		return
	}
	g.usageReport(w, r, p.ID, false)
}

// Month-to-date spend per project is cached so the budget check does not scan
// the month on every call. Entries are updated as calls finish and dropped
// whenever prices or budgets change. metricsMu guards the cache.
type monthSpend struct {
	month  int64
	amount float64
}

func (g *Gateway) invalidateSpend() {
	g.metricsMu.Lock()
	g.spend = map[string]monthSpend{}
	g.metricsMu.Unlock()
}

// Called with metricsMu held when a call's final metrics are saved.
func (g *Gateway) recordSpend(rec Record) {
	entry, ok := g.spend[rec.ProjectID]
	if !ok || entry.month != monthStart(time.UnixMilli(rec.Started)).UnixMilli() {
		return
	}
	book, err := g.loadPrices()
	if err != nil {
		delete(g.spend, rec.ProjectID)
		return
	}
	entry.amount += costOf(rec, book).Amount
	g.spend[rec.ProjectID] = entry
}

func (g *Gateway) monthSpent(projectID string, now time.Time) (float64, error) {
	month := monthStart(now).UnixMilli()
	g.metricsMu.Lock()
	defer g.metricsMu.Unlock()
	if entry, ok := g.spend[projectID]; ok && entry.month == month {
		return entry.amount, nil
	}
	book, err := g.loadPrices()
	if err != nil {
		return 0, err
	}
	records, err := g.costRecords(month, math.MaxInt64, projectID)
	if err != nil {
		return 0, err
	}
	var total float64
	for _, rec := range records {
		if _, running := g.inflight[rec.ID]; running {
			continue
		}
		total += costOf(rec, book).Amount
	}
	g.spend[projectID] = monthSpend{month: month, amount: total}
	return total, nil
}

func (g *Gateway) budgetStatus(projectID string) (BudgetStatus, error) {
	var s BudgetStatus
	var budget sql.NullFloat64
	if err := g.db.QueryRow("SELECT monthly_budget FROM projects WHERE id=?", projectID).Scan(&budget); err != nil {
		return s, err
	}
	spent, err := g.monthSpent(projectID, time.Now())
	if err != nil {
		return s, err
	}
	s.MonthSpent = roundCost(spent)
	if budget.Valid {
		b := budget.Float64
		left := roundCost(math.Max(0, b-spent))
		s.MonthlyBudget, s.Remaining, s.Exceeded = &b, &left, spent >= b
	}
	return s, nil
}

// checkBudget rejects a call once the project's month-to-date estimate reaches
// its budget. Calls already in flight are not counted, so concurrent calls can
// overshoot the budget slightly.
func (g *Gateway) checkBudget(w http.ResponseWriter, rec *Record, p Project) bool {
	if p.MonthlyBudget == nil {
		return true
	}
	spent, err := g.monthSpent(p.ID, time.Now())
	if err != nil {
		problem(w, 500, "读取项目预算用量失败")
		return false
	}
	if spent < *p.MonthlyBudget {
		return true
	}
	rec.ErrorType = "budget_exceeded"
	msg := fmt.Sprintf("项目「%s」本月预算 ¥%s 已用完（已用 ¥%s），网关已拒绝本次请求。请在网关管理页提高预算，或等下月 1 日自动恢复。", p.Name, formatYuan(*p.MonthlyBudget), formatYuan(spent))
	if observer, ok := w.(interface{ recordGatewayProblem(string) }); ok {
		observer.recordGatewayProblem(msg)
	}
	writeJSON(w, 402, map[string]any{"error": map[string]any{"message": msg, "type": "budget_exceeded", "code": "budget_exceeded", "monthly_budget": *p.MonthlyBudget, "month_spent": roundCost(spent), "currency": costCurrency}})
	return false
}

func formatYuan(v float64) string {
	s := strconv.FormatFloat(math.Round(v*100)/100, 'f', 2, 64)
	return strings.TrimSuffix(strings.TrimSuffix(s, "0"), ".0")
}

func validBudget(v *float64) bool {
	return v == nil || !math.IsNaN(*v) && *v > 0 && *v <= maxBudget
}
