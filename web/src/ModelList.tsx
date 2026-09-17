import { PricingSummary, type ModelPricing } from './pricing';
import { Activity, Copy, Pencil, Plug, Trash2 } from 'lucide-react';
import { modelProtocols, protocolName } from './connection-protocols';

type ModelInfo = { pricing?: ModelPricing; id: string; name: string; alias: string; upstream_model: string; connection_id: string; enabled: boolean; protocols: string[] };
type ConnectionInfo = { id: string; name: string; enabled: boolean; endpoints: Record<string, string> };

export function ModelList<T extends ModelInfo>({ models, connections, onEdit, onTest, onDelete, onCopyAlias }: {
  models: T[]; connections: ConnectionInfo[];
  onEdit: (model: T) => void; onTest: (model: T) => void; onDelete: (model: T) => void;
  onCopyAlias: (alias: string) => void;
}) {
  const byID = new Map(connections.map(c => [c.id, c]));
  return <section className="panel models-panel">
    <table className="models-table">
      <colgroup><col className="col-model"/><col className="col-upstream"/><col className="col-connection"/><col className="col-status"/><col className="col-actions"/></colgroup>
      <thead><tr><th scope="col">模型 / 调用别名</th><th scope="col">厂商模型 ID / 价格</th><th scope="col">所属连接</th><th scope="col">状态</th><th scope="col" className="actions-heading">操作</th></tr></thead>
      <tbody>{models.map(m => <tr key={m.id}>
        <td className="model-identity"><strong>{m.name}</strong><div className="model-alias"><code>{m.alias}</code><button type="button" className="model-alias-copy" title="复制调用别名" aria-label={'复制调用别名 '+m.alias} onClick={() => onCopyAlias(m.alias)}><Copy size={14}/></button></div></td>
        <td className="model-upstream" data-label="模型与计费"><code>{m.upstream_model}</code><div className="model-price-summary"><PricingSummary pricing={m.pricing}/></div></td>
        <td className="model-connection" data-label="所属连接"><span><Plug size={14}/>{byID.get(m.connection_id)?.name || '连接不可用'}</span><small className="model-protocols">{modelProtocols(m, byID.get(m.connection_id)).map(protocolName).join(' / ') || '无可用协议'}</small></td>
        <td className="model-status"><span className={'model-state '+(m.enabled && byID.get(m.connection_id)?.enabled && modelProtocols(m, byID.get(m.connection_id)).length ? 'is-enabled' : '')}>{!m.enabled ? '已停用' : !byID.get(m.connection_id)?.enabled ? '连接停用' : !modelProtocols(m, byID.get(m.connection_id)).length ? '协议不可用' : '已启用'}</span></td>
        <td className="model-operations"><div className="model-actions">
          <button onClick={() => onEdit(m)}><Pencil size={15}/>编辑</button>
          <button onClick={() => onTest(m)} disabled={!m.enabled || !byID.get(m.connection_id)?.enabled || !modelProtocols(m, byID.get(m.connection_id)).length}><Activity size={15}/>测试</button>
          <button className="danger" onClick={() => onDelete(m)}><Trash2 size={15}/>删除</button>
        </div></td>
      </tr>)}</tbody>
    </table>
  </section>;
}
