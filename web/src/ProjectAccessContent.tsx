import { useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { asrExample } from './asr.mjs';
import { protocolName } from './connection-protocols';
import { isWebTool, webToolExample, webToolPath } from './web-tools.mjs';

type Protocol = 'chat' | 'messages' | 'dashscope-asr' | 'deepseek-search' | 'deepseek-fetch';
type Model = { id: string; alias: string; name?: string; protocols: string[]; enabled: boolean };

type Props = {
  project: { id: string; name: string; enabled: boolean; token_prefix: string; has_saved_token?: boolean };
  baseURL: string;
  models: Model[];
  resolveToken: () => Promise<string>;
  saveToken: (token: string) => Promise<void>;
  rotateToken: () => Promise<void>;
};

const protocolOrder: Protocol[] = ['chat', 'messages', 'dashscope-asr', 'deepseek-search', 'deepseek-fetch'];

export function ProjectAccessContent({ project, baseURL, models, resolveToken, saveToken, rotateToken }: Props) {
  const protocolOptions = protocolOrder.filter(protocol => models.some(model => model.enabled && model.protocols.includes(protocol)));
  const visibleProtocols = protocolOptions.length ? protocolOptions : ['chat' as Protocol];
  const [protocol, setProtocol] = useState<Protocol>(visibleProtocols[0]);
  const [alias, setAlias] = useState(models.find(m => m.enabled)?.alias || '');
  const [existing, setExisting] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fallback, setFallback] = useState('');
  const [showFallback, setShowFallback] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(t); }, [notice]);

  const gatewayBaseURL = baseURL.replace(/\/+$/, '');
  const origin = gatewayBaseURL.replace(/\/v1$/, '');
  const availableModels = models.filter(model => model.enabled && model.protocols.includes(protocol));
  const selectedModel = availableModels.find(model => model.alias === alias) || availableModels[0];
  const selectedAlias = selectedModel?.alias || '';
  const isAsr = protocol === 'dashscope-asr';
  const isWeb = isWebTool(protocol);

  useEffect(() => {
    if (!visibleProtocols.includes(protocol)) setProtocol(visibleProtocols[0]);
  }, [protocol, visibleProtocols.join('|')]);
  useEffect(() => {
    if (selectedModel && selectedModel.alias !== alias) setAlias(selectedModel.alias);
  }, [alias, selectedModel?.alias]);

  function baseURLFor(target: Protocol) {
    return target === 'messages' ? origin : gatewayBaseURL;
  }
  function endpointFor(target: Protocol) {
    if (target === 'dashscope-asr') return `${gatewayBaseURL}/asr/transcriptions`;
    if (isWebTool(target)) return `${gatewayBaseURL}${webToolPath(target)}`;
    return `${origin}/v1/${target === 'messages' ? 'messages' : 'chat/completions'}`;
  }

  function modelsForCopy(target: Protocol, scope: 'current' | 'all'): Model[] {
    const candidates = models.filter(model => model.enabled && model.protocols.includes(target));
    if (scope === 'all') return candidates;
    const current = candidates.find(model => model.alias === selectedAlias);
    return current ? [current] : [];
  }

  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setFallback(''); setShowFallback(false);
    try { await fn(); } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }

  async function copyValue(value: string, message: string) {
    await action(async () => {
      if (!alive.current) return;
      try {
        await navigator.clipboard.writeText(value);
        if (alive.current) setNotice(message);
      } catch {
        if (alive.current) { setFallback(value); setError('浏览器未允许复制，可以显示内容后手动复制。'); }
      }
    });
  }

  async function copyToken() {
    await action(async () => {
      const token = await resolveToken();
      if (!alive.current) return;
      try {
        await navigator.clipboard.writeText(token);
        if (alive.current) setNotice('完整项目 Token 已复制');
      } catch {
        if (alive.current) { setFallback(token); setError('浏览器未允许复制，可以显示内容后手动复制。'); }
      }
    });
  }

  async function copyConfiguration(scope: 'current' | 'all') {
    await action(async () => {
      const token = await resolveToken();
      const blocks = modelsForCopy(protocol, scope).map(model => {
        if (protocol === 'dashscope-asr') {
          const endpoint = endpointFor(protocol);
          return `# ${protocolName(protocol)} · ${model.alias}\nASR_URL=${endpoint}\nAPI_KEY=${token}\nMODEL=${model.alias}\n\nPOST ${endpoint}\nContent-Type: application/json\nAuthorization: Bearer ${token}\n\n${asrExample(model.alias)}`;
        }
        if (isWebTool(protocol)) {
          const endpoint = endpointFor(protocol);
          return `# ${protocolName(protocol)} · ${model.alias}\nURL=${endpoint}\nAPI_KEY=${token}\n\nPOST ${endpoint}\nContent-Type: application/json\nAuthorization: Bearer ${token}\n\n${webToolExample(protocol)}`;
        }
        const title = `${protocolName(protocol)} · ${model.alias}`;
        return `# ${title}\nBASE_URL=${baseURLFor(protocol)}\nAPI_KEY=${token}\nMODEL=${model.alias}`;
      });
      const value = blocks.join('\n\n');
      if (!value) throw new Error('当前没有可复制的模型');
      try {
        await navigator.clipboard.writeText(value);
        if (alive.current) setNotice('完整接入配置已复制');
      } catch {
        if (alive.current) { setFallback(value); setError('浏览器未允许复制，可以显示内容后手动复制。'); }
      }
    });
  }

  function selectProtocol(next: Protocol) {
    setProtocol(next);
  }

  const hasCurrentModel = modelsForCopy(protocol, 'current').length > 0;

  return <div className="project-access-content">
    <p className="access-intro">按协议查看 Base URL、请求端点、项目凭证和授权模型；底部可以复制当前模型或全部模型的完整配置。</p>
    {!project.enabled && <p className="impact">项目已停用。接入信息可以复制，启用项目后才能调用。</p>}

    <nav className="access-tabs" role="tablist" aria-label="接入协议">
      {visibleProtocols.map(item => <button key={item} type="button" role="tab" aria-selected={protocol === item} className={protocol === item ? 'active' : ''} disabled={busy} onClick={() => selectProtocol(item)}>{protocolName(item)}</button>)}
    </nav>

    <section className="access-field">
      <div className="access-field-heading"><h3>Base URL <span>SDK 基础地址</span></h3></div>
      <div className="access-copy-row"><code>{baseURLFor(protocol)}</code><button disabled={busy} onClick={() => copyValue(baseURLFor(protocol), 'Base URL 已复制')}><Copy size={15}/>复制 Base URL</button></div>
      <p className="access-hint">{isAsr ? '用于构造百炼 ASR 请求；直接请求请复制下面的完整端点。' : isWeb ? '搜索和抓取没有 SDK，直接请求下面的完整端点。' : protocol === 'messages' ? 'Anthropic SDK 使用网关根地址，SDK 会自动补充 /v1/messages。' : 'OpenAI 兼容客户端使用包含 /v1 的基础地址，SDK 会自动补充 /chat/completions。'}</p>
    </section>

    <section className="access-field">
      <div className="access-field-heading"><h3>请求端点 <span>Endpoint</span></h3></div>
      <div className="access-copy-row"><code>{endpointFor(protocol)}</code><button disabled={busy} onClick={() => copyValue(endpointFor(protocol), '端点已复制')}><Copy size={15}/>复制端点</button></div>
      <p className="access-hint">{isAsr ? '将百炼原生 JSON 发送到此完整地址，使用项目 Token 进行 Bearer 鉴权。' : isWeb ? '请求体与 DeepSeek 原生接口相同，使用项目 Token 进行 Bearer 鉴权。' : '直接发送 HTTP 请求时使用此完整地址。'}</p>
    </section>

    <section className="access-field">
      <div className="access-field-heading"><h3>项目凭证 <span>API Key</span></h3>
        {project.has_saved_token && <span className="access-saved"><ShieldCheck size={13}/>已加密保管</span>}
      </div>
      <div className="access-copy-row"><code className="access-token"><KeyRound size={16}/>{project.token_prefix || 'gw_'}••••••••</code><button disabled={busy || !project.has_saved_token} onClick={copyToken}><Copy size={15}/>复制 Token</button></div>
      {project.has_saved_token ? <p className="access-hint">复制的是完整 Token。重新登录管理页面后，仍可在这里复制。</p> : <div className="access-legacy">
        <p>此项目由旧版本创建，尚未保存可复制的 Token。粘贴已有 Token 保存后，即可随时复制。</p>
        <form onSubmit={e => { e.preventDefault(); action(async () => { await saveToken(existing); if (alive.current) { setExisting(''); setNotice('已有 Token 已加密保存，正在使用的凭证保持有效'); } }); }}>
          <label className="field" htmlFor="existing-project-token">已有项目 Token<input id="existing-project-token" type="password" autoComplete="off" spellCheck={false} required value={existing} disabled={busy} onChange={e => setExisting(e.target.value)} placeholder="粘贴此项目完整的 gw_ 开头 Token"/></label>
          <button disabled={busy || !existing.trim()}>保存已有 Token</button>
        </form>
        <p className="access-hint">遗失时可在下方重置生成；重置会使旧凭证失效。</p>
      </div>}
    </section>

    <section className="access-field access-model-field">
      <div className="access-field-heading"><h3>授权模型 <span>Model</span></h3><span className="access-count">{availableModels.length} 个{protocolName(protocol)}模型</span></div>
      {availableModels.length ? <div className="access-model-list">
        {availableModels.map(model => <div className={'access-model-item' + (model.alias === selectedAlias ? ' active' : '')} key={model.id} onClick={() => { if (!busy) setAlias(model.alias); }}>
          <label className="access-model-main">
            <input type="radio" name="access-default-model" aria-label={`默认模型 ${model.alias}`} checked={model.alias === selectedAlias} disabled={busy} onChange={() => setAlias(model.alias)}/>
            <span><strong>{model.alias}</strong>{model.name && <small>{model.name}</small>}</span>
          </label>
          <button type="button" className="link" disabled={busy} onClick={event => { event.stopPropagation(); void copyValue(model.alias, '模型名已复制'); }}>复制模型名</button>
        </div>)}
      </div> : <p className="muted">尚未授权此协议的可用模型。</p>}
      {availableModels.length > 1 && <button type="button" className="link access-copy-models" disabled={busy} onClick={() => copyValue(availableModels.map(model => model.alias).join('\n'), '模型列表已复制')}><Copy size={14}/>复制全部模型名</button>}
      {isAsr && <p className="access-hint">音频请求的模型别名也从这里选择；下方会显示对应的原生 JSON 示例。</p>}
    </section>

    {isWeb && <section className="access-field"><h3>请求示例</h3><pre>{webToolExample(protocol)}</pre><p className="access-hint">不用写 model：网关会在此项目的授权里找到启用了该协议的模型。授权了多个时，再加 model 指定。</p></section>}

    {isAsr && <section className="access-field"><h3>音频请求示例</h3><pre>{asrExample(selectedAlias)}</pre><p className="access-hint">替换音频 Base64，format 与文件实际格式保持一致。热词可选；接口接收 JSON。</p></section>}

    <section className="access-unified">
      <div className="access-field-heading"><h3>统一复制 <span>配置范围</span></h3></div>
      <p className="access-hint access-unified-intro">按上方选中的协议生成可直接粘贴的配置；多个模型会分别生成配置块，不会合并到同一个 MODEL 字段。</p>
      <div className="access-copy-actions">
        <button className="primary access-copy-config" disabled={busy || !project.has_saved_token || !hasCurrentModel} onClick={() => copyConfiguration('current')}><Copy size={16}/>{busy ? '正在处理…' : '复制当前模型配置'}</button>
        <button className="access-copy-config" disabled={busy || !project.has_saved_token || !availableModels.length} onClick={() => copyConfiguration('all')}><Copy size={16}/>{busy ? '正在处理…' : '复制全部模型配置'}</button>
      </div>
    </section>

    <div className="access-feedback" aria-live="polite">
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <p className="access-success" role="status"><Check size={15}/>{notice}</p>}
      {fallback && <div className="access-fallback">{showFallback ? <textarea aria-label="待手动复制的内容" readOnly value={fallback} onFocus={e => e.target.select()}/> : <button onClick={() => setShowFallback(true)}>显示内容以手动复制</button>}</div>}
    </div>

    <div className="access-reset">
      {confirmReset ? <>
        <p>重置后，旧 Token 立即失效，已接入的程序需要更新。</p>
        <div><button disabled={busy} onClick={() => setConfirmReset(false)}>取消重置</button><button className="danger-solid" disabled={busy} onClick={() => action(async () => { await rotateToken(); if (alive.current) { setConfirmReset(false); setExisting(''); setNotice('已生成新的 Token，可以复制使用'); } })}>确认重置 Token</button></div>
      </> : <><span>需要更换凭证？</span><button className="link danger" disabled={busy} onClick={() => { setConfirmReset(true); setError(''); setNotice(''); setFallback(''); }}><RefreshCw size={14}/>重置项目 Token</button></>}
    </div>
  </div>;
}
