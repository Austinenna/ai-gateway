import type { ReactNode } from 'react';
import {
  type RequestRecord,
  diagnosticActionName,
  diagnosticPhaseName,
  diagnosticSourceName,
  errorName,
  firstTiming,
  inputTotal,
  number,
  outputTotal,
  recordStatus,
} from '../monitoring';
import { costText } from '../costs';
import { protocolName } from '../connection-protocols';

const hms = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const day = (t: number) => {
  const d = new Date(t),
    today = new Date();
  const label = d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  return d.toDateString() === today.toDateString() ? label + ' · TODAY' : label;
};
// Metric values render as a large number with a small unit, as in the preview.
function Num({ text }: { text: string }) {
  const m = /^([\d.,]+)\s*([a-zA-Z]+)$/.exec(text);
  return m ? (
    <>
      {m[1]}
      <small>{m[2]}</small>
    </>
  ) : (
    <>{text}</>
  );
}
const secs = (ms?: number | null) => (ms == null ? '—' : ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(2) + 's');

function led(r: RequestRecord) {
  if (r.state === 'running') return 'c';
  if (r.state === 'complete') return r.fallback_from ? 'a' : '';
  if (r.state === 'truncated' || r.error_type === 'project_rate_limit' || r.error_type === 'project_concurrency') return 'a';
  return 'r';
}
function tag(r: RequestRecord): [string, string] | null {
  if (r.state === 'running') return ['RUN', 'var(--cyan)'];
  if (r.fallback_from) return ['⇠ ' + r.fallback_from, 'var(--amber)'];
  if (r.error_type === 'project_rate_limit' || r.error_type === 'project_concurrency') return ['LIMIT', 'var(--amber)'];
  if (r.state === 'truncated') return ['TRUNC', 'var(--amber)'];
  if (r.body_purged) return ['BODY PURGED', 'var(--dim)'];
  if (r.state !== 'complete') return [String(r.status || r.state).toUpperCase(), 'var(--red)'];
  return null;
}

/** RequestList is the dense, date-grouped list on the left of the request page. */
export function RequestList({
  records,
  selectedId,
  onSelect,
  loading,
  hasMore,
  onLoadMore,
}: {
  records: RequestRecord[];
  selectedId?: string;
  onSelect: (id: string) => void;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  let lastDay = '';
  return (
    <div className="rq-items request-items" role="region" aria-label="请求列表" tabIndex={0}>
      {records.map((r) => {
        const d = day(r.started);
        const header = d !== lastDay;
        lastDay = d;
        const t = tag(r);
        return (
          <div key={r.id}>
            {header && <div className="dayh">{d}</div>}
            <button
              type="button"
              className={'ri request-item' + (selectedId === r.id ? ' on selected' : '')}
              onClick={() => onSelect(r.id)}
            >
              <span className={'led ' + led(r)} />
              <div>
                <div className="a">
                  {r.alias || '未路由'}
                  {t && <i style={{ color: t[1] }}>{t[0]}</i>}
                </div>
                <div className="pj2">
                  {r.project_name}
                  {r.task_ref || r.task_id ? ' · 任务' : ''}
                </div>
                <div className="q">{r.question_excerpt || r.diagnostic?.message || recordStatus(r) + ' · ' + protocolName(r.protocol)}</div>
              </div>
              <div className="r">
                <b>{r.state === 'running' ? '…' : secs(r.duration_ms)}</b>
                {hms(r.started)}
              </div>
            </button>
          </div>
        );
      })}
      {!records.length && <p className="rail-empty">{loading ? '正在读取…' : '没有匹配的请求'}</p>}
      {hasMore && (
        <div className="more">
          <button type="button" className="kb load-more" onClick={onLoadMore} disabled={loading}>
            {loading ? '正在读取…' : '加载更早 50 条 ↓'}
          </button>
        </div>
      )}
    </div>
  );
}

const outcomeLabel: Record<string, string> = {
  served: '已服务 · 按此模型计费',
  failed: '失败',
  skipped_breaker: '熔断中，直接跳过',
  not_granted: '项目未授权此备用模型',
  unavailable: '备用模型不可用',
};

/** Timeline places the measured phases of one call on a common time axis. */
function Timeline({ r }: { r: RequestRecord }) {
  const total = r.state === 'running' ? Date.now() - r.started : r.duration_ms;
  if (!total) return null;
  const fo = r.forward_offset_ms ?? 0;
  const rows: [string, number, number, string][] = [];
  rows.push(['网关校验·限速·预算', 0, fo, 'var(--tx)']);
  let cursor = fo;
  const attempts = r.attempts || [];
  attempts.forEach((a, i) => {
    if (a.outcome === 'failed' && i < attempts.length - 1) {
      rows.push([`#${i + 1} ${a.alias} → ${a.status || a.error_type || '失败'}`, cursor, cursor + a.duration_ms, 'var(--red)']);
      cursor += a.duration_ms;
    }
  });
  const prefix = attempts.length > 1 ? `#${attempts.length} ` : '';
  const ft = r.first_token_ms,
    fc = r.first_text_ms,
    lt = r.last_token_ms;
  if (r.stream && ft != null) {
    rows.push([prefix + '等待首个 token', cursor, fo + ft, 'dashed']);
    if (fc != null && fc > ft) rows.push([prefix + '思考输出', fo + ft, fo + fc, 'var(--go-2)']);
    const bodyStart = fo + (fc ?? ft);
    if (lt != null && lt > (fc ?? ft)) rows.push([prefix + '正文流', bodyStart, fo + lt, 'ticks']);
    if (lt != null && total > fo + lt) rows.push(['收尾与用量', fo + lt, total, 'var(--cyan)']);
  } else {
    rows.push([prefix + (r.stream === false ? '等待完整响应' : '上游处理'), cursor, total, 'dashed']);
  }
  const pct = (v: number) => Math.max(0, Math.min(100, (v / total) * 100));
  return (
    <div className="scope">
      <div className="h" style={{ marginBottom: 10 }}>
        TIMELINE<span className="zh">各阶段 · 相对请求开始</span>
      </div>
      {rows.map(([label, a, b, style], i) => {
        const css: React.CSSProperties = { left: pct(a) + '%', width: Math.max(0.6, pct(b) - pct(a)) + '%' };
        if (style === 'dashed') Object.assign(css, { border: '1px dashed var(--tx-2)' });
        else if (style === 'ticks')
          Object.assign(css, {
            background: 'repeating-linear-gradient(90deg,var(--go) 0 2px,transparent 2px 4px)',
            boxShadow: '0 0 8px rgba(92,255,157,.3)',
          });
        else css.background = style;
        return (
          <div className="sc" key={i}>
            <span className="zh">{label}</span>
            <div className="lane">
              <i style={css} />
            </div>
            <span className="n">{secs(Math.max(0, b - a))}</span>
          </div>
        );
      })}
      <div className="scax">
        <span />
        <div>
          <span>0</span>
          <span>{secs(total / 4)}</span>
          <span>{secs(total / 2)}</span>
          <span>{secs((total * 3) / 4)}</span>
          <span>{secs(total)}</span>
        </div>
        <span />
      </div>
    </div>
  );
}

/** Inspector is the request detail: identity, attempts, metrics, timeline, then tabs. */
export function Inspector({
  record: r,
  tab,
  setTab,
  onCopyCurl,
  onOpenTask,
  children,
}: {
  record: RequestRecord;
  tab: string;
  setTab: (t: string) => void;
  onCopyCurl: () => void;
  onOpenTask?: () => void;
  children: ReactNode;
}) {
  const ok = r.state === 'complete';
  const input = inputTotal(r),
    output = outputTotal(r);
  const attempts = r.attempts || [];
  const audio = r.protocol === 'dashscope-asr';
  const outcomeHTTP =
    r.error_type === 'client_canceled' && r.upstream_status ? `上游 HTTP ${r.upstream_status}` : `HTTP ${r.status || '—'}`;
  return (
    <>
      <div className="detail-head">
        <div className="ins-h">
          <div className="l1">
            <span className={'pill ' + (r.state === 'running' ? 'run' : ok ? 'ok' : r.state === 'truncated' ? 'am' : 'rd')}>
              {r.status || '—'} · <span className="result-label">{recordStatus(r)}</span>
            </span>
            {r.fallback_from && <span className="pill am">FALLBACK</span>}
            {r.body_purged && <span className="pill">BODY PURGED</span>}
            <code className="detail-request-id">{r.id}</code>
            <span>·</span>
            <span>{new Date(r.started).toLocaleString('zh-CN', { hour12: false })}</span>
            <span className="l1-actions">
              <button type="button" className="kb" onClick={onCopyCurl} disabled={!r.input}>
                COPY CURL
              </button>
              {onOpenTask && (
                <button type="button" className="kb" onClick={onOpenTask}>
                  → TASK
                </button>
              )}
            </span>
          </div>
          <h2>
            <span className="zh detail-project">{r.project_name}</span> <em>⟶</em> {r.fallback_from ? r.fallback_from : r.alias || '未路由'}
            {r.fallback_from && (
              <>
                {' '}
                <em style={{ color: 'var(--amber)' }}>⇢</em> {r.alias}
              </>
            )}
          </h2>
          <div className="facts">
            {r.connection_name && (
              <span>
                CONN <b className="zh">{r.connection_name}</b>
              </span>
            )}
            {r.upstream_model && (
              <span>
                UPSTREAM <b>{r.upstream_model}</b>
              </span>
            )}
            <span>
              PROTO <b>{protocolName(r.protocol)}</b>
            </span>
            <span>
              MODE <b>{r.stream === true ? 'SSE' : r.stream === false ? 'JSON' : '—'}</b>
            </span>
            {r.category && (
              <span>
                CATEGORY <b>{r.category}</b>
              </span>
            )}
            {(r.task_ref || r.task_id) && (
              <span>
                TASK <b>{r.task_ref || r.task_id}</b>
              </span>
            )}
          </div>
          {r.diagnostic ? (
            <div className="diag-note request-diagnostic-note">
              <b>{r.diagnostic.message}</b>
              <span>
                {errorName(r.diagnostic.code)} · {outcomeHTTP} · {diagnosticPhaseName(r.diagnostic.phase)} ·{' '}
                {diagnosticSourceName(r.diagnostic.source)} · {r.diagnostic.upstream_contacted ? '已尝试联系上游' : '未联系上游'} ·{' '}
                {r.diagnostic.retryable ? '可重试' : '需要处理'} · {diagnosticActionName(r.diagnostic.recommended_action)}
              </span>
            </div>
          ) : (
            r.error_type && (
              <div className="diag-note request-outcome-note">
                {errorName(r.error_type)} · {outcomeHTTP}
              </div>
            )
          )}
        </div>
        {attempts.length > 0 && (
          <div className="att">
            <div className="h">
              ATTEMPTS<span className="zh">尝试记录 · {attempts.length} 次</span>
            </div>
            <div className="atr hd">
              <span>#</span>
              <span>MODEL</span>
              <span>CONNECTION</span>
              <span>RESULT</span>
              <span className="n">TIME</span>
              <span>NOTE</span>
            </div>
            {attempts.map((a, i) => (
              <div className={'atr' + (a.outcome === 'served' ? ' ok' : '')} key={i}>
                <span>{i + 1}</span>
                <span>{a.alias}</span>
                <span className="zh">{a.connection_name || '—'}</span>
                <span style={{ color: a.outcome === 'served' ? 'var(--go)' : 'var(--red)' }}>
                  {a.status || '—'} {a.error_type || (a.outcome === 'served' ? 'ok' : '')}
                </span>
                <span className="n">{a.duration_ms ? secs(a.duration_ms) : '—'}</span>
                <span className="zh">{outcomeLabel[a.outcome] || a.outcome}</span>
              </div>
            ))}
          </div>
        )}
        <div className="mx">
          {audio ? (
            <>
              <div>
                <label>TOTAL</label>
                <div className="v">
                  <Num text={secs(r.duration_ms)} />
                </div>
                <div className="s">同步转写</div>
              </div>
              <div>
                <label>AUDIO</label>
                <div className="v">
                  {number(r.audio_seconds, 2)}
                  <small>s</small>
                </div>
                <div className="s">厂商返回的音频时长</div>
              </div>
            </>
          ) : (
            <>
              <div>
                <label>TTFT</label>
                <div className="v">
                  <Num text={firstTiming(r)} />
                </div>
                <div className="s">首个 token</div>
              </div>
              <div>
                <label>TTFC</label>
                <div className="v">
                  <Num text={firstTiming(r, true)} />
                </div>
                <div className="s">首段正文</div>
              </div>
              <div>
                <label>TOTAL</label>
                <div className="v">
                  <Num text={r.state === 'running' ? '…' : secs(r.duration_ms)} />
                </div>
                <div className="s">网关 +{r.forward_offset_ms ?? 0}ms</div>
              </div>
              <div>
                <label>INPUT</label>
                <div className="v">{number(input)}</div>
                <div className="s">
                  缓存读 {number(r.cache_read_tokens)}
                  {input && r.cache_read_tokens ? ' · ' + Math.round((r.cache_read_tokens / input) * 100) + '%' : ''}
                </div>
              </div>
              <div>
                <label>OUTPUT</label>
                <div className="v">{number(output)}</div>
                <div className="s">
                  {r.output_tps ? number(r.output_tps, 0) + ' tok/s' : '—'}
                  {r.tpot_ms ? ' · TPOT ' + number(r.tpot_ms, 1) + 'ms' : ''}
                </div>
              </div>
            </>
          )}
          <div>
            <label>COST</label>
            <div className="v" style={{ color: 'var(--amber)' }}>
              {costText(r.cost)}
            </div>
            <div className="s">{r.cost?.peak ? '高峰价' : '按当时单价估算'}</div>
          </div>
        </div>
        <Timeline r={r} />
      </div>
      <div className="tb detail-tabs">
        {[
          ['messages', 'MESSAGES'],
          ['response', 'RESPONSE'],
          ['raw', 'RAW'],
          ['timing', 'PERF'],
        ].map(([v, t]) => (
          <button key={v} type="button" aria-pressed={tab === v} className={tab === v ? 'on active' : ''} onClick={() => setTab(v)}>
            <span aria-hidden="true">{t}</span>
            <span className="tab-zh">{{ messages: '消息', response: '响应详情', raw: '原始数据', timing: '性能与用量' }[v]}</span>
          </button>
        ))}
      </div>
      <div className="trn detail-content">{children}</div>
    </>
  );
}
