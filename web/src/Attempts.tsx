import type { RequestRecord } from './monitoring';

const outcomeLabel: Record<string, string> = {
  served: '已服务',
  failed: '失败',
  skipped_breaker: '熔断中，已跳过',
  not_granted: '项目未授权此备用模型',
  unavailable: '备用模型不可用',
};

/** Attempts lists each upstream try of a call that involved a fallback model. */
export function Attempts({ record }: { record: RequestRecord }) {
  const attempts = record.attempts || [];
  if (!attempts.length) return null;
  return (
    <section className="attempts" aria-label="尝试记录">
      <h3>
        尝试记录 <small>{attempts.length} 次</small>
        {record.fallback_from && (
          <span className="attempts-route">
            {record.fallback_from} → {record.alias}
          </span>
        )}
      </h3>
      <div className="attempt-row attempt-head">
        <span>#</span>
        <span>模型</span>
        <span>连接</span>
        <span>结果</span>
        <span className="num">耗时</span>
        <span>说明</span>
      </div>
      {attempts.map((a, i) => (
        <div key={i} className={'attempt-row attempt-' + a.outcome}>
          <span>{i + 1}</span>
          <code>{a.alias}</code>
          <span>{a.connection_name || '—'}</span>
          <span className={a.outcome === 'served' ? 'good-text' : 'warning-text'}>
            {a.status ? a.status : a.outcome === 'served' ? '200' : '—'}
            {a.error_type ? ' ' + a.error_type : ''}
          </span>
          <span className="num">{a.duration_ms ? (a.duration_ms / 1000).toFixed(2) + 's' : '—'}</span>
          <span>{outcomeLabel[a.outcome] || a.outcome}</span>
        </div>
      ))}
    </section>
  );
}
