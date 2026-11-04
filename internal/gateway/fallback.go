package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"
)

// A fallback model is tried once, only while nothing has been written to the
// caller: connection failures, timeouts before response headers, 429, 401/403
// and 500/502/503/504/529. Request errors (400/404/413/422) and failures after
// streaming started are returned unchanged.

func fallbackStatus(status int) bool {
	switch status {
	case 401, 403, 429, 500, 502, 503, 504, 529:
		return true
	}
	return false
}

// attemptCtl lets forward hand a retryable failure back instead of answering.
type attemptCtl struct {
	allowRetry bool
	eligible   bool // the failure would qualify for a fallback
	retry      bool // forward returned without writing; try the fallback
}

func (g *Gateway) validateFallback(m Model) error {
	if m.FallbackModelID == "" {
		return nil
	}
	if m.FallbackModelID == m.ID {
		return errors.New("备用模型不能是模型自己")
	}
	var back, protocols string
	if g.db.QueryRow("SELECT fallback_model_id,protocols_json FROM models WHERE id=?", m.FallbackModelID).Scan(&back, &protocols) != nil {
		return errors.New("备用模型不存在")
	}
	if m.ID != "" && back == m.ID {
		return errors.New("两个模型不能互为备用")
	}
	var theirs []string
	if json.Unmarshal([]byte(protocols), &theirs) != nil {
		return errors.New("读取备用模型协议失败")
	}
	for _, p := range m.Protocols {
		if slices.Contains(theirs, p) {
			return nil
		}
	}
	return errors.New("备用模型与该模型没有共同的调用协议")
}

type fallbackPlan struct {
	model      Model
	conn       Connection
	encrypted  []byte
	usable     bool
	outcome    string // when unusable: not_granted | unavailable
	configured bool
}

func (g *Gateway) planFallback(m Model, projectID, protocol string) fallbackPlan {
	if m.FallbackModelID == "" {
		return fallbackPlan{}
	}
	plan := fallbackPlan{configured: true, outcome: "unavailable"}
	var alias string
	var granted bool
	if g.db.QueryRow("SELECT alias,EXISTS(SELECT 1 FROM project_models WHERE project_id=? AND model_id=models.id) FROM models WHERE id=?", projectID, m.FallbackModelID).Scan(&alias, &granted) != nil {
		return plan
	}
	plan.model.Alias, plan.model.ID = alias, m.FallbackModelID
	if !granted {
		plan.outcome = "not_granted"
		return plan
	}
	fm, fc, enc, err := g.route(alias, projectID, false)
	if err != nil {
		return plan
	}
	if fc, err = selectProtocol(fm, fc, protocol); err != nil {
		return plan
	}
	plan.model, plan.conn, plan.encrypted, plan.usable = fm, fc, enc, true
	return plan
}

func cloneBody(body map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(body))
	for k, v := range body {
		out[k] = bytes.Clone(v)
	}
	return out
}

func attemptOf(m Model, c Connection, rec *Record, started time.Time, outcome string) Attempt {
	return Attempt{ModelID: m.ID, Alias: m.Alias, ConnectionID: c.ID, ConnectionName: c.Name, Provider: c.Provider, Status: rec.Status, ErrorType: rec.ErrorType, DurationMS: time.Since(started).Milliseconds(), Outcome: outcome}
}

// resetAttempt clears per-attempt results before the fallback runs.
func resetAttempt(rec *Record) {
	rec.Status, rec.UpstreamStatus, rec.ErrorType, rec.State = 0, 0, "", "running"
	rec.Adaptations, rec.FirstToken, rec.FirstText, rec.LastToken = nil, nil, nil, nil
	rec.ContentChunks, rec.InputTokens, rec.OutputTokens = 0, 0, 0
	rec.InputTotal, rec.InputUncached, rec.CacheRead, rec.CacheWrite = nil, nil, nil, nil
	rec.OutputReported, rec.UsageStatus, rec.Diagnostic = false, "unknown", nil
}

func (g *Gateway) forwardWithFallback(w http.ResponseWriter, r *http.Request, p Project, m Model, c Connection, enc []byte, body map[string]json.RawMessage, protocol string) {
	plan := g.planFallback(m, p.ID, protocol)
	if !plan.configured {
		g.forward(w, r, p, m, c, enc, body, nil)
		return
	}
	rec := &traceOf(r).rec
	original := cloneBody(body)
	attempts := []Attempt{}
	if plan.usable && g.breakerOpen(c.ID) {
		// The primary connection is cooling down after 429 or repeated failures.
		attempts = append(attempts, Attempt{ModelID: m.ID, Alias: m.Alias, ConnectionID: c.ID, ConnectionName: c.Name, Provider: c.Provider, Outcome: "skipped_breaker"})
	} else {
		ctl := &attemptCtl{allowRetry: plan.usable}
		started := time.Now()
		g.forward(w, r, p, m, c, enc, body, ctl)
		if !ctl.retry {
			if ctl.eligible && !plan.usable {
				// Record why the configured fallback did not help.
				rec.Attempts = []Attempt{attemptOf(m, c, rec, started, "failed"), {ModelID: plan.model.ID, Alias: plan.model.Alias, Outcome: plan.outcome}}
			}
			return
		}
		attempts = append(attempts, attemptOf(m, c, rec, started, "failed"))
		resetAttempt(rec)
	}
	rec.FallbackFrom = m.Alias
	w.Header().Set("X-Gateway-Fallback", m.Alias+" -> "+plan.model.Alias)
	started := time.Now()
	g.forward(w, r, p, plan.model, plan.conn, plan.encrypted, original, nil)
	outcome := "served"
	if rec.State != "complete" {
		outcome = "failed"
	}
	rec.Attempts = append(attempts, attemptOf(plan.model, plan.conn, rec, started, outcome))
}
