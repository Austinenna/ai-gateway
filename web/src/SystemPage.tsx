import { ViewHead } from './cr/Shell';
import { useEffect, useState } from 'react';
import { formatBytes } from './health';

type Settings = {
  body_days: number;
  summary_days: number;
  cleanup_hour: number;
  health_window_minutes: number;
  degraded_ratio: number;
  down_streak: number;
  probe_idle_minutes: number;
  breaker_seconds: number;
  default_rpm: number;
  default_concurrent: number;
};
type Storage = {
  file_bytes: number;
  page_bytes: number;
  free_bytes: number;
  body_bytes: number;
  body_rows: number;
  summary_bytes: number;
  summary_rows: number;
  rollup_bytes: number;
  rollup_days: number;
  oldest_body?: number;
  oldest_summary?: number;
  auto_vacuum: string;
};
type LogEntry = {
  id: number;
  started: number;
  kind: string;
  detail: {
    trigger: string;
    bodies: number;
    summaries: number;
    rolled_days: number;
    reclaimed_bytes: number;
    size_before_bytes: number;
    size_after_bytes: number;
    duration_ms: number;
    status: string;
    error?: string;
  };
};
type System = { settings: Settings; storage: Storage; log: LogEntry[]; next_cleanup: number; schema_ext: number };

const triggerLabel: Record<string, string> = { schedule: '定时', startup: '启动', manual: '手动', migration: '升级' };
const when = (ms: number) =>
  new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function NumberField({
  label,
  unit,
  hint,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  unit: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="ret sys-field">
      <span className="zh">{label}</span>
      <input
        className="in"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <em className="zh">{unit}</em>
      <small className="zh">{hint}</small>
    </label>
  );
}

export function SystemPage({
  api,
  onNotice,
  onError,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  onNotice: (s: string) => void;
  onError: (s: string) => void;
}) {
  const [sys, setSys] = useState<System | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState('');
  const load = () =>
    api('/admin/system')
      .then((s: System) => {
        setSys(s);
        setDraft((d) => d ?? s.settings);
      })
      .catch((e: Error) => onError(e.message));
  useEffect(() => {
    load();
  }, []);
  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  if (!sys || !draft)
    return (
      <div className="cr-v">
        <ViewHead page="system" />
        <p className="cr-empty zh">正在读取数据与系统信息…</p>
      </div>
    );
  const st = sys.storage;
  const other = Math.max(0, st.page_bytes - st.body_bytes - st.summary_bytes - st.rollup_bytes - st.free_bytes);
  const total = Math.max(1, st.page_bytes);
  const pct = (n: number) => (n / total) * 100 + '%';
  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(sys.settings);
  const SaveButtons = () => (
    <>
      <button type="button" className="kb" onClick={() => setDraft(sys.settings)} disabled={!!busy || !dirty}>
        撤销修改
      </button>
      <button
        type="button"
        className="kb go"
        disabled={!!busy || !dirty}
        onClick={() =>
          act('save', async () => {
            const s = await api('/admin/settings', 'PUT', draft);
            setDraft(s);
            onNotice('设置已保存');
            await load();
          })
        }
      >
        保存设置
      </button>
    </>
  );
  return (
    <div className="cr-v">
      <ViewHead page="system" sub={'SQLite · ' + (st.auto_vacuum === 'incremental' ? 'auto_vacuum INCREMENTAL' : st.auto_vacuum)}>
        <button
          type="button"
          className="kb"
          disabled={!!busy}
          onClick={() =>
            act('vacuum', async () => {
              const d = await api('/admin/maintenance/vacuum', 'POST', {});
              onNotice('已回收 ' + formatBytes(d.reclaimed_bytes));
              await load();
            })
          }
        >
          {busy === 'vacuum' ? '回收中…' : '回收空间'}
        </button>
        <button
          type="button"
          className="kb am"
          disabled={!!busy}
          onClick={() =>
            act('cleanup', async () => {
              const d = await api('/admin/maintenance/cleanup', 'POST', {});
              onNotice(`清理完成：删除正文 ${d.bodies} 条，汇总摘要 ${d.summaries} 条`);
              await load();
            })
          }
        >
          {busy === 'cleanup' ? '清理中…' : '立即清理'}
        </button>
      </ViewHead>
      <section className="board system-page-board">
        <div className="p c12">
          <div className="h">
            STORAGE<span className="zh">数据库占用 · {formatBytes(st.file_bytes)}</span>
            <span className="r">
              下次定时清理 {when(sys.next_cleanup)}
              {st.oldest_body ? ` · 最早正文 ${when(st.oldest_body)}` : ''}
              {st.oldest_summary ? ` · 最早摘要 ${when(st.oldest_summary)}` : ''}
            </span>
          </div>
          <div className="stor" aria-hidden="true">
            <i style={{ width: pct(st.body_bytes), background: 'var(--go)' }} />
            <i style={{ width: pct(st.summary_bytes), background: 'var(--cyan)' }} />
            <i style={{ width: pct(st.rollup_bytes), background: '#c77dff' }} />
            <i style={{ width: pct(other), background: 'var(--dim)' }} />
            <i
              style={{ width: pct(st.free_bytes), background: 'repeating-linear-gradient(45deg,var(--line-2) 0 3px,transparent 3px 6px)' }}
            />
          </div>
          <div className="storl">
            <span>
              <b style={{ background: 'var(--go)' }} />
              请求正文 {formatBytes(st.body_bytes)} · {st.body_rows.toLocaleString()} 条
            </span>
            <span>
              <b style={{ background: 'var(--cyan)' }} />
              监控摘要 {formatBytes(st.summary_bytes)} · {st.summary_rows.toLocaleString()} 条
            </span>
            <span>
              <b style={{ background: '#c77dff' }} />
              按天汇总 {formatBytes(st.rollup_bytes)} · {st.rollup_days} 天
            </span>
            <span>
              <b style={{ background: 'var(--dim)' }} />
              配置与索引 {formatBytes(other)}
            </span>
            <span>
              <b style={{ background: 'var(--line-2)' }} />
              可回收空闲页 {formatBytes(st.free_bytes)}
            </span>
          </div>
        </div>
        <div className="p c5">
          <div className="h">
            RETENTION<span className="zh">保留策略</span>
            <span className="r">
              <SaveButtons />
            </span>
          </div>
          <NumberField
            label="请求正文"
            unit="天"
            min={1}
            max={3650}
            value={draft.body_days}
            onChange={(v) => set({ body_days: v })}
            hint="到期删除正文；详情仍显示摘要和指标，并标注“正文已过期清理”。"
          />
          <NumberField
            label="监控摘要"
            unit="天"
            min={62}
            max={3650}
            value={draft.summary_days}
            onChange={(v) => set({ summary_days: v })}
            hint="到期前先汇总进按天汇总再删除；至少 62 天，本月预算需要完整的当月数据。"
          />
          <NumberField
            label="清理时间"
            unit="点"
            min={0}
            max={23}
            value={draft.cleanup_hour}
            onChange={(v) => set({ cleanup_hour: v })}
            hint="每天这个整点运行一次；网关启动后 30 秒也会运行一次。"
          />
        </div>
        <div className="p c7">
          <div className="h">
            CLEANUP LOG<span className="zh">清理记录</span>
          </div>
          <table className="sys-log">
            <thead>
              <tr>
                <th>RUN</th>
                <th>TYPE</th>
                <th className="n">BODIES</th>
                <th className="n">SUMMARIES→DAILY</th>
                <th className="n">RECLAIMED</th>
                <th className="n">TOOK</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {sys.log.length ? (
                sys.log.slice(0, 8).map((e) => (
                  <tr key={e.id}>
                    <td>{when(e.started)}</td>
                    <td>
                      {e.kind === 'vacuum' ? '回收空间' : '清理'} · {triggerLabel[e.detail.trigger] || e.detail.trigger}
                    </td>
                    <td className="n">{e.kind === 'cleanup' ? e.detail.bodies : '—'}</td>
                    <td className="n">{e.kind === 'cleanup' ? e.detail.summaries : '—'}</td>
                    <td className="n">{formatBytes(e.detail.reclaimed_bytes)}</td>
                    <td className="n">{(e.detail.duration_ms / 1000).toFixed(1)}s</td>
                    <td className={e.detail.status === 'ok' ? 'good-text' : 'warning-text'} title={e.detail.error}>
                      {e.detail.status === 'ok' ? '完成' : '失败'}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="muted">
                    还没有清理记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="p c6">
          <div className="h">
            HEALTH CHECK<span className="zh">连接健康检查</span>
          </div>
          <NumberField
            label="观察窗口"
            unit="分钟"
            min={1}
            max={120}
            value={draft.health_window_minutes}
            onChange={(v) => set({ health_window_minutes: v })}
            hint="按这段时间内的真实调用判断，不额外花钱。"
          />
          <NumberField
            label="降级失败率"
            unit="比例"
            min={0.01}
            max={1}
            step={0.05}
            value={draft.degraded_ratio}
            onChange={(v) => set({ degraded_ratio: v })}
            hint="失败占比超过它，或出现 429，记为降级。"
          />
          <NumberField
            label="故障判定"
            unit="次连续"
            min={1}
            max={100}
            value={draft.down_streak}
            onChange={(v) => set({ down_streak: v })}
            hint="连续连接失败、超时或 5xx 达到次数记为故障；401/403 记为 Key 失效。"
          />
          <NumberField
            label="主动探测"
            unit="分钟"
            min={0}
            max={1440}
            value={draft.probe_idle_minutes}
            onChange={(v) => set({ probe_idle_minutes: v })}
            hint="连接这么久没有调用时，用 GET /models 探测一次；0 表示关闭。不计费、不进请求记录。"
          />
          <NumberField
            label="熔断时长"
            unit="秒"
            min={1}
            max={3600}
            value={draft.breaker_seconds}
            onChange={(v) => set({ breaker_seconds: v })}
            hint="429 或故障后，这段时间内配置了备用模型的请求直接走备用；上游给了 Retry-After 时以它为准。"
          />
        </div>
        <div className="p c6">
          <div className="h">
            DEFAULTS<span className="zh">新项目默认限速</span>
          </div>
          <NumberField
            label="每分钟请求"
            unit="次"
            min={0}
            max={100000}
            value={draft.default_rpm}
            onChange={(v) => set({ default_rpm: v })}
            hint="新建项目和接入申请创建的项目使用这个值；突发量默认为它的 1/4。0 表示不限。"
          />
          <NumberField
            label="同时进行"
            unit="个"
            min={0}
            max={1000}
            value={draft.default_concurrent}
            onChange={(v) => set({ default_concurrent: v })}
            hint="流式请求在结束前一直占用名额。0 表示不限。已有项目不受影响。"
          />
        </div>
      </section>
    </div>
  );
}
