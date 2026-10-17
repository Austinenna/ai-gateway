import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Copy, MessagesSquare, RotateCcw, SlidersHorizontal, Square, SquarePen, Waypoints, X } from 'lucide-react';
import { modelProtocols, protocolName } from './connection-protocols';
import { chatError, conversationHistory, createChatResponse } from './chat-response.mjs';
import { duration, firstTiming, inputTotal, number, outputTotal, recordStatus, type RequestRecord } from './monitoring';
import { TextPreview } from './TextPreview';
import './chat.css';

type ChatModel = { id: string; name: string; alias: string; connection_id: string; enabled: boolean; protocols: string[]; defaults: { temperature?: number; max_tokens?: number } };
type ChatConnection = { id: string; name: string; provider: string; enabled: boolean; endpoints: Record<string, string> };
type Parameters = { system: string; temperature: string; maxTokens: string; stream: boolean };
type Message = {
  id: string; role: 'user' | 'assistant'; text: string; thinking?: string; toolCalls?: boolean; finishReason?: string;
  model?: string; alias?: string; protocol?: string; requestID?: string; record?: RequestRecord;
  status?: 'sending' | 'complete' | 'stopped' | 'error' | 'interrupted'; error?: string;
};
type Props = {
  active: boolean; models: ChatModel[]; connections: ChatConnection[];
  api: (path: string) => Promise<any>; refresh: () => Promise<void>;
  onOpenRecord: (id: string) => void; onConfigure: () => void;
};
const defaults = (): Parameters => ({ system: '', temperature: '', maxTokens: '', stream: true });
const responseState = (message: Message) => ({ sending: '生成中…', complete: '', stopped: '已停止', error: '请求失败', interrupted: '未完整结束' }[message.status || 'complete']);
function pretty(value?: string) { try { return JSON.stringify(JSON.parse(value || ''), null, 2); } catch { return value || ''; } }

export function ChatPage({ active, models, connections, api, refresh, onOpenRecord, onConfigure }: Props) {
  const available = useMemo(() => models.filter(model => model.enabled && connections.some(connection => connection.id === model.connection_id && connection.enabled && modelProtocols(model, connection).some(p => p === 'chat' || p === 'messages'))), [models, connections]);
  const [modelID, setModelID] = useState(''), [protocol, setProtocol] = useState('chat');
  const [messages, setMessages] = useState<Message[]>([]), [draft, setDraft] = useState('');
  const [parameters, setParameters] = useState(defaults), [parameterDraft, setParameterDraft] = useState(defaults);
  const [panel, setPanel] = useState<'settings' | 'request' | null>(null), [requestID, setRequestID] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [parameterError, setParameterError] = useState('');
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const request = useRef<AbortController | null>(null), alive = useRef(true), scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null), followOutput = useRef(true);
  const settingsID = useId(), messagesID = useId();
  const selected = available.find(model => model.id === modelID) || available[0];
  const connection = connections.find(item => item.id === selected?.connection_id);
  const protocols: string[] = modelProtocols(selected, connection).filter(p => p === 'chat' || p === 'messages');
  const selectedProtocol = protocols.includes(protocol) ? protocol : protocols[0] || '';
  const customized = Boolean(parameters.system || parameters.temperature || parameters.maxTokens || !parameters.stream);
  const dirty = JSON.stringify(parameterDraft) !== JSON.stringify(parameters);
  const rounds = messages.filter(message => message.role === 'user').length;

  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!busy && !available.some(model => model.id === modelID)) setModelID(available[0]?.id || '');
  }, [available, modelID, busy]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer);
  }, [notice]);
  useLayoutEffect(() => {
    if (active && followOutput.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [active, messages, panel]);
  function updateMessage(id: string, value: Partial<Message>) {
    if (alive.current) setMessages(current => current.map(message => message.id === id ? { ...message, ...value } : message));
  }
  async function readMetrics(id: string, messageID: string) {
    for (let attempt = 0; attempt < 6 && alive.current; attempt++) {
      try {
        const record: RequestRecord = await api('/admin/requests/' + encodeURIComponent(id));
        if (!alive.current) return;
        // Full bodies remain in the request inspector, rather than duplicating
        // the whole conversation in every message's in-memory statistics.
        const summary = { ...record, input: undefined, output: undefined };
        setMessages(current => current.map(message => {
          if (message.id !== messageID) return message;
          const failed = record.state !== 'running' && record.state !== 'complete' && message.status === 'complete';
          return { ...message, record: summary, ...(failed ? { status: 'interrupted' as const, error: record.diagnostic?.message || recordStatus(record) } : {}) };
        }));
        if (record.state !== 'running' && !record.record_missing) return;
      } catch { /* A response may finish just before its record is committed. */ }
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 200 : 700));
    }
  }
  async function execute(history: Message[]) {
    if (!selected || !selectedProtocol || request.current) return;
    const controller = new AbortController(); request.current = controller;
    const assistantID = crypto.randomUUID();
    const pending: Message = { id: assistantID, role: 'assistant', text: '', thinking: '', model: selected.name, alias: selected.alias, protocol: selectedProtocol, status: 'sending' };
    const payload = {
      model: selected.alias, protocol: selectedProtocol, messages: conversationHistory(history), system: parameters.system, stream: parameters.stream,
      ...(parameters.temperature !== '' ? { temperature: Number(parameters.temperature) } : {}),
      ...(parameters.maxTokens !== '' ? { max_tokens: Number(parameters.maxTokens) } : {}),
    };
    setBusy(true); setNotice(''); followOutput.current = true; setAwayFromBottom(false); setMessages([...history, pending]);
    const parser = createChatResponse(selectedProtocol);
    let callID = '';
    try {
      const response = await fetch('/api/admin/chat', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Gateway-Admin': '1' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      callID = response.headers.get('X-Request-ID') || '';
      updateMessage(assistantID, { requestID: callID });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(chatError(error, '请求失败（HTTP ' + response.status + '）'));
      }
      let result;
      if (parameters.stream) {
        if (!response.headers.get('Content-Type')?.startsWith('text/event-stream') || !response.body) throw new Error('未收到预期的流式响应，请查看请求详情。');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let painted = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            result = parser.push(decoder.decode(part.value, { stream: true }));
            if (performance.now() - painted > 40) {
              updateMessage(assistantID, { text: result.text, thinking: result.thinking, toolCalls: result.toolCalls });
              painted = performance.now();
            }
          }
          parser.push(decoder.decode()); result = parser.finish();
        } finally { reader.releaseLock(); }
      } else result = parser.json(await response.json());
      updateMessage(assistantID, {
        text: result.text, thinking: result.thinking, toolCalls: result.toolCalls, finishReason: result.finishReason,
        status: result.error ? 'error' : result.ended ? 'complete' : 'interrupted',
        error: result.error || (!result.ended ? '响应在完整结束前断开，已保留收到的内容。' : ''),
      });
    } catch (error) {
      const partial = parser.snapshot();
      updateMessage(assistantID, {
        text: partial.text, thinking: partial.thinking, toolCalls: partial.toolCalls,
        status: controller.signal.aborted ? 'stopped' : 'error',
        error: controller.signal.aborted ? '' : (error as Error).message,
      });
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current) {
        setBusy(false);
        if (callID) void readMetrics(callID, assistantID);
        void refresh().catch(() => {});
      }
    }
  }
  function send() {
    if (!draft.trim() || busy || request.current || !selected) return;
    const history = [...messages, { id: crypto.randomUUID(), role: 'user' as const, text: draft.trim() }];
    setDraft(''); void execute(history);
  }
  function newConversation() {
    if (request.current) return;
    setMessages([]); setDraft(''); setRequestID(''); setNotice('');
    if (panel === 'request') setPanel(null);
    followOutput.current = true; setAwayFromBottom(false); textarea.current?.focus();
  }
  function applyParameters() {
    const temperature = Number(parameterDraft.temperature), maxTokens = Number(parameterDraft.maxTokens);
    if (parameterDraft.temperature !== '' && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) { setParameterError('Temperature 需在 0 到 2 之间。'); return; }
    if (parameterDraft.maxTokens !== '' && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072)) { setParameterError('最大输出需为 1 到 131072 的整数。'); return; }
    setParameters({ ...parameterDraft }); setParameterError(''); setNotice('参数已应用于后续请求。');
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('已复制回复'); }
    catch { setNotice('复制失败，请手动选择回复文字复制。'); }
  }
  function showRequest(id: string) { setRequestID(id); setPanel('request'); }

  return <section className="chat-page" hidden={!active} aria-label="对话调试">
    <div className="chat-controls">
      <label className="chat-model-select"><span>模型</span><select aria-label="对话模型" disabled={busy || !available.length} value={selected?.id || ''} onChange={event => {
        setModelID(event.target.value); setNotice(messages.length ? '已切换模型，下一次发送保留当前文本上下文。' : '');
      }}>{!available.length && <option value="">暂无可用模型</option>}{available.map(model => <option key={model.id} value={model.id}>{model.name} · {model.alias}</option>)}</select></label>
      {protocols.length > 1 ? <label className="chat-protocol-select"><span>协议</span><select aria-label="对话协议" disabled={busy} value={selectedProtocol} onChange={event => setProtocol(event.target.value)}>{protocols.map(value => <option key={value} value={value}>{protocolName(value)}</option>)}</select></label> : selectedProtocol && <div className="chat-single-protocol"><span>协议</span><div>{protocolName(selectedProtocol)}</div></div>}
      <div className="chat-toolbar-actions"><button type="button" className={panel === 'settings' ? 'chat-parameters-open' : ''} disabled={busy} aria-expanded={panel === 'settings'} aria-controls={settingsID} onClick={() => setPanel(panel === 'settings' ? null : 'settings')}><SlidersHorizontal size={15}/>参数{customized && <span className="chat-override-dot" aria-label="已覆盖默认参数"/>}</button><button type="button" className="quiet" disabled={busy} onClick={newConversation}><SquarePen size={15}/>新对话</button></div>
    </div>
    <div className="chat-route"><span>{connection?.name || '选择一个已启用的对话模型'}{connection && <><span className="chat-route-divider">/</span>{customized ? '使用本次对话参数' : '沿用模型默认参数'}</>}</span><span>管理员调试</span></div>
    {notice && <div className="chat-notice" role="status">{notice}</div>}
    <div className="chat-body">
      <div className="chat-conversation">
        <div ref={scroll} id={messagesID} className="chat-messages" role="region" aria-label="对话消息" tabIndex={0} onScroll={event => {
          const element = event.currentTarget, near = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          followOutput.current = near; setAwayFromBottom(!near);
        }}>
          {!messages.length && <div className="chat-empty"><MessagesSquare size={30}/><h2>{selected ? '从一条消息开始' : '暂无可对话的模型'}</h2><p>{selected ? '已选择 ' + selected.name + '，输入消息即可开始调试。' : '启用支持 Chat Completions 或 Messages 的模型后，即可在这里对话。'}</p>{!selected && <button type="button" onClick={onConfigure}>去配置模型<ArrowRight size={15}/></button>}</div>}
          {messages.map((message, index) => <article key={message.id} className={'chat-message chat-message-' + message.role}>
            <div className="chat-message-heading">{message.role === 'user' ? '你' : <><span className="chat-avatar"><Waypoints size={15}/></span><b>{message.model}</b><code>{message.alias}</code><span className="chat-message-state" role="status">{responseState(message)}</span></>}</div>
            {message.thinking && <details className="chat-thinking"><summary>思考内容</summary><p>{message.thinking}</p></details>}
            {message.text ? <div className="chat-message-text">{message.text}</div> : message.role === 'assistant' && !message.error && <p className="chat-empty-reply">{message.status === 'sending' ? message.thinking ? '正在思考，等待正文…' : '等待模型响应…' : message.status === 'stopped' ? '已停止，尚未收到正文。' : message.toolCalls ? '模型返回了工具调用，可在请求详情中查看。' : '模型未返回正文，可在请求详情中查看完整响应。'}</p>}
            {message.error && <p className="chat-call-error" role="alert">{message.error}</p>}
            {['length', 'max_tokens'].includes(message.finishReason || '') && <p className="chat-limit-note">本次回复已达到最大输出限制。</p>}
            {message.role === 'assistant' && <>
              {message.record && <div className="chat-message-metrics"><span>首 Token {firstTiming(message.record)}</span><span>耗时 {duration(message.record.duration_ms)}</span><span>Token {number(inputTotal(message.record))} → {number(outputTotal(message.record))}</span></div>}
              {message.status !== 'sending' && <div className="chat-message-actions">
                {message.text && <button type="button" className="link" onClick={() => void copy(message.text)}><Copy size={13}/>复制</button>}
                {index === messages.length - 1 && <button type="button" className="link" disabled={busy || !selected} onClick={() => void execute(messages.slice(0, index))}><RotateCcw size={13}/>{message.status === 'error' || message.status === 'interrupted' ? '重试' : '重新生成'}</button>}
                {message.requestID && <button type="button" className="link" onClick={() => showRequest(message.requestID!)}>请求详情<ArrowRight size={13}/></button>}
              </div>}
            </>}
          </article>)}
        </div>
        <div className="chat-composer-area">
          <div className="chat-context"><span>{rounds ? '已携带 ' + rounds + ' 轮文本上下文' : '新对话 · 尚无上下文'}</span>{awayFromBottom ? <button type="button" className="link" onClick={() => { followOutput.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }}><ArrowDown size={12}/>回到底部</button> : <span>{parameters.stream ? '流式输出' : '完整响应'}</span>}</div>
          <form className="chat-composer" onSubmit={event => { event.preventDefault(); send(); }}>
            <textarea ref={textarea} aria-label="对话消息输入" value={draft} onChange={event => setDraft(event.target.value)} placeholder={messages.length ? '继续追问，或输入一条测试消息…' : '输入一条消息，测试所选模型…'} rows={3} disabled={!selected} onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && !busy) { event.preventDefault(); send(); }
            }}/>
            <div className="chat-composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span>{busy ? <button type="button" className="primary" onClick={() => request.current?.abort()}><Square size={13}/>停止生成</button> : <button type="submit" className="primary" disabled={!selected || !draft.trim()}>发送<ArrowUp size={15}/></button>}</div>
          </form>
          <p className="chat-composer-note">调用使用厂商额度并写入请求记录；本页会话在刷新后清空。</p>
        </div>
      </div>
      {panel && <aside className="chat-panel" id={settingsID} aria-label={panel === 'settings' ? '本次对话参数' : '本次请求'}>
        <div className="chat-panel-heading"><h2>{panel === 'settings' ? '本次对话参数' : '本次请求'}</h2><button type="button" className="icon-btn" aria-label="收起对话面板" onClick={() => setPanel(null)}><X size={17}/></button></div>
        {panel === 'settings' ? <form className="chat-settings" onSubmit={event => { event.preventDefault(); applyParameters(); }}>
          <p className="chat-panel-intro">只影响当前对话的后续请求</p>
          <label className="field"><span>系统提示词 <small>System prompt</small></span><textarea rows={5} disabled={busy} value={parameterDraft.system} onChange={event => setParameterDraft({ ...parameterDraft, system: event.target.value })} placeholder="例如：回答简洁，优先给出结论。"/></label>
          <label className="field"><span>随机性 <small>Temperature</small></span><input aria-label="对话 Temperature" type="number" min={0} max={2} step="any" disabled={busy} value={parameterDraft.temperature} placeholder={selected?.defaults.temperature == null ? '使用厂商默认值' : '继承模型配置：' + selected.defaults.temperature} onChange={event => setParameterDraft({ ...parameterDraft, temperature: event.target.value })}/><small>留空时沿用所选模型的配置</small></label>
          <label className="field"><span>最大输出 <small>Max tokens</small></span><input aria-label="对话最大输出" type="number" min={1} max={131072} step={1} disabled={busy} value={parameterDraft.maxTokens} placeholder={selected?.defaults.max_tokens != null ? '继承模型配置：' + selected.defaults.max_tokens : selectedProtocol === 'messages' ? '网关默认值：1024' : '使用厂商默认值'} onChange={event => setParameterDraft({ ...parameterDraft, maxTokens: event.target.value })}/></label>
          <label className="check"><input type="checkbox" disabled={busy} checked={parameterDraft.stream} onChange={event => setParameterDraft({ ...parameterDraft, stream: event.target.checked })}/>流式输出</label>
          {parameterError && <p role="alert" className="chat-call-error">{parameterError}</p>}
          <div className="chat-settings-actions"><button type="submit" disabled={busy}>应用参数</button><button type="button" className="link" disabled={busy} onClick={() => { setParameters(defaults()); setParameterDraft(defaults()); setParameterError(''); setNotice('已恢复继承模型配置。'); }}>恢复默认</button></div>
          <p className="chat-parameter-status">{dirty ? '有未应用的修改' : customized ? '已应用 · 后续请求生效' : '未填写的参数沿用已有配置'}</p>
        </form> : active && <ChatRequestPanel key={requestID} id={requestID} api={api} onOpenRecord={onOpenRecord}/>}
      </aside>}
    </div>
  </section>;
}

function ChatRequestPanel({ id, api, onOpenRecord }: { id: string; api: Props['api']; onOpenRecord: Props['onOpenRecord'] }) {
  const [record, setRecord] = useState<RequestRecord | null>(null), [error, setError] = useState('');
  const [tab, setTab] = useState<'request' | 'response'>('request'), [retry, setRetry] = useState(0);
  const tabID = useId();
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, attempts = 0;
    setError('');
    async function load() {
      try {
        const value: RequestRecord = await api('/admin/requests/' + encodeURIComponent(id));
        if (disposed) return;
        setRecord(value);
        if ((value.state === 'running' || value.record_missing) && attempts++ < 6) timer = setTimeout(load, 700);
      } catch (reason) { if (!disposed) setError((reason as Error).message); }
    }
    void load(); return () => { disposed = true; clearTimeout(timer); };
  }, [id, api, retry]);
  if (error) return <div className="chat-request-error" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></div>;
  if (!record) return <p className="chat-panel-intro" role="status">读取请求详情…</p>;
  return <div className="chat-request-panel">
    <p className={'chat-request-result ' + (record.state === 'complete' ? 'good-text' : 'warning-text')}>{recordStatus(record)} · HTTP {record.status || '—'}</p>
    <dl className="chat-request-meta"><div><dt>模型</dt><dd>{record.alias}</dd></div><div><dt>协议</dt><dd>{protocolName(record.protocol)}</dd></div><div><dt>请求标识</dt><dd>{record.id}</dd></div><div><dt>首 Token / 首正文</dt><dd>{firstTiming(record)} / {firstTiming(record, true)}</dd></div><div><dt>总耗时</dt><dd>{duration(record.duration_ms)}</dd></div><div><dt>输入 / 输出 Token</dt><dd>{number(inputTotal(record))} / {number(outputTotal(record))}</dd></div></dl>
    {record.diagnostic && <p className="chat-call-error">{record.diagnostic.message}</p>}
    {record.record_missing && <p className="chat-panel-intro">当前只有监控摘要，完整正文可能尚未写入或未能保存。<button type="button" className="link" onClick={() => setRetry(value => value + 1)}>重新读取</button></p>}
    {record.truncated && <p className="chat-panel-intro">记录正文达到保存上限，以下内容可能被截断。</p>}
    <div className="chat-json-tabs" role="tablist" aria-label="对话请求原始数据">{(['request', 'response'] as const).map(value => <button key={value} type="button" role="tab" id={tabID + value} aria-selected={tab === value} aria-controls={tabID + 'panel'} onClick={() => setTab(value)}>{value === 'request' ? '请求 JSON' : '响应原文'}</button>)}</div>
    <div id={tabID + 'panel'} role="tabpanel" aria-labelledby={tabID + tab} className="chat-raw"><TextPreview key={tab}><pre>{pretty(tab === 'request' ? record.input : record.output) || '暂无正文'}</pre></TextPreview></div>
    <button type="button" className="link chat-open-record" onClick={() => onOpenRecord(id)}>在请求记录中查看<ArrowRight size={13}/></button>
  </div>;
}
