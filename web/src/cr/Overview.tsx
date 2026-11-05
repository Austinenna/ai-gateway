import { useEffect, useMemo, useState } from 'react';
import type { Metrics, RequestRecord } from '../monitoring';
import { errorName } from '../monitoring';
import type { ConnectionHealth } from '../health';
import { bucketClass } from '../health';
import { Segments, Sparkline, Throughput, TtftHistogram, type Bucket } from './charts';

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type Project = { id: string; name: string; monthly_budget?: number | null };
type Connection = { id: string; name: string; enabled: boolean };
type Application = { id: string; client: string; status: string; created: number; models: string[] };
type DiagGroup = {
  code: string;
  message: string;
  count: number;
  last_started: number;
  source: string;
  models: string[];
  projects: string[];
};

export const overviewWindows = [
  ['1h', '1H'],
  ['24h', '24H'],
  ['7d', '7D'],
  ['all', 'ALL'],
] as const;
const windowMs: Record<string, number> = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
const hhmm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const hms = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
// Older entries carry their date so yesterday's calls are not read as today's.
const tailTime = (t: number) =>
  new Date(t).toDateString() === new Date().toDateString()
    ? hms(t)
    : new Date(t)
        .toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .replace('/', '-');
const secs = (ms?: number | null) => (ms == null ? '—' : (ms / 1000).toFixed(2));
// Small amounts keep four decimals so a few cheap calls do not read as ¥0.00.
const yuan = (v: number) => '¥' + (v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(4));

function level(code: string) {
  if (
    [
      'upstream_rate_limit',
      'upstream_connection',
      'upstream_timeout',
      'upstream_error',
      'gateway_locked',
      'authentication_failed',
    ].includes(code)
  )
    return ['crit', 'CRIT'];
  if (['project_rate_limit', 'project_concurrency', 'budget_exceeded', 'stream_interrupted', 'upstream_protocol'].includes(code))
    return ['warn', 'WARN'];
  return ['info', 'INFO'];
}

export function Overview({
  api,
  projects,
  connections,
  applications,
  health,
  onOpenRecord,
  onNavigate,
  win,
  detailOpen,
  onToggleDetail,
}: {
  win: string;
  detailOpen: boolean;
  onToggleDetail: () => void;
  api: Api;
  projects: Project[];
  connections: Connection[];
  applications: Application[];
  health: Record<string, ConnectionHealth>;
  onOpenRecord: (id: string) => void;
  onNavigate: (page: 'requests' | 'diagnostics' | 'costs' | 'models' | 'projects') => void;
}) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [tail, setTail] = useState<RequestRecord[]>([]);
  const [ttfts, setTtfts] = useState<number[]>([]);
  const [fallback, setFallback] = useState<{ total: number; served: number } | null>(null);
  const [spend, setSpend] = useState<{ total: number; byProject: Record<string, number> } | null>(null);
  const [diag, setDiag] = useState<DiagGroup[]>([]);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const from = win === 'all' ? 0 : Date.now() - windowMs[win];
      const [m, fb, ok, d, u] = await Promise.all([
        api('/admin/metrics?window=' + win),
        api(`/admin/requests?state=fallback&limit=200&from=${from}`),
        api(`/admin/requests?state=success&limit=200&from=${from}`),
        api('/admin/diagnostics?window=' + (win === 'all' ? 'all' : win)),
        api('/admin/usage?period=month&group_by=project'),
      ]);
      if (disposed) return;
      setMetrics(m);
      const fbItems: RequestRecord[] = fb.items || [];
      setFallback({ total: fb.total ?? fbItems.length, served: fbItems.filter((r) => r.state === 'complete').length });
      setTtfts(((ok.items || []) as RequestRecord[]).map((r) => r.first_token_ms).filter((v): v is number => typeof v === 'number'));
      setDiag((d.groups || []) as DiagGroup[]);
      setSpend({
        total: u.total?.cost || 0,
        byProject: Object.fromEntries(((u.groups || []) as { key: string; cost: number }[]).map((g) => [g.key, g.cost])),
      });
    };
    load().catch(() => {});
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load().catch(() => {});
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, [win]);

  // The live tail polls faster than the aggregates.
  useEffect(() => {
    let disposed = false;
    const load = () =>
      api('/admin/requests?limit=16')
        .then((p) => {
          if (!disposed) setTail(p.items || []);
        })
        .catch(() => {});
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, []);

  const s = metrics?.summary;
  const buckets: Bucket[] = useMemo(
    () =>
      (metrics?.buckets || []).map((b) => ({
        started: b.started,
        ok: Math.max(0, b.requests - b.failed - b.canceled),
        failed: b.failed,
        ttft: b.ttft_p50 ?? null,
      })),
    [metrics],
  );
  const budgetTotal = projects.reduce((a, p) => a + (p.monthly_budget || 0), 0);
  const monthDays = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const eom = spend ? (spend.total / Math.max(1, new Date().getDate() - 1 + new Date().getHours() / 24)) * monthDays : 0;
  const pending = applications.filter((a) => a.status === 'pending');
  const alerts = [
    ...diag.slice(0, 4).map((g) => ({
      key: g.code + g.last_started,
      time: hhmm(g.last_started),
      level: level(g.code),
      title: g.models[0] || g.projects[0] || errorName(g.code),
      text: `${errorName(g.code)} ×${g.count}。${g.message}`,
      go: 'diagnostics' as const,
    })),
    ...projects
      .filter((p) => p.monthly_budget && spend && (spend.byProject[p.id] || 0) / p.monthly_budget >= 0.8)
      .map((p) => ({
        key: 'b' + p.id,
        time: '本月',
        level: ['warn', 'WARN'],
        title: p.name,
        text: `预算已用 ${Math.round(((spend!.byProject[p.id] || 0) / p.monthly_budget!) * 100)}%，用完后网关拒绝请求。`,
        go: 'costs' as const,
      })),
    ...pending.map((a) => ({
      key: 'a' + a.id,
      time: hhmm(a.created),
      level: ['info', 'INFO'],
      title: a.client,
      text: `申请接入 ${a.models.join('、')}，等待批准。`,
      go: 'projects' as const,
    })),
  ];
  const statusCls = (r: RequestRecord) =>
    r.state === 'running' ? 'run' : r.state === 'complete' ? 's200' : r.status === 429 || r.error_type?.includes('rate') ? 's429' : 's5';
  const statusText = (r: RequestRecord) => (r.state === 'running' ? 'RUN' : String(r.status || '—'));
  const ttftP50 = s?.ttft.p50 ?? null;

  return (
    <div className="cr-v">
      <h1 className="sr-only">总览</h1>
      <section className="board">
        <div className="p c2">
          <div className="h">
            REQ<span className="r">{win.toUpperCase()}</span>
          </div>
          <div className="kv">{s ? s.requests.toLocaleString() : '—'}</div>
          <div className="sub">
            <span>RPM {s ? s.rpm.toFixed(1) : '—'}</span>
            <span>进行中 {s?.active ?? 0}</span>
          </div>
          <Sparkline values={buckets.map((b) => b.ok + b.failed)} />
        </div>
        <div className="p c2">
          <div className="h">SUCCESS</div>
          <div className="kv go">
            {s?.success_rate == null ? '—' : s.success_rate.toFixed(1)}
            <small>%</small>
          </div>
          <div className="sub">
            <span className="dn">{s?.failed ?? 0} FAIL</span>
            <span>{s?.canceled ?? 0} CXL</span>
          </div>
          <Segments ratio={(s?.success_rate ?? 0) / 100} />
        </div>
        <div className="p c2">
          <div className="h">
            TTFT<span className="r">P50</span>
          </div>
          <div className="kv">
            {secs(ttftP50)}
            <small>s</small>
          </div>
          <div className="sub">
            <span>p95 {secs(s?.ttft.p95)}s</span>
            <span>{s?.ttft.count ?? 0} 样本</span>
          </div>
          <Sparkline values={ttfts.slice(-48).reverse()} color="var(--cyan)" />
        </div>
        <div className="p c2">
          <div className="h">
            OUTPUT<span className="r">TOK/S</span>
          </div>
          <div className="kv">{s?.speed.p50 == null ? '—' : s.speed.p50.toFixed(1)}</div>
          <div className="sub">
            <span>缓存 {s?.cache_ratio == null ? '—' : Math.round(s.cache_ratio * 100) + '%'}</span>
            <span>out {(s?.output_tokens ?? 0).toLocaleString()}</span>
          </div>
          <Segments ratio={s?.cache_ratio ?? 0} />
        </div>
        <div className="p c2" onClick={() => onNavigate('requests')} style={{ cursor: 'pointer' }}>
          <div className="h">
            FALLBACK<span className="r">{win.toUpperCase()}</span>
          </div>
          <div className="kv amber">{fallback ? fallback.total : '—'}</div>
          <div className="sub">
            <span className="up">救回 {fallback?.served ?? 0}</span>
            <span>改用备用模型</span>
          </div>
          <Segments ratio={fallback && fallback.total ? fallback.served / fallback.total : 0} />
        </div>
        <div className="p c2" onClick={() => onNavigate('costs')} style={{ cursor: 'pointer' }}>
          <div className="h">
            SPEND<span className="r">本月</span>
          </div>
          <div className="kv amber">{spend ? yuan(spend.total) : '—'}</div>
          <div className="sub">
            <span>{budgetTotal ? '/ ¥' + budgetTotal : '未设预算'}</span>
            {spend && <span className={budgetTotal && eom > budgetTotal ? 'dn' : ''}>EOM {yuan(eom)}</span>}
          </div>
          <Segments ratio={budgetTotal && spend ? spend.total / budgetTotal : 0} tone="am" />
        </div>

        <div className="col c8">
          <div className="p thru-p grow">
            <div className="h">
              THROUGHPUT<span className="zh">请求吞吐 · {metrics ? buckets.length + ' 个时段' : ''}</span>
              <span className="r">
                <span style={{ color: 'var(--go)' }}>■ OK</span> <span style={{ color: 'var(--red)' }}>■ FAIL</span>{' '}
                <span style={{ color: 'var(--cyan)' }}>┄ TTFT P50</span>
              </span>
            </div>
            <Throughput buckets={buckets} onHover={(text, x, y) => setTip(text ? { text, x, y } : null)} />
          </div>
          <div className="p tail-p">
            <div className="h">
              LIVE TAIL<span className="zh">实时请求流</span>
              <span className="r" style={{ color: 'var(--go)' }}>
                ● 2s
              </span>
            </div>
            <div className="tail">
              {tail.map((r) => (
                <button type="button" className="ln" key={r.id} onClick={() => onOpenRecord(r.id)}>
                  <span className="t">{tailTime(r.started)}</span>
                  <span className={statusCls(r)}>{statusText(r)}</span>
                  <span className="m">
                    {r.alias || '—'}
                    {r.fallback_from ? ' ⇠' : ''}
                  </span>
                  <span className="pj zh">{r.project_name}</span>
                  <span className="q">{r.question_excerpt || r.diagnostic?.message || r.protocol}</span>
                  <span className="d">{r.state === 'running' ? '…' : (r.duration_ms / 1000).toFixed(2) + 's'}</span>
                </button>
              ))}
              {!tail.length && <p className="dimnote zh">还没有调用。</p>}
            </div>
          </div>
        </div>
        <div className="col c4">
          <div className="p">
            <div className="h">
              UPSTREAM<span className="zh">厂商连接 · 48 × 30min</span>
            </div>
            <div className="health">
              {connections.map((c) => {
                const h = health[c.id];
                const breaker = h?.breaker_until && h.breaker_until > Date.now();
                const st = !h ? 'unknown' : h.state;
                const cls = st === 'ok' ? 'ok' : st === 'unknown' || st === 'disabled' ? '' : st === 'degraded' ? 'am' : 'rd';
                const total = h ? h.window.ok + h.window.failed + h.window.rate_limited + h.window.auth_failed - h.window.probes : 0;
                return (
                  <div className="hr" key={c.id} onClick={() => onNavigate('models')} style={{ cursor: 'pointer' }}>
                    <div className="row">
                      <span className="zh">{c.name}</span>
                      <span className={'st ' + cls}>
                        {breaker
                          ? `BREAKER ${Math.ceil((h!.breaker_until! - Date.now()) / 1000)}s`
                          : { ok: 'NOMINAL', degraded: 'DEGRADED', down: 'DOWN', auth: 'KEY FAIL', unknown: 'UNKNOWN', disabled: 'OFF' }[
                              st
                            ]}
                      </span>
                    </div>
                    <div className="hr-src zh">
                      {total > 0
                        ? `被动 · ${total} 次/${h!.window_minutes}min`
                        : h?.last_probe
                          ? `探测 /models ${hhmm(h.last_probe.at)} ${h.last_probe.ok ? 'OK' : 'FAIL'}`
                          : '暂无调用'}
                    </div>
                    <div className="blocks">
                      {(h?.buckets || Array.from({ length: 48 }, () => null)).map((b, i) => (
                        <i key={i} className={b ? { ok: '', degraded: 'a', down: 'r', auth: 'k', idle: 'n' }[bucketClass(b)] : 'n'} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="p grow">
            <div className="h">
              ALERTS<span className="zh">需要处理</span>
              <span className="r">{alerts.length} OPEN</span>
            </div>
            <div className="alerts">
              {alerts.slice(0, 6).map((a) => (
                <button type="button" className="al" key={a.key} onClick={() => onNavigate(a.go)}>
                  <time>{a.time}</time>
                  <span className={'lv ' + a.level[0]}>{a.level[1]}</span>
                  <p>
                    <b>{a.title}</b> {a.text}
                  </p>
                </button>
              ))}
              {!alerts.length && <p className="dimnote zh">没有需要处理的事项。</p>}
            </div>
          </div>
        </div>

        <div className="p c5">
          <div className="h">
            MODELS<span className="zh">模型表现</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>ALIAS</th>
                <th className="n">REQ</th>
                <th className="n">TTFT</th>
                <th className="n">TOK/S</th>
                <th className="n">ERR</th>
              </tr>
            </thead>
            <tbody>
              {(metrics?.models || []).slice(0, 8).map((m) => {
                const top = Math.max(1, ...(metrics?.models || []).map((x) => x.requests));
                return (
                  <tr key={m.model_id + m.alias}>
                    <td style={{ color: m.alias ? 'var(--tx)' : 'var(--dim)' }}>{m.alias || '未路由（前置拒绝）'}</td>
                    <td className="n">
                      <span className="b" style={{ width: (m.requests / top) * 40 }} />
                      {m.requests}
                    </td>
                    <td className="n">{secs(m.ttft.p50)}</td>
                    <td className="n">{m.speed.p50 == null ? '—' : m.speed.p50.toFixed(0)}</td>
                    <td className="n" style={{ color: m.failed > 5 ? 'var(--red)' : 'var(--tx-2)' }}>
                      {m.failed}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="p c4">
          <div className="h">
            LATENCY<span className="zh">TTFT 分布 · 最近 {ttfts.length} 次成功</span>
          </div>
          <TtftHistogram values={ttfts} />
        </div>
        <div className="p c3">
          <div className="h">
            BUDGET<span className="zh">项目预算 · 本月</span>
          </div>
          <div className="bud">
            {projects.map((p) => {
              const used = spend?.byProject[p.id] || 0;
              const ratio = p.monthly_budget ? used / p.monthly_budget : 0;
              return (
                <div key={p.id}>
                  <div className="row">
                    <span className="zh">{p.name}</span>
                    <span>
                      {yuan(used)}/{p.monthly_budget ? '¥' + p.monthly_budget : '∞'}
                    </span>
                  </div>
                  <Segments ratio={p.monthly_budget ? ratio : used > 0 ? 0.05 : 0} tone={ratio >= 0.8 ? 'am' : 'on'} />
                </div>
              );
            })}
          </div>
        </div>
      </section>
      <div className="foot-line">
        <span>
          CONTROL ROOM · {win === 'all' ? 'ALL' : win.toUpperCase()} · <span className="zh">每 10 秒刷新</span>
        </span>
        <button type="button" className="kb" aria-expanded={detailOpen} onClick={onToggleDetail}>
          <span className="zh">监控明细</span> {detailOpen ? '▴' : '▾'}
        </button>
      </div>
      {tip && (
        <div className="tip" style={{ opacity: 1, left: Math.min(tip.x + 12, innerWidth - 320), top: tip.y - 30 }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}
