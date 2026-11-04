import { RefreshCw } from 'lucide-react';
import { bucketClass, formatAgo, healthLabel, type ConnectionHealth } from './health';

/** HealthBlocks draws 48 half-hour cells; the right-most cell is now. */
export function HealthBlocks({ health }: { health: ConnectionHealth }) {
  return (
    <div className="health-blocks" aria-label="近 24 小时健康（每格 30 分钟）">
      {health.buckets.map((b) => (
        <i
          key={b.start}
          className={'hb-' + bucketClass(b)}
          title={`${new Date(b.start).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })} · 成功 ${b.ok} · 失败 ${b.failed} · 429 ${b.rate_limited} · 401/403 ${b.auth_failed} · 探测 ${b.probes}`}
        />
      ))}
    </div>
  );
}

function source(h: ConnectionHealth) {
  const total = h.window.ok + h.window.failed + h.window.rate_limited + h.window.auth_failed - h.window.probes;
  if (total > 0) return `按真实调用 · 近 ${h.window_minutes} 分钟 ${total} 次`;
  if (h.last_probe) return `主动探测 · ${formatAgo(h.last_probe.at)} · ${h.last_probe.message}`;
  return h.probe_supported ? '暂无调用，等待主动探测' : '只有语音/搜索端点，仅按真实调用判断';
}

export function ConnectionHealthCell({ health, onProbe, probing }: { health?: ConnectionHealth; onProbe: () => void; probing: boolean }) {
  if (!health) return null;
  const breaker = health.breaker_until && health.breaker_until > Date.now();
  return (
    <div className={'connection-health health-' + health.state}>
      <div className="ch-line">
        <span className="ch-state">{healthLabel[health.state]}</span>
        {breaker && <span className="ch-breaker">熔断 {Math.ceil((health.breaker_until! - Date.now()) / 1000)}s</span>}
        {health.probe_supported && health.state !== 'disabled' && (
          <button className="ch-probe" onClick={onProbe} disabled={probing} title="立即用 GET /models 探测一次，不计费、不进请求记录">
            <RefreshCw size={12} />
            {probing ? '探测中' : '探测'}
          </button>
        )}
      </div>
      <small className="ch-source">
        {health.reason && health.state !== 'unknown' ? health.reason + ' · ' : ''}
        {source(health)}
      </small>
      <HealthBlocks health={health} />
    </div>
  );
}
