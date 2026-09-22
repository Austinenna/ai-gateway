package gateway

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Applications create disabled projects immediately. Only an administrator can
// approve one; the applicant keeps the very same project credential afterwards.
func migrateApplications(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`CREATE TABLE IF NOT EXISTS project_applications(
 id TEXT PRIMARY KEY, project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE SET NULL,
 client TEXT NOT NULL, protocol TEXT NOT NULL, models_json TEXT NOT NULL, note TEXT NOT NULL,
 receipt_digest TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL, token_digest TEXT NOT NULL,
 created INTEGER NOT NULL, decided INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending');
 CREATE INDEX IF NOT EXISTS idx_applications_created ON project_applications(created);
 PRAGMA user_version=7;`)
	if err != nil {
		return err
	}
	return tx.Commit()
}

type ProjectApplication struct {
	ID        string   `json:"id"`
	ProjectID string   `json:"project_id"`
	Client    string   `json:"client"`
	Protocol  string   `json:"protocol"`
	Models    []string `json:"models"`
	Note      string   `json:"note"`
	Created   int64    `json:"created"`
	Decided   int64    `json:"decided"`
	Status    string   `json:"status"`
}
type applicationInput struct {
	Name     string   `json:"name"`
	Client   string   `json:"client"`
	Protocol string   `json:"protocol"`
	Models   []string `json:"models"`
	Note     string   `json:"note"`
}

var applicationReceipt = regexp.MustCompile(`^gr_[A-Za-z0-9_-]{43}$`)

func (g *Gateway) applications() ([]ProjectApplication, error) {
	rows, err := g.db.Query(`SELECT id,project_id,client,protocol,models_json,note,created,decided,status FROM project_applications WHERE project_id IS NOT NULL ORDER BY created DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProjectApplication{}
	for rows.Next() {
		var a ProjectApplication
		var models string
		if err := rows.Scan(&a.ID, &a.ProjectID, &a.Client, &a.Protocol, &models, &a.Note, &a.Created, &a.Decided, &a.Status); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(models), &a.Models); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Query using the same transaction as creation/approval so a deleted or disabled
// model cannot be approved based on an earlier catalog snapshot.
func applicationModels(tx *sql.Tx, protocol string, aliases []string) ([]Model, error) {
	rows, err := tx.Query(`SELECT m.id,m.alias,m.name,m.protocols_json,c.endpoints_json
 FROM models m JOIN connections c ON c.id=m.connection_id WHERE m.enabled=1 AND c.enabled=1 ORDER BY m.alias`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	available := []Model{}
	for rows.Next() {
		var m Model
		var c Connection
		var protocols, endpoints string
		if err := rows.Scan(&m.ID, &m.Alias, &m.Name, &protocols, &endpoints); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(protocols), &m.Protocols); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(endpoints), &c.Endpoints); err != nil {
			return nil, err
		}
		if slices.Contains(availableProtocols(m, c), protocol) {
			available = append(available, m)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(aliases) == 0 {
		if len(available) == 0 {
			return nil, errors.New("暂无支持所选协议的可用模型，请管理员先配置模型")
		}
		return available[:1], nil
	}
	selected := []Model{}
	for _, alias := range aliases {
		index := slices.IndexFunc(available, func(m Model) bool { return m.Alias == alias })
		if index < 0 {
			return nil, errors.New("申请中的模型不存在、已停用或不支持所选协议，请刷新模型目录")
		}
		selected = append(selected, available[index])
	}
	return selected, nil
}

func (g *Gateway) applyProject(w http.ResponseWriter, r *http.Request) {
	// Command-line clients do not send Origin; browser requests must be same-origin.
	if r.Header.Get("X-Gateway-Enrollment") != "1" || (r.Header.Get("Origin") != "" && !g.sameOrigin(r)) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		problem(w, 403, "申请接口需要 X-Gateway-Enrollment: 1，且不接受跨站浏览器请求")
		return
	}
	receipt := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !applicationReceipt.MatchString(receipt) {
		problem(w, 400, "请使用随机生成的 gr_ 申请回执密钥")
		return
	}
	var in applicationInput
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Client = strings.TrimSpace(in.Client)
	in.Note = strings.TrimSpace(in.Note)
	if in.Protocol == "" {
		in.Protocol = "chat"
	}
	if !validName(in.Name) || !validName(in.Client) || utf8.RuneCountInString(in.Note) > 500 || !slices.Contains(supportedProtocols, in.Protocol) || len(in.Models) > 20 {
		problem(w, 400, "请填写项目、客户端和有效协议，备注不超过 500 字、模型不超过 20 个")
		return
	}
	aliases := []string{}
	for _, alias := range in.Models {
		if !aliasPattern.MatchString(alias) {
			problem(w, 400, "模型别名格式不正确")
			return
		}
		if !slices.Contains(aliases, alias) {
			aliases = append(aliases, alias)
		}
	}
	in.Models = aliases
	payload, _ := json.Marshal(in)
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 423, "网关尚未解锁，请管理员启动或解锁后重试")
		return
	}
	tx, err := g.db.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, 500, "申请保存失败")
		return
	}
	defer tx.Rollback()
	var a ProjectApplication
	var storedPayload, storedToken, modelsJSON string
	err = tx.QueryRow(`SELECT id,COALESCE(project_id,''),client,protocol,models_json,note,created,decided,status,payload_digest,token_digest
 FROM project_applications WHERE receipt_digest=?`, digest(receipt)).Scan(&a.ID, &a.ProjectID, &a.Client, &a.Protocol, &modelsJSON, &a.Note, &a.Created, &a.Decided, &a.Status, &storedPayload, &storedToken)
	token := ""
	code := 200
	if err == nil {
		if storedPayload != digest(string(payload)) {
			problem(w, 409, "同一申请回执不能用于不同配置")
			return
		}
		if time.Now().UnixMilli()-a.Created > int64(24*time.Hour/time.Millisecond) || a.Status == "rejected" {
			problem(w, 410, "申请回执已过期或申请已拒绝，请使用已保存的项目 Token；不要自动重复申请")
			return
		}
		var enc []byte
		var current string
		if tx.QueryRow(`SELECT p.token_digest,c.credential FROM projects p JOIN project_credentials c ON c.project_id=p.id WHERE p.id=?`, a.ProjectID).Scan(&current, &enc) != nil || current != storedToken {
			problem(w, 410, "项目凭证已经变更，原申请回执不可再领取")
			return
		}
		plain, err := unseal(key, enc, "project:"+a.ProjectID)
		defer wipe(plain)
		if err != nil || digest(string(plain)) != storedToken {
			problem(w, 500, "读取申请凭证失败")
			return
		}
		token = string(plain)
		if json.Unmarshal([]byte(modelsJSON), &a.Models) != nil {
			problem(w, 500, "读取申请失败")
			return
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		var pending, recent int
		if tx.QueryRow(`SELECT COALESCE(SUM(status='pending' AND project_id IS NOT NULL),0),COALESCE(SUM(created>?),0) FROM project_applications`, time.Now().Add(-24*time.Hour).UnixMilli()).Scan(&pending, &recent) != nil {
			problem(w, 500, "读取申请数量失败")
			return
		}
		if pending >= 50 || recent >= 100 {
			problem(w, 429, "申请数量已达上限，请管理员处理现有申请后再试")
			return
		}
		models, err := applicationModels(tx, in.Protocol, in.Models)
		if err != nil {
			problem(w, 400, err.Error())
			return
		}
		a = ProjectApplication{ID: id("app_"), ProjectID: id("prj_"), Client: in.Client, Protocol: in.Protocol, Note: in.Note, Created: time.Now().UnixMilli(), Status: "pending", Models: []string{}}
		token = newToken()
		if _, err = tx.Exec(`INSERT INTO projects(id,name,enabled,token_digest,token_prefix) VALUES(?,?,0,?,?)`, a.ProjectID, in.Name, digest(token), token[:11]); err != nil {
			problem(w, 500, "创建待批准项目失败")
			return
		}
		if saveProjectToken(tx, key, a.ProjectID, token) != nil {
			problem(w, 500, "保存项目凭证失败")
			return
		}
		for _, m := range models {
			a.Models = append(a.Models, m.Alias)
			if _, err = tx.Exec(`INSERT INTO project_models(project_id,model_id) VALUES(?,?)`, a.ProjectID, m.ID); err != nil {
				problem(w, 500, "保存申请模型失败")
				return
			}
		}
		raw, _ := json.Marshal(a.Models)
		if _, err = tx.Exec(`INSERT INTO project_applications(id,project_id,client,protocol,models_json,note,receipt_digest,payload_digest,token_digest,created) VALUES(?,?,?,?,?,?,?,?,?,?)`, a.ID, a.ProjectID, a.Client, a.Protocol, string(raw), a.Note, digest(receipt), digest(string(payload)), digest(token), a.Created); err != nil {
			problem(w, 500, "保存接入申请失败")
			return
		}
		code = 201
	} else {
		problem(w, 500, "读取申请失败")
		return
	}
	if tx.Commit() != nil {
		problem(w, 500, "申请保存失败")
		return
	}
	base, endpoint := g.applicationEndpoints(a.Protocol)
	writeJSON(w, code, map[string]any{"application": a, "token": token, "base_url": base, "endpoint": endpoint, "model": a.Models[0], "approval_url": g.origin + "/?view=projects"})
}

func (g *Gateway) applicationEndpoints(protocol string) (string, string) {
	if protocol == "dashscope-asr" {
		return g.origin + "/v1", g.origin + "/v1/asr/transcriptions"
	}
	if protocol == "messages" {
		return g.origin, g.origin + "/v1/messages"
	}
	return g.origin + "/v1", g.origin + "/v1/chat/completions"
}

func (g *Gateway) decideApplication(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Decision string `json:"decision"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Decision != "approve" && in.Decision != "reject" {
		problem(w, 400, "请选择批准或拒绝")
		return
	}
	tx, err := g.db.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, 500, "审批失败")
		return
	}
	defer tx.Rollback()
	var pid, status, protocol, modelsJSON, issued, current string
	err = tx.QueryRow(`SELECT a.project_id,a.status,a.protocol,a.models_json,a.token_digest,p.token_digest FROM project_applications a JOIN projects p ON p.id=a.project_id WHERE a.id=?`, r.PathValue("id")).Scan(&pid, &status, &protocol, &modelsJSON, &issued, &current)
	if errors.Is(err, sql.ErrNoRows) {
		problem(w, 404, "申请不存在")
		return
	}
	if err != nil {
		problem(w, 500, "读取申请失败")
		return
	}
	target := "rejected"
	if in.Decision == "approve" {
		target = "approved"
	}
	if status == target {
		writeJSON(w, 200, map[string]string{"status": status})
		return
	}
	if status != "pending" {
		problem(w, 409, "申请已处理，请在项目权限中管理已批准项目")
		return
	}
	if in.Decision == "approve" {
		var aliases []string
		if json.Unmarshal([]byte(modelsJSON), &aliases) != nil || len(aliases) == 0 {
			problem(w, 500, "申请模型无效")
			return
		}
		models, err := applicationModels(tx, protocol, aliases)
		if err != nil {
			problem(w, 409, err.Error())
			return
		}
		if issued != current {
			problem(w, 409, "申请时的 Token 已变更，请拒绝此申请后由客户端重新申请")
			return
		}
		// Pending projects cannot have grants edited; verify again before activation.
		var grants int
		if tx.QueryRow(`SELECT COUNT(*) FROM project_models WHERE project_id=?`, pid).Scan(&grants) != nil || grants != len(models) {
			problem(w, 409, "申请模型授权已变更，请拒绝后重新申请")
			return
		}
		for _, m := range models {
			var n int
			if tx.QueryRow(`SELECT COUNT(*) FROM project_models WHERE project_id=? AND model_id=?`, pid, m.ID).Scan(&n) != nil || n != 1 {
				problem(w, 409, "申请模型授权已变更，请拒绝后重新申请")
				return
			}
		}
	}
	if _, err = tx.Exec(`UPDATE projects SET enabled=? WHERE id=?`, target == "approved", pid); err != nil {
		problem(w, 500, "项目审批失败")
		return
	}
	if _, err = tx.Exec(`UPDATE project_applications SET status=?,decided=? WHERE id=?`, target, time.Now().UnixMilli(), r.PathValue("id")); err != nil || tx.Commit() != nil {
		problem(w, 500, "保存审批失败")
		return
	}
	writeJSON(w, 200, map[string]string{"status": target})
}

// A pending token may inspect only its own activation status, never admin state
// or other projects. This endpoint does not forward a model request.
func (g *Gateway) projectAccess(w http.ResponseWriter, r *http.Request) {
	token := projectCredential(r)
	if len(token) != 46 || !strings.HasPrefix(token, "gw_") {
		problem(w, 401, "项目凭证无效")
		return
	}
	var pid, expected, status, protocol, modelsJSON string
	var enabled bool
	err := g.db.QueryRow(`SELECT p.id,p.token_digest,p.enabled,COALESCE(a.status,''),COALESCE(a.protocol,'chat'),COALESCE(a.models_json,'[]')
 FROM projects p LEFT JOIN project_applications a ON a.project_id=p.id WHERE p.token_digest=?`, digest(token)).Scan(&pid, &expected, &enabled, &status, &protocol, &modelsJSON)
	if err != nil || subtle.ConstantTimeCompare([]byte(expected), []byte(digest(token))) != 1 {
		problem(w, 401, "项目凭证无效")
		return
	}
	if status != "pending" && status != "rejected" {
		if enabled {
			status = "active"
		} else {
			status = "disabled"
		}
	}
	var models []string
	_ = json.Unmarshal([]byte(modelsJSON), &models)
	base, endpoint := g.applicationEndpoints(protocol)
	writeJSON(w, 200, map[string]any{"project_id": pid, "status": status, "protocol": protocol, "requested_models": models, "base_url": base, "endpoint": endpoint, "approval_url": g.origin + "/?view=projects"})
}

func (g *Gateway) applicationAllowsEdit(w http.ResponseWriter, projectID string) bool {
	var status string
	err := g.db.QueryRow(`SELECT status FROM project_applications WHERE project_id=?`, projectID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && status == "approved") {
		return true
	}
	if err != nil {
		problem(w, 500, "读取申请状态失败")
	} else {
		problem(w, 409, "此项目的申请尚未批准，请先在项目列表批准或拒绝；已拒绝项目可删除")
	}
	return false
}
