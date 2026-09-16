package gateway

import (
	"encoding/json"
	"fmt"
)

func validateModelDefaults(defaults map[string]json.RawMessage) error {
	for key, raw := range defaults {
		switch key {
		case "temperature", "max_tokens":
			var n *float64
			if json.Unmarshal(raw, &n) != nil || n == nil ||
				(key == "temperature" && (*n < 0 || *n > 2)) ||
				(key == "max_tokens" && (*n < 1 || *n > 131072 || *n != float64(int64(*n)))) {
				return fmt.Errorf("默认参数 %s 的数值超出允许范围", key)
			}
		case "reasoning_split":
			var enabled *bool
			if json.Unmarshal(raw, &enabled) != nil || enabled == nil {
				return fmt.Errorf("默认 reasoning_split 必须为布尔值")
			}
		case "thinking":
			var value map[string]string
			if json.Unmarshal(raw, &value) != nil || len(value) != 1 || (value["type"] != "adaptive" && value["type"] != "disabled") {
				return fmt.Errorf("默认 thinking 仅支持 type 为 adaptive 或 disabled 的对象")
			}
		default:
			return fmt.Errorf("默认参数仅支持 temperature、max_tokens、reasoning_split 与 thinking")
		}
	}
	return nil
}

func applyModelDefaults(body, defaults map[string]json.RawMessage, provider, protocol string) {
	for key, value := range defaults {
		switch key {
		case "reasoning_split":
			if provider != "minimax" || protocol != "chat" {
				continue
			}
		case "thinking":
			if provider != "minimax" || protocol != "messages" {
				continue
			}
		}
		// Presence, rather than truthiness, preserves explicit caller overrides.
		if _, exists := body[key]; !exists {
			body[key] = value
		}
	}
}
