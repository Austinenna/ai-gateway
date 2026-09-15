package gateway

import (
	"crypto/subtle"
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

// Authentication continues to use the digest. Only an unlocked admin session
// can request the encrypted copy, which is bound to this project by GCM AAD.
func saveProjectToken(tx *sql.Tx, key []byte, projectID, token string) error {
	enc, err := seal(key, []byte(token), "project:"+projectID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO project_credentials(project_id,credential) VALUES(?,?)
	 ON CONFLICT(project_id) DO UPDATE SET credential=excluded.credential`, projectID, enc)
	return err
}

func (g *Gateway) projectCredential(w http.ResponseWriter, r *http.Request) {
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 423, "密钥库已锁定")
		return
	}
	pid := r.PathValue("id")
	var enc []byte
	var expected string
	err := g.db.QueryRow(`SELECT c.credential,p.token_digest FROM projects p
	 LEFT JOIN project_credentials c ON c.project_id=p.id WHERE p.id=?`, pid).Scan(&enc, &expected)
	if errors.Is(err, sql.ErrNoRows) {
		problem(w, 404, "项目不存在")
		return
	}
	if err != nil {
		problem(w, 500, "读取项目 Token 失败")
		return
	}
	if len(enc) == 0 {
		problem(w, 409, "此项目尚未保存可复制的 Token，请保存已有 Token，或重置生成")
		return
	}
	plain, err := unseal(key, enc, "project:"+pid)
	defer wipe(plain)
	if err != nil || subtle.ConstantTimeCompare([]byte(digest(string(plain))), []byte(expected)) != 1 {
		problem(w, 500, "项目 Token 无法解密或已失效")
		return
	}
	writeJSON(w, 200, map[string]string{"token": string(plain)})
}

func (g *Gateway) saveExistingProjectCredential(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &input) {
		return
	}
	input.Token = strings.TrimSpace(input.Token)
	if len(input.Token) != 46 || !strings.HasPrefix(input.Token, "gw_") {
		problem(w, 400, "请粘贴完整的 gw_ 开头项目 Token")
		return
	}
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 423, "密钥库已锁定")
		return
	}
	tx, err := g.db.Begin()
	if err != nil {
		problem(w, 500, "保存失败")
		return
	}
	defer tx.Rollback()
	pid := r.PathValue("id")
	var expected string
	err = tx.QueryRow("SELECT token_digest FROM projects WHERE id=?", pid).Scan(&expected)
	if errors.Is(err, sql.ErrNoRows) {
		problem(w, 404, "项目不存在")
		return
	}
	if err != nil {
		problem(w, 500, "读取项目失败")
		return
	}
	if subtle.ConstantTimeCompare([]byte(expected), []byte(digest(input.Token))) != 1 {
		problem(w, 400, "Token 与这个项目的当前凭证不匹配，请检查是否选错项目或已经重置")
		return
	}
	if saveProjectToken(tx, key, pid, input.Token) != nil || tx.Commit() != nil {
		problem(w, 500, "保存项目 Token 失败")
		return
	}
	writeJSON(w, 200, map[string]bool{"saved": true})
}

func (g *Gateway) rotateProject(w http.ResponseWriter, r *http.Request) {
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 423, "密钥库已锁定")
		return
	}
	tx, err := g.db.Begin()
	if err != nil {
		problem(w, 500, "重置失败")
		return
	}
	defer tx.Rollback()
	token, pid := newToken(), r.PathValue("id")
	res, err := tx.Exec("UPDATE projects SET token_digest=?,token_prefix=? WHERE id=?", digest(token), token[:11], pid)
	if err != nil {
		problem(w, 500, "重置失败")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		problem(w, 404, "项目不存在")
		return
	}
	if saveProjectToken(tx, key, pid, token) != nil || tx.Commit() != nil {
		problem(w, 500, "重置失败，原凭证保持有效")
		return
	}
	writeJSON(w, 200, map[string]string{"token": token})
}
