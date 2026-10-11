package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"
)

type diagnosticOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type diagnosticGroupView struct {
	Code              string   `json:"code"`
	Message           string   `json:"message"`
	Phase             string   `json:"phase"`
	Source            string   `json:"source"`
	Status            int      `json:"status"`
	ErrorType         string   `json:"error_type"`
	UpstreamStatus    int      `json:"upstream_status"`
	Count             int      `json:"count"`
	FirstStarted      int64    `json:"first_started"`
	LastStarted       int64    `json:"last_started"`
	Retryable         bool     `json:"retryable"`
	UpstreamContacted bool     `json:"upstream_contacted"`
	RecommendedAction string   `json:"recommended_action"`
	ExampleID         string   `json:"example_id"`
	Models            []string `json:"models"`
	Providers         []string `json:"providers"`
	Protocols         []string `json:"protocols"`
	Projects          []string `json:"projects"`
}

type diagnosticSummaryView struct {
	Requests      int            `json:"requests"`
	Failed        int            `json:"failed"`
	Active        int            `json:"active"`
	Groups        int            `json:"groups"`
	Errors        map[string]int `json:"errors"`
	LatestFailure *int64         `json:"latest_failure"`
}

type diagnosticsResponse struct {
	From            int64                 `json:"from"`
	To              int64                 `json:"to"`
	MonitoringSince int64                 `json:"monitoring_since"`
	Summary         diagnosticSummaryView `json:"summary"`
	Groups          []diagnosticGroupView `json:"groups"`
	Recent          []Record              `json:"recent"`
	Options         map[string]any        `json:"options"`
	Runtime         map[string]any        `json:"runtime"`
	MetricsErrors   int64                 `json:"metrics_errors"`
	DroppedRecords  int64                 `json:"dropped_records"`
}

func diagnosticRange(window string, now int64, monitoringSince int64) (int64, error) {
	var span time.Duration
	switch window {
	case "1h":
		span = time.Hour
	case "", "24h":
		span = 24 * time.Hour
	case "7d":
		span = 7 * 24 * time.Hour
	case "all":
		return monitoringSince, nil
	default:
		return 0, fmt.Errorf("不支持的诊断时间范围")
	}
	return max(monitoringSince, now-span.Milliseconds()), nil
}

func (g *Gateway) diagnosticSnapshot(r *http.Request, from, now int64) ([]Record, error) {
	g.metricsMu.Lock()
	defer g.metricsMu.Unlock()
	rows, err := g.db.QueryContext(r.Context(), "SELECT summary FROM request_metrics WHERE started>=? AND started<=? ORDER BY started DESC,id", from, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []Record{}
	seen := map[string]bool{}
	for rows.Next() {
		var raw string
		var rec Record
		if err = rows.Scan(&raw); err != nil || json.Unmarshal([]byte(raw), &rec) != nil {
			if err == nil {
				err = fmt.Errorf("invalid diagnostic summary")
			}
			break
		}
		if active, ok := g.inflight[rec.ID]; ok {
			rec = active
		}
		rec.ensureDiagnostic("")
		records = append(records, rec)
		seen[rec.ID] = true
	}
	if err == nil {
		err = rows.Err()
	}
	if err != nil {
		return nil, err
	}
	for id, rec := range g.inflight {
		if !seen[id] && rec.Started >= from && rec.Started <= now {
			rec.ensureDiagnostic("")
			records = append(records, rec)
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Started > records[j].Started })
	return records, nil
}

func diagnosticMatches(rec Record, q map[string]string) bool {
	if q["code"] != "" && (rec.Diagnostic == nil || rec.Diagnostic.Code != q["code"]) {
		return false
	}
	if q["status"] != "" && strconv.Itoa(rec.Status) != q["status"] {
		return false
	}
	if q["provider"] != "" && rec.Provider != q["provider"] {
		return false
	}
	if q["protocol"] != "" && rec.Protocol != q["protocol"] {
		return false
	}
	if q["model_id"] != "" && rec.ModelID != q["model_id"] {
		return false
	}
	if q["project_id"] != "" {
		if q["project_id"] == "unknown" {
			if rec.ProjectID != "" {
				return false
			}
		} else if rec.ProjectID != q["project_id"] {
			return false
		}
	}
	return true
}

func diagnosticGroupKey(rec Record) string {
	if rec.Diagnostic == nil {
		return "gateway_error|0|0|gateway|gateway"
	}
	d := rec.Diagnostic
	return fmt.Sprintf("%s|%d|%d|%s|%s", d.Code, rec.Status, rec.UpstreamStatus, d.Source, d.Phase)
}

func appendDiagnosticContext(values []string, value string) []string {
	if value == "" {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	if len(values) < 20 {
		return append(values, value)
	}
	return values
}

func (g *Gateway) diagnostics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	now := time.Now().UnixMilli()
	from, err := diagnosticRange(q.Get("window"), now, g.monitoringSince)
	if err != nil {
		problem(w, 400, err.Error())
		return
	}
	records, err := g.diagnosticSnapshot(r, from, now)
	if err != nil {
		problem(w, 500, "读取异常诊断失败")
		return
	}
	filters := map[string]string{
		"code": q.Get("code"), "status": q.Get("status"), "provider": q.Get("provider"),
		"protocol": q.Get("protocol"), "model_id": q.Get("model_id"), "project_id": q.Get("project_id"),
	}
	groups := map[string]*diagnosticGroupView{}
	options := map[string]map[string]string{"providers": {}, "protocols": {}, "models": {}, "projects": {}, "codes": {}}
	summary := diagnosticSummaryView{Errors: map[string]int{}}
	recent := []Record{}
	for _, rec := range records {
		if rec.Diagnostic != nil {
			options["codes"][rec.Diagnostic.Code] = rec.Diagnostic.Message
		}
		if rec.Provider != "" {
			options["providers"][rec.Provider] = rec.Provider
		}
		if rec.Protocol != "" {
			options["protocols"][rec.Protocol] = rec.Protocol
		}
		if rec.ModelID != "" {
			options["models"][rec.ModelID] = rec.Alias
		}
		if rec.ProjectID != "" {
			options["projects"][rec.ProjectID] = rec.ProjectName
		}
		if !diagnosticMatches(rec, filters) {
			continue
		}
		summary.Requests++
		if rec.State == "running" {
			summary.Active++
			continue
		}
		if rec.State == "complete" {
			continue
		}
		summary.Failed++
		if rec.Diagnostic == nil {
			rec.ensureDiagnostic("")
		}
		if rec.Diagnostic == nil {
			continue
		}
		d := rec.Diagnostic
		summary.Errors[d.Code]++
		if summary.LatestFailure == nil || rec.Started > *summary.LatestFailure {
			v := rec.Started
			summary.LatestFailure = &v
		}
		if len(recent) < 24 {
			recent = append(recent, rec)
		}
		key := diagnosticGroupKey(rec)
		group := groups[key]
		if group == nil {
			group = &diagnosticGroupView{Code: d.Code, Message: d.Message, Phase: d.Phase, Source: d.Source, Status: rec.Status, ErrorType: rec.ErrorType, UpstreamStatus: rec.UpstreamStatus, FirstStarted: rec.Started, LastStarted: rec.Started, Retryable: d.Retryable, UpstreamContacted: d.UpstreamContacted, RecommendedAction: d.RecommendedAction, ExampleID: rec.ID}
			groups[key] = group
		}
		group.Count++
		if rec.Started < group.FirstStarted {
			group.FirstStarted = rec.Started
		}
		if rec.Started > group.LastStarted {
			group.LastStarted = rec.Started
		}
		group.Models = appendDiagnosticContext(group.Models, rec.Alias)
		group.Providers = appendDiagnosticContext(group.Providers, rec.Provider)
		group.Protocols = appendDiagnosticContext(group.Protocols, rec.Protocol)
		group.Projects = appendDiagnosticContext(group.Projects, rec.ProjectName)
	}
	groupList := make([]diagnosticGroupView, 0, len(groups))
	for _, group := range groups {
		sort.Strings(group.Models)
		sort.Strings(group.Providers)
		sort.Strings(group.Protocols)
		sort.Strings(group.Projects)
		groupList = append(groupList, *group)
	}
	sort.Slice(groupList, func(i, j int) bool {
		if groupList[i].Count == groupList[j].Count {
			return groupList[i].LastStarted > groupList[j].LastStarted
		}
		return groupList[i].Count > groupList[j].Count
	})
	summary.Groups = len(groupList)
	optionList := map[string]any{}
	for key, values := range options {
		items := []diagnosticOption{}
		for id, name := range values {
			items = append(items, diagnosticOption{ID: id, Name: name})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
		optionList[key] = items
	}
	key := g.key()
	runtime := map[string]any{"configured": g.configured(), "locked": len(key) == 0, "service_auto_unlock": g.serviceAutoUnlock, "monitoring_since": g.monitoringSince}
	writeJSON(w, 200, diagnosticsResponse{From: from, To: now, MonitoringSince: g.monitoringSince, Summary: summary, Groups: groupList, Recent: recent, Options: optionList, Runtime: runtime, MetricsErrors: g.metricsErrors.Load(), DroppedRecords: g.dropped.Load()})
}
