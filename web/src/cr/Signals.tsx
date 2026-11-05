import { useState } from 'react';
import { number } from '../monitoring';

type FailurePoint = { started: number; requests: number; failed: number };
type ModelSignal = {
  model_id: string;
  alias: string;
  samples: number;
  ttft_p50: number | null;
  base_samples: number;
  base_ttft_p50: number | null;
  ratio: number | null;
  slow: boolean;
};
type ProjectSignal = {
  project_id: string;
  name: string;
  kind: 'surge' | 'silent';
  last_hour: number;
  peak_hour: number;
  active_days: number;
  last_seen: number;
};
export type Signals = {
  failure: {
    requests: number;
    failed: number;
    rate: number | null;
    prev_requests: number;
    prev_rate: number | null;
    bucket_ms: number;
    buckets: FailurePoint[];
  };
  models: ModelSignal[];
  projects: ProjectSignal[];
  fallback: { total: number; served: number };
  usage_missing: number;
  background: {
    last_cleanup: { started: number; detail: { status: string; error?: string } } | null;
    last_cleanup_ok: number;
    cleanup_overdue: boolean;
    db_bytes: number;
    db_growth_7d: number | null;
    disk_free_bytes: number | null;
    disk_total_bytes: number | null;
    disk_low: boolean;
    metrics_errors: number;
    dropped_records: number;
  };
};

export const rangeName: Record<string, string> = { '1h': '近 1 小时', '24h': '近 24 小时', '7d': '近 7 天', all: '全部' };

const percent = (v: number) => (v > 0 && v < 0.1 ? '<0.1' : v.toFixed(1)) + '%';
const seconds = (v: number | null) => (v == null ? '—' : v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(1) + 's');
const when = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function bytes(v: number) {
  const size = Math.abs(v);
  if (size >= 2 ** 30) return (v / 2 ** 30).toFixed(1) + ' GB';
  if (size >= 2 ** 20) return (v / 2 ** 20).toFixed(1) + ' MB';
  return Math.round(v / 2 ** 10) + ' KB';
}

function compareText(rate: number | null, previous: number | null) {
  if (rate == null || previous == null) return '没有上一周期可比较';
  const delta = rate - previous;
  const change = Math.abs(delta) < 0.05 ? '持平' : (delta > 0 ? '升高 ' : '下降 ') + Math.abs(delta).toFixed(1) + ' 个百分点';
  return `上一周期 ${percent(previous)}，${change}`;
}

function FailureRate({ failure, win }: { failure: Signals['failure']; win: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = failure.buckets;
  const rates = points.map((p) => (p.requests ? (p.failed / p.requests) * 100 : 0));
  const top = Math.max(...rates, 0);
  const active = hover == null ? null : points[hover];
  return (
    <div className="p c8 fr-panel">
      <div className="h">
        FAILURE RATE<span className="zh">失败率 · {rangeName[win]}</span>
        <span className="r zh">不含客户端取消</span>
      </div>
      <div className="fr-head">
        <strong>{failure.rate == null ? '—' : percent(failure.rate)}</strong>
        <span className="zh">
          {number(failure.failed)} / {number(failure.requests)} 次 · {compareText(failure.rate, failure.prev_rate)}
        </span>
      </div>
      <div
        className="fr-bars"
        role="img"
        aria-label={`失败率 ${failure.rate == null ? '无数据' : percent(failure.rate)}，单段最高 ${percent(top)}`}
        onPointerLeave={() => setHover(null)}
      >
        {points.map((p, i) => (
          <span key={p.started} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
            {p.requests > 0 && (
              <i className={p.failed ? 'bad' : 'ok'} style={p.failed ? { height: Math.max(4, (rates[i] / top) * 100) + '%' } : undefined} />
            )}
          </span>
        ))}
      </div>
      <div className="fr-read zh">
        {active
          ? `${when(active.started)} 起 · ${number(active.requests)} 次请求 · 失败 ${number(active.failed)}` +
            (active.requests ? `（${percent((active.failed / active.requests) * 100)}）` : '')
          : top > 0
            ? `单段最高 ${percent(top)} · 低矮绿格为有流量无失败，空白为无流量`
            : '低矮绿格为有流量无失败，空白为无流量'}
      </div>
    </div>
  );
}

function Background({ background: b, usageMissing, win }: { background: Signals['background']; usageMissing: number; win: string }) {
  const cleanupFailed = b.last_cleanup?.detail.status === 'error';
  const writeProblem = b.metrics_errors > 0 || b.dropped_records > 0;
  const attention = cleanupFailed || b.cleanup_overdue || b.disk_low || writeProblem || usageMissing > 0;
  return (
    <div className="p c4">
      <div className="h">
        BACKGROUND<span className="zh">后台健康</span>
        <span className="r">
          <span className={'pill ' + (attention ? 'am' : 'ok')}>{attention ? 'CHECK' : 'OK'}</span>
        </span>
      </div>
      <div className="kvs">
        <span>数据清理</span>
        <b className={'zh' + (cleanupFailed || b.cleanup_overdue ? ' warn' : '')}>
          {!b.last_cleanup
            ? '尚未运行'
            : cleanupFailed
              ? `${when(b.last_cleanup.started)} 失败`
              : when(b.last_cleanup.started) + ' 成功'}
          {b.cleanup_overdue ? ' · 超过 2 天没有成功' : ''}
        </b>
        <span>数据库</span>
        <b className="zh">
          {bytes(b.db_bytes)}
          {b.db_growth_7d != null ? ` · 7 天 ${b.db_growth_7d >= 0 ? '+' : ''}${bytes(b.db_growth_7d)}` : ''}
        </b>
        <span>磁盘剩余</span>
        <b className={'zh' + (b.disk_low ? ' warn' : '')}>
          {b.disk_free_bytes == null || !b.disk_total_bytes
            ? '无法读取'
            : `${bytes(b.disk_free_bytes)} / ${bytes(b.disk_total_bytes)}${b.disk_low ? ' · 空间不足' : ''}`}
        </b>
        <span>记录写入</span>
        <b className={'zh' + (writeProblem ? ' warn' : '')}>
          {writeProblem ? `失败 ${number(b.metrics_errors)} · 丢失 ${number(b.dropped_records)}（本次启动）` : '正常'}
        </b>
        <span>用量缺失</span>
        <b className={'zh' + (usageMissing ? ' warn' : '')}>
          {usageMissing ? `${number(usageMissing)} 次，费用偏低 · ${rangeName[win]}` : '无'}
        </b>
      </div>
      {cleanupFailed && b.last_cleanup?.detail.error && <div className="dimnote zh">{b.last_cleanup.detail.error}</div>}
    </div>
  );
}

function modelState(m: ModelSignal) {
  if (m.slow) return <span className="pill am">变慢</span>;
  if (m.samples < 5 || m.base_samples < 20) return <span className="zh dim2">样本少</span>;
  return <span className="pill ok">正常</span>;
}

function ModelLatency({ models }: { models: ModelSignal[] }) {
  return (
    <div className="p c7">
      <div className="h">
        MODEL LATENCY<span className="zh">模型变慢 · 最近 1 小时 对比 前 7 天</span>
      </div>
      <table className="dg">
        <thead>
          <tr>
            <th>MODEL</th>
            <th className="n">SAMPLES</th>
            <th className="n">1H P50</th>
            <th className="n">7D P50</th>
            <th className="n">RATIO</th>
            <th>STATE</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model_id}>
              <td>{m.alias}</td>
              <td className="n">{number(m.samples)}</td>
              <td className="n">{seconds(m.ttft_p50)}</td>
              <td className="n">{seconds(m.base_ttft_p50)}</td>
              <td className="n">{m.ratio == null ? '—' : m.ratio.toFixed(1) + '×'}</td>
              <td>{modelState(m)}</td>
            </tr>
          ))}
          {!models.length && (
            <tr>
              <td colSpan={6} className="zh dim2">
                最近 1 小时没有流式调用，暂无可比较的数据。
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="dimnote zh">比较首 Token 中位数。至少 5 个样本，且变慢 2 倍并多出 1 秒才标记；只看成功的流式调用。</div>
    </div>
  );
}

function ProjectTraffic({ projects }: { projects: ProjectSignal[] }) {
  return (
    <div className="p c5">
      <div className="h">
        PROJECT TRAFFIC<span className="zh">项目流量异常</span>
      </div>
      {projects.length ? (
        projects.map((p) => (
          <div className="cb2" key={p.project_id}>
            <div className="row">
              <span className="zh">{p.name}</span>
              <span className="pill am">{p.kind === 'surge' ? 'SURGE 突增' : 'SILENT 静默'}</span>
            </div>
            <div className="zh dimnote">
              {p.kind === 'surge'
                ? `最近 1 小时 ${number(p.last_hour)} 次，过去 7 天最忙的一小时 ${number(p.peak_hour)} 次。`
                : `过去一周有 ${p.active_days} 天在用，已 24 小时没有调用，最后一次在 ${when(p.last_seen)}。`}
            </div>
          </div>
        ))
      ) : (
        <div className="cb2 calm">
          <div className="row">
            <span className="zh">没有突增或静默的项目</span>
            <span className="pill ok">NORMAL</span>
          </div>
        </div>
      )}
      <div className="dimnote zh">突增：最近 1 小时至少 20 次，且超过过去 7 天最忙一小时的 2 倍。静默：过去一周至少 3 天在用，24 小时没有调用。</div>
    </div>
  );
}

/** SignalPanels shows what is off even when no call reports an error. */
export function SignalPanels({ signals, win }: { signals: Signals | null; win: string }) {
  if (!signals?.failure) return null;
  return (
    <>
      <FailureRate failure={signals.failure} win={win} />
      <Background background={signals.background} usageMissing={signals.usage_missing} win={win} />
      <ModelLatency models={signals.models} />
      <ProjectTraffic projects={signals.projects} />
    </>
  );
}
