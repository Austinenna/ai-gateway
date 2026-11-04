package gateway

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"
)

const (
	maxRateLimit       = 100000
	maxConcurrentLimit = 1000
)

// ProjectLimits are per-project admission limits. nil and 0 both mean unlimited.
type ProjectLimits struct {
	RateRPM       *int `json:"rate_rpm"`
	RateBurst     *int `json:"rate_burst"`
	MaxConcurrent *int `json:"max_concurrent"`
}

func positive(v *int) int {
	if v == nil || *v < 0 {
		return 0
	}
	return *v
}

func (l ProjectLimits) validate() error {
	for _, v := range []*int{l.RateRPM, l.RateBurst} {
		if v != nil && (*v < 0 || *v > maxRateLimit) {
			return fmt.Errorf("每分钟请求数与突发量必须为 0 到 %d，0 表示不限", maxRateLimit)
		}
	}
	if l.MaxConcurrent != nil && (*l.MaxConcurrent < 0 || *l.MaxConcurrent > maxConcurrentLimit) {
		return fmt.Errorf("同时进行的请求数必须为 0 到 %d，0 表示不限", maxConcurrentLimit)
	}
	return nil
}

// burst defaults to a quarter of the per-minute rate so a short spike passes
// while a runaway loop is stopped within seconds.
func (l ProjectLimits) burst() float64 {
	if b := positive(l.RateBurst); b > 0 {
		return float64(b)
	}
	return math.Max(1, math.Floor(float64(positive(l.RateRPM))/4))
}

type projectLimiter struct {
	tokens   float64
	last     time.Time
	inflight int
	admitted []int64 // admission times within the last minute, for display
	limited  int64
}

type limitRejection struct {
	kind       string // project_rate_limit | project_concurrency
	retryAfter int
	message    string
}

// admit applies the token bucket and the concurrency cap. On success the
// caller must call release exactly once.
func (g *Gateway) admit(p Project, now time.Time) *limitRejection {
	rpm, conc := positive(p.ProjectLimits.RateRPM), positive(p.ProjectLimits.MaxConcurrent)
	g.limitMu.Lock()
	defer g.limitMu.Unlock()
	l := g.limiters[p.ID]
	if l == nil {
		l = &projectLimiter{tokens: p.ProjectLimits.burst(), last: now}
		g.limiters[p.ID] = l
	}
	cutoff := now.Add(-time.Minute).UnixMilli()
	for len(l.admitted) > 0 && l.admitted[0] < cutoff {
		l.admitted = l.admitted[1:]
	}
	if conc > 0 && l.inflight >= conc {
		l.limited++
		return &limitRejection{kind: "project_concurrency", retryAfter: 1, message: fmt.Sprintf("项目「%s」同时进行的请求已达上限 %d，请稍后重试", p.Name, conc)}
	}
	if rpm > 0 {
		capacity := p.ProjectLimits.burst()
		rate := float64(rpm) / 60
		l.tokens = math.Min(capacity, l.tokens+now.Sub(l.last).Seconds()*rate)
		l.last = now
		if l.tokens < 1 {
			l.limited++
			wait := int(math.Ceil((1 - l.tokens) / rate))
			return &limitRejection{kind: "project_rate_limit", retryAfter: max(1, wait), message: fmt.Sprintf("项目「%s」请求过于频繁，超过每分钟 %d 次的上限，请 %d 秒后重试", p.Name, rpm, max(1, wait))}
		}
		l.tokens--
	} else {
		l.last = now
	}
	l.inflight++
	l.admitted = append(l.admitted, now.UnixMilli())
	return nil
}

func (g *Gateway) release(projectID string) {
	g.limitMu.Lock()
	if l := g.limiters[projectID]; l != nil && l.inflight > 0 {
		l.inflight--
	}
	g.limitMu.Unlock()
}

// LimitUsage is the live view of one project's limiter.
type LimitUsage struct {
	Inflight   int   `json:"inflight"`
	LastMinute int   `json:"last_minute"`
	Limited    int64 `json:"limited_since_start"`
}

func (g *Gateway) limitUsage() map[string]LimitUsage {
	cutoff := time.Now().Add(-time.Minute).UnixMilli()
	g.limitMu.Lock()
	defer g.limitMu.Unlock()
	out := map[string]LimitUsage{}
	for id, l := range g.limiters {
		n := 0
		for _, t := range l.admitted {
			if t >= cutoff {
				n++
			}
		}
		out[id] = LimitUsage{Inflight: l.inflight, LastMinute: n, Limited: l.limited}
	}
	return out
}

// writeLimitRejection answers in the caller's protocol so the official
// Anthropic and OpenAI SDKs recognise a retryable rate limit.
func writeLimitRejection(w http.ResponseWriter, protocol string, rej *limitRejection) {
	if observer, ok := w.(interface{ recordGatewayProblem(string) }); ok {
		observer.recordGatewayProblem(rej.message)
	}
	w.Header().Set("Retry-After", strconv.Itoa(rej.retryAfter))
	if protocol == "messages" {
		writeJSON(w, 429, map[string]any{"type": "error", "error": map[string]string{"type": "rate_limit_error", "message": rej.message}})
		return
	}
	writeJSON(w, 429, map[string]any{"error": map[string]any{"message": rej.message, "type": "rate_limit_exceeded", "code": rej.kind}})
}

// runtimeAPI feeds the console status bar and live limit usage.
func (g *Gateway) runtimeAPI(w http.ResponseWriter, r *http.Request) {
	g.metricsMu.Lock()
	inflight := len(g.inflight)
	g.metricsMu.Unlock()
	usage := g.limitUsage()
	lastMinute := 0
	for _, u := range usage {
		lastMinute += u.LastMinute
	}
	breakers := map[string]int64{}
	now := time.Now()
	g.healthMu.Lock()
	for id, h := range g.health {
		if now.Before(h.breakerUntil) {
			breakers[id] = h.breakerUntil.UnixMilli()
		}
	}
	g.healthMu.Unlock()
	writeJSON(w, 200, map[string]any{
		"started_at": g.startedAt.UnixMilli(), "now": now.UnixMilli(),
		"inflight": inflight, "last_minute": lastMinute,
		"db_bytes": g.dbFileSize(), "limits": usage, "breakers": breakers,
		"schema_ext": schemaExtVersion,
	})
}
