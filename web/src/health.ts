export type HealthCounts = {
  ok: number;
  failed: number;
  rate_limited: number;
  auth_failed: number;
  probes: number;
  probe_failed: number;
};
export type ProbeResult = { at: number; ok: boolean; status: number; latency_ms: number; message: string };
export type ConnectionHealth = {
  id: string;
  state: 'ok' | 'degraded' | 'down' | 'auth' | 'unknown' | 'disabled';
  reason: string;
  window: HealthCounts;
  window_minutes: number;
  breaker_until?: number;
  last_traffic?: number;
  last_probe?: ProbeResult;
  probe_supported: boolean;
  buckets: (HealthCounts & { start: number })[];
};
export type LimitUsage = { inflight: number; last_minute: number; limited_since_start: number };
export type Runtime = {
  started_at: number;
  now: number;
  inflight: number;
  last_minute: number;
  db_bytes: number;
  limits: Record<string, LimitUsage>;
  breakers: Record<string, number>;
  schema_ext: number;
};

/** bucketClass picks the dominant outcome of one 30-minute bucket. */
export function bucketClass(b: HealthCounts) {
  if (b.auth_failed) return 'auth';
  if (b.failed + b.probe_failed > 0 && b.failed + b.probe_failed >= b.ok) return 'down';
  if (b.rate_limited || b.failed || b.probe_failed) return 'degraded';
  if (b.ok || b.probes) return 'ok';
  return 'idle';
}

export function formatBytes(n: number) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

export function formatAgo(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}

export function formatUptime(ms: number) {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440),
    h = Math.floor((m % 1440) / 60),
    min = m % 60;
  return (d ? d + 'd ' : '') + String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}
