import { useEffect, useState } from 'react';
import { Coins, RefreshCw, Wallet, Receipt, AlertTriangle } from 'lucide-react';
import { type BudgetStatus, type UsageReport, costStatusName, costText, uncertainText, yuan } from './costs';
import { dateTime, number } from './monitoring';

type ProjectOption = { id: string; name: string; monthly_budget?: number | null };
type Props = { projects: ProjectOption[]; onSelect: (id: string) => void; onEditProject: (id: string) => void };

const periods = [
  ['today', '今天'],
  ['month', '本月'],
  ['last_month', '上月'],
  ['30d', '近 30 天'],
  ['all', '全部'],
];
const groupings = [
  ['project', '按项目'],
  ['model', '按模型'],
  ['category', '按用途'],
  ['task', '按任务'],
  ['day', '按日期'],
  ['request', '单次调用'],
];

async function usage(params: URLSearchParams, signal?: AbortSignal): Promise<UsageReport> {
  const response = await fetch('/api/admin/usage?' + params, { credentials: 'same-origin', signal });
  const value = await response.json();
  if (!response.ok || !value.total) throw new Error(value.error?.message || '成本数据暂时不可用');
  return value;
}

function BudgetRow({ project, budget, onEdit }: { project: ProjectOption; budget?: BudgetStatus; onEdit: () => void }) {
  const limit = project.monthly_budget,
    spent = budget?.month_spent ?? 0;
  const ratio = limit ? Math.min(100, (100 * spent) / limit) : 0;
  return (
    <div className={'budget-row' + (budget?.exceeded ? ' exceeded' : ratio >= 80 ? ' warning' : '')}>
      <div className="budget-name">
        <b>{project.name}</b>
        <small>{limit ? (budget?.exceeded ? '已超出，新请求被拒绝' : `剩余 ${yuan(budget?.remaining)}`) : '不限预算'}</small>
      </div>
      <div className="budget-bar" role="img" aria-label={limit ? `已用 ${ratio.toFixed(0)}%` : '不限预算'}>
        <i style={{ width: `${ratio}%` }} />
      </div>
      <div className="budget-amount">
        <b>{yuan(spent)}</b>
        <small>{limit ? `/ ${yuan(limit)}` : '本月'}</small>
      </div>
      <button type="button" className="link" onClick={onEdit}>
        调整
      </button>
    </div>
  );
}

export function CostPage({ projects, onSelect, onEditProject }: Props) {
  const [period, setPeriod] = useState('month'),
    [project, setProject] = useState(''),
    [groupBy, setGroupBy] = useState('project');
  const [data, setData] = useState<UsageReport | null>(null),
    [budgets, setBudgets] = useState<Record<string, BudgetStatus>>({});
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const projectKey = projects.map((p) => p.id + ':' + (p.monthly_budget ?? '')).join(',');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ period, group_by: groupBy });
    if (project) params.set('project_id', project);
    usage(params, controller.signal)
      .then((value) => {
        setData(value);
        setError('');
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [period, project, groupBy, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all(
      projects.map((p) =>
        usage(new URLSearchParams({ period: 'month', project_id: p.id }), controller.signal).then((v) => [p.id, v.budget] as const),
      ),
    )
      .then((list) => setBudgets(Object.fromEntries(list.filter(([, b]) => b)) as Record<string, BudgetStatus>))
      .catch(() => {});
    return () => controller.abort();
  }, [projectKey, refresh]);

  const t = data?.total,
    uncertain = t ? uncertainText(t) : '';
  const groupLabel = groupings.find(([v]) => v === groupBy)?.[1].replace('按', '') || '';
  return (
    <div className="monitor-overview cost-page">
      <div className="monitor-toolbar">
        <div className="monitor-range" aria-label="成本时间范围">
          {periods.map(([v, label]) => (
            <button key={v} aria-pressed={period === v} onClick={() => setPeriod(v)}>
              {label}
            </button>
          ))}
        </div>
        <span className="monitor-refresh">
          <span className={'dot ' + (error ? 'offline' : '')} />
          {error ? '读取失败' : loading ? '正在更新' : '按 Asia/Shanghai 自然日、自然月统计'}
        </span>
        <button className="icon-btn" aria-label="刷新成本" onClick={() => setRefresh((v) => v + 1)} disabled={loading}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="monitor-filters">
        <label>
          <span>项目</span>
          <select aria-label="成本项目" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {t && (
        <div className="monitor-cards">
          <section className="metric-card">
            <div className="metric-label">
              估算费用
              <Wallet size={17} />
            </div>
            <div className="metric-value">
              <strong>{yuan(t.cost)}</strong>
              <span>{t.requests ? `${number(t.requests)} 次调用` : '暂无调用'}</span>
            </div>
            <div className="metric-foot">
              {uncertain ? (
                <span className="danger">
                  <AlertTriangle size={12} /> {uncertain}，未计入
                </span>
              ) : (
                <span>全部调用均已定价</span>
              )}
            </div>
          </section>
          <section className="metric-card">
            <div className="metric-label">
              Token 用量
              <Coins size={17} />
            </div>
            <div className="metric-value">
              <div className="metric-pair">
                <div>
                  <strong>{number(t.input_tokens + t.cache_read_tokens + t.cache_write_tokens)}</strong>
                  <span>输入（含缓存）</span>
                </div>
                <div>
                  <strong>{number(t.output_tokens)}</strong>
                  <span>输出</span>
                </div>
              </div>
            </div>
            <div className="metric-foot">
              <span>
                缓存读取 <b>{number(t.cache_read_tokens)}</b>
              </span>
              <span>
                缓存写入 <b>{number(t.cache_write_tokens)}</b>
              </span>
            </div>
          </section>
          <section className="metric-card">
            <div className="metric-label">
              语音转写
              <Receipt size={17} />
            </div>
            <div className="metric-value">
              <strong>{number(t.audio_seconds / 60, 1)}</strong>
              <span>分钟音频</span>
            </div>
            <div className="metric-foot">
              <span>按厂商返回的音频时长计</span>
            </div>
          </section>
        </div>
      )}
      {projects.some((p) => p.monthly_budget) || Object.keys(budgets).length ? (
        <section className="panel cost-budgets">
          <div className="panel-head">
            <h2>本月预算</h2>
            <span className="muted small">用完后网关拒绝该项目的新请求（HTTP 402），下月 1 日自动恢复</span>
          </div>
          <div className="budget-list">
            {projects
              .filter((p) => !project || p.id === project)
              .map((p) => (
                <BudgetRow key={p.id} project={p} budget={budgets[p.id]} onEdit={() => onEditProject(p.id)} />
              ))}
          </div>
        </section>
      ) : null}
      <section className="panel cost-breakdown">
        <div className="panel-head">
          <h2>费用明细</h2>
          <div className="cost-groupings" role="group" aria-label="明细分组">
            {groupings.map(([v, label]) => (
              <button key={v} aria-pressed={groupBy === v} onClick={() => setGroupBy(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {groupBy === 'request' ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间 / 项目</th>
                  <th>模型</th>
                  <th>用途 / 任务</th>
                  <th>费用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data?.requests || []).map((r) => (
                  <tr key={r.id}>
                    <td>
                      {dateTime(r.started)}
                      <small>{r.project_name}</small>
                    </td>
                    <td>
                      <code>{r.model || '—'}</code>
                    </td>
                    <td>
                      {r.category || '未标记'}
                      <small>{r.task || '—'}</small>
                    </td>
                    <td title={costStatusName(r.cost.status)}>{costText(r.cost)}</td>
                    <td>
                      <button className="table-link" onClick={() => onSelect(r.id)}>
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data?.has_more && <p className="monitor-empty-note">只显示最近 200 次调用，可缩小时间范围或筛选项目。</p>}
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{groupLabel}</th>
                  <th>调用</th>
                  <th>输入 / 输出 Token</th>
                  <th>音频</th>
                  <th>费用</th>
                </tr>
              </thead>
              <tbody>
                {(data?.groups || []).map((g) => (
                  <tr key={g.key}>
                    <td>
                      {g.label}
                      {groupBy === 'task' && g.key && g.key !== g.label && <small>{g.key}</small>}
                    </td>
                    <td>
                      {number(g.requests)}
                      {uncertainText(g) && <small className="danger">{uncertainText(g)}</small>}
                    </td>
                    <td>
                      {number(g.input_tokens + g.cache_read_tokens + g.cache_write_tokens)} / {number(g.output_tokens)}
                    </td>
                    <td>{g.audio_seconds ? `${number(g.audio_seconds / 60, 1)} 分钟` : '—'}</td>
                    <td>
                      <b>{yuan(g.cost)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && !data.total.requests && <p className="monitor-empty-note">这段时间没有到达厂商的调用。</p>}
      </section>
      <details className="monitor-definitions">
        <summary>统计口径与项目接入</summary>
        <p>
          费用 = 用量 × 模型单价，按调用开始时生效的价格版本估算，不是厂商账单。文本模型按输入、缓存读取、缓存写入、输出 Token
          分别计价；百炼 ASR
          按音频分钟；搜索／抓取按成功调用次数。没有到达厂商的请求（鉴权失败、预算拒绝等）不计费；未定价或厂商未报告用量的调用单独列出，不当作
          0。
        </p>
        <p>
          用途和任务来自调用方请求头：<code>X-Gateway-Category</code>（如 note、router）与 <code>X-Gateway-Task-ID</code>（如作品
          ID），可选，限 128 个字母、数字或 <code>._:-</code>。各项目用自己的 Token 调用 <code>GET /v1/usage</code>{' '}
          查询本项目用量与预算，参数见文档 docs/usage-costs.md。
        </p>
      </details>
    </div>
  );
}
