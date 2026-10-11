package gateway

import (
	"fmt"
	"strings"
)

// diagnosticCode keeps the persisted vocabulary stable while error_type stays
// compatible with the existing monitoring API.
func diagnosticCode(errorType string) string {
	switch errorType {
	case "authentication":
		return "authentication_failed"
	case "permission":
		return "permission_denied"
	case "invalid_request":
		return "invalid_request"
	case "gateway_restart":
		return "gateway_restart"
	case "upstream_connection":
		return "upstream_connection"
	case "timeout":
		return "upstream_timeout"
	case "upstream_protocol":
		return "upstream_protocol"
	case "rate_limit":
		return "upstream_rate_limit"
	case "upstream_error":
		return "upstream_error"
	case "stream_interrupted":
		return "stream_interrupted"
	case "client_canceled":
		return "client_canceled"
	default:
		return "gateway_error"
	}
}

func diagnosticPhase(code string) string {
	switch code {
	case "gateway_locked":
		return "unlock"
	case "authentication_failed":
		return "authentication"
	case "permission_denied":
		return "authorization"
	case "invalid_request":
		return "validation"
	case "upstream_connection", "upstream_timeout":
		return "upstream_request"
	case "upstream_protocol", "upstream_rate_limit", "upstream_error":
		return "upstream_response"
	case "stream_interrupted":
		return "stream"
	case "client_canceled":
		return "client"
	case "gateway_restart":
		return "shutdown"
	default:
		return "gateway"
	}
}

func diagnosticSource(code string) string {
	switch code {
	case "upstream_connection", "upstream_timeout", "upstream_protocol", "upstream_rate_limit", "upstream_error", "stream_interrupted":
		return "upstream"
	case "client_canceled":
		return "client"
	default:
		return "gateway"
	}
}

func diagnosticAction(code string) string {
	switch code {
	case "gateway_locked":
		return "admin_login"
	case "authentication_failed":
		return "check_project_credential"
	case "permission_denied":
		return "check_model_access"
	case "invalid_request":
		return "fix_request"
	case "upstream_connection", "upstream_timeout", "upstream_protocol", "upstream_error":
		return "inspect_upstream"
	case "upstream_rate_limit":
		return "retry_later"
	case "stream_interrupted":
		return "retry_or_check_client"
	case "client_canceled":
		return "check_client"
	case "gateway_restart":
		return "retry"
	default:
		return "inspect_gateway"
	}
}

func diagnosticRetryable(code string, status int) bool {
	switch code {
	case "gateway_locked", "upstream_connection", "upstream_timeout", "upstream_rate_limit", "stream_interrupted", "gateway_restart":
		return true
	case "upstream_error":
		return status >= 500 || status == 429
	default:
		return false
	}
}

func diagnosticMessage(rec *Record, code, problemMessage string) string {
	if problemMessage != "" {
		return truncateUTF8(problemMessage, 512)
	}
	switch code {
	case "upstream_rate_limit":
		return fmt.Sprintf("上游返回 HTTP %d，可能触发限流", rec.UpstreamStatus)
	case "upstream_error":
		if rec.UpstreamStatus > 0 {
			return fmt.Sprintf("上游返回 HTTP %d", rec.UpstreamStatus)
		}
		return "上游返回错误"
	case "upstream_connection":
		return "无法连接上游"
	case "upstream_timeout":
		return "上游请求超时"
	case "upstream_protocol":
		return "上游响应格式不符合预期"
	case "stream_interrupted":
		return "上游流式响应未正常结束"
	case "client_canceled":
		return "客户端取消或断开连接"
	case "gateway_restart":
		return "网关重启时请求被中断"
	case "authentication_failed":
		return "项目凭证无效或项目已停用"
	case "permission_denied":
		return "项目未获模型授权，或模型／连接已停用"
	case "invalid_request":
		return "请求未通过网关校验"
	default:
		return "网关返回内部错误"
	}
}

func buildDiagnostic(rec *Record, problemMessage string) *RequestDiagnostic {
	code := diagnosticCode(rec.ErrorType)
	if strings.Contains(problemMessage, "网关已锁定") || strings.Contains(problemMessage, "密钥库已锁定") || strings.Contains(problemMessage, "网关尚未解锁") {
		code = "gateway_locked"
	}
	status := rec.Status
	if rec.UpstreamStatus > 0 && status == 0 {
		status = rec.UpstreamStatus
	}
	return &RequestDiagnostic{
		Code:              code,
		Message:           diagnosticMessage(rec, code, problemMessage),
		Phase:             diagnosticPhase(code),
		Source:            diagnosticSource(code),
		UpstreamContacted: rec.Forwarded || rec.UpstreamStatus > 0,
		Retryable:         diagnosticRetryable(code, status),
		RecommendedAction: diagnosticAction(code),
	}
}

// ensureDiagnostic adds a safe, structured explanation to failed requests.
// Older records may not have the field; deriving a generic explanation keeps
// them readable without pretending that an old raw message was persisted.
func (rec *Record) ensureDiagnostic(problemMessage string) {
	if rec.Diagnostic != nil || rec.State == "complete" || rec.State == "running" {
		return
	}
	rec.Diagnostic = buildDiagnostic(rec, problemMessage)
}
