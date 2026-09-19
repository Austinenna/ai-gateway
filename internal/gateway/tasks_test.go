package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func buddyHeaders(root, session, turn, agent string) http.Header {
	h := http.Header{}
	h.Set("X-Root-Request-ID", root)
	h.Set("X-Conversation-ID", session)
	h.Set("X-Conversation-Request-ID", turn)
	h.Set("X-Agent-Type", agent)
	return h
}
func TestWorkBuddyIdentityBoundaries(t *testing.T) {
	main := Record{ProjectID: "project-a"}
	captureWorkBuddy(&main, buddyHeaders("root-a", "session-a", "turn-a", "main"), "")
	child := Record{ProjectID: "project-a"}
	captureWorkBuddy(&child, buddyHeaders("root-a", "session-b", "turn-b", "subagent"), "")
	otherProject := Record{ProjectID: "project-b"}
	captureWorkBuddy(&otherProject, buddyHeaders("root-a", "session-a", "turn-a", "main"), "")
	nextTurn := Record{ProjectID: "project-a"}
	captureWorkBuddy(&nextTurn, buddyHeaders("root-b", "session-a", "turn-b", "main"), "")
	if main.TaskID == "" || main.TaskID != child.TaskID || main.TaskID == otherProject.TaskID || main.TaskID == nextTurn.TaskID {
		t.Fatal("task identity boundary failed")
	}
	fallback := buddyHeaders("root-a", "session-a", "root-a", "main")
	fallback.Del("X-Root-Request-ID")
	rec := Record{ProjectID: "project-a"}
	captureWorkBuddy(&rec, fallback, "")
	if rec.TaskID != main.TaskID || rec.Grouping.Source != "turn" {
		t.Fatal("main turn fallback failed")
	}
	for _, kind := range []string{"no-session", "no-agent", "duplicate", "invalid-root", "oversize", "child-no-root", "credential", "unauthenticated"} {
		t.Run(kind, func(t *testing.T) {
			h := buddyHeaders("root-a", "session-a", "turn-a", "main")
			rec := Record{ProjectID: "project-a"}
			switch kind {
			case "no-session":
				h.Del("X-Conversation-ID")
			case "no-agent":
				h.Del("X-Agent-Type")
			case "duplicate":
				h.Add("X-Root-Request-ID", "root-a")
			case "invalid-root":
				h.Set("X-Root-Request-ID", "bad root")
			case "oversize":
				h.Set("X-Root-Request-ID", strings.Repeat("a", 257))
			case "child-no-root":
				h.Del("X-Root-Request-ID")
				h.Set("X-Agent-Type", "subagent")
			case "credential":
				h.Set("X-Root-Request-ID", "test-credential")
			case "unauthenticated":
				rec.ProjectID = ""
			}
			captureWorkBuddy(&rec, h, "test-credential")
			if rec.TaskID != "" {
				t.Fatal("unsafe grouping accepted")
			}
		})
	}
}
func TestWorkBuddyProxyCaptureAndRedaction(t *testing.T) {
	h := newHarness(t)
	c := h.connection("https://upstream.test/v1", "chat", "fake-vendor-secret")
	m := h.model(c, "coding")
	p := h.project("Buddy", m.ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		for _, name := range []string{"X-Root-Request-ID", "X-Conversation-ID", "X-Agent-Type", "Cookie"} {
			if r.Header.Get(name) != "" {
				t.Errorf("forwarded %s", name)
			}
		}
		return response(`{"choices":[{"message":{"content":"答案"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}`, "application/json", 200), nil
	})
	req := httptest.NewRequest("POST", "http://gateway.test/v1/chat/completions", strings.NewReader(`{"model":"coding","messages":[{"role":"user","content":"hello fake-vendor-secret"}]}`))
	req.Header = buddyHeaders("root-a", "session-a", "turn-a", "main")
	req.Header.Set("Authorization", "Bearer "+p.Token)
	req.Header.Set("Cookie", "private-cookie")
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, req)
	h.want(rr, 200)
	records := h.records(1)
	r := records[0]
	if r.TaskID == "" || r.ReplyKind != "reply" || strings.Contains(r.Question, "fake-vendor-secret") {
		t.Fatalf("bad metadata: %+v", r.TaskFields)
	}
	detail := h.request("GET", "/api/admin/request-tasks/"+r.TaskID, nil, "", true)
	h.want(detail, 200)
	d := parse[TaskDetail](t, detail)
	if d.Task.State != "replied" || d.Task.Calls != 1 || d.Task.InputTokens != 12 || d.Task.ReplyRecordID != r.ID {
		t.Fatalf("bad task: %+v", d.Task)
	}
	h.want(h.request("GET", "/api/admin/request-tasks", nil, "", false), 401)
	h.want(h.request("GET", "/api/admin/request-tasks/"+r.TaskID, nil, "", false), 401)
}
func TestTaskReplyAndQuestionEvidence(t *testing.T) {
	cases := []struct{ name, output, want string }{
		{"chat", `{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}`, "reply"},
		{"tools", `{"choices":[{"message":{"content":"checking","tool_calls":[{}]},"finish_reason":"tool_calls"}]}`, "tools"},
		{"length", `{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}`, "unknown"},
		{"thinking", `{"choices":[{"message":{"reasoning_content":"thinking"},"finish_reason":"stop"}]}`, "unknown"},
		{"messages", `{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}`, "reply"},
		{"stream", "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n", "reply"},
		{"messages-stream", "event: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n", "reply"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := Record{State: "complete", Output: c.output}
			if got := taskReplyKind(rec); got != c.want {
				t.Fatalf("%s != %s", got, c.want)
			}
			rec.Truncated = true
			if taskReplyKind(rec) != "unknown" {
				t.Fatal("truncated log claimed reply")
			}
		})
	}
	input := `{"messages":[{"role":"user","content":[{"type":"text","text":"真正问题"}]},{"role":"assistant","content":[{"type":"tool_use","name":"test"}]},{"role":"user","content":[{"type":"tool_result","content":"工具结果"}]}]}`
	if questionExcerpt(input) != "真正问题" {
		t.Fatal("tool result mistaken for user question")
	}
}
func TestTasksIncludeWholeGroupAndLegacyWithMissingBodies(t *testing.T) {
	h := newHarness(t)
	base := Record{ID: "r-000", ProjectID: "p", ProjectName: "P", Started: 1, Duration: 10, State: "complete", Alias: "coding"}
	// Embedded fields must be assigned separately in struct literals.
	base.Question = "最初的提问"
	captureWorkBuddy(&base, buddyHeaders("root", "session", "turn", "main"), "")
	for i := 0; i < 205; i++ {
		r := base
		r.ID = fmt.Sprintf("r-%03d", i)
		r.Started = int64(i + 1)
		r.Question = ""
		if i == 0 {
			r.Question = base.Question
		}
		if i > 0 {
			g := *r.Grouping
			g.AgentType = "subagent"
			r.Grouping = &g
		}
		h.g.saveMetric(r)
	}
	// One failure, then a successful main reply; the failure stays counted.
	failed := base
	failed.ID = "failed"
	failed.Started = 207
	failed.State = "error"
	h.g.saveMetric(failed)
	last := base
	last.ID = "last"
	last.Started = 208
	last.ReplyKind = "reply"
	h.g.saveMetric(last)
	legacy := Record{ID: "legacy", ProjectID: "p", Started: 209, State: "complete", Alias: "old", InputTokens: 3, OutputTokens: 2}
	raw, _ := json.Marshal(legacy)
	if _, err := h.g.db.Exec("INSERT INTO requests(id,project_id,started,summary,record) VALUES(?,?,?,?,?)", legacy.ID, "p", legacy.Started, string(raw), string(raw)); err != nil {
		t.Fatal(err)
	}
	rr := h.request("GET", "/api/admin/request-tasks", nil, "", true)
	h.want(rr, 200)
	var list struct {
		Tasks []RequestTask `json:"tasks"`
	}
	list = parse[struct {
		Tasks []RequestTask `json:"tasks"`
	}](t, rr)
	if len(list.Tasks) != 2 {
		t.Fatalf("tasks=%d", len(list.Tasks))
	}
	d := parse[TaskDetail](t, h.request("GET", "/api/admin/request-tasks/"+base.TaskID, nil, "", true))
	if d.Total != 207 || len(d.Calls) != 100 || !d.HasMore || d.Task.QuestionRecordID != "r-000" || d.Task.Failed != 1 || d.Task.Missing != 207 || d.Task.State != "replied" || d.Task.InputSamples != 0 {
		t.Fatalf("incomplete aggregation: %+v", d.Task)
	}
	page := parse[TaskDetail](t, h.request("GET", "/api/admin/request-tasks/"+base.TaskID+"?offset=200", nil, "", true))
	if len(page.Calls) != 7 || page.HasMore {
		t.Fatal("pagination failed")
	}
	active := base
	active.ID = "active"
	active.Started = 210
	active.State = "running"
	h.g.metricsMu.Lock()
	h.g.inflight[active.ID] = metricSummary(active)
	h.g.metricsMu.Unlock()
	d = parse[TaskDetail](t, h.request("GET", "/api/admin/request-tasks/"+base.TaskID, nil, "", true))
	if d.Total != 208 || d.Task.State != "running" || d.Task.Active != 1 {
		t.Fatal("active call absent")
	}
	h.want(h.request("GET", "/api/admin/request-tasks/"+base.TaskID+"?offset=-1", nil, "", true), 400)
}
