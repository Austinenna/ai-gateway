import { useEffect, useState, type ReactNode } from 'react';
import type { LimitUsage } from '../health';
import { protocolName } from '../connection-protocols';
import { Segments } from './charts';
import { ViewHead } from './Shell';

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type Project = {
  id: string;
  name: string;
  enabled: boolean;
  token_prefix: string;
  model_ids: string[];
  monthly_budget?: number | null;
  rate_rpm?: number | null;
  rate_burst?: number | null;
  max_concurrent?: number | null;
};
type Model = { id: string; alias: string; enabled: boolean; protocols: string[]; fallback_model_id?: string; connection_id: string };
type Application = {
  id: string;
  project_id: string;
  client: string;
  protocol: string;
  models: string[];
  note: string;
  created: number;
  status: string;
};

const shortProto: Record<string, string> = {
  chat: 'CHAT',
  messages: 'MSG',
  'dashscope-asr': 'ASR',
  'dashscope-tts': 'TTS',
  'deepseek-search': 'SEARCH',
  'deepseek-fetch': 'FETCH',
};
// Small amounts keep four decimals so a few cheap calls do not read as ¥0.00.
// Budgets read in yuan with cents; sub-cent spend shows as ¥0.00.
const money = (v: number) => '¥' + (v >= 100 ? v.toFixed(1) : v.toFixed(2));

/** Projects is the grant matrix plus limits, access and token panels for one project. */
export function Projects({
  api,
  projects,
  models,
  applications,
  usage,
  usable,
  busy,
  onNewProject,
  onSave,
  onDecision,
  onEdit,
  onTest,
  onDelete,
  onAccess,
  accessContent,
}: {
  onAccess: (p: Project) => void;
  api: Api;
  projects: Project[];
  models: Model[];
  applications: Application[];
  usage: Record<string, LimitUsage>;
  usable: (m: Model) => boolean;
  busy: boolean;
  onNewProject: () => void;
  onSave: (p: Project, notice: string) => void;
  onDecision: (a: Application, d: 'approve' | 'reject') => void;
  onEdit: (p: Project) => void;
  onTest: (p: Project) => void;
  onDelete: (p: Project) => void;
  accessContent: (p: Project) => ReactNode;
}) {
  const [selectedId, setSelectedId] = useState(projects[0]?.id || '');
  const [spend, setSpend] = useState<Record<string, number>>({});
  const selected = projects.find((p) => p.id === selectedId) || projects[0];
  const [draft, setDraft] = useState<Project | null>(null);
  useEffect(
    () => setDraft(selected ? { ...selected } : null),
    [selected?.id, selected?.rate_rpm, selected?.rate_burst, selected?.max_concurrent, selected?.monthly_budget],
  );
  useEffect(() => {
    api('/admin/usage?period=month&group_by=project')
      .then((u) => setSpend(Object.fromEntries(((u.groups || []) as { key: string; cost: number }[]).map((g) => [g.key, g.cost]))))
      .catch(() => {});
  }, [projects.length]);
  const byProject = new Map(applications.map((a) => [a.project_id, a]));
  const pending = applications.filter((a) => a.status === 'pending');
  const aliases = new Map(models.map((m) => [m.id, m.alias]));
  const missingFallback = (p: Project) => [
    ...new Set(
      p.model_ids
        .map((id) => models.find((m) => m.id === id)?.fallback_model_id)
        .filter((f): f is string => !!f && !p.model_ids.includes(f)),
    ),
  ];
  const toggle = (p: Project, m: Model) => {
    const on = p.model_ids.includes(m.id);
    onSave(
      { ...p, model_ids: on ? p.model_ids.filter((x) => x !== m.id) : [...p.model_ids, m.id] },
      (on ? '已取消 ' : '已授权 ') + p.name + ' → ' + m.alias,
    );
  };
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="cr-v projects-v">
      <ViewHead page="projects" sub={`${projects.length} 项目${pending.length ? ' · ' + pending.length + ' 待批准' : ''}`}>
        <button type="button" className="kb go" onClick={onNewProject} aria-label="新建项目">
          + 项目
        </button>
      </ViewHead>
      {pending.map((a) => (
        <div className="pend" key={a.id}>
          <span>▲ PENDING</span>
          <span className="zh">
            <b>{a.client}</b> 申请接入 · {protocolName(a.protocol)} · {a.models.join('、')}
            {a.note ? ` · “${a.note}”` : ''} · {new Date(a.created).toLocaleString('zh-CN', { hour12: false })}
          </span>
          <span className="sp" />
          <button type="button" className="kb rd" disabled={busy} onClick={() => onDecision(a, 'reject')}>
            REJECT 拒绝
          </button>
          <button type="button" className="kb go" disabled={busy} onClick={() => onDecision(a, 'approve')}>
            APPROVE 批准
          </button>
        </div>
      ))}
      {!projects.length ? (
        <div className="cr-empty">
          <p className="zh">还没有项目。新建项目、勾选模型权限，再把独立凭证填到你的程序里。</p>
          <button type="button" className="kb go" onClick={onNewProject}>
            新建项目
          </button>
        </div>
      ) : (
        <div className="gm-wrap">
          <table className="gm">
            <thead>
              <tr>
                <th className="pjh">PROJECT</th>
                {models.map((m) => (
                  <th className="m" key={m.id} title={m.alias + ' · ' + m.protocols.map(protocolName).join(' / ')}>
                    <div>
                      {m.alias}
                      <small>
                        {m.fallback_model_id
                          ? '⇢ ' + (aliases.get(m.fallback_model_id) || '?')
                          : m.protocols.map((p) => shortProto[p] || p).join('·')}
                      </small>
                    </div>
                  </th>
                ))}
                <th className="gap" aria-hidden="true" />
                <th className="st">RATE · NOW</th>
                <th className="st">CONCURRENCY · NOW</th>
                <th className="st">BUDGET · 本月</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const app = byProject.get(p.id);
                const isPending = app?.status === 'pending';
                const u = usage[p.id];
                const rpm = p.rate_rpm || 0,
                  conc = p.max_concurrent || 0;
                const used = spend[p.id] || 0;
                const fb = new Set(missingFallback(p));
                return (
                  <tr
                    key={p.id}
                    className={'project-card project-row ' + (selected?.id === p.id ? 'selp ' : '') + (p.enabled ? '' : 'off')}
                    onClick={() => setSelectedId(p.id)}
                    aria-selected={selected?.id === p.id}
                  >
                    <td className="pjn">
                      <span className="zh">{p.name}</span>{' '}
                      <small style={isPending ? { color: 'var(--amber)' } : undefined}>
                        <span className="zh">
                          {isPending ? '待批准' : app?.status === 'rejected' ? '已拒绝' : p.enabled ? '启用' : '停用'}
                        </span>
                        {isPending && <span className="zh"> · 申请 {protocolName(app!.protocol)}</span>}
                      </small>
                      {isPending && (
                        <span className="pend-ops" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="kb rd" disabled={busy} onClick={() => onDecision(app!, 'reject')}>
                            拒绝
                          </button>
                          <button type="button" className="kb go" disabled={busy} onClick={() => onDecision(app!, 'approve')}>
                            批准
                          </button>
                        </span>
                      )}
                    </td>
                    {models.map((m) => {
                      const on = p.model_ids.includes(m.id);
                      const requested = isPending && app!.models.includes(m.alias);
                      const cls = on ? 'on' : requested ? 'req' : fb.has(m.id) ? 'warnc' : !usable(m) ? 'na' : '';
                      return (
                        <td className="c" key={m.id}>
                          <button
                            type="button"
                            className={'cl ' + cls}
                            aria-pressed={on}
                            aria-label={(on ? '取消授权 ' : '授权 ') + p.name + ' 使用 ' + m.alias}
                            title={fb.has(m.id) ? '已授权模型的备用模型，未授权时回退不可用' : !usable(m) ? '模型或连接已停用' : ''}
                            disabled={busy || isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(p, m);
                            }}
                          />
                        </td>
                      );
                    })}
                    <td className="gap" aria-hidden="true" />
                    <td className="st">
                      {rpm ? rpm + '/min' : <span className="dim2">不限</span>}
                      {rpm > 0 && <Segments ratio={(u?.last_minute || 0) / rpm} tone={(u?.last_minute || 0) >= rpm * 0.8 ? 'am' : 'on'} />}
                      <small>
                        {u?.last_minute || 0}
                        {rpm ? '/' + rpm : ''}
                        {u?.limited_since_start ? ' · 限速 ' + u.limited_since_start + ' 次' : ''}
                      </small>
                    </td>
                    <td className="st">
                      {conc ? conc : <span className="dim2">不限</span>}
                      {conc > 0 && <Segments ratio={(u?.inflight || 0) / conc} tone={(u?.inflight || 0) >= conc ? 'am' : 'on'} />}
                      <small>
                        {u?.inflight || 0}
                        {conc ? '/' + conc : ''}
                        {conc && (u?.inflight || 0) >= conc ? ' · 排满' : ''}
                      </small>
                    </td>
                    <td className="st">
                      {money(used)} / {p.monthly_budget ? '¥' + p.monthly_budget : '∞'}
                      <Segments
                        ratio={p.monthly_budget ? used / p.monthly_budget : 0}
                        tone={p.monthly_budget && used / p.monthly_budget >= 0.8 ? 'am' : 'on'}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {selected && missingFallback(selected).length > 0 && (
        <div className="fbw zh">
          ⚠ {selected.name} 已授权的模型配置了备用{' '}
          {missingFallback(selected)
            .map((id) => aliases.get(id))
            .join('、')}
          ，但未授权它们，回退时会直接返回原错误。
          <button
            type="button"
            className="kb"
            disabled={busy}
            onClick={() => onSave({ ...selected, model_ids: [...selected.model_ids, ...missingFallback(selected)] }, '已授权备用模型')}
          >
            授权备用模型
          </button>
        </div>
      )}
      <p className="cap zh">■ 已授权　□ 未授权　⬚ 模型或连接已停用　橙框：备用模型未授权　橙色：申请中 · 点格子即保存</p>
      {selected && draft && (
        <div className="acc acc3">
          <div>
            <div className="h">
              LIMITS<span className="zh">限速与预算 · {selected.name}</span>
              <span className="r">
                <button
                  type="button"
                  className="kb go"
                  disabled={busy}
                  onClick={() =>
                    onSave(
                      {
                        ...draft,
                        rate_rpm: draft.rate_rpm ?? 0,
                        rate_burst: draft.rate_burst ?? 0,
                        max_concurrent: draft.max_concurrent ?? 0,
                      },
                      '限速已保存，后续请求立即生效',
                    )
                  }
                >
                  SAVE
                </button>
              </span>
            </div>
            {(() => {
              const u = usage[selected.id];
              const rpm = selected.rate_rpm || 0,
                conc = selected.max_concurrent || 0,
                used = spend[selected.id] || 0,
                budget = selected.monthly_budget || 0;
              return (
                <div className="lim-now">
                  <div>
                    <label>RATE · NOW</label>
                    <b>
                      {u?.last_minute || 0}
                      <small>{rpm ? ' / ' + rpm : ' / 不限'}</small>
                    </b>
                    <Segments
                      ratio={rpm ? (u?.last_minute || 0) / rpm : 0}
                      tone={rpm && (u?.last_minute || 0) >= rpm * 0.8 ? 'am' : 'on'}
                    />
                    <small>近 1 分钟{u?.limited_since_start ? ' · 已限流 ' + u.limited_since_start : ''}</small>
                  </div>
                  <div>
                    <label>CONCURRENCY</label>
                    <b>
                      {u?.inflight || 0}
                      <small>{conc ? ' / ' + conc : ' / 不限'}</small>
                    </b>
                    <Segments ratio={conc ? (u?.inflight || 0) / conc : 0} tone={conc && (u?.inflight || 0) >= conc ? 'am' : 'on'} />
                    <small>进行中</small>
                  </div>
                  <div>
                    <label>BUDGET · 本月</label>
                    <b>
                      {money(used)}
                      <small>{budget ? ' / ¥' + budget : ' / ∞'}</small>
                    </b>
                    <Segments ratio={budget ? used / budget : 0} tone={budget && used / budget >= 0.8 ? 'am' : 'on'} />
                    <small>超出后拒绝请求</small>
                  </div>
                </div>
              );
            })()}
            <div className="fld">
              <label>RPM · 每分钟请求数</label>
              <div className="in">
                <input
                  type="number"
                  min={0}
                  aria-label="每分钟请求数"
                  value={draft.rate_rpm ?? ''}
                  placeholder="不限"
                  onChange={(e) => setDraft({ ...draft, rate_rpm: num(e.target.value) })}
                />
                <em>留空 = 不限</em>
              </div>
            </div>
            <div className="fld">
              <label>BURST · 突发</label>
              <div className="in">
                <input
                  type="number"
                  min={0}
                  aria-label="突发量"
                  value={draft.rate_burst ?? ''}
                  placeholder="自动"
                  onChange={(e) => setDraft({ ...draft, rate_burst: num(e.target.value) })}
                />
                <em>默认 RPM / 4</em>
              </div>
            </div>
            <div className="fld">
              <label>MAX CONCURRENT · 同时进行</label>
              <div className="in">
                <input
                  type="number"
                  min={0}
                  aria-label="同时进行的请求"
                  value={draft.max_concurrent ?? ''}
                  placeholder="不限"
                  onChange={(e) => setDraft({ ...draft, max_concurrent: num(e.target.value) })}
                />
                <em>流式请求结束前一直占用</em>
              </div>
            </div>
            <div className="fld">
              <label>MONTHLY BUDGET · 月预算（元）</label>
              <div className="in">
                <input
                  type="number"
                  min={0}
                  step="any"
                  aria-label="月预算"
                  value={draft.monthly_budget ?? ''}
                  placeholder="不限"
                  onChange={(e) => setDraft({ ...draft, monthly_budget: num(e.target.value) })}
                />
                <em>用完后拒绝请求</em>
              </div>
            </div>
            <small className="zh lim-note">
              超限立即返回 429 + Retry-After，错误体按 Anthropic / OpenAI 格式，SDK 会自动退避重试。管理员测试不受限。
            </small>
          </div>
          <div>
            <div className="h">
              ACCESS<span className="zh">接入信息 · {selected.name}</span>
            </div>
            <div className="access-embed">{accessContent(selected)}</div>
          </div>
          <div>
            <div className="h">
              PROJECT<span className="zh">项目操作</span>
            </div>
            <div className="danger project-ops">
              <div className="row zh">
                Base URL、Token 与各协议的完整接入配置
                <button type="button" className="kb" onClick={() => onAccess(selected)}>
                  接入信息
                </button>
              </div>
              <div className="row zh">
                以项目身份发一次真实调用
                <button type="button" className="kb" onClick={() => onTest(selected)}>
                  试调用
                </button>
              </div>
              <div className="row zh">
                名称、启用状态与授权明细
                <button type="button" className="kb" onClick={() => onEdit(selected)}>
                  编辑权限
                </button>
              </div>
              <div className="row zh">
                {selected.enabled ? '停用：调用立即被拒绝，记录保留' : '启用：恢复此项目的调用'}
                <button
                  type="button"
                  className={'kb ' + (selected.enabled ? 'am' : 'go')}
                  disabled={busy}
                  onClick={() => onSave({ ...selected, enabled: !selected.enabled }, selected.enabled ? '项目已停用' : '项目已启用')}
                >
                  {selected.enabled ? 'DISABLE' : 'ENABLE'}
                </button>
              </div>
              <div className="row zh">
                删除项目：移除授权，历史请求保留
                <button type="button" className="kb rd" onClick={() => onDelete(selected)}>
                  DELETE
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
