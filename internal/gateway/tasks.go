package gateway

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Only this allowlist of client metadata is recorded. It never affects auth or forwarding.
type TaskFields struct {
	TaskID          string             `json:"task_id,omitempty"`
	Grouping        *WorkBuddyGrouping `json:"grouping,omitempty"`
	Question        string             `json:"question_excerpt,omitempty"`
	QuestionVersion int                `json:"question_version,omitempty"`
	ReplyKind       string             `json:"reply_kind,omitempty"`
}
type WorkBuddyGrouping struct {
	Client          string `json:"client"`
	RootID          string `json:"root_id"`
	SessionID       string `json:"session_id"`
	TurnID          string `json:"turn_id,omitempty"`
	ParentSessionID string `json:"parent_session_id,omitempty"`
	AgentType       string `json:"agent_type"`
	RequestID       string `json:"client_request_id,omitempty"`
	Source          string `json:"source"`
}

func captureWorkBuddy(rec *Record, h http.Header, credential string) {
	read := func(name string) (string, bool) {
		values := h.Values(name)
		if len(values) == 0 {
			return "", true
		}
		if len(values) != 1 || len(values[0]) == 0 || len(values[0]) > 256 || values[0] == credential {
			return "", false
		}
		for _, c := range values[0] {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._:-", c)) {
				return "", false
			}
		}
		return values[0], true
	}
	names := []string{"X-Root-Request-ID", "X-Conversation-ID", "X-Conversation-Request-ID", "X-Parent-Conversation-ID", "X-Agent-Type", "X-Conversation-Message-ID"}
	values := make([]string, len(names))
	for i, name := range names {
		value, ok := read(name)
		if !ok {
			return
		}
		values[i] = value
	}
	root, session, turn, parent, agent, request := values[0], values[1], values[2], values[3], values[4], values[5]
	if rec.ProjectID == "" || session == "" || (agent != "main" && agent != "subagent" && agent != "team") {
		return
	}
	source := "root"
	if root == "" {
		// A child turn ID does not identify its parent's task.
		if agent != "main" || parent != "" || turn == "" {
			return
		}
		root, source = turn, "turn"
	}
	key, _ := json.Marshal([]string{rec.ProjectID, "workbuddy", root})
	rec.TaskID = "task_" + digest(string(key))
	rec.Grouping = &WorkBuddyGrouping{Client: "workbuddy", RootID: root, SessionID: session, TurnID: turn, ParentSessionID: parent, AgentType: agent, RequestID: request, Source: source}
}

func contentText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	var out strings.Builder
	if parts, ok := v.([]any); ok {
		for _, part := range parts {
			if p, ok := part.(map[string]any); ok && p["type"] == "text" {
				if s, ok := p["text"].(string); ok {
					out.WriteString(s)
				}
			}
		}
	}
	return out.String()
}

var buddyContextStart = regexp.MustCompile(`^<system-reminder(?:\s[^>]*)?>`)
var buddyQueryStart = regexp.MustCompile(`^<(user_query|query|session)(?:\s[^>]*)?>`)

// WorkBuddy wraps the actual question after its injected context. These are
// text delimiters, not an XML document: keep Markdown and literal markup intact.
func workBuddyQuestion(text string) string {
	text = strings.TrimSpace(text)
	for buddyContextStart.MatchString(text) {
		end := strings.Index(text, "</system-reminder>")
		if end < 0 {
			return ""
		}
		text = strings.TrimSpace(text[end+len("</system-reminder>"):])
	}
	if match := buddyQueryStart.FindStringSubmatch(text); match != nil {
		end := strings.LastIndex(text, "</"+match[1]+">")
		if end < len(match[0]) {
			return ""
		}
		return strings.TrimSpace(text[len(match[0]):end])
	}
	return text
}

func questionText(input string, workBuddy bool) string {
	var body struct {
		Messages []struct {
			Role    string
			Content any
		}
	}
	if json.Unmarshal([]byte(input), &body) != nil {
		return ""
	}
	for i := len(body.Messages) - 1; i >= 0; i-- {
		m := body.Messages[i]
		if m.Role != "user" {
			continue
		}
		value := strings.TrimSpace(contentText(m.Content))
		if workBuddy {
			value = workBuddyQuestion(value)
		}
		if value == "" {
			continue
		}
		return value
	}
	return ""
}

func excerpt(value string) string {
	r := []rune(value)
	if len(r) > 1024 {
		return string(r[:1024]) + "…"
	}
	return value
}

func questionExcerpt(input string) string { return excerpt(questionText(input, true)) }

// A normal textual stop is evidence of a reply, not proof that the agent task has ended.
func taskReplyKind(rec Record) string {
	if rec.State != "complete" || rec.Truncated {
		return "unknown"
	}
	text, tool, stop := false, false, false
	consume := func(raw string) {
		var v struct {
			Choices []struct {
				Index   int
				Message struct {
					Content      any
					ToolCalls    []any `json:"tool_calls"`
					FunctionCall any   `json:"function_call"`
				}
				Delta struct {
					Content      any
					ToolCalls    []any `json:"tool_calls"`
					FunctionCall any   `json:"function_call"`
				}
				FinishReason string `json:"finish_reason"`
			}
			Content      []struct{ Type, Text string }
			ContentBlock struct{ Type, Text string } `json:"content_block"`
			Delta        struct {
				Type, Text string
				StopReason string `json:"stop_reason"`
			}
			StopReason string `json:"stop_reason"`
		}
		if json.Unmarshal([]byte(raw), &v) != nil {
			return
		}
		for _, c := range v.Choices {
			if c.Index != 0 {
				continue
			}
			text = text || strings.TrimSpace(contentText(c.Message.Content)+contentText(c.Delta.Content)) != ""
			tool = tool || len(c.Message.ToolCalls) > 0 || len(c.Delta.ToolCalls) > 0 || c.Message.FunctionCall != nil || c.Delta.FunctionCall != nil || c.FinishReason == "tool_calls" || c.FinishReason == "function_call"
			stop = stop || c.FinishReason == "stop"
		}
		for _, c := range v.Content {
			text = text || (c.Type == "text" && strings.TrimSpace(c.Text) != "")
			tool = tool || c.Type == "tool_use" || c.Type == "server_tool_use"
		}
		text = text || (v.ContentBlock.Type == "text" && strings.TrimSpace(v.ContentBlock.Text) != "") || (v.Delta.Type == "text_delta" && strings.TrimSpace(v.Delta.Text) != "")
		tool = tool || v.ContentBlock.Type == "tool_use" || v.ContentBlock.Type == "server_tool_use" || v.StopReason == "tool_use" || v.Delta.StopReason == "tool_use"
		stop = stop || v.StopReason == "end_turn" || v.Delta.StopReason == "end_turn"
	}
	if json.Valid([]byte(rec.Output)) {
		consume(rec.Output)
	} else {
		for _, frame := range strings.Split(strings.ReplaceAll(rec.Output, "\r\n", "\n"), "\n\n") {
			data := []string{}
			for _, line := range strings.Split(frame, "\n") {
				if strings.HasPrefix(line, "data:") {
					data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
				}
			}
			if len(data) > 0 {
				consume(strings.Join(data, "\n"))
			}
		}
	}
	if tool {
		return "tools"
	}
	if text && stop {
		return "reply"
	}
	return "unknown"
}

type RequestTask struct {
	ID               string             `json:"id"`
	ProjectID        string             `json:"project_id"`
	ProjectName      string             `json:"project_name"`
	Grouped          bool               `json:"grouped"`
	Title            string             `json:"title"`
	State            string             `json:"state"`
	Started          int64              `json:"started"`
	Updated          int64              `json:"updated"`
	Duration         int64              `json:"duration_ms"`
	Calls            int                `json:"calls"`
	Active           int                `json:"active"`
	Failed           int                `json:"failed"`
	Missing          int                `json:"missing_records"`
	InputTokens      int64              `json:"input_tokens"`
	OutputTokens     int64              `json:"output_tokens"`
	InputSamples     int                `json:"input_samples"`
	OutputSamples    int                `json:"output_samples"`
	QuestionRecordID string             `json:"question_record_id,omitempty"`
	ReplyRecordID    string             `json:"reply_record_id,omitempty"`
	Grouping         *WorkBuddyGrouping `json:"grouping,omitempty"`
	Models           []string           `json:"models"`
	Providers        []string           `json:"providers"`
}
type TaskDetail struct {
	Task     RequestTask `json:"task"`
	Question string      `json:"question"`
	Calls    []Record    `json:"calls"`
	Total    int         `json:"total"`
	Offset   int         `json:"offset"`
	HasMore  bool        `json:"has_more"`
}

func taskKey(r Record) string {
	if r.TaskID != "" {
		return r.TaskID
	}
	return r.ID
}

const taskKeySQL = "COALESCE(NULLIF(json_extract(summary,'$.task_id'),''),id)"

func (g *Gateway) initTasks() error {
	_, err := g.db.Exec(`CREATE INDEX IF NOT EXISTS idx_requests_task ON requests (` + taskKeySQL + `);
 CREATE INDEX IF NOT EXISTS idx_metrics_task ON request_metrics (` + taskKeySQL + `);`)
	return err
}

// Metrics survive body-log drops. Only calls with explicit task IDs belong here;
// ungrouped calls remain available through the request APIs.
func (g *Gateway) taskRecords(keys []string) ([]Record, error) {
	where := " WHERE COALESCE(json_extract(summary,'$.task_id'),'')<>''"
	args := []any{}
	if len(keys) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(keys)), ",")
		where += " AND " + taskKeySQL + " IN (" + placeholders + ")"
		for _, key := range keys {
			args = append(args, key)
		}
	}
	query := "SELECT id,started,summary,NOT EXISTS(SELECT 1 FROM requests r WHERE r.id=m.id) AS missing FROM request_metrics m" + where + " UNION ALL SELECT id,started,summary,0 AS missing FROM requests" + where
	query += " AND NOT EXISTS(SELECT 1 FROM request_metrics m WHERE m.id=requests.id) ORDER BY started DESC,id DESC"
	if len(keys) == 0 {
		query += " LIMIT 200"
	} else {
		args = append(args, args...)
	}
	rows, err := g.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	records := map[string]Record{}
	for rows.Next() {
		var id, raw string
		var started int64
		var missing bool
		var rec Record
		if err = rows.Scan(&id, &started, &raw, &missing); err == nil {
			err = json.Unmarshal([]byte(raw), &rec)
		}
		if err != nil {
			rows.Close()
			return nil, err
		}
		rec.RecordMissing = missing
		rec.normalizeStoredUsage()
		records[rec.ID] = rec
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	wanted := map[string]bool{}
	for _, key := range keys {
		wanted[key] = true
	}
	g.metricsMu.Lock()
	for id, rec := range g.inflight {
		delete(records, id)
		if rec.TaskID != "" && (len(keys) == 0 || wanted[taskKey(rec)]) {
			rec.RecordMissing = true
			records[id] = rec
		}
	}
	g.metricsMu.Unlock()
	out := make([]Record, 0, len(records))
	for _, rec := range records {
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Started == out[j].Started {
			return out[i].ID < out[j].ID
		}
		return out[i].Started < out[j].Started
	})
	return out, nil
}
func summarizeTask(records []Record) RequestTask {
	first := records[0]
	task := RequestTask{ID: taskKey(first), ProjectID: first.ProjectID, ProjectName: first.ProjectName, Grouped: first.TaskID != "", Title: first.Alias, State: "waiting", Started: first.Started, Calls: len(records), Grouping: first.Grouping, Models: []string{}, Providers: []string{}}
	models, providers := map[string]bool{}, map[string]bool{}
	var latestMain *Record
	for i := range records {
		r := &records[i]
		end := r.Started + r.Duration
		if r.State == "running" {
			task.Active++
			end = time.Now().UnixMilli()
		} else if r.State != "complete" {
			task.Failed++
		}
		if end > task.Updated {
			task.Updated = end
		}
		if r.RecordMissing && r.State != "running" {
			task.Missing++
		}
		if r.MetricsVersion > 0 {
			if r.InputTotal != nil {
				task.InputSamples++
				task.InputTokens += *r.InputTotal
			}
			if r.OutputReported {
				task.OutputSamples++
				task.OutputTokens += r.OutputTokens
			}
		} else {
			if r.InputTokens > 0 {
				task.InputSamples++
				task.InputTokens += r.InputTokens
			}
			if r.OutputTokens > 0 {
				task.OutputSamples++
				task.OutputTokens += r.OutputTokens
			}
		}
		if r.Alias != "" && !models[r.Alias] {
			task.Models = append(task.Models, r.Alias)
			models[r.Alias] = true
		}
		if r.Provider != "" && !providers[r.Provider] {
			task.Providers = append(task.Providers, r.Provider)
			providers[r.Provider] = true
		}
		main := r.Grouping == nil || r.Grouping.AgentType == "main"
		if main {
			latestMain = r
			if task.QuestionRecordID == "" && r.Question != "" {
				task.QuestionRecordID = r.ID
				task.Title = r.Question
				task.Grouping = r.Grouping
			}
		}
	}
	if task.Title == "" {
		task.Title = "未记录提问"
	}
	task.Duration = task.Updated - task.Started
	if task.Active > 0 {
		task.State = "running"
	} else if latestMain != nil {
		if latestMain.State != "complete" {
			task.State = "error"
		} else if latestMain.ReplyKind == "reply" {
			task.State = "replied"
			task.ReplyRecordID = latestMain.ID
		}
	}
	if !task.Grouped {
		task.State = first.State
		task.QuestionRecordID = first.ID
		task.ReplyRecordID = first.ID
	}
	return task
}

// Older summaries may have cut off the query after a long context prefix.
// Derive their presentation from the saved body without rewriting either log.
// New summaries already contain the query; only the detail needs its full text.
func (g *Gateway) presentTask(records []Record, fullQuestion bool) (RequestTask, string, error) {
	task := summarizeTask(records)
	for _, rec := range records {
		if task.Grouped && (rec.Grouping == nil || rec.Grouping.AgentType != "main") {
			continue
		}
		question := rec.Question
		if task.Grouped && rec.QuestionVersion == 0 {
			question = workBuddyQuestion(question)
		}
		if fullQuestion || task.Grouped && rec.QuestionVersion == 0 {
			input := rec.Input
			if input == "" {
				err := g.db.QueryRow("SELECT COALESCE(json_extract(record,'$.input'),'') FROM requests WHERE id=?", rec.ID).Scan(&input)
				if err != nil && err != sql.ErrNoRows {
					return task, "", err
				}
			}
			if json.Valid([]byte(input)) {
				question = questionText(input, task.Grouped)
			}
		}
		if task.Grouped {
			task.QuestionRecordID = rec.ID
			task.Title = excerpt(question)
			if task.Title == "" {
				task.Title = "未记录提问"
			}
		}
		return task, question, nil
	}
	return task, "", nil
}
func (g *Gateway) listTasks(w http.ResponseWriter, r *http.Request) {
	seeds, err := g.taskRecords(nil)
	if err != nil {
		problem(w, 500, "读取任务失败")
		return
	}
	keys := []string{}
	seen := map[string]bool{}
	for _, rec := range seeds {
		key := taskKey(rec)
		if !seen[key] {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	tasks := []RequestTask{}
	if len(keys) > 0 {
		records, e := g.taskRecords(keys)
		if e != nil {
			problem(w, 500, "读取任务失败")
			return
		}
		groups := map[string][]Record{}
		for _, rec := range records {
			key := taskKey(rec)
			groups[key] = append(groups[key], rec)
		}
		for _, group := range groups {
			task, _, err := g.presentTask(group, false)
			if err != nil {
				problem(w, 500, "读取任务提问失败")
				return
			}
			tasks = append(tasks, task)
		}
		sort.Slice(tasks, func(i, j int) bool {
			if tasks[i].Updated == tasks[j].Updated {
				return tasks[i].ID > tasks[j].ID
			}
			return tasks[i].Updated > tasks[j].Updated
		})
	}
	writeJSON(w, 200, map[string]any{"tasks": tasks, "recent_call_limit": 200})
}
func (g *Gateway) getTask(w http.ResponseWriter, r *http.Request) {
	offset := 0
	var err error
	if value := r.URL.Query().Get("offset"); value != "" {
		offset, err = strconv.Atoi(value)
	}
	if err != nil || offset < 0 {
		problem(w, 400, "分页参数无效")
		return
	}
	records, err := g.taskRecords([]string{r.PathValue("id")})
	if err != nil {
		problem(w, 500, "读取任务失败")
		return
	}
	if len(records) == 0 {
		problem(w, 404, "任务不存在")
		return
	}
	if offset > len(records) {
		offset = len(records)
	}
	end := offset + 100
	if end > len(records) {
		end = len(records)
	}
	task, question, err := g.presentTask(records, true)
	if err != nil {
		problem(w, 500, "读取任务提问失败")
		return
	}
	writeJSON(w, 200, TaskDetail{Task: task, Question: question, Calls: records[offset:end], Total: len(records), Offset: offset, HasMore: end < len(records)})
}
