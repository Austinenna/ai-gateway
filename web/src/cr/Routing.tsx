import { useEffect, useState } from 'react';
import { connectionProtocols, modelProtocols, protocolName } from '../connection-protocols';
import { bucketClass, formatAgo, type ConnectionHealth } from '../health';
import type { ModelPrice } from '../costs';
import { ViewHead } from './Shell';

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type Conn = {
  id: string;
  name: string;
  provider: string;
  endpoints: Record<string, string>;
  enabled: boolean;
  has_token?: boolean;
  use_proxy?: boolean;
};
type Model = {
  id: string;
  name: string;
  alias: string;
  connection_id: string;
  protocols: string[];
  upstream_model: string;
  context_window?: number;
  enabled: boolean;
  prices?: ModelPrice[];
  fallback_model_id?: string;
};
type ModelStat = { model_id: string; alias: string; requests: number; failed: number; ttft: { p50: number | null } };

const providerName: Record<string, string> = {
  zhipu: '智谱',
  minimax: 'MiniMax',
  deepseek: 'DeepSeek',
  dashscope: '阿里百炼',
  custom: '自定义',
  demo: '本地演示',
};
const shortProto: Record<string, string> = {
  chat: 'chat',
  messages: 'messages',
  'dashscope-asr': 'asr',
  'dashscope-tts': 'tts',
  'deepseek-search': 'search',
  'deepseek-fetch': 'fetch',
};
const allProtocols = ['chat', 'messages', 'dashscope-asr', 'dashscope-tts', 'deepseek-search', 'deepseek-fetch'];

function priceText(m: Model) {
  const p = [...(m.prices || [])].filter((x) => x.effective_from <= Date.now()).sort((a, b) => b.effective_from - a.effective_from)[0];
  if (!p) return '未定价';
  if (p.audio_per_minute != null) return `¥${p.audio_per_minute}/min`;
  if (p.per_10k_characters != null) return `¥${p.per_10k_characters}/万字`;
  if (p.input_per_mtok != null || p.output_per_mtok != null) return `${p.input_per_mtok ?? '—'} · ${p.output_per_mtok ?? '—'}`;
  if (p.per_call != null) return `¥${p.per_call}/次`;
  return '未定价';
}

function healthPill(h?: ConnectionHealth, enabled = true): [string, string] {
  if (!enabled) return ['', 'DISABLED'];
  if (!h) return ['', 'UNKNOWN'];
  if (h.breaker_until && h.breaker_until > Date.now())
    return ['am', `DEGRADED · BREAKER ${Math.ceil((h.breaker_until - Date.now()) / 1000)}s`];
  return (
    {
      ok: ['ok', 'NOMINAL'],
      degraded: ['am', 'DEGRADED'],
      down: ['rd', 'DOWN'],
      auth: ['rd', 'KEY FAIL'],
      unknown: ['', 'UNKNOWN'],
      disabled: ['', 'DISABLED'],
    } as Record<string, [string, string]>
  )[h.state];
}

/** Routing shows each provider connection as a rack with its models inside. */
export function Routing({
  api,
  connections,
  models,
  health,
  probing,
  outboundProxy,
  onProbe,
  onEditConnection,
  onDeleteConnection,
  onReveal,
  onNewModel,
  onEditModel,
  onTestModel,
  onToggleModel,
  onNewConnection,
  proxyPanel,
}: {
  api: Api;
  connections: Conn[];
  models: Model[];
  health: Record<string, ConnectionHealth>;
  probing: string;
  outboundProxy: string;
  onProbe: (c: Conn) => void;
  onEditConnection: (c: Conn) => void;
  onDeleteConnection: (c: Conn) => void;
  onReveal: (c: Conn) => void;
  onNewModel: (connectionId: string) => void;
  onEditModel: (m: Model) => void;
  onTestModel: (m: Model) => void;
  onToggleModel: (m: Model) => void;
  onNewConnection: () => void;
  proxyPanel: React.ReactNode;
}) {
  const [stats, setStats] = useState<Record<string, ModelStat>>({});
  useEffect(() => {
    let disposed = false;
    const load = () =>
      api('/admin/metrics?window=24h')
        .then((m) => {
          if (!disposed) setStats(Object.fromEntries(((m.models || []) as ModelStat[]).map((s) => [s.model_id, s])));
        })
        .catch(() => {});
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10000);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, []);
  const aliasByID = new Map(models.map((m) => [m.id, m.alias]));
  const usedAsFallback = (id: string) => models.filter((m) => m.fallback_model_id === id).length;
  return (
    <div className="cr-v routing">
      <ViewHead page="models" sub={`${connections.length} 连接 · ${models.length} 别名`}>
        <span className="zh dim2">出站代理 {outboundProxy ? 'ON' : 'OFF'}</span>
        <button type="button" className="kb" onClick={onNewConnection} aria-label="新增连接">
          + 连接
        </button>
        <button type="button" className="kb go" onClick={() => onNewModel('')} disabled={!connections.length} aria-label="新增模型">
          + 模型
        </button>
      </ViewHead>
      {!connections.length && (
        <div className="cr-empty">
          <p className="zh">还没有厂商连接。先添加一个连接（端点 + Token），模型挂在连接下面。</p>
          <button type="button" className="kb go" onClick={onNewConnection}>
            + 添加厂商连接
          </button>
        </div>
      )}
      <div className="racks">
        {connections.map((c) => {
          const h = health[c.id];
          const [tone, label] = healthPill(h, c.enabled);
          const protos = connectionProtocols(c);
          const total = h ? h.window.ok + h.window.failed + h.window.rate_limited + h.window.auth_failed - h.window.probes : 0;
          const rackModels = models.filter((m) => m.connection_id === c.id);
          return (
            <div className="rack" key={c.id}>
              <div className="connection-row">
                <div className="rack-h">
                  <span className={'sq ' + (tone === 'am' || tone === 'rd' ? 'am' : '')} title={providerName[c.provider] || c.provider}>
                    {(providerName[c.provider] || c.name).slice(0, 1)}
                  </span>
                  <div>
                    <div className="zh">{c.name}</div>
                    <div className="ep">
                      {[...new Set(protos.map((p) => c.endpoints[p]).filter(Boolean))].join(' · ')}
                      {c.use_proxy ? ' · 走代理' : ''}
                    </div>
                  </div>
                  <span className={'pill ' + tone}>{label}</span>
                  <span className="rack-actions">
                    <button type="button" className="kb" onClick={() => onEditConnection(c)}>
                      编辑
                    </button>
                    <button type="button" className="kb rd" onClick={() => onDeleteConnection(c)}>
                      删除
                    </button>
                  </span>
                </div>
                <div className="hl">
                  <span className={tone === 'am' || tone === 'rd' ? 'warn-t' : ''}>
                    {h?.reason && h.state !== 'unknown' && h.state !== 'ok' ? h.reason + ' · ' : ''}
                    {total > 0 ? `被动：近 ${h!.window_minutes} 分钟 ${total} 次` : '被动：暂无调用'}
                  </span>
                  <span>
                    {h?.last_probe
                      ? `探测：${formatAgo(h.last_probe.at)} ${h.last_probe.status || ''} ${h.last_probe.ok ? 'OK' : h.last_probe.message}`
                      : h && !h.probe_supported
                        ? '探测：仅被动（无模型列表接口）'
                        : '探测：空闲时自动进行'}
                  </span>
                  {(h?.probe_supported ?? true) && c.enabled && (
                    <button
                      type="button"
                      className="kb"
                      onClick={() => onProbe(c)}
                      disabled={probing === c.id}
                      aria-label={'探测 ' + c.name}
                    >
                      {probing === c.id ? 'PROBING…' : 'PROBE'}
                    </button>
                  )}
                </div>
                <div className="pl">
                  {allProtocols
                    .filter((p) => protos.includes(p))
                    .map((p) => (
                      <span className="on" key={p} title={protocolName(p) + ' · ' + c.endpoints[p]}>
                        {shortProto[p]}
                      </span>
                    ))}
                  <span className="key">
                    KEY {c.provider === 'demo' ? '无需' : c.has_token ? '已配置' : '未配置'}
                    {c.provider !== 'demo' && (
                      <button type="button" className="link-btn" onClick={() => onReveal(c)}>
                        解锁查看
                      </button>
                    )}
                  </span>
                </div>
                <div className="blocks" aria-label="近 24 小时健康">
                  {(h?.buckets || Array.from({ length: 48 }, () => null)).map((b, i) => (
                    <i key={i} className={b ? { ok: '', degraded: 'a', down: 'r', auth: 'k', idle: 'n' }[bucketClass(b)] : 'n'} />
                  ))}
                </div>
              </div>
              <div className="mt-wrap">
                <table className="mt rack-models">
                  <thead>
                    <tr>
                      <th>ON</th>
                      <th>ALIAS</th>
                      <th>UPSTREAM</th>
                      <th className="n">¥/M</th>
                      <th className="n">24H</th>
                      <th className="n">TTFT</th>
                      <th>FALLBACK</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rackModels.map((m) => {
                      const st = stats[m.id];
                      const usable = m.enabled && c.enabled && modelProtocols(m, c).length > 0;
                      return (
                        <tr key={m.id} onClick={() => onEditModel(m)} title="编辑模型">
                          <td>
                            <button
                              type="button"
                              className={'tg' + (m.enabled ? ' on' : '')}
                              aria-label={(m.enabled ? '停用 ' : '启用 ') + m.alias}
                              aria-pressed={m.enabled}
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleModel(m);
                              }}
                            />
                          </td>
                          <td style={{ color: usable ? 'var(--tx)' : 'var(--dim)' }}>
                            {m.alias}
                            {m.name && m.name !== m.alias && <small className="zh">{m.name}</small>}
                          </td>
                          <td>
                            {m.upstream_model}
                            <small className="zh">
                              {m.context_window ? `上下文 ${m.context_window.toLocaleString('en-US')} Token` : '上下文未设置'}
                            </small>
                          </td>
                          <td className="n">{priceText(m)}</td>
                          <td className="n">{st?.requests ?? 0}</td>
                          <td className="n">{st?.ttft.p50 == null ? '—' : (st.ttft.p50 / 1000).toFixed(2) + 's'}</td>
                          <td
                            style={{ color: m.fallback_model_id ? 'var(--amber)' : 'var(--dim)' }}
                            title={usedAsFallback(m.id) ? `被 ${usedAsFallback(m.id)} 个模型用作备用` : undefined}
                          >
                            {m.fallback_model_id
                              ? '⇢ ' + (aliasByID.get(m.fallback_model_id) || '已删除')
                              : usedAsFallback(m.id)
                                ? `⇠ ×${usedAsFallback(m.id)}`
                                : '—'}
                          </td>
                          <td className="row-actions">
                            <span className="model-actions">
                              <button
                                type="button"
                                className="kb"
                                disabled={!usable}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onTestModel(m);
                                }}
                              >
                                测试
                              </button>
                              <button
                                type="button"
                                className="kb"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onEditModel(m);
                                }}
                              >
                                编辑
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="rack-f">
                <button type="button" className="add" onClick={() => onNewModel(c.id)}>
                  ＋ 在此连接下添加模型
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="routing-proxy">{proxyPanel}</div>
    </div>
  );
}
