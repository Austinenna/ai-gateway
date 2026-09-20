import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, GitBranch, Layers3, RefreshCw, Search } from 'lucide-react';
import { TaskCallDialog } from './TaskCallDialog';
import { FilterSelect } from './FilterSelect';
import { TextPreview } from './TextPreview';
import { responseText } from './protocol.mjs';
import { dateTime, duration, inputTotal, number, outputTotal, recordStatus, type RequestRecord } from './monitoring';
import { agentName, taskState, type RequestTask, type TaskDetail } from './request-tasks';
import './task-groups.css';

type Props = {
  tasks: RequestTask[]; api: (path: string) => Promise<any>; refresh: () => void;
  renderRecord: (record: RequestRecord, tab: string, setTab: (tab: string) => void, copy: (value: string) => void) => ReactNode;
};
export function TaskWorkspace({ tasks, api, refresh, renderRecord }: Props) {
  const [id, setID] = useState(tasks[0]?.id || ''), [detail, setDetail] = useState<TaskDetail | null>(null);
  const [search, setSearch] = useState(''), [project, setProject] = useState('all'), [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('overview'), [limit, setLimit] = useState(100), [error, setError] = useState('');
  const [callID, setCallID] = useState(''), [callTab, setCallTab] = useState('messages'), [bodies, setBodies] = useState<Record<string, RequestRecord>>({});
  const cache = useRef(new Map<string, RequestRecord>()), pane = useRef<HTMLElement>(null), rail = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!id && tasks.length) setID(tasks[0].id); }, [tasks, id]);
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    async function load() {
      const first: TaskDetail = await api('/admin/request-tasks/' + encodeURIComponent(id));
      if (disposed) return;
      const pages = await Promise.all(Array.from({ length: Math.ceil(Math.min(limit, first.total) / 100) - 1 }, (_, i) => api('/admin/request-tasks/' + encodeURIComponent(id) + '?offset=' + (i + 1) * 100)));
      if (disposed) return;
      const calls = [first, ...pages].flatMap(p => p.calls);
      setDetail({ ...first, calls, has_more: calls.length < first.total }); setError('');
    }
    load().catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [id, limit, tasks, api]);
  useEffect(() => {
    if (detail?.task.id !== id) return;
    let disposed = false;
    const ids = [detail.task.reply_record_id].filter(Boolean) as string[];
    Promise.all(ids.map(async recordID => {
      const cached = cache.current.get(recordID);
      const record: RequestRecord = cached || await api('/admin/requests/' + encodeURIComponent(recordID));
      if (!disposed && !record.record_missing && record.state !== 'running') cache.current.set(recordID, record);
      return [recordID, record] as const;
    })).then(values => { if (!disposed) setBodies(Object.fromEntries(values)); }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [detail, id, api]);
  useEffect(() => { pane.current?.scrollTo({ top: 0 }); }, [id, tab]);
  useEffect(() => { rail.current?.scrollTo({ top: 0 }); }, [search, project, filter]);
  const visible = tasks.filter(t => (project === 'all' || t.project_id === project) &&
    (filter === 'all' || filter === 'attention' && (t.failed > 0 || t.state === 'waiting')) &&
    [t.title, t.project_name, t.id, t.grouping?.root_id, t.grouping?.session_id, ...t.models].join(' ').toLowerCase().includes(search.toLowerCase()));
  const projects = [...new Map(tasks.map(t => [t.project_id, t.project_name])).entries()];
  const t = detail?.task.id === id ? detail.task : null;
  const reply = t?.reply_record_id ? bodies[t.reply_record_id] : undefined;
  function select(task: RequestTask) { if (task.id === id) return; setID(task.id); setDetail(null); setTab('overview'); setLimit(100); setCallID(''); setBodies({}); cache.current.clear(); setError(''); }
  function openCall(recordID: string) { setCallID(recordID); setCallTab('messages'); }
  return <><div className="inspector task-inspector">
    <section className="request-rail">
      <div className="rail-head task-rail-head">
        <div><h2>任务记录</h2><span className="muted small">{visible.length} / {tasks.length} 项</span><button className="icon-btn" aria-label="刷新任务" onClick={refresh}><RefreshCw size={15}/></button></div>
        <label className="search"><Search size={15}/><input aria-label="搜索任务" placeholder="搜索提问、项目、模型、ID" value={search} onChange={e => setSearch(e.target.value)}/></label>
        <FilterSelect label="按任务项目筛选" value={project} onChange={setProject} options={[{ value: 'all', label: '所有项目' }, ...projects.map(([value, label]) => ({ value, label }))]}/>
        <div className="filter-tabs">{[['all','全部'],['attention','需关注']].map(([v, label]) => <button key={v} className={filter === v ? 'selected' : ''} aria-pressed={filter === v} onClick={() => setFilter(v)}>{label}</button>)}</div>
        <p className="task-scope">最近 200 次已分组调用涉及的任务<br/>组内统计包含全部已记录调用</p>
      </div>
      <div className="request-items" ref={rail} role="region" aria-label="任务列表" tabIndex={0}>
        {visible.map(task => <button key={task.id} className={'request-item task-item ' + (id === task.id ? 'selected' : '')} onClick={() => select(task)}>
          <span><small>{task.project_name}</small><small>{dateTime(task.started)}</small></span>
          <b className="task-title">{task.title}</b>
          <span className="task-badges"><em className="task-tag">WorkBuddy · 明确分组</em><small className={task.state === 'replied' ? 'good-text' : 'warning-text'}>{taskState(task)}</small></span>
          <span><small>{task.calls} 次调用</small></span>
          {task.failed > 0 && <span className="task-failure">{task.failed} 次调用失败</span>}
        </button>)}
        {!visible.length && <p className="rail-empty">{tasks.length ? '没有匹配的任务。' : '暂无已识别的任务。未分组的调用可在「请求记录」中查看。'}</p>}
      </div>
    </section>
    <section className="request-detail" ref={pane} aria-label="任务详情" tabIndex={0}>
      {error && <div className="error" role="alert">{error}</div>}
      {t ? <>
        <header className="task-head">
          <div className="task-heading-meta"><span><Layers3 size={14}/>WorkBuddy · 一次提问 · {t.project_name}</span><span className={'task-state ' + t.state}>{taskState(t)}</span></div>
          <h2>{t.title}</h2>
          <div className="task-stats">
            <div><span>LLM 调用</span><b>{t.calls}<small> 次</small></b><small>{t.failed ? `${t.failed} 次失败，已计入统计` : t.active ? `${t.active} 次正在进行` : '全部已记录调用'}</small></div>
            <div><span>输入 Token</span><b>{t.input_samples ? number(t.input_tokens) : '—'}</b><small>{t.input_samples} / {t.calls} 次用量已知</small></div>
            <div><span>输出 Token</span><b>{t.output_samples ? number(t.output_tokens) : '—'}</b><small>{t.output_samples} / {t.calls} 次用量已知</small></div>
            <div><span>调用时间跨度</span><b>{duration(t.duration_ms)}</b><small>{t.active ? '截至当前' : '首个开始 → 最后结束'}</small></div>
          </div>
        </header>
        <div className="detail-tabs">{[['overview','对话概览'],['calls',`调用过程 · ${t.calls}`],['grouping','分组信息']].map(([v, label]) => <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>{label}</button>)}</div>
        <div className="detail-content task-content">
          {t.missing_records > 0 && <p className="request-outcome-note">{t.missing_records} 次调用只有摘要，正文尚未保存或未能保存；统计仍包含这些调用。</p>}
          {tab === 'overview' ? <>
            <div className="task-explanation">按根任务标识合并主代理与子代理。“已回复”只表示网关看到了主代理正文回复。</div>
            <section className="task-message"><div className="task-message-label">用户提问{t.question_record_id && <button className="link" onClick={() => openCall(t.question_record_id!)}>查看请求<ArrowRight size={13}/></button>}</div><TextPreview key={t.question_record_id || t.id}><p>{detail!.question || '未记录可识别的用户提问，可在调用详情中查看完整提示词。'}</p></TextPreview></section>
            <section className="task-message task-answer"><div className="task-message-label">最新主代理回复{t.reply_record_id && <button className="link" onClick={() => openCall(t.reply_record_id!)}>查看响应<ArrowRight size={13}/></button>}</div><TextPreview><p>{reply ? responseText(reply.output || '') || '此调用没有可显示的正文，请查看调用详情。' : t.state === 'running' ? '调用仍在进行，等待主代理回复。' : t.state === 'error' ? '最新主代理调用异常，请查看调用过程。' : t.state === 'replied' ? '正在读取回复…' : '尚未记录主代理正常结束的正文回复；可能仍在执行工具或等待后续。'}</p></TextPreview></section>
            <button className="task-process-link" onClick={() => setTab('calls')}><GitBranch size={16}/>查看 {t.calls} 次 LLM 调用{t.failed > 0 && <span className="task-failure">含 {t.failed} 次失败</span>}<ArrowRight size={15}/></button>
          </> : tab === 'calls' ? <>
            <p className="task-explanation">按开始时间排列，点击查看该次消息、响应、原始数据与性能。Token 为输入 / 输出；“—”表示未知。</p>
            <div className="task-calls">{detail!.calls.map((call, i) => <button key={call.id} className="task-call" onClick={() => openCall(call.id)}>
              <span className="task-call-index">{i + 1}</span><span className="task-call-main"><b>{agentName(call)}</b><small>{call.alias || '未匹配模型'} · {dateTime(call.started)}</small>{call.grouping?.parent_session_id && <small>父会话 {call.grouping.parent_session_id.slice(0, 8)}</small>}</span>
              <span className="task-call-usage"><b className={call.state === 'complete' ? 'good-text' : 'warning-text'}>{recordStatus(call)}{call.reply_kind === 'tools' ? ' · 工具调用' : call.reply_kind === 'reply' ? ' · 正文回复' : ''}</b><small>{number(inputTotal(call))} / {number(outputTotal(call))} Token · {duration(call.duration_ms)}</small></span><ArrowRight size={14}/>
            </button>)}</div>
            {detail!.has_more && <button className="task-load-more" onClick={() => setLimit(v => v + 100)}>加载更多调用（已显示 {detail!.calls.length} / {detail!.total}）</button>}
          </> : <>
            <p className="task-explanation">此组依据客户端显式标识合并，并限定在同一个网关项目内。兼容相同请求头的客户端也会识别为 WorkBuddy。</p>
            <dl className="task-group-fields"><dt>分组方式</dt><dd>{t.grouping?.source === 'turn' ? '明确分组 · 主代理轮次 ID 回退' : '明确分组 · 根任务 ID'}</dd><dt>网关任务 ID</dt><dd>{t.id}</dd><dt>网关项目 ID</dt><dd>{t.project_id || '未识别'}</dd>{t.grouping && <><dt>根任务 ID</dt><dd>{t.grouping.root_id}</dd><dt>参考会话 ID</dt><dd>{t.grouping.session_id}</dd><dt>参考轮次 ID</dt><dd>{t.grouping.turn_id || '未提供'}</dd></>}</dl>
            <p className="task-explanation">同一会话的不同提问不会仅因会话 ID 相同而合并。仅统计经过网关且标识有效的调用，无法确认是否捕获了客户端的全部过程。</p>
          </>}
        </div>
      </> : <p className="rail-empty">{id ? '正在读取任务…' : '选择一项任务，查看提问、回复和中间调用。'}</p>}
    </section>
  </div>
    {callID && t && <TaskCallDialog key={t.id} taskID={t.id} initialCallID={callID} initialCalls={detail!.calls} total={detail!.total}
      api={api} detailTab={callTab} renderRecord={(record, copy) => renderRecord(record, callTab, setCallTab, copy)} onClose={() => setCallID('')}/>}
  </>;
}
