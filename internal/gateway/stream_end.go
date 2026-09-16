package gateway

import "encoding/json"

// chatStreamEnd supplements the explicit SSE terminator for providers that end
// with finish_reason=stop. Every requested/observed choice must have stopped;
// one completed choice must not hide another choice's interrupted response.
type chatStreamEnd struct {
	expected int
	choices  map[int]bool
}

func newChatStreamEnd(n json.RawMessage) chatStreamEnd {
	expected := 1
	if json.Unmarshal(n, &expected) != nil || expected < 1 {
		expected = 1
	}
	return chatStreamEnd{expected: expected, choices: make(map[int]bool)}
}

func (s *chatStreamEnd) observe(data []byte) {
	var event struct {
		Choices []struct {
			Index        int    `json:"index"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if json.Unmarshal(data, &event) != nil {
		return
	}
	for _, choice := range event.Choices {
		if _, seen := s.choices[choice.Index]; !seen || choice.FinishReason != "" {
			s.choices[choice.Index] = choice.FinishReason == "stop"
		}
	}
}

func (s *chatStreamEnd) complete() bool {
	if len(s.choices) < s.expected {
		return false
	}
	for _, stopped := range s.choices {
		if !stopped {
			return false
		}
	}
	return true
}
