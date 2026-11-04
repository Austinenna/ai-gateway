package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestTTSForwardsNativeBodyAndOmitsAudioFromRecord(t *testing.T) {
	h := newHarness(t)
	rr := h.request("POST", "/api/admin/connections", Connection{
		Name: "百炼语音", Provider: "dashscope", Enabled: true, Token: "fake-tts-key",
		Endpoints: map[string]string{"dashscope-tts": "https://ws.cn-beijing.maas.test/api/v1"},
	}, "", true)
	h.want(rr, 200)
	c := parse[Connection](t, rr)
	rr = h.request("POST", "/api/admin/models", Model{
		Name: "千问 TTS", Alias: "tts", UpstreamModel: "qwen-audio-3.1-tts-flash", ConnectionID: c.ID,
		Protocols: []string{"dashscope-tts"}, Enabled: true,
		Prices: []ModelPrice{{EffectiveFrom: 0, Chars10K: f(2)}},
	}, "", true)
	h.want(rr, 200)
	m := parse[Model](t, rr)
	p := h.project("配音", m.ID)

	audio := strings.Repeat("QUJD", 2000)
	upstream := `{"request_id":"r1","output":{"finish_reason":"stop","audio":{"id":"a1","data":"` + audio + `","url":"https://oss.test/a.mp3"}},"usage":{"characters":500}}`
	var gotURL, gotAuth, gotBody string
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(r.Body)
		gotURL, gotAuth, gotBody = r.URL.String(), r.Header.Get("Authorization"), string(raw)
		return response(upstream, "application/json", 200), nil
	})

	body := map[string]any{"model": "tts", "input": map[string]any{"text": "你好", "voice": "wenhuaizhi_v3.1", "format": "mp3"}}
	rr = h.request("POST", "/v1/tts/speech", body, p.Token, false)
	h.want(rr, 200)
	if rr.Body.String() != upstream {
		t.Fatal("caller must receive the full DashScope response including audio")
	}
	if gotURL != c.Endpoints["dashscope-tts"]+"/services/audio/tts/SpeechSynthesizer" || gotAuth != "Bearer fake-tts-key" {
		t.Fatalf("wrong upstream route or credential: %s", gotURL)
	}
	var sent struct {
		Model string         `json:"model"`
		Input map[string]any `json:"input"`
	}
	if json.Unmarshal([]byte(gotBody), &sent) != nil || sent.Model != "qwen-audio-3.1-tts-flash" || sent.Input["voice"] != "wenhuaizhi_v3.1" {
		t.Fatalf("upstream body wrong: %s", gotBody)
	}

	h.records(1)
	rr = h.request("GET", "/api/admin/requests/"+rr.Header().Get("X-Request-ID"), nil, "", true)
	h.want(rr, 200)
	rec := parse[Record](t, rr)
	if strings.Contains(rec.Output, audio) || !strings.Contains(rec.Output, `"omitted":"audio"`) {
		t.Fatalf("stored output must omit synthesized audio: %.200s", rec.Output)
	}
	if rec.Protocol != "dashscope-tts" || rec.TTSCharacters == nil || *rec.TTSCharacters != 500 || rec.UsageStatus != "complete" {
		t.Fatalf("tts record wrong: %+v", rec)
	}
	if rec.Cost == nil || rec.Cost.Status != "priced" || !near(rec.Cost.Amount, 0.1) {
		t.Fatalf("500 characters at 2 CNY / 10k should cost 0.1: %+v", rec.Cost)
	}
	a := newAggregate()
	a.add(rec)
	if a.UsageEligible != 0 || a.TTSCharacters != 500 {
		t.Fatal("tts calls must not count toward token usage completeness")
	}

	// Admin test sends a sample sentence with the chosen voice.
	h.want(h.request("POST", "/api/admin/models/"+m.ID+"/test", map[string]any{"protocol": "dashscope-tts", "voice": "anmingyuan_v3.1"}, "", true), 200)
	if !strings.Contains(gotBody, `"voice":"anmingyuan_v3.1"`) || !strings.Contains(gotBody, `"text":"网关语音合成测试。"`) {
		t.Fatalf("admin test sent wrong sample: %s", gotBody)
	}
}

func TestTTSRejectsMissingTextVoiceAndStream(t *testing.T) {
	h := newHarness(t)
	rr := h.request("POST", "/api/admin/connections", Connection{
		Name: "百炼语音", Provider: "dashscope", Enabled: true, Token: "fake-tts-key",
		Endpoints: map[string]string{"dashscope-tts": "https://ws.cn-beijing.maas.test/api/v1"},
	}, "", true)
	h.want(rr, 200)
	c := parse[Connection](t, rr)
	rr = h.request("POST", "/api/admin/models", Model{Name: "TTS", Alias: "tts", UpstreamModel: "qwen-tts", ConnectionID: c.ID, Protocols: []string{"dashscope-tts"}, Enabled: true}, "", true)
	h.want(rr, 200)
	p := h.project("配音", parse[Model](t, rr).ID)
	h.g.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		t.Fatal("rejected requests must not reach DashScope")
		return nil, nil
	})
	for _, input := range []map[string]any{{"voice": "v"}, {"text": "你好"}} {
		h.want(h.request("POST", "/v1/tts/speech", map[string]any{"model": "tts", "input": input}, p.Token, false), 400)
	}
	h.want(h.request("POST", "/v1/tts/speech", map[string]any{"model": "tts", "stream": true, "input": map[string]any{"text": "你好", "voice": "v"}}, p.Token, false), 400)
}
