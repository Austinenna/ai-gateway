package gateway

import (
	"encoding/json"
	"net/http"
	"strings"
)

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// adminChat is a text conversation client of the existing forwarding pipeline.
// It uses the administrator's session; vendor credentials remain server-side.
func (g *Gateway) adminChat(w http.ResponseWriter, r *http.Request) {
	identity := Project{ID: "admin-chat", Name: "对话调试"}
	t := traceOf(r)
	t.rec.ProjectID, t.rec.ProjectName = identity.ID, identity.Name
	g.snapshotCall(t)
	var in struct {
		Model       string          `json:"model"`
		Protocol    string          `json:"protocol"`
		System      string          `json:"system"`
		Messages    []chatMessage   `json:"messages"`
		Temperature json.RawMessage `json:"temperature"`
		MaxTokens   json.RawMessage `json:"max_tokens"`
		Stream      json.RawMessage `json:"stream"`
	}
	if !decodeLimit(w, r, &in, maxLLMRequestBytes) {
		return
	}
	t.rec.Alias, t.rec.Protocol = in.Model, in.Protocol
	if in.Protocol != "chat" && in.Protocol != "messages" {
		problem(w, 400, "对话调试仅支持 Chat Completions 和 Messages")
		return
	}
	if len(in.Messages) == 0 || in.Messages[0].Role != "user" || in.Messages[len(in.Messages)-1].Role != "user" {
		problem(w, 400, "对话必须以用户消息开始，并以本次用户消息结束")
		return
	}
	for _, message := range in.Messages {
		if (message.Role != "user" && message.Role != "assistant") || strings.TrimSpace(message.Content) == "" {
			problem(w, 400, "对话消息仅支持非空的 user 或 assistant 文本")
			return
		}
	}
	parameters := make(map[string]json.RawMessage)
	if len(in.Temperature) > 0 {
		parameters["temperature"] = in.Temperature
	}
	if len(in.MaxTokens) > 0 {
		parameters["max_tokens"] = in.MaxTokens
	}
	if err := validateModelDefaults(parameters); err != nil {
		problem(w, 400, err.Error())
		return
	}
	stream := true
	if len(in.Stream) > 0 {
		var value *bool
		if json.Unmarshal(in.Stream, &value) != nil || value == nil {
			problem(w, 400, "stream 必须为布尔值")
			return
		}
		stream = *value
	}
	t.rec.Stream = &stream
	m, c, encrypted, err := g.route(in.Model, "", true)
	if err != nil {
		problem(w, 400, "模型不存在，或模型／连接已停用")
		return
	}
	c, err = selectProtocol(m, c, in.Protocol)
	if err != nil {
		problem(w, 400, err.Error())
		return
	}
	body := parameters
	body["model"], _ = json.Marshal(m.Alias)
	body["stream"], _ = json.Marshal(stream)
	if in.System != "" {
		if in.Protocol == "messages" {
			body["system"], _ = json.Marshal(in.System)
		} else {
			in.Messages = append([]chatMessage{{Role: "system", Content: in.System}}, in.Messages...)
		}
	}
	body["messages"], _ = json.Marshal(in.Messages)
	g.forward(w, r, identity, m, c, encrypted, body)
}
