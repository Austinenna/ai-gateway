import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Layers3, Plug, RefreshCw, Trash2, X } from 'lucide-react';

type LinkedModel = { id: string; name: string; alias: string; upstream_model: string; enabled: boolean };
type ProjectInfo = { id: string; name: string; model_ids: string[] };

export function ConnectionDeleteContent({ name, endpoint, models, projects, busy, error, onClose, onDeleteAll, onDeleteModel, onRefresh }: {
  name: string; endpoint: string; models: LinkedModel[]; projects: ProjectInfo[]; busy: boolean; error: string;
  onClose: () => void; onDeleteAll: () => void; onDeleteModel: (id: string) => Promise<boolean>; onRefresh: () => void;
}) {
  const [pending, setPending] = useState('');
  useEffect(() => { if (pending && !models.some(m => m.id === pending)) setPending(''); }, [models, pending]);
  const affected = projects.filter(p => p.model_ids.some(id => models.some(m => m.id === id)));
  return <div className="connection-delete-content">
    <div className="connection-delete-summary"><span className="connection-delete-icon"><Plug size={22}/></span><div><h3>{name}</h3><code>{endpoint}</code></div><span className="linked-count">{models.length} 个模型</span></div>
    <div className="linked-section-heading"><h3>关联模型</h3><button className="link" disabled={busy} onClick={onRefresh}><RefreshCw size={14}/>刷新列表</button></div>
    <div className="linked-model-list" aria-label="关联模型列表">
      {models.length ? models.map(m => {
        const grants = projects.filter(p => p.model_ids.includes(m.id));
        return <div className={'linked-model '+(pending === m.id ? 'pending-delete' : '')} key={m.id}>
          <span className="linked-model-icon"><Layers3 size={17}/></span>
          <div className="linked-model-info"><div className="linked-model-title"><b>{m.name}</b><span className={'model-state '+(m.enabled ? 'is-enabled' : '')}>{m.enabled ? '已启用' : '已停用'}</span></div><code>{m.alias}</code><p>厂商模型：<code>{m.upstream_model}</code></p><p>{grants.length ? '授权项目：'+grants.map(p => p.name).join('、') : '尚未授权给项目'}</p></div>
          <div className="linked-model-actions">{pending === m.id ? <><span>删除模型并移除授权？</span><div><button disabled={busy} className="danger" onClick={async () => { if (await onDeleteModel(m.id)) setPending(''); }}><Check size={14}/>确认删除</button><button disabled={busy} aria-label="取消删除此模型" onClick={() => setPending('')}><X size={14}/></button></div></> : <button className="danger" disabled={busy} onClick={() => setPending(m.id)}><Trash2 size={14}/>删除模型</button>}</div>
        </div>;
      }) : <div className="linked-empty"><Check size={20}/><p>已无关联模型，可以直接删除厂商连接。</p></div>}
    </div>
    <div className="cascade-impact"><AlertTriangle size={17}/><div><b>{models.length ? `将删除此连接及以上 ${models.length} 个模型` : '将删除此厂商连接'}</b><p>{affected.length ? `同时移除 ${affected.length} 个项目对这些模型的授权。` : ''}项目和历史请求会保留。</p><p>网关保存的厂商 Token 一并移除，此操作无法撤销。</p></div></div>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="connection-delete-footer"><button data-initial-focus="" disabled={busy} onClick={onClose}>取消</button><button className="danger-solid" disabled={busy || !!pending} onClick={onDeleteAll}><Trash2 size={16}/>{busy ? '正在处理…' : models.length ? `删除厂商及 ${models.length} 个模型` : '删除厂商连接'}</button></div>
  </div>;
}
