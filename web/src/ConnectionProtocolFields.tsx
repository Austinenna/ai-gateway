import { useEffect, useState } from 'react';
import { protocols, protocolName, templateEndpoint } from './connection-protocols';
import { isWebTool } from './web-tools.mjs';

const endpointSuffix: Record<string, string> = { chat: '/chat/completions', messages: '/messages', 'dashscope-asr': '/services/aigc/multimodal-generation/generation', 'deepseek-search': '/tools/search', 'deepseek-fetch': '/tools/fetch' };
const offered = (provider: string, protocol: string) => provider === 'dashscope' ? protocol === 'dashscope-asr' : provider === 'custom' || (protocol !== 'dashscope-asr' && (provider === 'deepseek' || !isWebTool(protocol)));

export function ConnectionProtocolFields({ provider, endpoints, onChange }: {
  provider: string; endpoints: Record<string, string>; onChange: (endpoints: Record<string, string>) => void;
}) {
  const [inactive, setInactive] = useState<Record<string, string>>({});
  useEffect(() => setInactive({}), [provider]);
  return <fieldset className="protocol-fields"><legend>协议与端点</legend>
    <p className="muted small">至少启用一种协议；多个协议共用此连接的 Token，分别填写基础端点。</p>
    {protocols.filter(p => offered(provider, p)).map(protocol => {
      const enabled = Object.hasOwn(endpoints, protocol);
      return <div className="protocol-endpoint-field" key={protocol}>
        <label className="check"><input type="checkbox" checked={enabled} disabled={provider === 'demo'} onChange={e => {
          const next = { ...endpoints };
          if (e.target.checked) next[protocol] = inactive[protocol] ?? templateEndpoint(provider, protocol);
          else { setInactive(current => ({ ...current, [protocol]: next[protocol] })); delete next[protocol]; }
          onChange(next);
        }}/>{protocolName(protocol)}</label>
        {enabled && <label className="field"><span>{protocolName(protocol)} 基础端点</span>
          <input required value={endpoints[protocol]} disabled={provider === 'demo'} placeholder="https://example.com/v1" onChange={e => onChange({ ...endpoints, [protocol]: e.target.value })}/>
          <small>含版本路径，不含 {endpointSuffix[protocol]}。远程使用 HTTPS，本机可用回环 HTTP。</small>
        </label>}
      </div>;
    })}
    {!Object.keys(endpoints).length && <p className="error" role="alert">请至少启用一种协议并填写端点。</p>}
  </fieldset>;
}
