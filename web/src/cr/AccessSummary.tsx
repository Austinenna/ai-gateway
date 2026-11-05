import { useEffect, useState } from 'react';
import { protocolName } from '../connection-protocols';
import { accessBlock, accessURLs, protocolOrder, type Protocol } from '../ProjectAccessContent';
import { FilterSelect } from '../FilterSelect';

type Model = { id: string; alias: string; protocols: string[]; enabled: boolean };

/**
 * AccessSummary is the fixed-height access panel under the grant matrix: protocol
 * chips, one model picker and a paste-ready config block with the token masked.
 * The full access drawer stays available for saving or replacing a token.
 */
export function AccessSummary({
  project,
  baseURL,
  models,
  resolveToken,
}: {
  project: { id: string; token_prefix: string };
  baseURL: string;
  models: Model[];
  resolveToken: () => Promise<string>;
}) {
  const protocols = protocolOrder.filter((p) => models.some((m) => m.enabled && m.protocols.includes(p)));
  const [protocol, setProtocol] = useState<Protocol>(protocols[0] || 'chat');
  const available = models.filter((m) => m.enabled && m.protocols.includes(protocol));
  const [alias, setAlias] = useState(available[0]?.alias || '');
  const [notice, setNotice] = useState('');
  const current = available.find((m) => m.alias === alias) || available[0];
  useEffect(() => {
    if (protocols.length && !protocols.includes(protocol)) setProtocol(protocols[0]);
  }, [protocols.join('|')]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  async function copy(scope: 'current' | 'all') {
    try {
      const token = await resolveToken();
      const list = scope === 'all' ? available : current ? [current] : [];
      if (!list.length) throw new Error('当前协议下没有可复制的模型');
      await navigator.clipboard.writeText(list.map((m) => accessBlock(baseURL, protocol, m.alias, token)).join('\n\n'));
      setNotice(scope === 'all' ? `已复制 ${list.length} 个模型的配置` : '已复制当前配置');
    } catch (e) {
      setNotice((e as Error).message || '复制失败，请在接入信息里手动复制');
    }
  }

  if (!protocols.length) return <p className="acc-empty zh">此项目还没有授权可用的模型。先在上方矩阵里勾选模型。</p>;
  const masked = project.token_prefix + '••••••••';
  const preview = current ? accessBlock(baseURL, protocol, current.alias, masked) : '';
  // Long request examples (ASR/TTS/web tools) are copied in full but previewed only up to the request line.
  const shown = preview.split('\n\n')[0];
  return (
    <div className="acc-sum">
      <div className="proto" role="group" aria-label="接入协议">
        {protocols.map((p) => (
          <button key={p} type="button" className={p === protocol ? 'on' : ''} aria-pressed={p === protocol} onClick={() => setProtocol(p)}>
            {protocolName(p)}
          </button>
        ))}
        <div className="acc-pick">
          <FilterSelect
            label="接入模型"
            value={current?.alias || ''}
            onChange={setAlias}
            options={available.map((m) => ({ value: m.alias, label: m.alias }))}
          />
        </div>
      </div>

      <pre className="acc-code">
        {shown.split('\n').map((line, i) => {
          const eq = line.indexOf('=');
          return (
            <span key={i} className="cfg-line">
              {line.startsWith('#') || eq < 0 ? (
                <span className="cm">{line}</span>
              ) : (
                <>
                  <span className="k">{line.slice(0, eq)}</span>=<span className="v">{line.slice(eq + 1)}</span>
                </>
              )}
              {'\n'}
            </span>
          );
        })}
      </pre>
      <div className="acc-actions">
        <button type="button" className="kb go" onClick={() => copy('current')}>
          复制当前配置
        </button>
        <button type="button" className="kb" onClick={() => copy('all')} disabled={available.length < 2}>
          复制全部 {available.length} 个
        </button>
        <span className="acc-note zh" role="status">
          {notice || '复制时填入完整 Token · 端点 ' + accessURLs(baseURL, protocol).endpoint.replace(/^https?:\/\/[^/]+/, '')}
        </span>
      </div>
    </div>
  );
}
