package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Request list paging uses (started, rowid) as a keyset cursor: rowid follows
// insertion order, so calls started in the same millisecond keep a stable order.

const (
	requestPageDefault = 50
	requestPageMax     = 200
	bodySearchTimeout  = 10 * time.Second
)

type requestPage struct {
	Items      []Record `json:"items"`
	NextCursor string   `json:"next_cursor,omitempty"`
	Total      *int     `json:"total,omitempty"`
	BodySearch string   `json:"body_search,omitempty"` // "" | "complete" | "timeout"
}

func parseCursor(s string) (int64, int64, error) {
	a, b, ok := strings.Cut(s, ":")
	if !ok {
		return 0, 0, errors.New("cursor 格式无效")
	}
	started, err1 := strconv.ParseInt(a, 10, 64)
	rowid, err2 := strconv.ParseInt(b, 10, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, errors.New("cursor 格式无效")
	}
	return started, rowid, nil
}

func likePattern(q string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(q) + "%"
}

type requestFilter struct {
	where []string
	args  []any
}

// add copies before appending so filters derived from one base never share storage.
func (f *requestFilter) add(clause string, args ...any) {
	f.where = append(append([]string{}, f.where...), clause)
	f.args = append(append([]any{}, f.args...), args...)
}

func (f requestFilter) sql() string {
	if len(f.where) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(f.where, " AND ")
}

func buildRequestFilter(q map[string][]string, now time.Time) (requestFilter, int64, int64, error) {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	var f requestFilter
	from, to := int64(0), now.UnixMilli()+1
	var err error
	if v := get("from"); v != "" {
		if from, err = strconv.ParseInt(v, 10, 64); err != nil {
			return f, 0, 0, errors.New("from 必须为毫秒时间戳")
		}
	}
	if v := get("to"); v != "" {
		if to, err = strconv.ParseInt(v, 10, 64); err != nil {
			return f, 0, 0, errors.New("to 必须为毫秒时间戳")
		}
	}
	f.add("m.started>=? AND m.started<?", from, to)
	if v := get("project_id"); v != "" && v != "all" {
		f.add("m.m_project=?", v)
	}
	if v := get("model"); v != "" && v != "all" {
		switch {
		case strings.HasPrefix(v, "id:"):
			f.add("m.m_model=?", strings.TrimPrefix(v, "id:"))
		case strings.HasPrefix(v, "alias:"):
			f.add("m.m_alias=?", strings.TrimPrefix(v, "alias:"))
		case v == "unknown":
			f.add("COALESCE(m.m_alias,'')='' AND COALESCE(m.m_model,'')=''")
		default:
			f.add("m.m_alias=?", v)
		}
	}
	if v := get("provider"); v != "" && v != "all" {
		if v == "unknown" {
			f.add("COALESCE(m.m_provider,'')=''")
		} else {
			f.add("m.m_provider=?", v)
		}
	}
	switch get("state") {
	case "", "all":
	case "success", "complete":
		f.add("m.m_state='complete'")
	case "unfinished":
		f.add("m.m_state<>'complete'")
	case "running":
		f.add("m.m_state='running'")
	case "failed":
		f.add("m.m_state NOT IN ('complete','running')")
	case "truncated":
		f.add("(m.m_state='truncated' OR json_extract(m.summary,'$.output_truncated'))")
	case "fallback":
		f.add("COALESCE(json_extract(m.summary,'$.fallback_from'),'')<>''")
	case "limited":
		f.add("json_extract(m.summary,'$.error_type') IN ('project_rate_limit','project_concurrency','budget_exceeded')")
	default:
		return f, 0, 0, errors.New("state 只支持 all、success、unfinished、running、failed、truncated、fallback、limited")
	}
	return f, from, to, nil
}

func (g *Gateway) listRecords(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := requestPageDefault
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > requestPageMax {
			problem(w, 400, fmt.Sprintf("limit 必须为 1 到 %d", requestPageMax))
			return
		}
		limit = n
	}
	f, from, to, err := buildRequestFilter(q, time.Now())
	if err != nil {
		problem(w, 400, err.Error())
		return
	}
	search := strings.TrimSpace(q.Get("q"))
	if len([]rune(search)) > 200 {
		problem(w, 400, "搜索词不能超过 200 个字符")
		return
	}
	cursor := q.Get("cursor")
	if cursor != "" {
		if _, _, err := parseCursor(cursor); err != nil {
			problem(w, 400, err.Error())
			return
		}
	}
	// withSearch adds the keyword clause; body search also scans stored bodies.
	withSearch := func(base requestFilter, body bool) requestFilter {
		if search == "" {
			return base
		}
		pattern := likePattern(search)
		if body {
			base.add("(m.id=? OR m.summary LIKE ? ESCAPE '\\' OR m.id IN (SELECT id FROM requests WHERE started>=? AND started<? AND record LIKE ? ESCAPE '\\'))", search, pattern, from, to, pattern)
		} else {
			base.add("(m.id=? OR m.summary LIKE ? ESCAPE '\\')", search, pattern)
		}
		return base
	}
	withCursor := func(base requestFilter) requestFilter {
		if cursor != "" {
			started, rowid, _ := parseCursor(cursor)
			base.add("(m.started<? OR m.started=? AND m.rowid<?)", started, started, rowid)
		}
		return base
	}
	// Load prices first: the database has one connection and rows hold it.
	book, err := g.loadPrices()
	if err != nil {
		problem(w, 500, "读取单价失败")
		return
	}
	const selectPage = "SELECT m.rowid,m.started,m.summary,EXISTS(SELECT 1 FROM requests b WHERE b.id=m.id) FROM request_metrics m"
	const orderPage = " ORDER BY m.started DESC,m.rowid DESC LIMIT ?"
	page := requestPage{Items: []Record{}}
	bodySearch := search != "" && q.Get("body") == "1"
	var items []Record
	var next string
	if bodySearch {
		page.BodySearch = "complete"
		ctx, cancel := context.WithTimeout(r.Context(), bodySearchTimeout)
		pf := withCursor(withSearch(f, true))
		items, next, err = g.queryRecordPage(ctx, selectPage+pf.sql()+orderPage, append(pf.args, limit+1), limit, book)
		timedOut := ctx.Err() != nil
		cancel()
		if err != nil && timedOut && r.Context().Err() == nil {
			// Body scans are bounded; fall back to summary matches and say so.
			page.BodySearch = "timeout"
			err = nil
			bodySearch = false
		}
	}
	if !bodySearch {
		pf := withCursor(withSearch(f, false))
		items, next, err = g.queryRecordPage(r.Context(), selectPage+pf.sql()+orderPage, append(pf.args, limit+1), limit, book)
	}
	if err != nil {
		problem(w, 500, "读取记录失败")
		return
	}
	page.Items, page.NextCursor = items, next
	if page.BodySearch == "" {
		cf := withSearch(f, false)
		var total int
		if g.db.QueryRowContext(r.Context(), "SELECT count(*) FROM request_metrics m"+cf.sql(), cf.args...).Scan(&total) == nil {
			page.Total = &total
		}
	}
	writeJSON(w, 200, page)
}

func (g *Gateway) queryRecordPage(ctx context.Context, query string, args []any, limit int, book priceBook) ([]Record, string, error) {
	rows, err := g.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	bodyCutoff, _ := retentionCutoffs(g.currentSettings(), time.Now())
	items := []Record{}
	type key struct{ started, rowid int64 }
	keys := []key{}
	for rows.Next() {
		var rowid, started int64
		var raw string
		var hasBody bool
		if err = rows.Scan(&rowid, &started, &raw, &hasBody); err != nil {
			return nil, "", err
		}
		var rec Record
		if err = json.Unmarshal([]byte(raw), &rec); err != nil {
			return nil, "", err
		}
		rec.Input, rec.Output = "", ""
		rec.RecordMissing = !hasBody
		rec.BodyPurged = !hasBody && rec.State != "running" && started < bodyCutoff
		items = append(items, rec)
		keys = append(keys, key{started, rowid})
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	cursor := ""
	if len(items) > limit {
		items, keys = items[:limit], keys[:limit]
		last := keys[len(keys)-1]
		cursor = fmt.Sprintf("%d:%d", last.started, last.rowid)
	}
	g.metricsMu.Lock()
	for i := range items {
		if live, ok := g.inflight[items[i].ID]; ok {
			live.RecordMissing = true
			items[i] = live
		}
	}
	g.metricsMu.Unlock()
	for i := range items {
		items[i].ensureDiagnostic("")
		items[i].normalizeStoredUsage()
		g.priceRecord(&items[i], book)
	}
	return items, cursor, nil
}
