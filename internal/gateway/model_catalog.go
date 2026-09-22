package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

const catalogModelLimit = 5000
const catalogPageBytes = 4 * 1024 * 1024

type catalogModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	CreatedAt   int64  `json:"created_at,omitempty"`
}

type modelCatalog struct {
	Models    []catalogModel `json:"models"`
	Protocol  string         `json:"protocol"`
	Truncated bool           `json:"truncated"`
}

// Discovery uses only a saved connection; credentials and upstream error bodies
// never leave the server. It does not create models or issue inference requests.
func (g *Gateway) discoverModels(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Protocol string `json:"protocol"`
	}
	if !decode(w, r, &in) {
		return
	}
	var c Connection
	var endpoints string
	var encrypted []byte
	c.ID = r.PathValue("id")
	if g.db.QueryRow("SELECT provider,endpoints_json,enabled,credential FROM connections WHERE id=?", c.ID).Scan(&c.Provider, &endpoints, &c.Enabled, &encrypted) != nil {
		problem(w, 404, "连接不存在")
		return
	}
	if json.Unmarshal([]byte(endpoints), &c.Endpoints) != nil {
		problem(w, 500, "读取连接失败")
		return
	}
	if !c.Enabled {
		problem(w, 400, "连接已停用，请先启用或手动填写模型 ID")
		return
	}
	if !slices.Contains(supportedProtocols, in.Protocol) || c.Endpoints[in.Protocol] == "" {
		problem(w, 400, "请选择连接已配置的协议")
		return
	}
	if in.Protocol == "dashscope-asr" {
		problem(w, 400, "当前不支持获取百炼 ASR 模型列表，请手动填写模型 ID")
		return
	}
	if c.Provider == "demo" {
		writeJSON(w, 200, modelCatalog{Models: []catalogModel{{ID: "demo-v1", DisplayName: "本地演示模型"}}, Protocol: in.Protocol})
		return
	}
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 423, "密钥库已锁定")
		return
	}
	token, err := unseal(key, encrypted, c.ID)
	if err != nil {
		problem(w, 500, "解锁厂商凭据失败")
		return
	}
	defer wipe(token)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	catalog, err := g.fetchModelCatalog(ctx, c.Endpoints[in.Protocol], in.Protocol, string(token))
	if err != nil {
		problem(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, catalog)
}

func (g *Gateway) fetchModelCatalog(ctx context.Context, endpoint, protocol, token string) (modelCatalog, error) {
	out := modelCatalog{Models: []catalogModel{}, Protocol: protocol}
	if protocol == "dashscope-asr" {
		return out, errors.New("当前不支持获取百炼 ASR 模型列表，请手动填写模型 ID")
	}
	byID := map[string]catalogModel{}
	cursors := map[string]bool{}
	cursor := ""
	count := 0
	for page := 0; page < 5; page++ {
		u, err := url.Parse(strings.TrimRight(endpoint, "/") + "/models")
		if err != nil || !validEndpointURL(endpoint) {
			return out, errors.New("连接端点无效，请检查连接配置")
		}
		if protocol == "messages" {
			q := u.Query()
			q.Set("limit", "1000")
			if cursor != "" {
				q.Set("after_id", cursor)
			}
			u.RawQuery = q.Encode()
		}
		req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		if err != nil {
			return out, errors.New("无法创建模型列表请求")
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		if protocol == "messages" {
			req.Header.Set("x-api-key", token)
			req.Header.Set("anthropic-version", "2023-06-01")
		}
		res, err := g.client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return out, errors.New("获取模型列表超时或已取消，可重试或手动填写模型 ID")
			}
			return out, errors.New("无法连接厂商模型列表接口，可检查端点或手动填写模型 ID")
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			switch res.StatusCode {
			case 404, 405, 501:
				return out, errors.New("此端点不支持模型列表接口，可切换获取协议或手动填写模型 ID")
			case 401, 403:
				return out, errors.New("厂商拒绝获取模型列表，请检查凭据或套餐权限；仍可手动填写模型 ID")
			case 429:
				return out, errors.New("厂商模型列表请求过于频繁，请稍后重试或手动填写模型 ID")
			default:
				return out, fmt.Errorf("厂商模型列表接口返回 HTTP %d，可重试或手动填写模型 ID", res.StatusCode)
			}
		}
		raw, err := io.ReadAll(io.LimitReader(res.Body, catalogPageBytes+1))
		res.Body.Close()
		if err != nil || len(raw) > catalogPageBytes {
			return out, errors.New("模型列表读取失败或响应过大，请手动填写模型 ID")
		}
		var response struct {
			Data []struct {
				ID          string          `json:"id"`
				DisplayName string          `json:"display_name"`
				Created     json.RawMessage `json:"created"`
				CreatedAt   json.RawMessage `json:"created_at"`
			} `json:"data"`
			HasMore bool   `json:"has_more"`
			LastID  string `json:"last_id"`
		}
		if json.Unmarshal(raw, &response) != nil || response.Data == nil {
			return out, errors.New("厂商返回的模型列表格式不受支持，请手动填写模型 ID")
		}
		for _, item := range response.Data {
			count++
			if count > catalogModelLimit {
				out.Truncated = true
				break
			}
			item.ID = strings.TrimSpace(item.ID)
			if !validName(item.ID) || strings.ContainsAny(item.ID, "\r\n\t") {
				continue
			}
			name := strings.TrimSpace(item.DisplayName)
			if !validName(name) {
				name = item.ID
			}
			created := catalogTimestamp(item.CreatedAt, item.Created)
			if old, exists := byID[item.ID]; !exists || created > old.CreatedAt {
				byID[item.ID] = catalogModel{ID: item.ID, DisplayName: name, CreatedAt: created}
			}
		}
		if !response.HasMore || out.Truncated {
			break
		}
		// Only the Messages specification defines after_id pagination. Unknown
		// pagination and repeated cursors are reported as partial, never guessed.
		if protocol != "messages" || response.LastID == "" || cursors[response.LastID] || page == 4 || count >= catalogModelLimit {
			out.Truncated = true
			break
		}
		cursor = response.LastID
		cursors[cursor] = true
	}
	for _, m := range byID {
		out.Models = append(out.Models, m)
	}
	slices.SortFunc(out.Models, func(a, b catalogModel) int {
		if a.CreatedAt > b.CreatedAt {
			return -1
		}
		if a.CreatedAt < b.CreatedAt {
			return 1
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}

func catalogTimestamp(values ...json.RawMessage) int64 {
	for _, raw := range values {
		var stamp int64
		var text string
		if json.Unmarshal(raw, &text) == nil {
			parsed, err := time.Parse(time.RFC3339, text)
			if err == nil {
				stamp = parsed.Unix()
			}
		} else {
			_ = json.Unmarshal(raw, &stamp)
		}
		// Epoch placeholders, future dates and millisecond values cannot establish
		// model recency. Never infer a release date from a model name.
		if stamp >= 946684800 && stamp <= time.Now().Add(24*time.Hour).Unix() {
			return stamp
		}
	}
	return 0
}
