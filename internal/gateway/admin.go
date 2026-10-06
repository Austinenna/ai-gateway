package gateway

import (
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

var aliasPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$`)

func validName(s string) bool { return len(strings.TrimSpace(s)) > 0 && len(s) <= 200 }
func validEndpoint(c Connection) bool {
	if c.Provider == "demo" {
		return len(c.Endpoints) == 1 && c.Endpoints["chat"] == "demo://local"
	}
	if c.Provider != "zhipu" && c.Provider != "minimax" && c.Provider != "deepseek" && c.Provider != "dashscope" && c.Provider != "custom" {
		return false
	}
	if len(c.Endpoints) == 0 || len(c.Endpoints) > len(supportedProtocols) {
		return false
	}
	for protocol, endpoint := range c.Endpoints {
		if !slices.Contains(supportedProtocols, protocol) || !validEndpointURL(endpoint) {
			return false
		}
	}
	return true
}
func validEndpointURL(endpoint string) bool {
	u, e := url.Parse(endpoint)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return u.Scheme == "http" && (u.Hostname() == "localhost" || ip != nil && ip.IsLoopback())
}
func (g *Gateway) state(w http.ResponseWriter, r *http.Request) {
	cs, e := g.connections()
	if e != nil {
		problem(w, 500, "读取连接失败")
		return
	}
	ms, e := g.models()
	if e != nil {
		problem(w, 500, "读取模型失败")
		return
	}
	ps, e := g.projects()
	if e != nil {
		problem(w, 500, "读取项目失败")
		return
	}
	var count int
	_ = g.db.QueryRow("SELECT count(*) FROM requests").Scan(&count)
	applications, e := g.applications()
	if e != nil {
		problem(w, 500, "读取申请失败")
		return
	}
	writeJSON(w, 200, map[string]any{"applications": applications, "connections": cs, "models": ms, "projects": ps, "request_count": count, "dropped_records": g.dropped.Load(), "base_url": g.origin + "/v1"})
}
func (g *Gateway) saveConnection(w http.ResponseWriter, r *http.Request) {
	var c Connection
	if !decode(w, r, &c) {
		return
	}
	c.ID = r.PathValue("id")
	c.Name = strings.TrimSpace(c.Name)
	legacy := c.Endpoints == nil
	if legacy {
		c.Endpoints = map[string]string{c.Protocol: c.BaseURL}
	} else if c.Protocol != "" || c.BaseURL != "" {
		problem(w, 400, "请使用 endpoints 配置协议端点，不要混用旧字段")
		return
	}
	for protocol, endpoint := range c.Endpoints {
		c.Endpoints[protocol] = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	}
	c.Token = strings.TrimSpace(c.Token)
	if !validName(c.Name) || !validEndpoint(c) || len(c.Token) > 8192 || strings.ContainsAny(c.Token, "\r\n") {
		problem(w, 400, "请填写有效名称、受支持的厂商协议和端点（远程端点使用 HTTPS）")
		return
	}
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 423, "密钥库已锁定")
		return
	}
	creating := c.ID == ""
	if creating {
		c.ID = id("con_")
	}
	var encrypted []byte
	var oldEndpoints, oldProvider string
	if !creating {
		if e := g.db.QueryRow("SELECT credential,endpoints_json,provider FROM connections WHERE id=?", c.ID).Scan(&encrypted, &oldEndpoints, &oldProvider); e != nil {
			problem(w, 404, "连接不存在")
			return
		}
		if (oldProvider == "demo") != (c.Provider == "demo") {
			problem(w, 400, "演示连接与真实厂商连接不能相互转换，请新建连接")
			return
		}
		if legacy {
			var previous map[string]string
			if json.Unmarshal([]byte(oldEndpoints), &previous) != nil || len(previous) > 1 {
				problem(w, 400, "此连接包含多个协议，请刷新页面后编辑")
				return
			}
		}
	}
	if c.Token != "" || c.Provider == "demo" {
		var e error
		encrypted, e = seal(key, []byte(c.Token), c.ID)
		if e != nil {
			problem(w, 500, "保存凭据失败")
			return
		}
	} else if creating {
		problem(w, 400, "请填写厂商 Token")
		return
	}
	var result sql.Result
	var e error
	endpoints, _ := json.Marshal(c.Endpoints)
	if creating {
		result, e = g.db.Exec(`INSERT INTO connections(id,name,provider,protocol,base_url,credential,enabled,endpoints_json) VALUES(?,?,?,'','',?,?,?)`, c.ID, c.Name, c.Provider, encrypted, c.Enabled, string(endpoints))
	} else {
		result, e = g.db.Exec(`UPDATE connections SET name=?,provider=?,protocol='',base_url='',credential=?,enabled=?,endpoints_json=? WHERE id=?`, c.Name, c.Provider, encrypted, c.Enabled, string(endpoints), c.ID)
	}
	if e != nil {
		problem(w, 500, "连接保存失败")
		return
	}
	if n, _ := result.RowsAffected(); n == 0 {
		problem(w, 404, "连接不存在")
		return
	}
	c.Token = ""
	c.Protocol, c.BaseURL = "", ""
	c.HasToken = c.Provider != "demo"
	writeJSON(w, 200, c)
}
func (g *Gateway) reveal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	g.authMu.Lock()
	defer g.authMu.Unlock()
	if time.Since(g.attemptWindow) > time.Minute {
		g.attemptWindow = time.Now()
		g.attempts = 0
	}
	if g.attempts >= 8 {
		problem(w, 429, "尝试次数过多")
		return
	}
	g.attempts++
	key, e := g.unlock(in.Password)
	if e != nil {
		problem(w, 401, "管理密码不正确")
		return
	}
	defer wipe(key)
	g.attempts = 0
	var data []byte
	if e = g.db.QueryRow("SELECT credential FROM connections WHERE id=?", r.PathValue("id")).Scan(&data); e != nil {
		problem(w, 404, "连接不存在")
		return
	}
	token, e := unseal(key, data, r.PathValue("id"))
	if e != nil {
		problem(w, 500, "解锁凭据失败")
		return
	}
	defer wipe(token)
	writeJSON(w, 200, map[string]string{"token": string(token)})
}
func (g *Gateway) saveModel(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Model
		ContextWindow *int `json:"context_window"`
	}
	if !decode(w, r, &in) {
		return
	}
	m := in.Model
	m.ID = r.PathValue("id")
	m.Name = strings.TrimSpace(m.Name)
	m.Alias = strings.TrimSpace(m.Alias)
	m.UpstreamModel = strings.TrimSpace(m.UpstreamModel)
	if !validName(m.Name) || !aliasPattern.MatchString(m.Alias) || !validName(m.UpstreamModel) {
		problem(w, 400, "请填写显示名称、有效调用别名与厂商模型 ID")
		return
	}
	var endpointsJSON string
	if g.db.QueryRow("SELECT endpoints_json FROM connections WHERE id=?", m.ConnectionID).Scan(&endpointsJSON) != nil {
		problem(w, 400, "请选择已有连接")
		return
	}
	var endpoints map[string]string
	if json.Unmarshal([]byte(endpointsJSON), &endpoints) != nil {
		problem(w, 500, "读取连接协议失败")
		return
	}
	if m.Protocols == nil {
		m.Protocols = endpointProtocols(endpoints)
		if m.ID != "" {
			var oldConnection, oldProtocols string
			if g.db.QueryRow("SELECT connection_id,protocols_json FROM models WHERE id=?", m.ID).Scan(&oldConnection, &oldProtocols) == nil && oldConnection == m.ConnectionID {
				if json.Unmarshal([]byte(oldProtocols), &m.Protocols) != nil {
					problem(w, 500, "读取模型协议失败")
					return
				}
			}
		}
	}
	if len(m.Protocols) == 0 || len(m.Protocols) > len(supportedProtocols) {
		problem(w, 400, "请至少选择一种模型调用协议")
		return
	}
	seen := map[string]bool{}
	for _, protocol := range m.Protocols {
		if !slices.Contains(supportedProtocols, protocol) || endpoints[protocol] == "" || seen[protocol] {
			problem(w, 400, "模型协议必须对应连接已配置的端点，且不能重复")
			return
		}
		seen[protocol] = true
	}
	if in.ContextWindow != nil {
		m.ContextWindow = *in.ContextWindow
	} else if m.ID != "" {
		// Older clients do not send capacity. Preserve it only for the same route.
		var oldConnection, oldModel string
		var oldWindow int
		if err := g.db.QueryRow("SELECT connection_id,upstream_model,context_window FROM models WHERE id=?", m.ID).Scan(&oldConnection, &oldModel, &oldWindow); err == nil && oldConnection == m.ConnectionID && oldModel == m.UpstreamModel {
			m.ContextWindow = oldWindow
		}
	}
	if m.ContextWindow < 0 || m.ContextWindow > maxContextWindow {
		problem(w, 400, "上下文窗口必须为 0 到 2147483647 的整数，0 表示未设置")
		return
	}
	if !seen["chat"] && !seen["messages"] {
		m.ContextWindow = 0
	}
	if m.Defaults == nil {
		m.Defaults = map[string]json.RawMessage{}
	}
	if err := validateModelDefaults(m.Defaults); err != nil {
		problem(w, 400, err.Error())
		return
	}
	defaults, _ := json.Marshal(m.Defaults)
	protocols, _ := json.Marshal(m.Protocols)
	creating := m.ID == ""
	if creating {
		m.ID = id("mod_")
	} else {
		var found int
		if g.db.QueryRow("SELECT count(*) FROM models WHERE id=?", m.ID).Scan(&found) != nil || found == 0 {
			problem(w, 404, "模型不存在")
			return
		}
	}
	var result sql.Result
	var e error
	if creating {
		result, e = g.db.Exec(`INSERT INTO models(id,name,alias,connection_id,upstream_model,defaults_json,enabled,protocols_json,context_window) VALUES(?,?,?,?,?,?,?,?,?)`, m.ID, m.Name, m.Alias, m.ConnectionID, m.UpstreamModel, string(defaults), m.Enabled, string(protocols), m.ContextWindow)
	} else {
		result, e = g.db.Exec(`UPDATE models SET name=?,alias=?,connection_id=?,upstream_model=?,defaults_json=?,enabled=?,protocols_json=?,context_window=? WHERE id=?`, m.Name, m.Alias, m.ConnectionID, m.UpstreamModel, string(defaults), m.Enabled, string(protocols), m.ContextWindow, m.ID)
	}
	if e != nil {
		problem(w, 409, "模型保存失败，请检查调用别名是否重复")
		return
	}
	if n, _ := result.RowsAffected(); n == 0 {
		problem(w, 404, "模型不存在")
		return
	}
	writeJSON(w, 200, m)
}
func (g *Gateway) saveProject(w http.ResponseWriter, r *http.Request) {
	var p Project
	if !decode(w, r, &p) {
		return
	}
	p.ID = r.PathValue("id")
	if p.ID != "" && !g.applicationAllowsEdit(w, p.ID) {
		return
	}
	p.Name = strings.TrimSpace(p.Name)
	if !validName(p.Name) {
		problem(w, 400, "请填写项目名称")
		return
	}
	if len(p.ModelIDs) > 1000 {
		problem(w, 400, "授权数量过多")
		return
	}
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 423, "密钥库已锁定")
		return
	}
	tx, e := g.db.Begin()
	if e != nil {
		problem(w, 500, "保存失败")
		return
	}
	defer tx.Rollback()
	token := ""
	if p.ID == "" {
		p.ID = id("prj_")
		token = newToken()
		p.TokenPrefix = token[:11]
		_, e = tx.Exec("INSERT INTO projects(id,name,enabled,token_digest,token_prefix) VALUES(?,?,?,?,?)", p.ID, p.Name, p.Enabled, digest(token), p.TokenPrefix)
		if e == nil {
			e = saveProjectToken(tx, key, p.ID, token)
		}
	} else {
		var result sql.Result
		result, e = tx.Exec("UPDATE projects SET name=?,enabled=? WHERE id=?", p.Name, p.Enabled, p.ID)
		if e == nil {
			n, _ := result.RowsAffected()
			if n == 0 {
				problem(w, 404, "项目不存在")
				return
			}
		}
	}
	if e != nil {
		problem(w, 500, "项目保存失败")
		return
	}
	if _, e = tx.Exec("DELETE FROM project_models WHERE project_id=?", p.ID); e != nil {
		problem(w, 500, "授权保存失败")
		return
	}
	for _, mid := range p.ModelIDs {
		if _, e = tx.Exec("INSERT OR IGNORE INTO project_models(project_id,model_id) VALUES(?,?)", p.ID, mid); e != nil {
			problem(w, 400, "授权列表包含不存在的模型")
			return
		}
	}
	if tx.QueryRow("SELECT token_prefix,EXISTS(SELECT 1 FROM project_credentials WHERE project_id=projects.id) FROM projects WHERE id=?", p.ID).Scan(&p.TokenPrefix, &p.HasSavedToken) != nil {
		problem(w, 500, "读取凭证状态失败")
		return
	}
	if tx.Commit() != nil {
		problem(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, map[string]any{"project": p, "token": token})
}
func (g *Gateway) listRecords(w http.ResponseWriter, r *http.Request) {
	query := "SELECT summary FROM requests"
	args := []any{}
	if p := r.URL.Query().Get("project_id"); p != "" {
		query += " WHERE project_id=?"
		args = append(args, p)
	}
	query += " ORDER BY started DESC LIMIT 200"
	rows, e := g.db.Query(query, args...)
	if e != nil {
		problem(w, 500, "读取记录失败")
		return
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		var s string
		var rec Record
		if rows.Scan(&s) != nil || json.Unmarshal([]byte(s), &rec) != nil {
			problem(w, 500, "读取记录失败")
			return
		}
		rec.Input = ""
		rec.Output = ""
		rec.normalizeStoredUsage()
		out = append(out, rec)
	}
	writeJSON(w, 200, out)
}
func (g *Gateway) getRecord(w http.ResponseWriter, r *http.Request) {
	g.metricsMu.Lock()
	active, running := g.inflight[r.PathValue("id")]
	g.metricsMu.Unlock()
	if running {
		active.RecordMissing = true
		active.normalizeStoredUsage()
		writeJSON(w, 200, active)
		return
	}
	var s string
	if g.db.QueryRow("SELECT record FROM requests WHERE id=?", r.PathValue("id")).Scan(&s) != nil {
		if g.db.QueryRow("SELECT summary FROM request_metrics WHERE id=?", r.PathValue("id")).Scan(&s) != nil {
			problem(w, 404, "记录不存在")
			return
		}
		var rec Record
		if json.Unmarshal([]byte(s), &rec) != nil {
			problem(w, 500, "读取记录失败")
			return
		}
		rec.normalizeStoredTruncation()
		rec.RecordMissing = true
		rec.normalizeStoredUsage()
		writeJSON(w, 200, rec)
		return
	}
	var rec Record
	if json.Unmarshal([]byte(s), &rec) != nil {
		problem(w, 500, "读取记录失败")
		return
	}
	rec.normalizeStoredTruncation()
	rec.normalizeStoredUsage()
	writeJSON(w, 200, rec)
}
func (g *Gateway) seedDemo(w http.ResponseWriter, r *http.Request) {
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 423, "密钥库已锁定")
		return
	}
	tx, e := g.db.Begin()
	if e != nil {
		problem(w, 500, "创建失败")
		return
	}
	defer tx.Rollback()
	var count int
	if tx.QueryRow("SELECT count(*) FROM models WHERE alias='demo-chat'").Scan(&count) != nil || count > 0 {
		problem(w, 409, "演示模型已存在，可在项目页重置凭证后继续体验")
		return
	}
	cid, mid, pid := id("con_"), id("mod_"), id("prj_")
	token := newToken()
	enc, e := seal(key, nil, cid)
	if e != nil {
		problem(w, 500, "创建失败")
		return
	}
	if _, e = tx.Exec(`INSERT INTO connections(id,name,provider,protocol,base_url,credential,enabled,endpoints_json) VALUES(?,?,?,'','',?,?,?)`, cid, "本地演示连接", "demo", enc, true, `{"chat":"demo://local"}`); e == nil {
		_, e = tx.Exec("INSERT INTO models(id,name,alias,connection_id,upstream_model,defaults_json,enabled,protocols_json) VALUES(?,?,?,?,?,?,?,?)", mid, "本地演示模型", "demo-chat", cid, "demo-v1", "{}", true, `["chat"]`)
	}
	if e == nil {
		_, e = tx.Exec("INSERT INTO projects VALUES(?,?,?,?,?)", pid, "演示项目", true, digest(token), token[:11])
	}
	if e == nil {
		e = saveProjectToken(tx, key, pid, token)
	}
	if e == nil {
		_, e = tx.Exec("INSERT INTO project_models VALUES(?,?)", pid, mid)
	}
	if e != nil || tx.Commit() != nil {
		problem(w, 500, "演示数据创建失败")
		return
	}
	writeJSON(w, 200, map[string]string{"token": token, "project_id": pid, "alias": "demo-chat"})
}
