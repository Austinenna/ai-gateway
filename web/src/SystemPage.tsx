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
    <label className="sys-field">
      <span className="sys-label">{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <em>{unit}</em>
      <small>{hint}</small>
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
  if (!sys || !draft) return <p className="muted">正在读取数据与系统信息…</p>;
  const st = sys.storage;
  const other = Math.max(0, st.page_bytes - st.body_bytes - st.summary_bytes - st.rollup_bytes - st.free_bytes);
  const total = Math.max(1, st.page_bytes);
  const pct = (n: number) => (n / total) * 100 + '%';
  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  return (
    <div className="system-page">
      <section className="panel sys-panel">
        <div className="panel-head">
          <h2>数据库占用 · {formatBytes(st.file_bytes)}</h2>
          <div className="actions">
            <button
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
              className="primary"
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
          </div>
        </div>
        <div className="storage-bar" aria-hidden="true">
          <i className="sb-body" style={{ width: pct(st.body_bytes) }} />
          <i className="sb-summary" style={{ width: pct(st.summary_bytes) }} />
          <i className="sb-rollup" style={{ width: pct(st.rollup_bytes) }} />
          <i className="sb-other" style={{ width: pct(other) }} />
          <i className="sb-free" style={{ width: pct(st.free_bytes) }} />
        </div>
        <div className="storage-legend">
          <span>
            <b className="sb-body" />
            请求正文 {formatBytes(st.body_bytes)} · {st.body_rows.toLocaleString()} 条
          </span>
          <span>
            <b className="sb-summary" />
            监控摘要 {formatBytes(st.summary_bytes)} · {st.summary_rows.toLocaleString()} 条
          </span>
          <span>
            <b className="sb-rollup" />
            按天汇总 {formatBytes(st.rollup_bytes)} · {st.rollup_days} 天
          </span>
          <span>
            <b className="sb-other" />
            配置与索引 {formatBytes(other)}
          </span>
          <span>
            <b className="sb-free" />
            可回收空闲页 {formatBytes(st.free_bytes)}
          </span>
        </div>
        <p className="muted small sys-note">
          回收方式：{st.auto_vacuum === 'incremental' ? '增量回收（清理后自动归还空间）' : st.auto_vacuum} · 下次定时清理{' '}
          {when(sys.next_cleanup)}
          {st.oldest_body ? ` · 最早正文 ${when(st.oldest_body)}` : ''}
          {st.oldest_summary ? ` · 最早摘要 ${when(st.oldest_summary)}` : ''}
        </p>
      </section>

      <div className="sys-grid">
        <section className="panel sys-panel">
          <div className="panel-head">
            <h2>保留策略</h2>
          </div>
          <div className="sys-fields">
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
        </section>
        <section className="panel sys-panel">
          <div className="panel-head">
            <h2>清理记录</h2>
          </div>
          <div className="table-scroll">
            <table className="sys-log">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th className="num">正文</th>
                  <th className="num">摘要→汇总</th>
                  <th className="num">回收</th>
                  <th className="num">耗时</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {sys.log.length ? (
                  sys.log.map((e) => (
                    <tr key={e.id}>
                      <td>{when(e.started)}</td>
                      <td>
                        {e.kind === 'vacuum' ? '回收空间' : '清理'} · {triggerLabel[e.detail.trigger] || e.detail.trigger}
                      </td>
                      <td className="num">{e.kind === 'cleanup' ? e.detail.bodies : '—'}</td>
                      <td className="num">{e.kind === 'cleanup' ? e.detail.summaries : '—'}</td>
                      <td className="num">{formatBytes(e.detail.reclaimed_bytes)}</td>
                      <td className="num">{(e.detail.duration_ms / 1000).toFixed(1)}s</td>
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
        </section>
        <section className="panel sys-panel">
          <div className="panel-head">
            <h2>连接健康检查</h2>
          </div>
          <div className="sys-fields">
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
        </section>
        <section className="panel sys-panel">
          <div className="panel-head">
            <h2>新项目默认限速</h2>
          </div>
          <div className="sys-fields">
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
      <div className="sys-save">
        <button
          type="button"
          onClick={() => setDraft(sys.settings)}
          disabled={!!busy || JSON.stringify(draft) === JSON.stringify(sys.settings)}
        >
          撤销修改
        </button>
        <button
          className="primary"
          disabled={!!busy || JSON.stringify(draft) === JSON.stringify(sys.settings)}
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
      </div>
    </div>
  );
}
