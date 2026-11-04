package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Connection health is derived from real traffic first (passive). A connection
// without recent traffic is probed with GET <endpoint>/models, which providers
// do not bill; probe results never enter request records or costs.

const healthBucket = 30 * time.Minute
const healthBuckets = 48

type healthKind int

const (
	healthOK healthKind = iota
	healthFail
	healthRate
	healthAuth
)

type healthEvent struct {
	at    time.Time
	kind  healthKind
	probe bool
}

type healthCounts struct {
	OK          int `json:"ok"`
	Failed      int `json:"failed"`
	RateLimited int `json:"rate_limited"`
	AuthFailed  int `json:"auth_failed"`
	Probes      int `json:"probes"`
	ProbeFailed int `json:"probe_failed"`
}

type probeResult struct {
	At        int64  `json:"at"`
	OK        bool   `json:"ok"`
	Status    int    `json:"status"`
	LatencyMS int64  `json:"latency_ms"`
	Message   string `json:"message"`
}

type connHealth struct {
	events       []healthEvent
	streak       int
	breakerUntil time.Time
	lastTraffic  time.Time
	lastProbe    *probeResult
	buckets      map[int64]*healthCounts
	dirty        map[int64]bool
}

func (g *Gateway) connHealthLocked(id string) *connHealth {
	h := g.health[id]
	if h == nil {
		h = &connHealth{buckets: map[int64]*healthCounts{}, dirty: map[int64]bool{}}
		g.health[id] = h
	}
	return h
}

func bucketOf(t time.Time) int64 { return t.Truncate(healthBucket).UnixMilli() }

func (h *connHealth) add(e healthEvent, s Settings) {
	h.events = append(h.events, e)
	cutoff := e.at.Add(-time.Duration(s.HealthWindowMinutes) * time.Minute)
	i := 0
	for i < len(h.events) && h.events[i].at.Before(cutoff) {
		i++
	}
	h.events = h.events[i:]
	b := bucketOf(e.at)
	c := h.buckets[b]
	if c == nil {
		c = &healthCounts{}
		h.buckets[b] = c
	}
	h.dirty[b] = true
	if e.probe {
		c.Probes++
		if e.kind != healthOK {
			c.ProbeFailed++
		}
	} else {
		h.lastTraffic = e.at
		switch e.kind {
		case healthOK:
			c.OK++
		case healthFail:
			c.Failed++
		case healthRate:
			c.RateLimited++
		case healthAuth:
			c.AuthFailed++
		}
	}
	switch e.kind {
	case healthFail:
		h.streak++
		if h.streak >= s.DownStreak {
			h.breakerUntil = e.at.Add(time.Duration(s.BreakerSeconds) * time.Second)
		}
	case healthOK:
		h.streak = 0
	}
}

// observeUpstream records the outcome of one upstream exchange. Client-side
// request errors (400/404/413/422) say nothing about the connection.
func (g *Gateway) observeUpstream(connectionID string, status int, transportErr bool, retryAfter string) {
	if connectionID == "" {
		return
	}
	var kind healthKind
	switch {
	case transportErr || status >= 500:
		kind = healthFail
	case status == 429:
		kind = healthRate
	case status == 401 || status == 403:
		kind = healthAuth
	case status >= 200 && status < 300:
		kind = healthOK
	default:
		return
	}
	s := g.currentSettings()
	now := time.Now()
	g.healthMu.Lock()
	defer g.healthMu.Unlock()
	h := g.connHealthLocked(connectionID)
	h.add(healthEvent{at: now, kind: kind}, s)
	if kind == healthRate {
		wait := time.Duration(s.BreakerSeconds) * time.Second
		if secs, err := time.ParseDuration(strings.TrimSpace(retryAfter) + "s"); err == nil && secs > 0 && secs <= time.Hour {
			wait = secs
		}
		h.breakerUntil = now.Add(wait)
	}
}

func (g *Gateway) breakerOpen(connectionID string) bool {
	g.healthMu.Lock()
	defer g.healthMu.Unlock()
	h := g.health[connectionID]
	return h != nil && time.Now().Before(h.breakerUntil)
}

// ConnectionHealth is the management view of one connection.
type ConnectionHealth struct {
	ID             string             `json:"id"`
	State          string             `json:"state"` // ok | degraded | down | auth | unknown
	Reason         string             `json:"reason"`
	Window         healthCounts       `json:"window"`
	WindowMinutes  int                `json:"window_minutes"`
	BreakerUntil   int64              `json:"breaker_until,omitempty"`
	LastTraffic    int64              `json:"last_traffic,omitempty"`
	LastProbe      *probeResult       `json:"last_probe,omitempty"`
	ProbeSupported bool               `json:"probe_supported"`
	Buckets        []healthBucketView `json:"buckets"`
}

type healthBucketView struct {
	Start int64 `json:"start"`
	healthCounts
}

func healthState(h *connHealth, s Settings, now time.Time) (string, string, healthCounts) {
	var w healthCounts
	if h == nil {
		return "unknown", "最近没有调用，也没有探测", w
	}
	cutoff := now.Add(-time.Duration(s.HealthWindowMinutes) * time.Minute)
	var last *healthEvent
	for i := range h.events {
		e := h.events[i]
		if e.at.Before(cutoff) {
			continue
		}
		last = &h.events[i]
		if e.probe {
			w.Probes++
			if e.kind != healthOK {
				w.ProbeFailed++
			}
		}
		switch e.kind {
		case healthOK:
			w.OK++
		case healthFail:
			w.Failed++
		case healthRate:
			w.RateLimited++
		case healthAuth:
			w.AuthFailed++
		}
	}
	total := w.OK + w.Failed + w.RateLimited + w.AuthFailed
	switch {
	case last == nil:
		return "unknown", "最近没有调用，也没有探测", w
	case last.kind == healthAuth:
		return "auth", "厂商拒绝凭据（401/403），请检查 Key", w
	case h.streak >= s.DownStreak:
		return "down", "连续连接失败、超时或 5xx", w
	case w.RateLimited > 0:
		return "degraded", "最近出现 429 限流", w
	case total > 0 && float64(w.Failed+w.AuthFailed)/float64(total) > s.DegradedRatio:
		return "degraded", "最近失败率偏高", w
	default:
		return "ok", "", w
	}
}

func probeProtocol(c Connection) string {
	for _, p := range []string{"chat", "messages"} {
		if c.Endpoints[p] != "" {
			return p
		}
	}
	return ""
}

func (g *Gateway) connectionsForHealth() ([]Connection, map[string][]byte, error) {
	rows, err := g.db.Query("SELECT id,name,provider,endpoints_json,enabled,use_proxy,credential FROM connections ORDER BY name")
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []Connection{}
	creds := map[string][]byte{}
	for rows.Next() {
		var c Connection
		var endpoints string
		var useProxy bool
		var cred []byte
		if err = rows.Scan(&c.ID, &c.Name, &c.Provider, &endpoints, &c.Enabled, &useProxy, &cred); err != nil {
			return nil, nil, err
		}
		if json.Unmarshal([]byte(endpoints), &c.Endpoints) != nil {
			c.Endpoints = map[string]string{}
		}
		c.UseProxy = &useProxy
		creds[c.ID] = cred
		out = append(out, c)
	}
	return out, creds, rows.Err()
}

func (g *Gateway) healthView() ([]ConnectionHealth, error) {
	conns, _, err := g.connectionsForHealth()
	if err != nil {
		return nil, err
	}
	s := g.currentSettings()
	now := time.Now()
	first := bucketOf(now) - int64(healthBuckets-1)*healthBucket.Milliseconds()
	stored, err := g.storedBuckets(first)
	if err != nil {
		return nil, err
	}
	g.healthMu.Lock()
	defer g.healthMu.Unlock()
	out := []ConnectionHealth{}
	for _, c := range conns {
		h := g.health[c.ID]
		state, reason, window := healthState(h, s, now)
		if !c.Enabled {
			state, reason = "disabled", "连接已停用"
		}
		v := ConnectionHealth{ID: c.ID, State: state, Reason: reason, Window: window, WindowMinutes: s.HealthWindowMinutes, ProbeSupported: probeProtocol(c) != "" || c.Provider == "demo"}
		if h != nil {
			if now.Before(h.breakerUntil) {
				v.BreakerUntil = h.breakerUntil.UnixMilli()
			}
			if !h.lastTraffic.IsZero() {
				v.LastTraffic = h.lastTraffic.UnixMilli()
			}
			v.LastProbe = h.lastProbe
		}
		for i := 0; i < healthBuckets; i++ {
			start := first + int64(i)*healthBucket.Milliseconds()
			var counts healthCounts
			if h != nil && h.buckets[start] != nil {
				counts = *h.buckets[start]
			} else if sc, ok := stored[c.ID][start]; ok {
				counts = sc
			}
			v.Buckets = append(v.Buckets, healthBucketView{Start: start, healthCounts: counts})
		}
		out = append(out, v)
	}
	return out, nil
}

func (g *Gateway) storedBuckets(from int64) (map[string]map[int64]healthCounts, error) {
	rows, err := g.db.Query("SELECT connection_id,bucket,ok,failed,rate_limited,auth_failed,probes,probe_failed FROM connection_health WHERE bucket>=?", from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[int64]healthCounts{}
	for rows.Next() {
		var id string
		var b int64
		var c healthCounts
		if err = rows.Scan(&id, &b, &c.OK, &c.Failed, &c.RateLimited, &c.AuthFailed, &c.Probes, &c.ProbeFailed); err != nil {
			return nil, err
		}
		if out[id] == nil {
			out[id] = map[int64]healthCounts{}
		}
		out[id][b] = c
	}
	return out, rows.Err()
}

// flushHealth persists changed buckets so the 24-hour history survives restarts.
func (g *Gateway) flushHealth() {
	type row struct {
		id string
		b  int64
		c  healthCounts
	}
	rows := []row{}
	cutoff := bucketOf(time.Now()) - int64(healthBuckets)*healthBucket.Milliseconds()
	g.healthMu.Lock()
	for id, h := range g.health {
		for b := range h.dirty {
			if c := h.buckets[b]; c != nil {
				rows = append(rows, row{id, b, *c})
			}
		}
		h.dirty = map[int64]bool{}
		for b := range h.buckets {
			if b < cutoff {
				delete(h.buckets, b)
			}
		}
	}
	g.healthMu.Unlock()
	for _, r := range rows {
		// In-memory counts start from the persisted value (see loadHealth), so
		// replacing the row keeps totals exact across restarts.
		_, _ = g.db.Exec(`INSERT INTO connection_health(connection_id,bucket,ok,failed,rate_limited,auth_failed,probes,probe_failed) VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(connection_id,bucket) DO UPDATE SET ok=excluded.ok,failed=excluded.failed,rate_limited=excluded.rate_limited,auth_failed=excluded.auth_failed,probes=excluded.probes,probe_failed=excluded.probe_failed`,
			r.id, r.b, r.c.OK, r.c.Failed, r.c.RateLimited, r.c.AuthFailed, r.c.Probes, r.c.ProbeFailed)
	}
}

// loadHealth seeds the current bucket from storage so a restart inside a
// 30-minute bucket keeps adding to the persisted counts.
func (g *Gateway) loadHealth() error {
	current := bucketOf(time.Now())
	stored, err := g.storedBuckets(current)
	if err != nil {
		return err
	}
	g.healthMu.Lock()
	defer g.healthMu.Unlock()
	for id, buckets := range stored {
		h := g.connHealthLocked(id)
		for b, c := range buckets {
			counts := c
			h.buckets[b] = &counts
		}
	}
	return nil
}

func (g *Gateway) probeConnection(ctx context.Context, c Connection, encrypted []byte) probeResult {
	res := probeResult{At: time.Now().UnixMilli()}
	finish := func(kind healthKind) probeResult {
		res.LatencyMS = time.Now().UnixMilli() - res.At
		g.healthMu.Lock()
		h := g.connHealthLocked(c.ID)
		h.add(healthEvent{at: time.Now(), kind: kind, probe: true}, g.currentSettings())
		r := res
		h.lastProbe = &r
		g.healthMu.Unlock()
		return res
	}
	if c.Provider == "demo" {
		res.OK, res.Status, res.Message = true, 200, "本地演示连接"
		return finish(healthOK)
	}
	protocol := probeProtocol(c)
	if protocol == "" {
		res.Message = "该连接只有语音或搜索端点，没有模型列表接口，只做被动检查"
		return res
	}
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		res.Message = "网关未解锁，跳过探测"
		return res
	}
	token, err := unseal(key, encrypted, c.ID)
	if err != nil {
		res.Message = "读取厂商凭据失败"
		return res
	}
	defer wipe(token)
	endpoint := c.Endpoints[protocol]
	u, err := url.Parse(strings.TrimRight(endpoint, "/") + "/models")
	if err != nil || !validEndpointURL(endpoint) {
		res.Message = "连接端点无效"
		return finish(healthFail)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ctx = g.withUpstreamProxy(ctx, c.UseProxy != nil && *c.UseProxy)
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		res.Message = "无法创建探测请求"
		return res
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+string(token))
	if protocol == "messages" {
		req.Header.Set("x-api-key", string(token))
		req.Header.Set("anthropic-version", "2023-06-01")
	}
	resp, err := g.client.Do(req)
	if err != nil {
		res.Message = "无法连接厂商或超时"
		return finish(healthFail)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	resp.Body.Close()
	res.Status = resp.StatusCode
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		res.OK, res.Message = true, "模型列表接口正常"
		return finish(healthOK)
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		res.Message = "厂商拒绝凭据"
		return finish(healthAuth)
	case resp.StatusCode == 429:
		res.Message = "厂商限流"
		return finish(healthRate)
	case resp.StatusCode == 404 || resp.StatusCode == 405 || resp.StatusCode == 501:
		// The endpoint is reachable but has no catalog: reachability is all we learn.
		res.OK, res.Message = true, "可连接，但该端点不提供模型列表"
		return finish(healthOK)
	case resp.StatusCode >= 500:
		res.Message = "厂商返回服务端错误"
		return finish(healthFail)
	default:
		res.Message = "厂商返回非预期状态"
		return finish(healthFail)
	}
}

// probeIdle probes enabled connections that had neither traffic nor a probe
// within the configured idle interval.
func (g *Gateway) probeIdle(ctx context.Context) {
	s := g.currentSettings()
	if s.ProbeIdleMinutes == 0 || len(g.key()) == 0 {
		return
	}
	conns, creds, err := g.connectionsForHealth()
	if err != nil {
		return
	}
	idle := time.Duration(s.ProbeIdleMinutes) * time.Minute
	now := time.Now()
	due := []Connection{}
	g.healthMu.Lock()
	for _, c := range conns {
		if !c.Enabled || probeProtocol(c) == "" && c.Provider != "demo" {
			continue
		}
		h := g.health[c.ID]
		if h != nil && (now.Sub(h.lastTraffic) < idle || h.lastProbe != nil && now.Sub(time.UnixMilli(h.lastProbe.At)) < idle) {
			continue
		}
		due = append(due, c)
	}
	g.healthMu.Unlock()
	sort.Slice(due, func(i, j int) bool { return due[i].ID < due[j].ID })
	for _, c := range due {
		if ctx.Err() != nil {
			return
		}
		g.probeConnection(ctx, c, creds[c.ID])
	}
}

func (g *Gateway) healthAPI(w http.ResponseWriter, r *http.Request) {
	view, err := g.healthView()
	if err != nil {
		problem(w, 500, "读取连接健康失败")
		return
	}
	writeJSON(w, 200, map[string]any{"connections": view, "bucket_minutes": int(healthBucket.Minutes())})
}

func (g *Gateway) probeAPI(w http.ResponseWriter, r *http.Request) {
	conns, creds, err := g.connectionsForHealth()
	if err != nil {
		problem(w, 500, "读取连接失败")
		return
	}
	for _, c := range conns {
		if c.ID == r.PathValue("id") {
			if !c.Enabled {
				problem(w, 400, "连接已停用")
				return
			}
			writeJSON(w, 200, g.probeConnection(r.Context(), c, creds[c.ID]))
			return
		}
	}
	problem(w, 404, "连接不存在")
}
