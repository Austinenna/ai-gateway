import { Activity, Pencil, Plug, Trash2 } from 'lucide-react';

type ModelInfo = { id: string; name: string; alias: string; upstream_model: string; connection_id: string; enabled: boolean };
type ConnectionInfo = { id: string; name: string; enabled: boolean };

export function ModelList<T extends ModelInfo>({ models, connections, onEdit, onTest, onDelete }: {
  models: T[]; connections: ConnectionInfo[];
  onEdit: (model: T) => void; onTest: (model: T) => void; onDelete: (model: T) => void;
}) {
  const byID = new Map(connections.map(c => [c.id, c]));
  return <section className="panel models-panel">
    <table className="models-table">
      <colgroup><col className="col-model"/><col className="col-upstream"/><col className="col-connection"/><col className="col-status"/><col className="col-actions"/></colgroup>
      <thead><tr><th scope="col">模型 / 调用别名</th><th scope="col">厂商模型 ID</th><th scope="col">所属连接</th><th scope="col">状态</th><th scope="col" className="actions-heading">操作</th></tr></thead>
      <tbody>{models.map(m => <tr key={m.id}>
        <td className="model-identity"><strong>{m.name}</strong><code>{m.alias}</code></td>
        <td className="model-upstream" data-label="厂商模型 ID"><code>{m.upstream_model}</code></td>
        <td className="model-connection" data-label="所属连接"><span><Plug size={14}/>{byID.get(m.connection_id)?.name || '连接不可用'}</span></td>
        <td className="model-status"><span className={'model-state '+(m.enabled && byID.get(m.connection_id)?.enabled ? 'is-enabled' : '')}>{!m.enabled ? '已停用' : !byID.get(m.connection_id)?.enabled ? '连接停用' : '已启用'}</span></td>
        <td className="model-operations"><div className="model-actions">
          <button onClick={() => onEdit(m)}><Pencil size={15}/>编辑</button>
          <button onClick={() => onTest(m)} disabled={!m.enabled || !byID.get(m.connection_id)?.enabled}><Activity size={15}/>测试</button>
          <button className="danger" onClick={() => onDelete(m)}><Trash2 size={15}/>删除</button>
        </div></td>
      </tr>)}</tbody>
    </table>
  </section>;
}
