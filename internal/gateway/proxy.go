package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

func newHTTPClient() *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConns = 32
	t.MaxIdleConnsPerHost = 8
	t.ResponseHeaderTimeout = 45 * time.Second
	t.DisableCompression = true
	return &http.Client{Transport: t, Timeout: 10 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
}
func projectCredential(r *http.Request) string {
	b := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if b == r.Header.Get("Authorization") {
		b = ""
	}
	x := r.Header.Get("x-api-key")
	if x != "" && b != "" && x != b {
		return ""
	}
	if b != "" {
		return b
	}
	return x
}
func (g *Gateway) project(r *http.Request) (Project, bool) {
	var p Project
	token := projectCredential(r)
	if token == "" || len(token) > 200 {
		return p, false
	}
	e := g.db.QueryRow("SELECT id,name,enabled,token_prefix FROM projects WHERE token_digest=?", digest(token)).Scan(&p.ID, &p.Name, &p.Enabled, &p.TokenPrefix)
	return p, e == nil && p.Enabled
}
func (g *Gateway) modelList(w http.ResponseWriter, r *http.Request) {
	p, ok := g.project(r)
	if !ok {
		problem(w, 401, "项目凭证无效或项目已停用")
		return
	}
	rows, e := g.db.Query(`SELECT m.alias FROM models m JOIN project_models pm ON pm.model_id=m.id JOIN connections c ON c.id=m.connection_id WHERE pm.project_id=? AND m.enabled=1 AND c.enabled=1 AND EXISTS(SELECT 1 FROM json_each(m.protocols_json) mp JOIN json_each(c.endpoints_json) ce ON ce.key=mp.value) ORDER BY m.alias`, p.ID)
	if e != nil {
		problem(w, 500, "查询失败")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var a string
		if rows.Scan(&a) != nil {
			problem(w, 500, "查询失败")
			return
		}
		out = append(out, map[string]any{"id": a, "object": "model", "owned_by": "local-gateway", "created": 0})
	}
	writeJSON(w, 200, map[string]any{"object": "list", "data": out})
}
func (g *Gateway) route(alias, projectID string, admin bool) (Model, Connection, []byte, error) {
	var m Model
	var c Connection
	var encrypted []byte
	var defaults, protocols, endpoints string
	q := `SELECT m.id,m.name,m.alias,m.connection_id,m.upstream_model,m.defaults_json,m.enabled,m.protocols_json,c.id,c.name,c.provider,c.endpoints_json,c.enabled,c.credential FROM models m JOIN connections c ON c.id=m.connection_id WHERE m.alias=? AND m.enabled=1 AND c.enabled=1`
	args := []any{alias}
	if !admin {
		q += ` AND EXISTS(SELECT 1 FROM project_models pm WHERE pm.model_id=m.id AND pm.project_id=?)`
		args = append(args, projectID)
	}
	e := g.db.QueryRow(q, args...).Scan(&m.ID, &m.Name, &m.Alias, &m.ConnectionID, &m.UpstreamModel, &defaults, &m.Enabled, &protocols, &c.ID, &c.Name, &c.Provider, &endpoints, &c.Enabled, &encrypted)
	if e == nil {
		e = json.Unmarshal([]byte(defaults), &m.Defaults)
	}
	if e == nil {
		e = json.Unmarshal([]byte(protocols), &m.Protocols)
	}
	if e == nil {
		e = json.Unmarshal([]byte(endpoints), &c.Endpoints)
	}
	return m, c, encrypted, e
}
func (g *Gateway) proxy(w http.ResponseWriter, r *http.Request) {
	t := traceOf(r)
	p, ok := g.project(r)
	if !ok {
		problem(w, 401, "项目凭证无效或项目已停用")
		return
	}
	t.rec.ProjectID, t.rec.ProjectName = p.ID, p.Name
	captureWorkBuddy(&t.rec, r.Header, projectCredential(r))
	g.snapshotCall(t)
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	if e != nil {
		problem(w, 413, "请求超过 2 MB 上限")
		return
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(raw, &body) != nil || body == nil {
		problem(w, 400, "请求必须为 JSON 对象")
		return
	}
	var alias string
	if json.Unmarshal(body["model"], &alias) != nil {
		problem(w, 400, "缺少模型别名")
		return
	}
	var stream bool
	if v, exists := body["stream"]; exists && (string(v) == "null" || json.Unmarshal(v, &stream) != nil) {
		problem(w, 400, "stream 必须为布尔值")
		return
	}
	t.rec.Stream = &stream
	m, c, enc, e := g.route(alias, p.ID, false)
	if e != nil {
		problem(w, 403, "此项目未获模型授权，或模型／连接已停用")
		return
	}
	protocol := "chat"
	if r.URL.Path == "/v1/messages" {
		protocol = "messages"
	}
	c, e = selectProtocol(m, c, protocol)
	if e != nil {
		problem(w, 400, e.Error())
		return
	}
	g.forward(w, r, p, m, c, enc, body)
}
func (g *Gateway) testModel(w http.ResponseWriter, r *http.Request) {
	t := traceOf(r)
	t.rec.ProjectID, t.rec.ProjectName = "admin-test", "管理员测试"
	g.snapshotCall(t)
	var in struct {
		Message  string `json:"message"`
		Protocol string `json:"protocol"`
	}
	if !decode(w, r, &in) {
		return
	}
	var alias string
	if g.db.QueryRow("SELECT alias FROM models WHERE id=?", r.PathValue("id")).Scan(&alias) != nil {
		problem(w, 404, "模型不存在")
		return
	}
	m, c, enc, e := g.route(alias, "", true)
	if e != nil {
		problem(w, 400, "模型或连接已停用")
		return
	}
	if in.Protocol == "" {
		protocols := availableProtocols(m, c)
		if len(protocols) != 1 {
			problem(w, 400, "请明确选择要测试的协议")
			return
		}
		in.Protocol = protocols[0]
	}
	c, e = selectProtocol(m, c, in.Protocol)
	if e != nil {
		problem(w, 400, e.Error())
		return
	}
	if in.Message == "" {
		in.Message = "请简短回复：连接成功。"
	}
	messages, _ := json.Marshal([]map[string]string{{"role": "user", "content": in.Message}})
	aliasJSON, _ := json.Marshal(alias)
	body := map[string]json.RawMessage{"model": aliasJSON, "messages": messages, "max_tokens": json.RawMessage("128"), "stream": json.RawMessage("false")}
	g.forward(w, r, Project{ID: "admin-test", Name: "管理员测试"}, m, c, enc, body)
}

const maxLog = 1024 * 1024

type capture struct {
	data      []byte
	truncated bool
}

func (c *capture) add(b []byte) {
	left := maxLog - len(c.data)
	if len(b) > left {
		c.data = append(c.data, b[:left]...)
		c.truncated = true
	} else {
		c.data = append(c.data, b...)
	}
}
func redact(s string, secrets ...string) string {
	for _, v := range secrets {
		if v != "" {
			s = strings.ReplaceAll(s, v, "[凭据已排除]")
		}
	}
	return s
}
func (g *Gateway) forward(w http.ResponseWriter, r *http.Request, p Project, m Model, c Connection, encrypted []byte, body map[string]json.RawMessage) {
	t := traceOf(r)
	rec := &t.rec
	rec.ProjectID, rec.ProjectName, rec.ModelID, rec.Alias, rec.UpstreamModel, rec.Protocol = p.ID, p.Name, m.ID, m.Alias, m.UpstreamModel, c.Protocol
	rec.ConnectionID, rec.ConnectionName, rec.Provider = c.ID, c.Name, c.Provider
	g.snapshotCall(t)
	key := g.key()
	defer wipe(key)
	if len(key) == 0 {
		problem(w, 503, "网关已锁定，请在管理页面解锁")
		return
	}
	secret, e := unseal(key, encrypted, c.ID)
	if e != nil {
		problem(w, 500, "读取厂商凭据失败")
		return
	}
	defer wipe(secret)
	// Caller-controlled routing and credentials never reach the upstream.
	for _, k := range []string{"project_id", "connection_id", "base_url", "api_key", "token"} {
		delete(body, k)
	}
	original, _ := json.Marshal(body)
	rec.Input = redact(string(original), string(secret), projectCredential(r))
	if rec.TaskID != "" {
		rec.Question = questionExcerpt(rec.Input)
	}
	start := time.Now()
	rec.ForwardOffset = time.Since(t.start).Milliseconds()
	var captured capture
	defer func() {
		rec.Truncated = captured.truncated
		rec.Output = redact(string(captured.data), string(secret), projectCredential(r))
		if len(rec.Input) > maxLog {
			rec.Input = rec.Input[:maxLog]
			rec.Truncated = true
		}
	}()
	applyModelDefaults(body, m.Defaults, c.Provider, c.Protocol)
	rec.Adaptations = adaptProviderRequest(body, c.Provider, m.UpstreamModel, c.Protocol)
	body["model"], _ = json.Marshal(m.UpstreamModel)
	var stream bool
	if v, ok := body["stream"]; ok && json.Unmarshal(v, &stream) != nil {
		rec.Status = 400
		problem(w, 400, "stream 必须为布尔值")
		return
	}
	rec.Stream = &stream
	if c.Protocol == "messages" {
		if _, ok := body["max_tokens"]; !ok {
			body["max_tokens"] = json.RawMessage("1024")
		}
	}
	if c.Provider == "demo" {
		rec.Forwarded = true
		g.snapshotCall(t)
		g.demoResponse(w, r, m, body, stream, rec, &captured, start)
		return
	}
	payload, _ := json.Marshal(body)
	path := "/chat/completions"
	if c.Protocol == "messages" {
		path = "/messages"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "POST", c.BaseURL+path, bytes.NewReader(payload))
	if e != nil {
		problem(w, 502, "创建上游请求失败")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+string(secret))
	if c.Protocol == "messages" {
		req.Header.Set("x-api-key", string(secret))
		req.Header.Set("anthropic-version", "2023-06-01")
		if beta := r.Header.Get("anthropic-beta"); beta != "" {
			req.Header.Set("anthropic-beta", beta)
		}
	}
	rec.Forwarded = true
	g.snapshotCall(t)
	res, e := g.client.Do(req)
	if e != nil {
		classifyTransport(rec, r.Context(), ctx, e)
		status := 502
		if rec.State == "timeout" {
			status = 504
		}
		if rec.State == "canceled" {
			status = 499
		}
		problem(w, status, "上游连接失败、超时或请求已取消")
		return
	}
	defer res.Body.Close()
	rec.Status = res.StatusCode
	rec.UpstreamStatus = res.StatusCode
	if res.StatusCode >= 400 {
		rec.State = "error"
		rec.ErrorType = "upstream_error"
		if res.StatusCode == 429 {
			rec.ErrorType = "rate_limit"
		}
	}
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		rec.Status = 502
		rec.ErrorType = "upstream_protocol"
		problem(w, 502, "上游返回重定向，网关已拒绝转发凭据")
		return
	}
	if stream && res.StatusCode >= 200 && res.StatusCode < 300 {
		if !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
			rec.Status = 502
			rec.ErrorType = "upstream_protocol"
			problem(w, 502, "上游未返回预期的 SSE 事件流")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Accel-Buffering", "no")
		w.Header().Set("X-Request-ID", rec.ID)
		w.WriteHeader(res.StatusCode)
		scanner := bufio.NewScanner(res.Body)
		scanner.Buffer(make([]byte, 4096), maxLog)
		var event strings.Builder
		done := false
		chatEnd := newChatStreamEnd(body["n"])
		send := func() bool {
			if event.Len() == 0 {
				return true
			}
			s := redact(event.String(), string(secret), projectCredential(r))
			event.Reset()
			text, token, ended, _, _ := eventStats(s, c.Protocol)
			payload := eventData(s)
			if c.Protocol == "chat" {
				chatEnd.observe(payload)
			}
			if kind := responseError(payload); kind != "" {
				rec.ErrorType = kind
			}
			rec.readUsage(payload)
			if token && rec.FirstToken == nil {
				v := time.Since(start).Milliseconds()
				rec.FirstToken = &v
			}
			if text && rec.FirstText == nil {
				v := time.Since(start).Milliseconds()
				rec.FirstText = &v
			}
			if token {
				v := time.Since(start).Milliseconds()
				rec.LastToken = &v
				rec.ContentChunks++
			}
			done = done || ended
			captured.add([]byte(s))
			if _, e = w.Write([]byte(s)); e != nil {
				return false
			}
			if e = http.NewResponseController(w).Flush(); e != nil {
				return false
			}
			return true
		}
		for scanner.Scan() {
			line := scanner.Text()
			event.WriteString(line)
			event.WriteByte('\n')
			if event.Len() > maxLog {
				rec.State = "truncated"
				rec.ErrorType = "upstream_protocol"
				return
			}
			if line == "" {
				if !send() {
					rec.State = "canceled"
					rec.ErrorType = "client_canceled"
					return
				}
			}
		}
		if event.Len() > 0 {
			event.WriteByte('\n')
			if !send() {
				rec.State = "canceled"
				rec.ErrorType = "client_canceled"
				return
			}
		}
		// Some Chat providers close normally after finish_reason=stop/tool_calls
		// without [DONE]. Still drain the body for final content, usage and errors.
		done = done || (c.Protocol == "chat" && chatEnd.complete())
		if ctx.Err() != nil || isTimeout(scanner.Err()) {
			classifyTransport(rec, r.Context(), ctx, scanner.Err())
		} else if rec.ErrorType != "" {
			rec.State = "error"
		} else if scanner.Err() != nil || !done {
			rec.State = "truncated"
			rec.ErrorType = "stream_interrupted"
		} else {
			rec.State = "complete"
		}
		return
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024+1))
	if e != nil || len(data) > 8*1024*1024 {
		classifyTransport(rec, r.Context(), ctx, e)
		status := 502
		if rec.State == "timeout" {
			status = 504
		}
		if rec.State == "canceled" {
			status = 499
		}
		problem(w, status, "上游响应读取失败或超过 8 MB 上限")
		return
	}
	data = []byte(redact(string(data), string(secret), projectCredential(r)))
	captured.add(data)
	if rec.Status >= 200 && rec.Status < 300 {
		rec.State = "complete"
		if kind := responseError(data); kind != "" {
			rec.State = "error"
			rec.ErrorType = kind
		}
		rec.readUsage(data)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Request-ID", rec.ID)
	w.WriteHeader(rec.Status)
	if _, err := w.Write(data); err != nil {
		rec.State = "canceled"
		rec.ErrorType = "client_canceled"
		return
	}
	if http.NewResponseController(w).Flush() != nil {
		rec.State = "canceled"
		rec.ErrorType = "client_canceled"
	}
}
func eventStats(s, protocol string) (bool, bool, bool, int64, int64) {
	var values []string
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "data:") {
			values = append(values, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	data := strings.Join(values, "\n")
	if data == "[DONE]" {
		return false, false, true, 0, 0
	}
	return jsonStats([]byte(data), protocol)
}

// First token means the first non-empty generated content, including reasoning
// and tool output. Role-only, usage, heartbeat and end events do not qualify.
func jsonStats(b []byte, protocol string) (bool, bool, bool, int64, int64) {
	type toolFunction struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	}
	type chatContent struct {
		Content          string `json:"content"`
		ReasoningContent string `json:"reasoning_content"`
		Reasoning        string `json:"reasoning"`
		ToolCalls        []struct {
			Function toolFunction `json:"function"`
		} `json:"tool_calls"`
		FunctionCall toolFunction `json:"function_call"`
	}
	type contentBlock struct {
		Text     string `json:"text"`
		Thinking string `json:"thinking"`
		Type     string `json:"type"`
		Name     string `json:"name"`
	}
	var v struct {
		Type  string `json:"type"`
		Delta struct {
			Text        string `json:"text"`
			Thinking    string `json:"thinking"`
			PartialJSON string `json:"partial_json"`
		} `json:"delta"`
		ContentBlock contentBlock   `json:"content_block"`
		Content      []contentBlock `json:"content"`
		Choices      []struct {
			Delta   chatContent `json:"delta"`
			Message chatContent `json:"message"`
		} `json:"choices"`
		Usage struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			Prompt     int64 `json:"prompt_tokens"`
			Completion int64 `json:"completion_tokens"`
		} `json:"usage"`
		Message struct {
			Usage struct {
				Input  int64 `json:"input_tokens"`
				Output int64 `json:"output_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(b, &v) != nil {
		return false, false, false, 0, 0
	}
	text := v.Delta.Text != "" || v.ContentBlock.Text != ""
	blockToken := func(c contentBlock) bool {
		return c.Text != "" || c.Thinking != "" || (c.Type == "tool_use" && c.Name != "")
	}
	token := text || v.Delta.Thinking != "" || v.Delta.PartialJSON != "" || blockToken(v.ContentBlock)
	for _, c := range v.Content {
		text = text || c.Text != ""
		token = token || blockToken(c)
	}
	for _, c := range v.Choices {
		text = text || c.Delta.Content != "" || c.Message.Content != ""
		for _, part := range []chatContent{c.Delta, c.Message} {
			token = token || part.Content != "" || part.ReasoningContent != "" || part.Reasoning != "" || part.FunctionCall.Name != "" || part.FunctionCall.Arguments != ""
			for _, call := range part.ToolCalls {
				token = token || call.Function.Name != "" || call.Function.Arguments != ""
			}
		}
	}
	in, out := v.Usage.Input, v.Usage.Output
	if protocol == "chat" {
		in, out = v.Usage.Prompt, v.Usage.Completion
	}
	if v.Type == "message_start" {
		in, out = v.Message.Usage.Input, v.Message.Usage.Output
	}
	return text, token, v.Type == "message_stop", in, out
}
func (g *Gateway) demoResponse(w http.ResponseWriter, r *http.Request, m Model, body map[string]json.RawMessage, stream bool, rec *Record, captured *capture, start time.Time) {
	zero := int64(0)
	rec.InputTotal, rec.InputUncached, rec.CacheRead = &zero, &zero, &zero
	rec.OutputReported, rec.outputFinal = true, true
	reply := "这是一条本地模拟响应。项目凭证已验证，模型授权已通过。这次调用不会访问外部厂商，也不会消耗真实额度。你可以在请求记录中查看输入、响应与耗时。"
	rec.Status = 200
	w.Header().Set("X-Request-ID", rec.ID)
	if !stream {
		b, _ := json.Marshal(map[string]any{"id": rec.ID, "object": "chat.completion", "model": m.Alias, "choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": reply}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 0, "completion_tokens": 0}})
		captured.add(b)
		writeJSON(w, 200, json.RawMessage(b))
		rec.State = "complete"
		_ = http.NewResponseController(w).Flush()
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	runes := []rune(reply)
	for i := 0; i < len(runes); i += 4 {
		end := i + 4
		if end > len(runes) {
			end = len(runes)
		}
		select {
		case <-r.Context().Done():
			rec.State = "canceled"
			rec.ErrorType = "client_canceled"
			return
		case <-time.After(35 * time.Millisecond):
		}
		chunk, _ := json.Marshal(map[string]any{"id": rec.ID, "object": "chat.completion.chunk", "model": m.Alias, "choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": string(runes[i:end])}, "finish_reason": nil}}})
		s := fmt.Sprintf("data: %s\n\n", chunk)
		captured.add([]byte(s))
		if rec.FirstText == nil {
			v := time.Since(start).Milliseconds()
			rec.FirstText = &v
			rec.FirstToken = &v
		}
		v := time.Since(start).Milliseconds()
		rec.LastToken = &v
		rec.ContentChunks++
		if _, e := io.WriteString(w, s); e != nil {
			rec.State = "canceled"
			rec.ErrorType = "client_canceled"
			return
		}
		if http.NewResponseController(w).Flush() != nil {
			rec.State = "canceled"
			rec.ErrorType = "client_canceled"
			return
		}
	}
	tail := fmt.Sprintf("data: {\"id\":%q,\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", rec.ID)
	captured.add([]byte(tail))
	if _, err := io.WriteString(w, tail); err != nil {
		rec.State = "canceled"
		rec.ErrorType = "client_canceled"
		return
	}
	if http.NewResponseController(w).Flush() != nil {
		rec.State = "canceled"
		rec.ErrorType = "client_canceled"
		return
	}
	rec.State = "complete"
}
