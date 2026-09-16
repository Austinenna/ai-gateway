package gateway

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type streamEndReadError struct{ err error }

func (r streamEndReadError) Read([]byte) (int, error) { return 0, r.err }

func TestStreamStopCompatibility(t *testing.T) {
	const text = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"}}]}\n\n"
	const stop = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\n"
	const usage = "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":3}}\n\n"
	const done = "data: [DONE]\n\n"
	const second = "data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"second answer\"}}]}\n\n"
	const secondStop = "data: {\"choices\":[{\"index\":1,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
	for _, tc := range []struct {
		name, protocol, body, state, kind string
		n                                 int
		readErr                           error
		wantUsage                         bool
	}{
		{name: "minimax stop includes last text", body: text + stop, state: "complete"},
		{name: "empty final delta", body: text + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", state: "complete"},
		{name: "trailing usage without done", body: text + stop + usage, state: "complete", wantUsage: true},
		{name: "zhipu stop usage and done", body: text + stop + usage + done, state: "complete", wantUsage: true},
		{name: "legacy done only", body: text + done, state: "complete"},
		{name: "no end marker", body: text, state: "truncated", kind: "stream_interrupted"},
		{name: "unexpected read failure after stop", body: text + stop, readErr: io.ErrUnexpectedEOF, state: "truncated", kind: "stream_interrupted"},
		{name: "timeout after stop", body: text + stop, readErr: context.DeadlineExceeded, state: "timeout", kind: "timeout"},
		{name: "upstream error after stop", body: text + stop + "data: {\"error\":{\"type\":\"rate_limit_error\"}}\n\n", state: "error", kind: "rate_limit"},
		{name: "both choices stopped", body: text + second + stop + secondStop, n: 2, state: "complete"},
		{name: "observed choice unfinished", body: text + second + stop, state: "truncated", kind: "stream_interrupted"},
		{name: "requested choice missing", body: text + stop, n: 2, state: "truncated", kind: "stream_interrupted"},
		{name: "unknown reason is not stop", body: text + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"network_error\"}]}\n\n", state: "truncated", kind: "stream_interrupted"},
		{name: "length is not normal stop", body: text + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n", state: "truncated", kind: "stream_interrupted"},
		{name: "messages still requires message stop", protocol: "messages", body: "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", state: "complete"},
		{name: "chat stop cannot end messages", protocol: "messages", body: stop, state: "truncated", kind: "stream_interrupted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			protocol, path := tc.protocol, "/v1/chat/completions"
			if protocol == "" {
				protocol = "chat"
			} else if protocol == "messages" {
				path = "/v1/messages"
			}
			c := h.connection("https://upstream.test/v1", protocol, "fake-stream-end-key")
			m := h.model(c, "stream-end")
			p := h.project("stream-end", m.ID)
			h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
				res := response(tc.body, "text/event-stream", 200)
				if tc.readErr != nil {
					res.Body = io.NopCloser(io.MultiReader(strings.NewReader(tc.body), streamEndReadError{tc.readErr}))
				}
				return res, nil
			})
			body := map[string]any{"model": m.Alias, "messages": []any{}, "stream": true}
			if tc.n > 0 {
				body["n"] = tc.n
			}
			rr := h.request("POST", path, body, p.Token, false)
			h.want(rr, 200)
			if rr.Body.String() != tc.body {
				t.Fatal("the last content or trailing events were altered or dropped")
			}
			rec := getMetrics(t, h, "").Recent[0]
			if rec.State != tc.state || rec.ErrorType != tc.kind || rec.Status != 200 {
				t.Fatalf("state/error/status = %s/%s/%d, want %s/%s/200", rec.State, rec.ErrorType, rec.Status, tc.state, tc.kind)
			}
			if tc.wantUsage && (rec.UsageStatus != "complete" || rec.InputTokens != 8 || rec.OutputTokens != 3) {
				t.Fatal("trailing token usage was not recorded")
			}
			var stored Record
			until := time.Now().Add(3 * time.Second)
			for {
				detail := h.request("GET", "/api/admin/requests/"+rec.ID, nil, "", true)
				h.want(detail, 200)
				stored = parse[Record](t, detail)
				if !stored.RecordMissing {
					break
				}
				if time.Now().After(until) {
					t.Fatal("response log was not persisted")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if stored.Output != tc.body || stored.State != tc.state {
				t.Fatal("saved response or result differs from forwarded response")
			}
		})
	}
}
