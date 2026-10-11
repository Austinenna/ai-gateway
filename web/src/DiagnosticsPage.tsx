import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, RefreshCw, ServerCrash, ShieldCheck } from 'lucide-react';
import { type DiagnosticGroup, type Diagnostics, diagnosticActionName, diagnosticPhaseName, diagnosticSourceName, errorName, dateTime, number } from './monitoring';

type Props = { onSelect: (id: string) => void };
const ranges = [['1h', '近 1 小时'], ['24h', '近 24 小时'], ['7d', '近 7 天'], ['all', '全部']];

function optionList(data: Diagnostics | null, key: 'codes' | 'providers' | 'protocols' | 'models' | 'projects') {
  return data?.options?.[key] || [];
}

function GroupRow({ group, selected, onSelect }: { group: DiagnosticGroup; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={'diagnostic-group' + (selected ? ' selected' : '')} onClick={onSelect}>
    <span className="diagnostic-group-main"><b>{errorName(group.code)}</b><small>{group.message}</small></span>
    <span className="diagnostic-group-count"><strong>{number(group.count)}</strong><small>{dateTime(group.last_started)}</small></span>
  </button>;
}

function GroupDetail({ group, onSelect }: { group: DiagnosticGroup; onSelect: (id: string) => void }) {
  return <div className="diagnostic-detail">
    <div className="diagnostic-detail-title"><div><span className="eyebrow">错误组</span><h2>{group.message}</h2><p>{errorName(group.code)} · {group.count} 次</p></div><span className={'diagnostic-severity ' + (group.retryable ? 'retryable' : 'fixed')}>{group.retryable ? '可重试' : '需处理'}</span></div>
    <div className="diagnostic-facts">
      <div><span>错误阶段</span><b>{diagnosticPhaseName(group.phase)}</b></div>
      <div><span>来源</span><b>{diagnosticSourceName(group.source)}</b></div>
      <div><span>HTTP 状态</span><b>{group.status || '—'}</b></div>
      <div><span>上游状态</span><b>{group.upstream_status || '未返回'}</b></div>
      <div><span>首次出现</span><b>{dateTime(group.first_started)}</b></div>
      <div><span>最近出现</span><b>{dateTime(group.last_started)}</b></div>
    </div>
    <p className="diagnostic-explanation">{group.upstream_contacted ? '网关已经尝试联系上游，错误发生在上游请求或响应阶段。' : '请求没有到达上游，错误发生在网关自己的校验、解锁或转发前流程。'}</p>
    <div className="diagnostic-context"><div><span>涉及模型</span><b>{group.models.length ? group.models.join('、') : '未路由'}</b></div><div><span>涉及厂商</span><b>{group.providers.length ? group.providers.join('、') : '—'}</b></div><div><span>调用协议</span><b>{group.protocols.length ? group.protocols.join('、') : '—'}</b></div><div><span>涉及项目</span><b>{group.projects.length ? group.projects.join('、') : '未识别项目'}</b></div></div>
    <div className="diagnostic-action"><strong>建议操作</strong><span>{group.retryable ? '可以先重试；若持续出现，再检查相关连接或客户端。' : '先按错误阶段检查配置、权限或请求格式。'}</span><small>{diagnosticActionName(group.recommended_action)}</small></div>
    <button type="button" className="link diagnostic-example" onClick={() => onSelect(group.example_id)}>查看代表请求 <ArrowRight size={14}/></button>
  </div>;
}

export function DiagnosticsPage({ onSelect }: Props) {
  const [window, setWindow] = useState('24h');
  const [code, setCode] = useState('');
  const [provider, setProvider] = useState('');
  const [protocol, setProtocol] = useState('');
  const [data, setData] = useState<Diagnostics | null>(null);
  const [selectedKey, setSelectedKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      const params = new URLSearchParams({ window });
      if (code) params.set('code', code);
      if (provider) params.set('provider', provider);
      if (protocol) params.set('protocol', protocol);
      try {
        const response = await fetch('/api/admin/diagnostics?' + params, { credentials: 'same-origin', signal: controller.signal });
        const value = await response.json();
        if (!response.ok || !value.summary) throw new Error(value.error?.message || '诊断数据暂时不可用');
        if (!disposed) { setData(value); setError(''); }
      } catch (e) {
        if (!disposed && (e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5000);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [window, code, provider, protocol, refresh]);

  const groups = data?.groups || [];
  const selected = groups.find(group => `${group.code}|${group.status}|${group.upstream_status}|${group.phase}` === selectedKey) || groups[0];
  const selectGroup = (group: DiagnosticGroup) => setSelectedKey(`${group.code}|${group.status}|${group.upstream_status}|${group.phase}`);
  const clear = () => { setCode(''); setProvider(''); setProtocol(''); };
  const runtime = data?.runtime;

  return <div className="diagnostics-page">
    <div className="diagnostics-toolbar">
      <div className="monitor-range" aria-label="诊断时间范围">{ranges.map(([value, label]) => <button key={value} aria-pressed={window === value} onClick={() => setWindow(value)}>{label}</button>)}</div>
      <span className="monitor-refresh"><span className={'dot ' + (error ? 'offline' : '')}/>{error ? '刷新失败' : loading ? '正在更新' : `更新于 ${new Date(data?.to || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}`}</span>
      <button className="icon-btn" aria-label="刷新异常诊断" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={16}/></button>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {data && <>
      <div className="diagnostics-runtime">
        <section className={'diagnostic-runtime-card ' + (runtime?.locked ? 'locked' : 'ready')}><div><span>网关调用状态</span>{runtime?.locked ? <ServerCrash size={18}/> : <CheckCircle2 size={18}/>}</div><strong>{runtime?.locked ? '已锁定' : '已解锁'}</strong><small>{runtime?.locked ? '项目请求会在转发前返回 503' : '项目调用可以进入正常转发流程'}</small></section>
        <section className="diagnostic-runtime-card"><div><span>异常请求</span><AlertTriangle size={18}/></div><strong>{number(data.summary.failed)}</strong><small>{number(data.summary.groups)} 个重复错误组 · {number(data.summary.requests)} 次请求</small></section>
        <section className="diagnostic-runtime-card"><div><span>最近一次异常</span><Clock3 size={18}/></div><strong>{data.summary.latest_failure ? dateTime(data.summary.latest_failure) : '—'}</strong><small>{data.summary.active ? `${number(data.summary.active)} 个请求仍在进行` : '当前没有进行中的请求'}</small></section>
      </div>
      <div className="diagnostic-filters">
        <label><span>错误类型</span><select aria-label="诊断错误类型" value={code} onChange={e => setCode(e.target.value)}><option value="">全部错误</option>{optionList(data, 'codes').map(option => <option key={option.id} value={option.id}>{errorName(option.id)}</option>)}</select></label>
        <label><span>厂商</span><select aria-label="诊断厂商" value={provider} onChange={e => setProvider(e.target.value)}><option value="">全部厂商</option>{optionList(data, 'providers').map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
        <label><span>协议</span><select aria-label="诊断协议" value={protocol} onChange={e => setProtocol(e.target.value)}><option value="">全部协议</option>{optionList(data, 'protocols').map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
        {(code || provider || protocol) && <button className="link" onClick={clear}>清除筛选</button>}
      </div>
      <div className="diagnostic-workbench">
        <section className="panel diagnostic-groups"><div className="panel-head"><h2><AlertTriangle size={16}/>重复错误</h2><span className="muted small">按错误特征聚合</span></div><div className="diagnostic-group-list">{groups.length ? groups.map(group => <GroupRow key={`${group.code}|${group.status}|${group.upstream_status}|${group.phase}`} group={group} selected={selected === group || (!!selected && selectedKey === `${group.code}|${group.status}|${group.upstream_status}|${group.phase}`)} onSelect={() => selectGroup(group)}/>) : <div className="diagnostic-empty"><ShieldCheck size={24}/><b>这段时间没有异常请求</b><span>新的失败会自动出现在这里。</span></div>}</div></section>
        <section className="panel diagnostic-detail-panel">{selected ? <GroupDetail group={selected} onSelect={onSelect}/> : <div className="diagnostic-empty"><ShieldCheck size={24}/><b>选择一个错误组</b><span>查看发生阶段、影响范围和代表请求。</span></div>}</section>
      </div>
      <section className="panel diagnostic-recent"><div className="panel-head"><h2>最近异常请求</h2><span className="muted small">最近 {number(data.recent.length)} 条</span></div><div className="table-scroll"><table><thead><tr><th>时间</th><th>错误</th><th>项目 / 模型</th><th>状态</th><th/></tr></thead><tbody>{data.recent.map(record => <tr key={record.id}><td>{dateTime(record.started)}</td><td><b>{record.diagnostic ? errorName(record.diagnostic.code) : errorName(record.error_type)}</b><small>{record.diagnostic?.message || '未保存错误详情'}</small></td><td>{record.project_name}<small><code>{record.alias || '未路由'}</code></small></td><td>{record.status || '—'}<small>{record.diagnostic ? diagnosticPhaseName(record.diagnostic.phase) : '—'}</small></td><td><button className="icon-btn" aria-label={`查看异常请求 ${record.id}`} onClick={() => onSelect(record.id)}><ArrowRight size={16}/></button></td></tr>)}</tbody></table></div>{!data.recent.length && <p className="monitor-empty-note">暂无异常请求。</p>}</section>
      {(data.metrics_errors > 0 || data.dropped_records > 0) && <div className="error" role="alert">记录写入异常：监控失败 {number(data.metrics_errors)} 次，丢失记录 {number(data.dropped_records)} 条。诊断数据可能不完整。</div>}
    </>}
    {!data && !error && <div className="monitor-loading" role="status">正在读取异常诊断…</div>}
  </div>;
}
