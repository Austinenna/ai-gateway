import { useEffect, useState } from 'react';
import { formatBytes, formatUptime, type Runtime } from './health';

/** StatusBar is the control-room strip above every page. */
export function StatusBar({
  api,
  host,
  runtime,
  onRuntime,
}: {
  api: (path: string) => Promise<Runtime>;
  host: string;
  runtime: Runtime | null;
  onRuntime: (r: Runtime) => void;
}) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let disposed = false;
    const load = () =>
      api('/admin/runtime')
        .then((r) => {
          // Ignore malformed replies instead of breaking the whole console.
          if (!disposed && r && typeof r.started_at === 'number') onRuntime({ ...r, breakers: r.breakers || {}, limits: r.limits || {} });
        })
        .catch(() => {});
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, []);
  const breakers = runtime ? Object.keys(runtime.breakers).length : 0;
  return (
    <div className="status-bar" role="status" aria-label="网关运行状态">
      <span className="sb-online">
        <i aria-hidden="true" />
        在线
      </span>
      <span>
        运行 <b>{runtime ? formatUptime(runtime.now - runtime.started_at) : '—'}</b>
      </span>
      <span>
        近 1 分钟 <b>{runtime?.last_minute ?? '—'}</b> 次
      </span>
      <span>
        进行中 <b>{runtime?.inflight ?? '—'}</b>
      </span>
      <span>
        数据库 <b>{runtime ? formatBytes(runtime.db_bytes) : '—'}</b>
      </span>
      {breakers > 0 && (
        <span className="sb-warn">
          熔断中 <b>{breakers}</b> 个连接
        </span>
      )}
      <span className="sb-host">{host}</span>
      <span className="sb-clock">{clock.toTimeString().slice(0, 8)}</span>
    </div>
  );
}
