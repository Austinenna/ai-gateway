package gateway

import (
	"encoding/json"
	"net/http"
)

// Public model discovery exposes only the catalog, never connection details or grants.
type publicModel struct {
	ID            string   `json:"id"`
	Object        string   `json:"object"`
	Name          string   `json:"name"`
	Protocols     []string `json:"protocols"`
	ContextWindow int      `json:"context_window,omitempty"`
}

func (g *Gateway) publicModels(w http.ResponseWriter, r *http.Request) {
	rows, err := g.db.QueryContext(r.Context(), `SELECT m.alias,m.name,m.protocols_json,c.endpoints_json,m.context_window
	 FROM models m JOIN connections c ON c.id=m.connection_id
	 WHERE m.enabled=1 AND c.enabled=1 ORDER BY m.alias`)
	if err != nil {
		problem(w, 500, "查询失败")
		return
	}
	defer rows.Close()
	out := []publicModel{}
	for rows.Next() {
		var m Model
		var c Connection
		var protocols, endpoints string
		if rows.Scan(&m.Alias, &m.Name, &protocols, &endpoints, &m.ContextWindow) != nil ||
			json.Unmarshal([]byte(protocols), &m.Protocols) != nil ||
			json.Unmarshal([]byte(endpoints), &c.Endpoints) != nil {
			problem(w, 500, "查询失败")
			return
		}
		available := availableProtocols(m, c)
		if len(available) > 0 {
			out = append(out, publicModel{ID: m.Alias, Object: "model", Name: m.Name, Protocols: available, ContextWindow: m.ContextWindow})
		}
	}
	if rows.Err() != nil {
		problem(w, 500, "查询失败")
		return
	}
	writeJSON(w, 200, map[string]any{"object": "list", "data": out})
}
