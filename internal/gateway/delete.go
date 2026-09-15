package gateway

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"slices"
)

func (g *Gateway) deleteConnection(w http.ResponseWriter, r *http.Request) {
	cascade := r.URL.Query().Get("cascade") == "true"
	var in struct {
		ModelIDs []string `json:"model_ids"`
	}
	if cascade && !decode(w, r, &in) {
		return
	}
	tx, err := g.db.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, 500, "删除连接失败")
		return
	}
	defer tx.Rollback()
	id := r.PathValue("id")
	var found string
	if err = tx.QueryRow("SELECT id FROM connections WHERE id=?", id).Scan(&found); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			problem(w, 404, "连接不存在")
		} else {
			problem(w, 500, "读取连接失败")
		}
		return
	}
	rows, err := tx.Query("SELECT id FROM models WHERE connection_id=? ORDER BY id", id)
	if err != nil {
		problem(w, 500, "检查关联模型失败")
		return
	}
	modelIDs := []string{}
	for rows.Next() {
		var mid string
		if err = rows.Scan(&mid); err != nil {
			rows.Close()
			problem(w, 500, "检查关联模型失败")
			return
		}
		modelIDs = append(modelIDs, mid)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		problem(w, 500, "检查关联模型失败")
		return
	}
	if !cascade && len(modelIDs) > 0 {
		problem(w, 409, fmt.Sprintf("此连接仍被 %d 个模型使用，请查看关联模型并选择级联删除", len(modelIDs)))
		return
	}
	if cascade {
		slices.Sort(in.ModelIDs)
		if !slices.Equal(in.ModelIDs, modelIDs) {
			problem(w, 409, "关联模型已发生变化，请刷新列表并核对后重试")
			return
		}
		// All removals share one transaction; a failure preserves the connection and its grants.
		if _, err = tx.Exec("DELETE FROM project_models WHERE model_id IN (SELECT id FROM models WHERE connection_id=?)", id); err != nil {
			problem(w, 500, "移除模型授权失败")
			return
		}
		if _, err = tx.Exec("DELETE FROM models WHERE connection_id=?", id); err != nil {
			problem(w, 500, "删除关联模型失败")
			return
		}
	}
	if _, err = tx.Exec("DELETE FROM connections WHERE id=?", id); err != nil {
		problem(w, 500, "删除连接失败")
		return
	}
	if err = tx.Commit(); err != nil {
		problem(w, 500, "删除连接失败")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (g *Gateway) deleteModel(w http.ResponseWriter, r *http.Request) {
	tx, err := g.db.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, 500, "删除模型失败")
		return
	}
	defer tx.Rollback()
	id := r.PathValue("id")
	// Remove grants and the model atomically. Request records contain their own snapshots.
	if _, err = tx.Exec("DELETE FROM project_models WHERE model_id=?", id); err != nil {
		problem(w, 500, "移除模型授权失败")
		return
	}
	result, err := tx.Exec("DELETE FROM models WHERE id=?", id)
	if err != nil {
		problem(w, 500, "删除模型失败")
		return
	}
	n, err := result.RowsAffected()
	if err != nil {
		problem(w, 500, "删除模型失败")
		return
	}
	if n == 0 {
		problem(w, 404, "模型不存在")
		return
	}
	if err = tx.Commit(); err != nil {
		problem(w, 500, "删除模型失败")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (g *Gateway) deleteProject(w http.ResponseWriter, r *http.Request) {
	// The foreign key cascades only to model grants, never to historical requests.
	result, err := g.db.ExecContext(r.Context(), "DELETE FROM projects WHERE id=?", r.PathValue("id"))
	if err != nil {
		problem(w, 500, "删除项目失败")
		return
	}
	n, err := result.RowsAffected()
	if err != nil {
		problem(w, 500, "删除项目失败")
		return
	}
	if n == 0 {
		problem(w, 404, "项目不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
