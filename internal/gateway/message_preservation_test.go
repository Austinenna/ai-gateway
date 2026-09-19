package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"
)

func TestMessageContentPreservedThroughForwardingAndRecording(t *testing.T) {
	h := newHarness(t)
	original := "<system-reminder data-role=\"user-context\">\r\n<user_info>\r\nOS Version: darwin\r\nWorkspace Folder: /demo/project\r\n</user_info>\r\n<identity_context>\r\n## SOUL.md\r\n---\r\ntitle: \"Sample\"\r\n---\r\n# Heading\r\n- **Original text** & symbols\r\n</identity_context>\r\n</system-reminder>\r\n\r\n请保留这些原始文字与顺序。"
	for _, protocol := range []string{"chat", "messages"} {
		t.Run(protocol, func(t *testing.T) {
			c := h.connection("https://upstream.test/v1", protocol, "test-upstream-credential")
			m := h.model(c, "preserve-"+protocol)
			p := h.project("preserve", m.ID)
			messages := []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": original}}}}
			h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
				data, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatal(err)
				}
				var body map[string]any
				if err = json.Unmarshal(data, &body); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(body["messages"], messages) {
					t.Error("forwarded messages changed")
				}
				if protocol == "messages" {
					return response(`{"type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}`, "application/json", 200), nil
				}
				return response(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`, "application/json", 200), nil
			})
			path := "/v1/chat/completions"
			if protocol == "messages" {
				path = "/v1/messages"
			}
			rr := h.request("POST", path, map[string]any{"model": m.Alias, "messages": messages, "max_tokens": 64}, p.Token, false)
			h.want(rr, 200)
			count := 1
			if protocol == "messages" {
				count = 2
			}
			h.records(count)
			detail := h.request("GET", "/api/admin/requests/"+rr.Header().Get("X-Request-ID"), nil, "", true)
			h.want(detail, 200)
			record := parse[Record](t, detail)
			var saved map[string]any
			if err := json.Unmarshal([]byte(record.Input), &saved); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(saved["messages"], messages) {
				t.Error("recorded messages changed")
			}
		})
	}
}
