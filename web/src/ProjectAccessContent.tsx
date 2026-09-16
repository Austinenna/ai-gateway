import { useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';

type Props = {
  project: { id: string; name: string; enabled: boolean; token_prefix: string; has_saved_token?: boolean };
  baseURL: string;
  models: { id: string; alias: string; protocols: string[]; enabled: boolean }[];
  resolveToken: () => Promise<string>;
  saveToken: (token: string) => Promise<void>;
  rotateToken: () => Promise<void>;
};

export function ProjectAccessContent({ project, baseURL, models, resolveToken, saveToken, rotateToken }: Props) {
  const [protocol, setProtocol] = useState(models.find(m => m.enabled && m.protocols.length)?.protocols[0] || 'chat');
  const [alias, setAlias] = useState(models[0]?.alias || '');
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
  const endpoint = protocol === 'messages' ? baseURL.replace(/\/v1\/?$/, '') : baseURL;
  const availableModels = models.filter(m => m.enabled && m.protocols.includes(protocol));
  const selectedAlias = availableModels.some(m => m.alias === alias) ? alias : availableModels[0]?.alias || '';

  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setFallback(''); setShowFallback(false);
    try { await fn(); } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  async function copy(kind: 'endpoint' | 'token' | 'all') {
    await action(async () => {
      let value = endpoint;
      if (kind !== 'endpoint') {
        const token = await resolveToken();
        value = kind === 'token' ? token : `BASE_URL=${endpoint}\nAPI_KEY=${token}\nMODEL=${selectedAlias}`;
      }
      if (!alive.current) return;
      try {
        await navigator.clipboard.writeText(value);
        if (alive.current) setNotice(kind === 'endpoint' ? '网关端点已复制' : kind === 'token' ? '完整项目 Token 已复制' : '接入配置已复制');
      } catch {
        if (alive.current) { setFallback(value); setError('浏览器未允许复制，可以显示内容后手动复制。'); }
      }
    });
  }

  return <div className="project-access-content">
    <p className="access-intro">把端点和 Token 填入程序，模型名称使用下面的调用别名。</p>
    {!project.enabled && <p className="impact">项目已停用。接入信息可以复制，启用项目后才能调用。</p>}
    <section className="access-field">
      <div className="access-field-heading"><label htmlFor="access-protocol">网关端点 <span>Base URL</span></label>
        <select id="access-protocol" aria-label="客户端协议" value={protocol} disabled={busy} onChange={e => setProtocol(e.target.value)}>
          <option value="chat">Chat Completions</option><option value="messages">Anthropic SDK</option>
        </select>
      </div>
      <div className="access-copy-row"><code>{endpoint}</code><button disabled={busy} onClick={() => copy('endpoint')}><Copy size={15}/>复制端点</button></div>
      <p className="access-hint">{protocol === 'messages' ? 'Anthropic SDK 会自动添加 /v1/messages。' : '适用于 OpenAI 兼容客户端，调用 /v1/chat/completions。'}</p>
    </section>

    <section className="access-field">
      <div className="access-field-heading"><h3>项目 Token <span>API Key</span></h3>
        {project.has_saved_token && <span className="access-saved"><ShieldCheck size={13}/>已加密保管</span>}
      </div>
      <div className="access-copy-row"><code className="access-token"><KeyRound size={16}/>{project.token_prefix || 'gw_'}••••••••</code><button disabled={busy || !project.has_saved_token} onClick={() => copy('token')}><Copy size={15}/>复制 Token</button></div>
      {project.has_saved_token ? <p className="access-hint">复制的是完整 Token。重新登录管理页面后，仍可在这里复制。</p> : <div className="access-legacy">
        <p>此项目由旧版本创建，尚未保存可复制的 Token。粘贴已有 Token 保存后，即可随时复制。</p>
        <form onSubmit={e => { e.preventDefault(); action(async () => { await saveToken(existing); if (alive.current) { setExisting(''); setNotice('已有 Token 已加密保存，正在使用的凭证保持有效'); } }); }}>
          <label className="field" htmlFor="existing-project-token">已有项目 Token<input id="existing-project-token" type="password" autoComplete="off" spellCheck={false} required value={existing} disabled={busy} onChange={e => setExisting(e.target.value)} placeholder="粘贴此项目完整的 gw_ 开头 Token"/></label>
          <button disabled={busy || !existing.trim()}>保存已有 Token</button>
        </form>
        <p className="access-hint">遗失时可在下方重置生成；重置会使旧凭证失效。</p>
      </div>}
    </section>

    <section className="access-field">
      <div className="access-field-heading"><label htmlFor="access-model">模型别名 <span>Model</span></label></div>
      <select id="access-model" value={selectedAlias} disabled={busy || !availableModels.length} onChange={e => setAlias(e.target.value)}>
        {!availableModels.length && <option value="">尚未授权此协议的模型</option>}
        {availableModels.map(m => <option key={m.id} value={m.alias}>{m.alias}{m.enabled ? '' : ' · 已停用'}</option>)}
      </select>
    </section>

    <div className="access-feedback" aria-live="polite">
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <p className="access-success" role="status"><Check size={15}/>{notice}</p>}
      {fallback && <div className="access-fallback">{showFallback ? <textarea aria-label="待手动复制的内容" readOnly value={fallback} onFocus={e => e.target.select()}/> : <button onClick={() => setShowFallback(true)}>显示内容以手动复制</button>}</div>}
    </div>
    <button className="primary access-copy-all" disabled={busy || !project.has_saved_token || !selectedAlias} onClick={() => copy('all')}><Copy size={16}/>{busy ? '正在处理…' : '复制完整接入配置'}</button>
    <p className="access-hint access-format">包含 BASE_URL、API_KEY 和 MODEL，可粘贴到配置文件。</p>

    <div className="access-reset">
      {confirmReset ? <>
        <p>重置后，旧 Token 立即失效，已接入的程序需要更新。</p>
        <div><button disabled={busy} onClick={() => setConfirmReset(false)}>取消重置</button><button className="danger-solid" disabled={busy} onClick={() => action(async () => { await rotateToken(); if (alive.current) { setConfirmReset(false); setExisting(''); setNotice('已生成新的 Token，可以复制使用'); } })}>确认重置 Token</button></div>
      </> : <><span>需要更换凭证？</span><button className="link danger" disabled={busy} onClick={() => { setConfirmReset(true); setError(''); setNotice(''); setFallback(''); }}><RefreshCw size={14}/>重置项目 Token</button></>}
    </div>
  </div>;
}
