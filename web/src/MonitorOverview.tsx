import { useEffect, useState, type ReactNode } from 'react';
import { Activity, ArrowRight, Clock3, Gauge, RefreshCw, ShieldCheck, Timer, Coins, Plug, FlaskConical } from 'lucide-react';
import { type Metrics, type MetricOption, number, percent, duration, dateTime, errorName, recordStatus, firstTiming } from './monitoring';

type Props = {
  projects: MetricOption[]; connections: MetricOption[]; models: { id: string; alias: string }[];
  onSelect: (id: string) => void; onNewConnection: () => void; onDemo: () => void;
};
function MetricCard({ label, icon, children, foot, className = '' }: { label: string; icon: ReactNode; children: ReactNode; foot: ReactNode; className?: string }) {
  return <section className={'metric-card ' + className}><div className="metric-label">{label}{icon}</div><div className="metric-value">{children}</div><div className="metric-foot">{foot}</div></section>;
}
function mergeOptions(current: MetricOption[], history: MetricOption[]) {
  return [...new Map([...history, ...current].map(v => [v.id, v])).values()];
}
export function MonitorOverview(props: Props) {
  const [window, setWindow] = useState('24h'), [project, setProject] = useState(''), [connection, setConnection] = useState(''), [model, setModel] = useState(''), [stream, setStream] = useState('');
  const [data, setData] = useState<Metrics | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false, inProgress = false;
    const controller = new AbortController();
    setData(null); setLoading(true); setError('');
    async function load() {
      if (inProgress) return;
      inProgress = true;
      try {
        const params = new URLSearchParams({ window, project_id: project, connection_id: connection, model_id: model, stream });
        const response = await fetch('/api/admin/metrics?' + params, { credentials: 'same-origin', signal: controller.signal });
        const value = await response.json();
        if (!response.ok || !value.summary) throw new Error(value.error?.message || '监控数据暂时不可用');
        if (!disposed) { setData(value); setError(''); }
      } catch (e) { if (!disposed) setError((e as Error).message); }
      finally { inProgress = false; if (!disposed) setLoading(false); }
    }
    load(); const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5000);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [window, project, connection, model, stream, refresh]);
  const filtersActive = !!(project || connection || model || stream);
  const s = data?.summary;
  const modelRows = [...(data?.models || [])].sort((a, b) => Number(!a.model_id) - Number(!b.model_id));
  const max = Math.max(1, ...(data?.buckets.map(b => b.requests) || []));
  const select = (label: string, value: string, change: (v: string) => void, options: MetricOption[]) => <label><span>{label}</span><select aria-label={'监控' + label} value={value} onChange={e => change(e.target.value)}><option value="">所有{label}</option>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>;
  return <div className="monitor-overview">
    <div className="monitor-toolbar">
      <div className="monitor-range" aria-label="监控时间范围">{[['1h', '近 1 小时'], ['24h', '近 24 小时'], ['7d', '近 7 天'], ['all', '全部']].map(([v, label]) => <button key={v} aria-pressed={window === v} title={v === 'all' ? '从监控开始采集至今' : undefined} onClick={() => setWindow(v)}>{label}</button>)}</div>
      <span className="monitor-refresh"><span className={'dot ' + (error ? 'offline' : '')}/>{error ? '刷新失败' : loading ? '正在更新' : `更新于 ${new Date(data?.to || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}`}</span>
      <button className="icon-btn" aria-label="刷新监控" onClick={() => setRefresh(v => v + 1)} disabled={loading}><RefreshCw size={16}/></button>
    </div>
    <div className="monitor-filters">
      {select('项目', project, setProject, mergeOptions(props.projects, data?.options.projects || []))}
      {select('连接', connection, setConnection, mergeOptions(props.connections, data?.options.connections || []))}
      {select('模型', model, setModel, mergeOptions(props.models.map(m => ({ id: m.id, name: m.alias })), data?.options.models || []))}
      <label><span>调用方式</span><select aria-label="监控调用方式" value={stream} onChange={e => setStream(e.target.value)}><option value="">全部方式</option><option value="true">仅流式</option><option value="false">仅非流式</option></select></label>
      {filtersActive && <button className="link" onClick={() => { setProject(''); setConnection(''); setModel(''); setStream(''); }}>清除筛选</button>}
    </div>
    {error && <div className="error" role="alert">{error}。{data ? '当前显示上次成功更新的数据。' : '请稍后刷新。'}</div>}
    {data && data.metrics_errors > 0 && <div className="error" role="alert">有 {number(data.metrics_errors)} 次监控写入失败，统计可能不完整，请检查数据库与磁盘。</div>}
    {s ? <>
      <div className="monitor-cards">
        <MetricCard label="请求结果" icon={<ShieldCheck size={17}/>} className="metric-health" foot={<><span>成功 <b>{number(s.completed)}</b></span><span className={s.failed ? 'danger' : ''}>失败 <b>{number(s.failed)}</b></span><span>取消 <b>{number(s.canceled)}</b></span></>}>
          <strong>{percent(s.success_rate)}</strong><span>成功率</span>
        </MetricCard>
        <MetricCard label="首次响应 · P50" icon={<Timer size={17}/>} foot={<><span>TTFT P95 <b>{duration(s.ttft.p95)}</b></span><span>TTFC P95 <b>{duration(s.ttfc.p95)}</b></span></>}>
          <div className="metric-pair"><div><strong>{duration(s.ttft.p50)}</strong><span>TTFT · 首个 Token</span></div><div><strong>{duration(s.ttfc.p50)}</strong><span>TTFC · 正文首字</span></div></div>
        </MetricCard>
        <MetricCard label="Token 用量" icon={<Coins size={17}/>} foot={<><span>缓存命中 <b>{percent(s.cache_ratio)}</b></span><span>用量完整 <b>{s.usage_eligible ? percent(100 * s.usage_complete / s.usage_eligible) : '—'}</b></span></>}>
          <div className="metric-pair"><div><strong>{number(s.input_samples ? s.input_tokens : null)}</strong><span>输入总量</span></div><div><strong>{number(s.output_samples ? s.output_tokens : null)}</strong><span>输出总量</span></div></div>
        </MetricCard>
        <MetricCard label="请求总耗时" icon={<Clock3 size={17}/>} foot={<><span>P95 <b>{duration(s.duration.p95)}</b></span><span>{number(s.duration.count)} 个成功样本</span></>}>
          <strong>{duration(s.duration.p50)}</strong><span>P50 · 中位数</span>
        </MetricCard>
        <MetricCard label="请求量与并发" icon={<Activity size={17}/>} foot={<><span>平均 <b>{number(s.rpm, 2)} RPM</b></span><span>当前进行中 <b className="live-count">{number(s.active)}</b></span></>}>
          <strong>{number(s.requests)}</strong><span>次调用</span>
        </MetricCard>
        <MetricCard label="估算输出速度" icon={<Gauge size={17}/>} foot={<><span>P50 · 输出阶段</span><span>{number(s.speed.count)} 个有效样本</span></>}>
          <strong>{number(s.speed.p50, 1)}</strong><span>Token/s</span>
        </MetricCard>
      </div>
      <div className="monitor-chart-grid">
        <section className="panel monitor-trend"><div className="panel-head"><h2>调用趋势</h2><span className="muted small">24 个时段 · {number(s.requests)} 次</span></div>
          <div className="trend-body"><div className="trend-legend"><span><i/>调用数</span><span><i className="failed"/>其中失败</span><small>峰值 {number(Math.max(0, ...data!.buckets.map(b => b.rpm)), 2)} RPM</small></div>
            <div className="trend-plot" role="img" aria-label={`调用趋势：${s.requests} 次请求，${s.failed} 次失败`}>
              <div className="trend-grid"><span>{number(max)}</span><span>{number(Math.round(max / 2))}</span><span>0</span></div>
              <div className="trend-bars">{data!.buckets.map((b, i) => <div key={i} tabIndex={0} className="trend-column" title={`${dateTime(b.started)} · ${b.requests} 次调用 · ${b.failed} 次失败 · ${number(b.rpm, 2)} RPM`} aria-label={`${dateTime(b.started)}，${b.requests} 次调用，${b.failed} 次失败`}><div className="trend-bar" style={{ height: `${100 * b.requests / max}%` }}><span style={{ height: `${b.requests ? 100 * b.failed / b.requests : 0}%` }}/></div></div>)}</div>
            </div><div className="trend-axis"><span>{dateTime(data!.from)}</span><span>{dateTime(data!.to)}</span></div>
            {!s.requests && <p className="monitor-empty-note">这段时间还没有调用，新的请求会自动出现在这里。</p>}
          </div>
        </section>
        <section className="panel monitor-errors"><div className="panel-head"><h2>异常分布</h2><span className="muted small">{number(s.failed)} 次失败</span></div>
          <div className="error-distribution">{Object.entries(s.errors).sort((a, b) => b[1] - a[1]).map(([kind, count]) => <div key={kind}><span>{errorName(kind)}</span><b>{number(count)}</b><div className="error-track"><i style={{ width: `${100 * count / Math.max(1, s.failed)}%` }}/></div></div>)}
            {!s.failed && <div className="monitor-no-errors"><ShieldCheck size={26}/><b>{s.completed ? '这段时间没有失败请求' : '暂无异常样本'}</b><span>{s.completed ? `${number(s.completed)} 次调用已完成` : '开始调用后可查看结果分布'}</span></div>}
          </div><p className="monitor-panel-note">客户端取消／断开单列，不计入成功率分母。</p>
        </section>
      </div>
      <section className="panel monitor-models"><div className="panel-head"><h2>模型表现</h2><span className="muted small">点击模型可筛选</span></div><div className="table-scroll"><table><thead><tr><th>模型 / 连接</th><th>请求数</th><th>成功率</th><th>TTFT · P95</th><th>TTFC · P95</th><th>输入 / 输出 Token</th><th>缓存命中</th><th>速度 · P50</th></tr></thead><tbody>{modelRows.map(m => <tr key={m.model_id + m.connection_id}><td>{m.model_id ? <button className="table-link" onClick={() => { setModel(m.model_id); setConnection(m.connection_id); }}>{m.alias}</button> : <span>未路由请求</span>}<small>{m.connection_name || '网关前置检查'}</small></td><td>{number(m.requests)}</td><td>{percent(m.success_rate)}</td><td>{duration(m.ttft.p95)}</td><td>{duration(m.ttfc.p95)}</td><td>{number(m.input_samples ? m.input_tokens : null)} / {number(m.output_samples ? m.output_tokens : null)}</td><td>{percent(m.cache_ratio)}</td><td>{number(m.speed.p50, 1)}<small>Token/s</small></td></tr>)}</tbody></table></div>{!data!.models.length && <p className="monitor-empty-note">当前筛选下没有请求。</p>}</section>
      <section className="panel monitor-recent"><div className="panel-head"><h2>近期调用</h2><span className="muted small">当前筛选 · 最近 8 条</span></div><div className="table-scroll"><table><thead><tr><th>项目 / 时间</th><th>模型</th><th>结果</th><th>TTFT</th><th>TTFC</th><th>总耗时</th><th/></tr></thead><tbody>{data!.recent.map(r => <tr key={r.id}><td>{r.project_name}<small>{dateTime(r.started)}</small></td><td><code>{r.alias || '—'}</code><small>{r.stream == null ? '—' : r.stream ? '流式' : '非流式'}</small></td><td><span className={'result-label result-' + r.state}>{recordStatus(r)}</span>{r.error_type && <small>{errorName(r.error_type)}</small>}</td><td>{firstTiming(r)}</td><td>{firstTiming(r, true)}</td><td>{r.state === 'running' || r.state === 'interrupted' ? '—' : duration(r.duration_ms)}</td><td><button className="icon-btn" aria-label={`查看请求 ${r.id}`} onClick={() => props.onSelect(r.id)}><ArrowRight size={16}/></button></td></tr>)}</tbody></table></div>{!data!.recent.length && <p className="monitor-empty-note">暂无调用记录。</p>}</section>
      <details className="monitor-definitions"><summary>统计口径与采集范围</summary><p>首次响应和输出速度仅统计有效的流式成功请求，总耗时统计成功请求。P50 是中位数，P95 覆盖约 95% 的样本；不同长度的回答可结合 Token 用量比较。TTFC 专指正文，不包含思考和工具调用。</p><p>用量为已上报数量，部分请求可能只报告了部分用量。缓存命中占比按已报告缓存信息的输入 Token 加权，未知不当作零。缓存写入 {number(s.cache_write_samples ? s.cache_write_tokens : null)} Token；缓存读取 {number(s.cache_samples ? s.cache_read_tokens : null)} Token。</p><p>从 {dateTime(data!.monitoring_since)} 开始采集；旧记录保留在请求记录中，不补入新统计。当前范围为 {dateTime(data!.from)} 至 {dateTime(data!.to)}，每 5 秒刷新。包含模型调用及管理员测试，排除管理操作和模型列表查询。RPM 按实际已监控时长计算。</p></details>
    </> : !error && <div className="monitor-loading" role="status">正在读取监控数据…</div>}
    {!props.connections.length && <section className="panel monitor-onboarding"><Plug size={26}/><div><h2>接入模型，开始监控</h2><p>添加厂商连接并授权项目，调用会自动进入统计。</p><div className="actions"><button className="primary" onClick={props.onNewConnection}>添加连接</button><button onClick={props.onDemo}><FlaskConical size={15}/>载入本地演示</button></div></div></section>}
  </div>;
}
