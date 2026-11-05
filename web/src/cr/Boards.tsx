import { useEffect, useState } from 'react';
import { diagnosticActionName, errorName } from '../monitoring';
import { bucketClass, type ConnectionHealth } from '../health';
import { Segments, useWidth } from './charts';

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type Group = { code: string; source: string; count: number; recommended_action?: string; last_started: number };
type Conn = { id: string; name: string; enabled: boolean };
const sourceName: Record<string, string> = { upstream: 'UPSTREAM', gateway: 'GATEWAY', client: 'CLIENT' };

function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let disposed = false;
    const run = () =>
      load()
        .then((v) => {
          if (!disposed) setValue(v);
        })
        .catch(() => {});
    run();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, ms);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, deps);
  return value;
}

/** DiagnosticsBoard: categories, circuit breakers and 24-hour connection health. */
export function DiagnosticsBoard({
  api,
  connections,
  health,
}: {
  api: Api;
  connections: Conn[];
  health: Record<string, ConnectionHealth>;
}) {
  const data = usePoll(async () => {
    const from = Date.now() - 86400e3;
    const [d, fb] = await Promise.all([api('/admin/diagnostics?window=24h'), api(`/admin/requests?state=fallback&limit=200&from=${from}`)]);
    return {
      groups: (d.groups || []) as Group[],
      fallback: (fb.items || []) as { state: string }[],
      fallbackTotal: (fb.total as number) ?? 0,
    };
  }, 10000);
  const byCode = new Map<string, Group>();
  for (const g of data?.groups || []) {
    const cur = byCode.get(g.code);
    byCode.set(g.code, cur ? { ...cur, count: cur.count + g.count, last_started: Math.max(cur.last_started, g.last_started) } : { ...g });
  }
  const cats = [...byCode.values()].sort((a, b) => b.count - a.count);
  const top = Math.max(1, ...cats.map((c) => c.count));
  const breakers = connections.filter((c) => (health[c.id]?.breaker_until || 0) > Date.now());
  return (
    <section className="board cr-v diag-board">
      <div className="p c7">
        <div className="h">
          CATEGORIES<span className="zh">按来源分类 · 近 24 小时</span>
        </div>
        <table className="dg">
          <thead>
            <tr>
              <th>CATEGORY</th>
              <th>SOURCE</th>
              <th className="n">24H</th>
              <th>TREND</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.code}>
                <td>
                  <span className="zh">{errorName(c.code)}</span> <small>{c.code}</small>
                </td>
                <td>{c.code.startsWith('project_') ? 'PROJECT' : sourceName[c.source] || c.source}</td>
                <td className="n" style={{ color: c.source === 'upstream' ? 'var(--red)' : 'var(--amber)' }}>
                  {c.count}
                </td>
                <td>
                  <span className="bar2">
                    <i
                      style={{ width: (c.count / top) * 100 + '%', background: c.source === 'upstream' ? 'var(--red)' : 'var(--amber)' }}
                    />
                  </span>
                </td>
                <td className="zh">{diagnosticActionName(c.recommended_action)}</td>
              </tr>
            ))}
            {!cats.length && (
              <tr>
                <td colSpan={5} className="zh dim2">
                  近 24 小时没有异常。
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="dimnote zh">项目限速、并发和预算由网关自己拒绝，不计入厂商健康；上游错误计入对应连接。</div>
      </div>
      <div className="p c5">
        <div className="h">
          CIRCUIT<span className="zh">熔断与回退</span>
        </div>
        {breakers.length ? (
          breakers.map((c) => (
            <div className="cb2" key={c.id}>
              <div className="row">
                <span className="zh">{c.name}</span>
                <span className="pill am">BREAKER OPEN</span>
              </div>
              <div className="big2">{Math.ceil(((health[c.id].breaker_until || 0) - Date.now()) / 1000)}s</div>
              <div className="zh dimnote">{health[c.id].reason}。到期前，配置了备用模型的请求直接改走备用。</div>
            </div>
          ))
        ) : (
          <div className="cb2 calm">
            <div className="row">
              <span className="zh">当前没有熔断</span>
              <span className="pill ok">CLOSED</span>
            </div>
            <div className="zh dimnote">上游 429 或连续故障后自动熔断，时长在「数据与系统」设置。</div>
          </div>
        )}
        <div className="kvs">
          <span>fallback 24h</span>
          <b>
            {data?.fallbackTotal ?? '—'} 次 · 救回 {(data?.fallback || []).filter((r) => r.state === 'complete').length}
          </b>
          <span>mid-stream</span>
          <b className="zh">流式开始后不回退</b>
        </div>
      </div>
      <div className="p c12">
        <div className="h">
          HEALTH HISTORY<span className="zh">连接健康 · 24H · 每格 30 分钟</span>
          <span className="r">
            <span style={{ color: 'var(--go)' }}>■ 正常</span> <span style={{ color: 'var(--amber)' }}>■ 降级</span>{' '}
            <span style={{ color: 'var(--red)' }}>■ 故障</span> <span style={{ color: '#c77dff' }}>■ KEY 失效</span>{' '}
            <span style={{ color: 'var(--dim)' }}>■ 无数据</span>
          </span>
        </div>
        <div className="hh">
          {connections.map((c) => {
            const h = health[c.id];
            return (
              <div className="r2" key={c.id}>
                <span className="zh">{c.name}</span>
                <div className="bl">
                  {(h?.buckets || Array.from({ length: 48 }, () => null)).map((b, i) => (
                    <i key={i} className={b ? { ok: '', degraded: 'a', down: 'r', auth: 'k', idle: 'u' }[bucketClass(b)] : 'u'} />
                  ))}
                </div>
                <em className="zh">{h ? (h.probe_supported ? '被动 + 探测' : '仅被动') : '—'}</em>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

type Proj = { id: string; name: string; monthly_budget?: number | null };
// Small amounts keep four decimals so a few cheap calls do not read as ¥0.00.
const yuan = (v: number) => '¥' + (v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(4));

/** CostBoard: month, today, forecast and cache, the daily chart and project budgets. */
type UsageGroup = {
  key: string;
  label: string;
  cost: number;
  requests: number;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  audio_seconds: number;
};
const stackColors = ['var(--red)', 'var(--cyan)', 'var(--go)', 'var(--amber)', '#c77dff', 'var(--tx-2)'];
const compact = (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(v));

export function CostBoard({ api, projects, connectionOf }: { api: Api; projects: Proj[]; connectionOf: (modelID: string) => string }) {
  const data = usePoll(async () => {
    const [month, today, days, byProject, byModel] = await Promise.all([
      api('/admin/usage?period=month'),
      api('/admin/usage?period=today'),
      api('/admin/usage?period=month&group_by=day'),
      api('/admin/usage?period=month&group_by=project'),
      api('/admin/usage?period=month&group_by=model'),
    ]);
    const projectGroups = ((byProject.groups || []) as UsageGroup[]).filter((g) => g.cost > 0).slice(0, stackColors.length - 1);
    // Per-project daily series feed the stacked bars; the remainder is grouped as "其他".
    const perProject = await Promise.all(
      projectGroups.map(async (g) => {
        const r = await api('/admin/usage?period=month&group_by=day&project_id=' + encodeURIComponent(g.key));
        return { key: g.key, label: g.label, days: Object.fromEntries(((r.groups || []) as UsageGroup[]).map((d) => [d.key, d.cost])) };
      }),
    );
    return {
      month: month.total as { cost: number; input_tokens: number; cache_read_tokens: number },
      today: today.total as { cost: number },
      days: (days.groups || []) as UsageGroup[],
      byProject: Object.fromEntries(((byProject.groups || []) as UsageGroup[]).map((g) => [g.key, g.cost])),
      byModel: (byModel.groups || []) as UsageGroup[],
      series: perProject,
    };
  }, 15000);
  const [ref, W] = useWidth<SVGSVGElement>();
  const now = new Date();
  const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsed = Math.max(1, now.getDate() - 1 + now.getHours() / 24);
  const spent = data?.month.cost || 0;
  const eom = (spent / elapsed) * monthDays;
  const budget = projects.reduce((a, p) => a + (p.monthly_budget || 0), 0);
  // Cost input_tokens are the uncached, input-priced tokens; cache reads are counted separately.
  const cacheBase = data ? data.month.input_tokens + data.month.cache_read_tokens : 0;
  const cache = data && cacheBase ? data.month.cache_read_tokens / cacheBase : null;
  const daily = Array.from({ length: monthDays }, (_, i) => {
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
    return { key, day: i + 1, cost: data?.days.find((d) => d.key === key)?.cost ?? null };
  });
  const avg7 = (() => {
    const done = daily.filter((d) => d.day < now.getDate() && d.cost != null).slice(-7);
    return done.length ? done.reduce((a, d) => a + (d.cost || 0), 0) / done.length : 0;
  })();
  const H = 220,
    pl = 40,
    pb = 22,
    pt = 12;
  const maxCost = Math.max(budget ? budget / monthDays : 0, avg7, ...daily.map((d) => d.cost || 0), 0.01) * 1.2;
  const bw = W > 0 ? (W - pl) / monthDays : 0;
  const y = (v: number) => H - pb - (v / maxCost) * (H - pb - pt);
  return (
    <section className="board cr-v cost-board">
      <div className="p c3">
        <div className="h">MONTH</div>
        <div className="kv amber">{data ? yuan(spent) : '—'}</div>
        <div className="sub">
          <span>{budget ? '/ ¥' + budget + ' 总预算' : '未设预算'}</span>
        </div>
        <Segments ratio={budget ? spent / budget : 0} tone="am" />
      </div>
      <div className="p c3">
        <div className="h">TODAY</div>
        <div className="kv">{data ? yuan(data.today.cost) : '—'}</div>
        <div className="sub">
          <span>近 7 天日均 {yuan(avg7)}</span>
        </div>
      </div>
      <div className="p c3">
        <div className="h">
          FORECAST<span className="r">EOM</span>
        </div>
        <div className="kv" style={{ color: budget && eom > budget ? 'var(--red)' : 'var(--tx)' }}>
          {data ? yuan(eom) : '—'}
        </div>
        <div className="sub">
          <span>{budget ? (eom > budget ? '超预算 ' + yuan(eom - budget) : '在预算内') : '按本月日均推算'}</span>
        </div>
      </div>
      <div className="p c3">
        <div className="h">CACHE HIT</div>
        <div className="kv go">
          {cache == null ? '—' : Math.round(cache * 100)}
          <small>%</small>
        </div>
        <div className="sub">
          <span>缓存读取占输入 Token</span>
        </div>
        <Segments ratio={cache || 0} />
      </div>
      <div className="p c8">
        <div className="h">
          DAILY<span className="zh">每日费用 · 按项目堆叠</span>
          <span className="r legend zh">
            {(data?.series || []).map((sr, k) => (
              <span key={sr.key}>
                <i style={{ background: stackColors[k] }} />
                {sr.label}
              </span>
            ))}
            {budget > 0 && <span style={{ color: 'var(--amber)' }}>--- 预算日均 {yuan(budget / monthDays)}</span>}
          </span>
        </div>
        <svg ref={ref} id="cost" viewBox={`0 0 ${W || 1} ${H}`} role="img" aria-label="本月每日费用">
          {W > 0 &&
            [0, 0.5, 1].map((r) => (
              <g key={r}>
                <line x1={pl} x2={W} y1={y(maxCost * r)} y2={y(maxCost * r)} stroke="var(--line)" />
                <text x={pl - 6} y={y(maxCost * r) + 3} textAnchor="end" fontSize={9.5} fill="var(--dim)">
                  {yuan(maxCost * r)}
                </text>
              </g>
            ))}
          {W > 0 && budget > 0 && (
            <line x1={pl} x2={W} y1={y(budget / monthDays)} y2={y(budget / monthDays)} stroke="var(--amber)" strokeDasharray="4 3" />
          )}
          {W > 0 &&
            daily.map((d, i) => {
              const x = pl + i * bw + 2,
                w = Math.max(1, bw - 4);
              const future = d.day > now.getDate();
              return (
                <g key={d.key}>
                  {future
                    ? avg7 > 0 && (
                        <rect
                          x={x}
                          y={y(avg7)}
                          width={w}
                          height={H - pb - y(avg7)}
                          fill="none"
                          stroke="var(--line-2)"
                          strokeDasharray="2 2"
                        />
                      )
                    : (() => {
                        let base = 0;
                        const parts = (data?.series || []).map((sr, k) => ({ v: sr.days[d.key] || 0, c: stackColors[k], n: sr.label }));
                        const rest = Math.max(0, (d.cost || 0) - parts.reduce((a, p) => a + p.v, 0));
                        if (rest > 1e-9) parts.push({ v: rest, c: stackColors[stackColors.length - 1], n: '其他' });
                        return parts.map((p, k) => {
                          if (!p.v) return null;
                          const top = y(base + p.v),
                            bottom = y(base);
                          base += p.v;
                          return (
                            <rect key={k} x={x} y={top} width={w} height={Math.max(1, bottom - top)} fill={p.c} opacity={0.85}>
                              <title>{`${d.key} · ${p.n} ${yuan(p.v)}`}</title>
                            </rect>
                          );
                        });
                      })()}
                  {i % 5 === 0 && (
                    <text x={x} y={H - 6} fontSize={9.5} fill="var(--dim)">
                      {d.key.slice(5)}
                    </text>
                  )}
                </g>
              );
            })}
        </svg>
        <div className="dimnote zh">虚线框是按近 7 天日均推算的剩余日期。</div>
      </div>
      <div className="p c4">
        <div className="h">
          BY PROJECT<span className="zh">项目 · 本月</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>PROJECT</th>
              <th className="n">SPENT</th>
              <th className="n">BUDGET</th>
              <th className="n">EOM</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const s = data?.byProject[p.id] || 0;
              const e = (s / elapsed) * monthDays;
              return (
                <tr key={p.id}>
                  <td className="zh">{p.name}</td>
                  <td className="n">{s < 1 ? s.toFixed(4) : s.toFixed(1)}</td>
                  <td className="n">{p.monthly_budget ?? '∞'}</td>
                  <td className="n" style={{ color: p.monthly_budget && e > p.monthly_budget ? 'var(--red)' : 'var(--tx-2)' }}>
                    {e.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="dimnote zh">超出月预算后网关拒绝该项目的请求（402），下月 1 日恢复。</div>
      </div>
      <div className="p c12">
        <div className="h">
          BY MODEL<span className="zh">模型 · 本月</span>
        </div>
        <table className="by-model">
          <thead>
            <tr>
              <th>ALIAS</th>
              <th>CONNECTION</th>
              <th className="n">REQ</th>
              <th className="n">IN</th>
              <th className="n">CACHE</th>
              <th className="n">OUT</th>
              <th className="n">¥</th>
              <th className="n">SHARE</th>
            </tr>
          </thead>
          <tbody>
            {(data?.byModel || []).map((m) => {
              const share = spent ? m.cost / spent : 0;
              return (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td className="zh">{connectionOf(m.key) || '—'}</td>
                  <td className="n">{m.requests.toLocaleString()}</td>
                  <td className="n">{m.audio_seconds ? Math.round(m.audio_seconds) + ' s' : compact(m.input_tokens)}</td>
                  <td className="n">{m.cache_read_tokens ? compact(m.cache_read_tokens) : '—'}</td>
                  <td className="n">{m.output_tokens ? compact(m.output_tokens) : '—'}</td>
                  <td className="n" style={{ color: 'var(--amber)' }}>
                    {m.cost < 1 ? m.cost.toFixed(4) : m.cost.toFixed(1)}
                  </td>
                  <td className="n share">
                    <span className="b" style={{ width: Math.max(2, share * 60) }} />
                    {Math.round(share * 100)}%
                  </td>
                </tr>
              );
            })}
            {data && !data.byModel.length && (
              <tr>
                <td colSpan={8} className="zh dim2">
                  本月还没有计费调用。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
