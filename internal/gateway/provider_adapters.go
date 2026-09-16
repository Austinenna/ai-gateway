package gateway

import (
	"encoding/json"
	"strings"
)

// RequestAdaptation records only known parameter changes, never arbitrary payload
// values. The caller's original request remains in Record.Input.
type RequestAdaptation struct {
	Rule          string   `json:"rule"`
	Field         string   `json:"field"`
	Before        string   `json:"before"`
	After         string   `json:"after"`
	RemovedFields []string `json:"removed_fields,omitempty"`
}

// Adaptation uses the resolved route, not the public alias, project or client.
// Keep vendor-specific rules here so all callers share the same compatibility.
func adaptProviderRequest(body map[string]json.RawMessage, provider, upstreamModel, protocol string) []RequestAdaptation {
	switch provider {
	case "minimax":
		return adaptMinimaxRequest(body, upstreamModel, protocol)
	default:
		return nil
	}
}

func adaptMinimaxRequest(body map[string]json.RawMessage, upstreamModel, protocol string) []RequestAdaptation {
	if protocol != "messages" || !strings.EqualFold(upstreamModel, "MiniMax-M3") {
		return nil
	}
	var thinking map[string]json.RawMessage
	if json.Unmarshal(body["thinking"], &thinking) != nil || thinking == nil {
		return nil
	}
	var mode string
	if json.Unmarshal(thinking["type"], &mode) != nil || mode != "enabled" {
		return nil
	}
	// M3 documents adaptive as thinking on. Its switch cannot preserve a fixed
	// Anthropic thinking budget; the independent max_tokens limit is untouched.
	change := RequestAdaptation{
		Rule: "minimax-m3-messages-thinking", Field: "thinking.type",
		Before: "enabled", After: "adaptive",
	}
	if _, exists := thinking["budget_tokens"]; exists {
		delete(thinking, "budget_tokens")
		change.RemovedFields = []string{"thinking.budget_tokens"}
	}
	thinking["type"] = json.RawMessage(`"adaptive"`)
	body["thinking"], _ = json.Marshal(thinking)
	return []RequestAdaptation{change}
}
