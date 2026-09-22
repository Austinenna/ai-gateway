package gateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const asrPath = "/v1/asr/transcriptions"

func asrFixture(t *testing.T) (*harness, Connection, Model, projectCreated) {
	t.Helper()
	h := newHarness(t)
	rr := h.request("POST", "/api/admin/connections", Connection{
		Name: "百炼测试连接", Provider: "dashscope", Enabled: true,
		Endpoints: map[string]string{"dashscope-asr": "https://dashscope.example.test/api/v1/"}, Token: "fake-asr-vendor-key",
	}, "", true)
	h.want(rr, 200)
	c := parse[Connection](t, rr)
	rr = h.request("POST", "/api/admin/models", Model{
		Name: "语音转写", Alias: "transcribe", UpstreamModel: "qwen-audio-3.0-asr-flash", ConnectionID: c.ID,
		Protocols: []string{"dashscope-asr"}, Enabled: true,
		Defaults: map[string]json.RawMessage{"temperature": json.RawMessage("0.7"), "max_tokens": json.RawMessage("123")},
	}, "", true)
	h.want(rr, 200)
	m := parse[Model](t, rr)
	return h, c, m, h.project("ASR 项目", m.ID)
}

func asrBody(alias, audio string) map[string]any {
	return map[string]any{
		"model": alias,
		"input": map[string]any{"messages": []any{
			map[string]any{"role": "system", "content": []any{map[string]any{"text": "Codex, Claude Code, 热词"}}},
			map[string]any{"role": "user", "content": []any{map[string]any{"audio": audio}}},
		}},
		"parameters": map[string]any{"format": "mp3", "asr_options": map[string]any{"language": "zh", "enable_itn": true}, "native_future_option": "preserve"},
	}
}

func TestASRNativeForwardingRecordingAndUsage(t *testing.T) {
	h, c, m, p := asrFixture(t)
	// A realistic file exceeds the old text request/log caps. No audio reaches
	// the database, while the exact input still reaches the fake upstream.
	encoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("private-audio-fixture-"), 100000))
	audio := "data:audio/mp3;base64," + encoded
	body := asrBody(m.Alias, audio)
	body["project_id"], body["api_key"] = "caller-route-injection", "caller-key-injection"
	input, _ := json.Marshal(body["input"])
	parameters, _ := json.Marshal(body["parameters"])
	responseBody := `{"request_id":"vendor-request","output":{"text":"你好 Codex。","sentence":[{"words":[{"text":"你好","begin_time":0,"end_time":340}]}]},"usage":{"duration":25.5,"input_tokens":999,"output_tokens":888},"echo":{"audio":"` + audio + `"}}`
	calls := 0
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != c.Endpoints["dashscope-asr"]+"/services/aigc/multimodal-generation/generation" || r.Method != "POST" {
			t.Fatalf("wrong ASR upstream route: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer fake-asr-vendor-key" || r.Header.Get("x-api-key") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("ASR credential isolation failed")
		}
		if asr, _ := r.Context().Value(asrTransportKey{}).(bool); !asr {
			t.Fatal("ASR request did not select the longer response-header wait")
		}
		var got map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if string(got["model"]) != `"qwen-audio-3.0-asr-flash"` || !bytes.Equal(got["input"], input) || !bytes.Equal(got["parameters"], parameters) {
			t.Fatal("ASR model mapping, audio, hotwords or native parameters changed")
		}
		for _, key := range []string{"project_id", "api_key", "temperature", "max_tokens", "messages"} {
			if _, exists := got[key]; exists {
				t.Fatalf("unexpected forwarded field %s", key)
			}
		}
		return response(responseBody, "application/json", 200), nil
	})
	rr := h.request("POST", asrPath, body, p.Token, false)
	h.want(rr, 200)
	if rr.Body.String() != responseBody || calls != 1 {
		t.Fatal("native ASR response (including timestamps and echo) was altered")
	}
	h.records(1)
	rr = h.request("GET", "/api/admin/requests/"+rr.Header().Get("X-Request-ID"), nil, "", true)
	h.want(rr, 200)
	rec := parse[Record](t, rr)
	if rec.Protocol != "dashscope-asr" || rec.Provider != "dashscope" || rec.Alias != m.Alias || rec.ProjectID != p.Project.ID || rec.State != "complete" {
		t.Fatal("ASR record attribution or state missing")
	}
	if rec.AudioSeconds == nil || *rec.AudioSeconds != 25.5 || rec.UsageStatus != "complete" || rec.InputTotal != nil || rec.OutputReported || rec.InputTokens != 0 || rec.OutputTokens != 0 || rec.OutputTPS != nil {
		t.Fatal("ASR seconds must remain separate from LLM tokens and speed")
	}
	if rec.Truncated || !strings.Contains(rec.Input, `"bytes":2200000`) || !strings.Contains(rec.Input, "热词") || !strings.Contains(rec.Output, `"begin_time":0`) || !strings.Contains(rec.Output, `"duration":25.5`) {
		t.Fatalf("ASR log lost native text/parameters/timestamps or audio size summary; truncated=%v input=%s", rec.Truncated, rec.Input)
	}
	for _, query := range []string{"SELECT record FROM requests WHERE id=?", "SELECT summary FROM requests WHERE id=?", "SELECT summary FROM request_metrics WHERE id=?"} {
		var stored string
		if err := h.g.db.QueryRow(query, rec.ID).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{encoded[:100], "data:audio", "fake-asr-vendor-key", p.Token, "caller-key-injection"} {
			if strings.Contains(stored, forbidden) {
				t.Fatal("audio or credentials reached stored ASR data")
			}
		}
		if !strings.Contains(stored, `"audio_seconds":25.5`) {
			t.Fatal("audio seconds did not survive record/metrics persistence")
		}
	}
	a := newAggregate()
	a.add(rec)
	if a.Requests != 1 || a.Completed != 1 || a.UsageEligible != 0 || a.UsageComplete != 0 || a.AudioSeconds != 25.5 || a.AudioSamples != 1 || a.InputSamples != 0 || a.OutputSamples != 0 {
		t.Fatal("ASR incorrectly changed token completeness or token samples")
	}
}

func TestASRNoSpeechAndOldDialectUsagePreserved(t *testing.T) {
	for _, tt := range []struct {
		name, body string
		status     int
		seconds    float64
	}{
		{"no speech", `{"code":"ASR_RESPONSE_HAVE_NO_WORDS","message":"no words","request_id":"silent","usage":{"duration":0}}`, 400, 0},
		{"qwen3 seconds", `{"output":{"choices":[{"message":{"content":[{"text":"旧协议的文字"}]}}]},"usage":{"seconds":4.75}}`, 200, 4.75},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h, _, m, p := asrFixture(t)
			h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
				return response(tt.body, "application/json", tt.status), nil
			})
			rr := h.request("POST", asrPath, asrBody(m.Alias, "data:audio/mp3;base64,YWJj"), p.Token, false)
			h.want(rr, tt.status)
			if rr.Body.String() != tt.body {
				t.Fatal("native ASR error/text response changed")
			}
			rec := h.records(1)[0]
			if rec.UpstreamStatus != tt.status || rec.AudioSeconds == nil || *rec.AudioSeconds != tt.seconds {
				t.Fatal("upstream status or native seconds were lost")
			}
			if tt.status == 400 && (rec.State != "error" || rec.ErrorType != "upstream_error") {
				t.Fatal("no-speech 400 was incorrectly turned into gateway success")
			}
		})
	}
}

func TestASRRejectsUnauthorizedDisabledAndWrongProtocol(t *testing.T) {
	h, c, m, p := asrFixture(t)
	body := asrBody(m.Alias, "data:audio/mp3;base64,YWJj")
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("rejected ASR request reached upstream")
		return nil, nil
	})
	for _, token := range []string{"", "invalid-project-token"} {
		rr := h.request("POST", asrPath, body, token, false)
		h.want(rr, 401)
	}
	unauthorized := h.project("无授权")
	h.want(h.request("POST", asrPath, body, unauthorized.Token, false), 403)
	for _, path := range []string{"/v1/chat/completions", "/v1/messages"} {
		h.want(h.request("POST", path, body, p.Token, false), 400)
	}
	textConnection := h.connection("https://text.example.test/v1", "chat", "fake-text-key")
	textModel := h.model(textConnection, "text-only")
	textProject := h.project("纯文本项目", textModel.ID)
	h.want(h.request("POST", asrPath, asrBody(textModel.Alias, "data:audio/mp3;base64,YWJj"), textProject.Token, false), 400)
	p.Project.Enabled = false
	h.want(h.request("PUT", "/api/admin/projects/"+p.Project.ID, p.Project, "", true), 200)
	h.want(h.request("POST", asrPath, body, p.Token, false), 401)
	p.Project.Enabled = true
	h.want(h.request("PUT", "/api/admin/projects/"+p.Project.ID, p.Project, "", true), 200)
	m.Enabled = false
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	h.want(h.request("POST", asrPath, body, p.Token, false), 403)
	m.Enabled = true
	h.want(h.request("PUT", "/api/admin/models/"+m.ID, m, "", true), 200)
	c.Enabled = false
	h.want(h.request("PUT", "/api/admin/connections/"+c.ID, c, "", true), 200)
	h.want(h.request("POST", asrPath, body, p.Token, false), 403)
	for _, rec := range h.records(9) {
		if rec.Forwarded {
			t.Fatal("rejected request marked forwarded")
		}
		if rec.ProjectName == "未识别项目" && rec.Protocol != "dashscope-asr" {
			t.Fatal("unauthenticated ASR request misclassified as chat")
		}
	}
}

func TestASRValidationLimitsAndExplicitAdminAudio(t *testing.T) {
	h, _, m, p := asrFixture(t)
	calls := 0
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		var got map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(got["input"], []byte("data:audio/mp3;base64,")) || got["messages"] != nil || got["max_tokens"] != nil || !bytes.Contains(got["parameters"], []byte(`"format":"mp3"`)) {
			t.Fatal("admin ASR test generated a text request or lost native fields")
		}
		return response(`{"output":{"text":"管理员音频"},"usage":{"duration":1}}`, "application/json", 200), nil
	})
	for _, tt := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"stream", func(b map[string]any) { b["stream"] = true }},
		{"null stream", func(b map[string]any) { b["stream"] = nil }},
		{"string stream", func(b map[string]any) { b["stream"] = "true" }},
		{"no audio", func(b map[string]any) {
			b["input"] = map[string]any{"messages": []any{map[string]any{"role": "user", "content": []any{map[string]string{"text": "hello"}}}}}
		}},
		{"null input", func(b map[string]any) { b["input"] = nil }},
		{"array input", func(b map[string]any) { b["input"] = []any{} }},
		{"array parameters", func(b map[string]any) { b["parameters"] = []any{} }},
		{"blank audio", func(b map[string]any) { b["input"] = asrBody(m.Alias, "  ")["input"] }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			b := asrBody(m.Alias, "data:audio/mp3;base64,YWJj")
			tt.edit(b)
			h.want(h.request("POST", asrPath, b, p.Token, false), 400)
		})
	}
	adminPath := "/api/admin/models/" + m.ID + "/test"
	for _, b := range []any{map[string]string{}, map[string]string{"protocol": "dashscope-asr", "message": "hello"}, map[string]any{"protocol": "dashscope-asr", "input": asrBody(m.Alias, "data:audio/mp3;base64,YWJj")["input"], "stream": true}} {
		h.want(h.request("POST", adminPath, b, "", true), 400)
	}
	if calls != 0 {
		t.Fatal("invalid ASR request reached vendor")
	}
	// The admin path also accepts more than the old 256 KiB decode cap.
	large := asrBody(m.Alias, "data:audio/mp3;base64,"+strings.Repeat("YWJj", 80000))
	adminBody := map[string]any{"protocol": "dashscope-asr", "input": large["input"], "parameters": large["parameters"]}
	h.want(h.request("POST", adminPath, adminBody, "", false), 401)
	h.want(h.request("POST", adminPath, adminBody, "", true), 200)
	if calls != 1 {
		t.Fatal("explicit audio admin test did not make exactly one call")
	}
	oversized := asrBody(m.Alias, "data:audio/mp3;base64,"+strings.Repeat("A", maxASRRequestBytes))
	h.want(h.request("POST", asrPath, oversized, p.Token, false), 413)
	adminBody["input"] = oversized["input"]
	h.want(h.request("POST", adminPath, adminBody, "", true), 400)
	if calls != 1 {
		t.Fatal("oversized audio reached upstream")
	}
}

func TestASRCatalogAndEnrollment(t *testing.T) {
	h, c, m, p := asrFixture(t)
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("model discovery must not assume a DashScope /models endpoint")
		return nil, nil
	})
	rr := h.request("POST", "/api/admin/connections/"+c.ID+"/models", map[string]string{"protocol": "dashscope-asr"}, "", true)
	h.want(rr, 400)
	if !strings.Contains(rr.Body.String(), "手动填写模型 ID") {
		t.Fatal("unsupported discovery did not explain the manual path")
	}
	if _, err := h.g.fetchModelCatalog(context.Background(), c.Endpoints["dashscope-asr"], "dashscope-asr", "fake-only"); err == nil {
		t.Fatal("internal catalog fetch accepted ASR")
	}
	public := h.request("GET", "/api/public/models", nil, "", false)
	h.want(public, 200)
	if !strings.Contains(public.Body.String(), `"protocols":["dashscope-asr"]`) || !strings.Contains(public.Body.String(), m.Alias) {
		t.Fatal("ASR is missing from the public model directory")
	}
	authorized := h.request("GET", "/v1/models", nil, p.Token, false)
	h.want(authorized, 200)
	if !strings.Contains(authorized.Body.String(), m.Alias) {
		t.Fatal("authorized ASR alias not listed")
	}
	in := applicationInput{Name: "ASR self enrollment", Client: "audio client", Protocol: "dashscope-asr", Models: []string{m.Alias}}
	rr = apply(h, in, "gr_"+strings.Repeat("a", 43))
	h.want(rr, 201)
	application := parse[applicationResult](t, rr)
	if application.Endpoint != "http://gateway.test/v1/asr/transcriptions" || application.BaseURL != "http://gateway.test/v1" || application.Application.Protocol != "dashscope-asr" {
		t.Fatal("ASR enrollment returned a text endpoint")
	}
	h.want(h.request("POST", asrPath, asrBody(m.Alias, "data:audio/mp3;base64,YWJj"), application.Token, false), 401)
	h.want(h.request("POST", "/api/admin/applications/"+application.Application.ID+"/decision", map[string]string{"decision": "approve"}, "", true), 200)
	status := h.request("GET", "/api/project-access", nil, application.Token, false)
	h.want(status, 200)
	if !strings.Contains(status.Body.String(), `"endpoint":"http://gateway.test/v1/asr/transcriptions"`) || !strings.Contains(status.Body.String(), `"status":"active"`) {
		t.Fatal("approved ASR access metadata changed")
	}
	h.g.client = doerFunc(func(*http.Request) (*http.Response, error) {
		return response(`{"output":{"text":"approved"}}`, "application/json", 200), nil
	})
	h.want(h.request("POST", asrPath, asrBody(m.Alias, "data:audio/mp3;base64,YWJj"), application.Token, false), 200)
}

func TestASRLogRecursiveAndUsageValidation(t *testing.T) {
	raw := []byte(`{"input":{"messages":[{"content":[{"audio":"  data:audio/wav;base64,YWJjZA==  "},{"text":"原文保持"}]}]},"echo":["data:audio/mp3;base64,YWJj"],"message":"Invalid audio: data:audio/mp3;base64,YWJj please retry", "id":9007199254740993}`)
	safe := string(asrLogPayload(raw))
	if strings.Contains(safe, "YWJj") || strings.Contains(safe, "data:audio") || !strings.Contains(safe, `"bytes":4`) || !strings.Contains(safe, `"bytes":3`) || !strings.Contains(safe, `9007199254740993`) || !strings.Contains(safe, "原文保持") || !strings.Contains(safe, "Invalid audio:") || !strings.Contains(safe, "please retry") {
		t.Fatal("recursive audio omission changed other JSON data or kept audio")
	}
	for _, raw := range []string{`{"usage":{"duration":-1}}`, `{"usage":{"duration":"3"}}`, `{"usage":{}}`, `not-json`} {
		rec := Record{Protocol: "dashscope-asr"}
		rec.readUsage([]byte(raw))
		finalizeUsage(&rec)
		if rec.AudioSeconds != nil || rec.UsageStatus != "unknown" {
			t.Fatal("invalid or missing audio use was converted into a measurement")
		}
	}
}

type asrRoundTripper func(*http.Request) (*http.Response, error)

func (f asrRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestASRTransportTimeoutIsolation(t *testing.T) {
	client := newHTTPClient()
	transport, ok := client.Transport.(*protocolTransport)
	if !ok || transport.text.ResponseHeaderTimeout != 45*time.Second || transport.asr.ResponseHeaderTimeout != 10*time.Minute || client.Timeout != 10*time.Minute {
		t.Fatal("ASR timeout must not reduce the text protocol header limit or overall deadline")
	}
	// Exercise selection without a socket: each transport has its own protocol handler.
	transport.text.RegisterProtocol("fixture", asrRoundTripper(func(*http.Request) (*http.Response, error) { return response("text", "text/plain", 200), nil }))
	transport.asr.RegisterProtocol("fixture", asrRoundTripper(func(*http.Request) (*http.Response, error) { return response("asr", "text/plain", 200), nil }))
	for _, asr := range []bool{false, true} {
		ctx := context.Background()
		if asr {
			ctx = context.WithValue(ctx, asrTransportKey{}, true)
		}
		req, _ := http.NewRequestWithContext(ctx, "POST", "fixture://unused/", nil)
		res, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(res.Body)
		res.Body.Close()
		want := "text"
		if asr {
			want = "asr"
		}
		if string(got) != want {
			t.Fatal("ASR transport selection leaked between requests")
		}
	}
	transport.CloseIdleConnections()
}

func TestASRMalformedRequestDoesNotLogAudio(t *testing.T) {
	h, _, _, p := asrFixture(t)
	req := httptest.NewRequest("POST", "http://gateway.test"+asrPath, io.NopCloser(strings.NewReader(`{"input":"data:audio/mp3;base64,private`)))
	req.Header.Set("Authorization", "Bearer "+p.Token)
	rr := httptest.NewRecorder()
	h.handler.ServeHTTP(rr, req)
	h.want(rr, 400)
	rec := h.records(1)[0]
	if rec.Protocol != "dashscope-asr" || rec.Input != "" || rec.Forwarded {
		t.Fatal("malformed ASR body was logged or forwarded")
	}
}
