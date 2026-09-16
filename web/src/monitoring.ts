export type RequestRecord = {
  id: string; project_id: string; project_name: string; model_id: string; alias: string;
  upstream_model: string; protocol: string; started: number; duration_ms: number;
  first_text_ms: number | null; first_token_ms?: number | null; timing_version?: number;
  status: number; state: string; input?: string; output?: string;
  input_tokens: number; output_tokens: number; truncated: boolean;
  metrics_version?: number; connection_id?: string; connection_name?: string; provider?: string;
  stream?: boolean | null; forwarded?: boolean; forward_offset_ms?: number;
  last_token_ms?: number | null; content_chunks?: number; error_type?: string; upstream_status?: number;
  input_total_tokens?: number | null; input_uncached_tokens?: number | null;
  cache_read_tokens?: number | null; cache_write_tokens?: number | null;
  output_reported?: boolean; usage_status?: string; output_tps?: number | null; tpot_ms?: number | null;
  record_missing?: boolean;
};
export type Distribution = { count: number; p50: number | null; p95: number | null };
export type MetricSummary = {
  requests: number; completed: number; failed: number; canceled: number; active: number;
  success_rate: number | null; rpm: number; errors: Record<string, number>;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  input_samples: number; output_samples: number; cache_samples: number; cache_write_samples: number;
  usage_complete: number; usage_eligible: number; cache_ratio: number | null;
  ttft: Distribution; ttfc: Distribution; duration: Distribution; speed: Distribution;
};
export type MetricOption = { id: string; name: string };
export type Metrics = {
  from: number; to: number; monitoring_since: number; summary: MetricSummary;
  models: (MetricSummary & { model_id: string; alias: string; connection_id: string; connection_name: string })[];
  buckets: { started: number; requests: number; failed: number; canceled: number; rpm: number }[];
  recent: RequestRecord[];
  options: { projects: MetricOption[]; models: MetricOption[]; connections: MetricOption[] };
  metrics_errors: number; dropped_records: number;
};

export const number = (value: number | null | undefined, digits = 0) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
export const percent = (value: number | null | undefined) => value == null ? '—' : `${number(value, 1)}%`;
export const duration = (value: number | null | undefined) => value == null ? '—' : value < 1000 ? `${number(value)} ms` : `${number(value / 1000, 2)} s`;
export const dateTime = (value: number) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const errorName = (kind?: string) => ({ authentication: '凭证无效', permission: '模型未授权或停用', invalid_request: '请求格式错误', gateway_error: '网关错误', gateway_restart: '服务重启中断', upstream_connection: '上游连接失败', upstream_protocol: '上游响应格式错误', upstream_error: '上游错误', rate_limit: '上游限流 · 429', timeout: '请求超时', stream_interrupted: '流式传输中断', client_canceled: '客户端取消／断开' }[kind || ''] || kind || '未分类错误');
export const recordStatus = (r: RequestRecord) => ({ complete: '完成', canceled: '已取消', truncated: '未完整结束', timeout: '已超时', rejected: '已拒绝', interrupted: '异常中断', running: '进行中' }[r.state] || '失败');
export function firstTiming(r: RequestRecord, content = false) {
  if (r.metrics_version && r.stream === false) return '非流式';
  if (!content && !r.timing_version) return '未记录';
  const v = content ? r.first_text_ms : r.first_token_ms;
  if (v == null) return content && r.state === 'complete' ? '无正文' : r.state === 'running' ? '等待中' : '未收到';
  return duration(v);
}
export const inputTotal = (r: RequestRecord) => r.metrics_version ? r.input_total_tokens : r.input_tokens > 0 ? r.input_tokens : null;
export const outputTotal = (r: RequestRecord) => r.metrics_version ? r.output_reported ? r.output_tokens : null : r.output_tokens > 0 ? r.output_tokens : null;
