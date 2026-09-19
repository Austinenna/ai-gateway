import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import type { RequestRecord } from './monitoring';
import type { TaskDetail } from './request-tasks';
import './task-call-dialog.css';

type Props = {
  taskID: string; initialCallID: string; initialCalls: RequestRecord[]; total: number;
  detailTab: string; api: (path: string) => Promise<any>;
  renderRecord: (record: RequestRecord, copy: (value: string) => void) => ReactNode; onClose: () => void;
};
function mergeCalls(current: RequestRecord[], incoming: RequestRecord[]) {
  const byID = new Map(current.map(call => [call.id, call]));
  for (const call of incoming) byID.set(call.id, call);
  return [...byID.values()].sort((a, b) => a.started - b.started || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function TaskCallDialog({ taskID, initialCallID, initialCalls, total, detailTab, api, renderRecord, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), content = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const titleID = useId();
  const [callID, setCallID] = useState(initialCallID), [record, setRecord] = useState<RequestRecord | null>(null);
  const [calls, setCalls] = useState(initialCalls), [count, setCount] = useState(total);
  const [copyNotice, setCopyNotice] = useState('');
  const [bodyError, setBodyError] = useState(''), [listError, setListError] = useState(''), [loadingList, setLoadingList] = useState(false);
  const [bodyAttempt, setBodyAttempt] = useState(0), [listAttempt, setListAttempt] = useState(0);
  const knownCalls = useRef(initialCalls), cache = useRef(new Map<string, RequestRecord>());

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current!;
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => { element.close(); opener?.focus({ preventScroll: true }); };
  }, []);

  // Only summaries are loaded for navigation; full input/output is fetched for the selected call.
  useEffect(() => {
    let disposed = false;
    let all = mergeCalls(knownCalls.current, initialCalls);
    knownCalls.current = all; setCalls(all); setCount(total); setListError('');
    async function loadRemaining() {
      let expected = total;
      setLoadingList(all.length < expected);
      while (all.length < expected) {
        const page: TaskDetail = await api('/admin/request-tasks/' + encodeURIComponent(taskID) + '?offset=' + all.length);
        if (disposed) return;
        const merged = mergeCalls(all, page.calls);
        if (merged.length === all.length) throw new Error('调用列表未能完整读取，请重试。');
        all = merged; expected = page.total;
        knownCalls.current = all; setCalls(all); setCount(expected);
      }
      if (!disposed) setLoadingList(false);
    }
    loadRemaining().catch(e => { if (!disposed) { setListError(e.message); setLoadingList(false); } });
    return () => { disposed = true; };
  }, [taskID, initialCalls, total, api, listAttempt]);

  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    setBodyError('');
    async function load() {
      const value: RequestRecord = cache.current.get(callID) || await api('/admin/requests/' + encodeURIComponent(callID));
      if (disposed) return;
      setRecord(value);
      if (value.record_missing || value.state === 'running') timer = setTimeout(() => { load().catch(fail); }, 5000);
      else {
        // Keep a small bounded cache for back-and-forth inspection of large responses.
        cache.current.delete(callID); cache.current.set(callID, value);
        if (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
      }
    }
    function fail(e: Error) { if (!disposed) setBodyError(e.message); }
    load().catch(fail);
    return () => { disposed = true; clearTimeout(timer); };
  }, [callID, api, bodyAttempt]);
  useEffect(() => { content.current?.scrollTo({ top: 0 }); }, [callID, detailTab]);

  useEffect(() => {
    if (!copyNotice) return;
    const timer = setTimeout(() => setCopyNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [copyNotice]);
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopyNotice('已复制'); }
    catch { setCopyNotice('复制失败，请手动选择文本复制。'); }
  }

  const index = calls.findIndex(call => call.id === callID);
  const shown = record?.id === callID ? record : null;
  function navigate(offset: number) {
    const next = calls[index + offset];
    if (index >= 0 && next) setCallID(next.id);
  }
  return createPortal(<dialog ref={dialog} className="task-call-dialog" aria-labelledby={titleID} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="task-call-dialog-head">
      <div className="task-call-dialog-title"><h2 id={titleID}>单次调用</h2><span aria-live="polite">{index >= 0 ? `第 ${index + 1} / ${count} 次调用` : '正在定位调用…'}</span></div>
      <div className="task-call-dialog-nav" role="group" aria-label="切换任务内调用">
        <button type="button" disabled={index <= 0} onClick={() => navigate(-1)}><ArrowLeft size={15}/>上一个调用</button>
        <button type="button" disabled={index < 0 || index >= calls.length - 1} onClick={() => navigate(1)}>下一个调用<ArrowRight size={15}/></button>
      </div>
      <button ref={closeButton} type="button" className="icon-btn task-call-dialog-close" aria-label="关闭调用详情" onClick={onClose}><X size={19}/></button>
    </header>
    {copyNotice && <p className="task-call-dialog-notice" role="status">{copyNotice}</p>}
    {loadingList && <p className="task-call-dialog-notice" role="status">正在读取其余调用，已读取 {calls.length} / {count} 条…</p>}
    {listError && <div className="task-call-dialog-error" role="alert">{listError}<button type="button" onClick={() => setListAttempt(v => v + 1)}>重试调用列表</button></div>}
    <div ref={content} className="request-detail task-call-dialog-content" role="region" aria-label="单次调用详情" tabIndex={0} aria-busy={!shown && !bodyError}>
      {bodyError ? <div className="task-call-dialog-error" role="alert">{bodyError}<button type="button" onClick={() => setBodyAttempt(v => v + 1)}>重试读取调用</button></div> : shown ? renderRecord(shown, copy) : <p className="rail-empty" role="status">读取调用详情…</p>}
    </div>
  </dialog>, document.body);
}
