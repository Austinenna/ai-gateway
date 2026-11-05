import { useEffect, useState, type ReactNode } from 'react';
import { formatBytes, formatUptime, type Runtime } from '../health';

export type CrPage = 'overview' | 'requests' | 'tasks' | 'diagnostics' | 'costs' | 'models' | 'projects' | 'chat' | 'system';

export const crLabels: Record<CrPage, string> = {
  overview: '总览',
  requests: '请求',
  tasks: '任务',
  diagnostics: '异常诊断',
  costs: '成本与预算',
  models: '连接与模型',
  projects: '项目与权限',
  chat: '调试台',
  system: '数据与系统',
};
export const crTitles: Record<CrPage, [string, string]> = {
  overview: ['OVERVIEW', '总览'],
  requests: ['REQUESTS', '请求记录'],
  tasks: ['TASKS', '任务记录'],
  diagnostics: ['DIAGNOSTICS', '异常诊断'],
  costs: ['COSTS', '成本与预算'],
  models: ['ROUTING', '连接与模型'],
  projects: ['PROJECTS', '项目与权限'],
  chat: ['CONSOLE', '调试台'],
  system: ['SYSTEM', '数据与系统'],
};
const groups: [string, CrPage[]][] = [
  ['OBSERVE', ['overview', 'requests', 'tasks', 'diagnostics', 'costs']],
  ['CONFIG', ['models', 'projects']],
  ['TOOLS', ['chat', 'system']],
];
export const crNumber = Object.fromEntries(groups.flatMap(([, p]) => p).map((p, i) => [p, String(i + 1).padStart(2, '0')])) as Record<
  CrPage,
  string
>;

export type RailBadge = { text: string; hot?: boolean };

/** TopBar is the full-width ticker: identity, live counters, clock. */
export function TopBar({ runtime, mode, host, extra }: { runtime: Runtime | null; mode: string; host: string; extra?: ReactNode }) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const breakers = runtime ? Object.keys(runtime.breakers).length : 0;
  return (
    <header className="top" role="status" aria-label="网关运行状态">
      <div className="logo">
        <i />
        AIGW/01
      </div>
      <div className="ticker">
        <span className="ok">
          <b>ONLINE</b>
        </span>
        <span>
          UPTIME <b>{runtime ? formatUptime(runtime.now - runtime.started_at) : '—'}</b>
        </span>
        <span>
          RPM <b>{runtime?.last_minute ?? '—'}</b>
        </span>
        <span>
          并发 <b>{runtime?.inflight ?? '—'}</b>
        </span>
        <span>
          DB <b>{runtime ? formatBytes(runtime.db_bytes) : '—'}</b>
        </span>
        {breakers > 0 && (
          <span style={{ color: 'var(--amber)' }}>
            BREAKER <b style={{ color: 'var(--amber)' }}>{breakers}</b>
          </span>
        )}
        <span className="zh">{mode}</span>
        <span>{host}</span>
      </div>
      {extra}
      <div className="clock">{clock.toTimeString().slice(0, 8)}</div>
    </header>
  );
}

/** Rail is the numbered navigation; the footer carries build and refresh facts. */
export function Rail({
  page,
  onNavigate,
  badges,
  foot,
  onLogout,
}: {
  page: CrPage;
  onNavigate: (p: CrPage) => void;
  badges: Partial<Record<CrPage, RailBadge>>;
  foot: ReactNode;
  onLogout: () => void;
}) {
  return (
    <nav className="rail" id="workspace-navigation" aria-label="工作空间">
      {groups.map(([group, pages]) => (
        <div key={group} className="rail-group">
          <h6>// {group}</h6>
          {pages.map((p) => (
            <button
              key={p}
              type="button"
              className={'rail-link' + (page === p ? ' on' : '')}
              aria-current={page === p ? 'page' : undefined}
              aria-label={crLabels[p] + (badges[p] ? '，' + badges[p]!.text : '')}
              onClick={() => onNavigate(p)}
            >
              <em aria-hidden="true">{crNumber[p]}</em>
              <span className="zh">{crLabels[p]}</span>
              {badges[p] && <b className={badges[p]!.hot ? 'hot' : ''}>{badges[p]!.text}</b>}
            </button>
          ))}
        </div>
      ))}
      <div className="foot">
        {foot}
        <button type="button" className="rail-logout" onClick={onLogout} aria-label="退出管理">
          LOGOUT · 退出管理
        </button>
      </div>
    </nav>
  );
}

/** ViewHead is the compact per-page title bar used instead of a large page heading. */
export function ViewHead({ page, sub, children }: { page: CrPage; sub?: ReactNode; children?: ReactNode }) {
  const [en, zh] = crTitles[page];
  return (
    <div className="vh">
      <h1>
        <span aria-hidden="true">{en}</span>
        <span className="zh">{zh}</span>
      </h1>
      {sub && <span className="vh-sub zh">· {sub}</span>}
      <span className="r">{children}</span>
    </div>
  );
}
