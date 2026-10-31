package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
)

// DeepSeek Search / Fetch are account-level services, not models. They borrow a
// model entry only for its alias, project grant and connection (key + endpoint);
// the upstream body is DeepSeek's native one and carries no model field.
const maxWebToolRequestBytes = 64 * 1024

func isWebTool(protocol string) bool {
	return protocol == "deepseek-search" || protocol == "deepseek-fetch"
}

func webToolPath(protocol string) string {
	if protocol == "deepseek-fetch" {
		return "/tools/fetch"
	}
	return "/tools/search"
}

// Query, URL and count limits are left to DeepSeek; its 400 reaches the caller unchanged.
func validateWebToolRequest(body map[string]json.RawMessage) error {
	if raw, exists := body["stream"]; exists && string(raw) == "true" {
		return errors.New("搜索和抓取只支持同步调用，不支持 stream:true")
	}
	return nil
}

// webToolAlias lets a caller send DeepSeek's native body without `model`: it picks
// the single model granted to the project that serves this protocol.
func (g *Gateway) webToolAlias(w http.ResponseWriter, projectID, protocol string) (string, bool) {
	rows, err := g.db.Query(`SELECT m.alias FROM models m JOIN project_models pm ON pm.model_id=m.id JOIN connections c ON c.id=m.connection_id
	 WHERE pm.project_id=? AND m.enabled=1 AND c.enabled=1
	 AND EXISTS(SELECT 1 FROM json_each(m.protocols_json) WHERE value=?)
	 AND EXISTS(SELECT 1 FROM json_each(c.endpoints_json) WHERE key=?)`, projectID, protocol, protocol)
	if err != nil {
		problem(w, 500, "查询失败")
		return "", false
	}
	defer rows.Close()
	aliases := []string{}
	for rows.Next() {
		var alias string
		if rows.Scan(&alias) != nil {
			problem(w, 500, "查询失败")
			return "", false
		}
		aliases = append(aliases, alias)
	}
	switch {
	case rows.Err() != nil:
		problem(w, 500, "查询失败")
	case len(aliases) == 0:
		problem(w, 403, "此项目未获搜索或抓取授权，或模型／连接已停用")
	case len(aliases) > 1:
		problem(w, 400, "项目有多个可用的搜索模型，请在请求中用 model 指定")
	default:
		return aliases[0], true
	}
	return "", false
}

// Sample request for the admin "test model" button; message overrides the query or URL.
func webToolTestBody(protocol, message string) map[string]json.RawMessage {
	if protocol == "deepseek-fetch" {
		if message == "" {
			message = "https://api-docs.deepseek.com/"
		}
		url, _ := json.Marshal(message)
		return map[string]json.RawMessage{"url": url}
	}
	if message == "" {
		message = "DeepSeek"
	}
	query, _ := json.Marshal(message)
	return map[string]json.RawMessage{"query": query, "count": json.RawMessage("3")}
}
