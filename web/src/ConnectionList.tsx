import { Eye, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { connectionProtocols, protocolName } from './connection-protocols';

type ConnectionInfo = { id: string; name: string; provider: string; endpoints: Record<string, string>; enabled: boolean; has_token?: boolean };
const providerName = (provider: string) => ({ zhipu: '智谱', minimax: 'MiniMax', deepseek: 'DeepSeek', custom: '自定义', demo: '本地演示' }[provider] || provider);

export function ConnectionList<T extends ConnectionInfo>({ connections, onEdit, onReveal, onDelete }: {
  connections: T[];
  onEdit: (connection: T) => void;
  onReveal: (connection: T) => void;
  onDelete: (connection: T) => void;
}) {
  return <section className="panel connections-panel" aria-label="厂商连接列表">
    <table className="connections-table">
      <colgroup><col className="connection-name-col"/><col/><col className="connection-credential-col"/><col className="connection-state-col"/><col className="connection-actions-col"/></colgroup>
      <thead><tr><th scope="col">连接 / 厂商</th><th scope="col">协议 / 端点</th><th scope="col">凭据</th><th scope="col">状态</th><th scope="col" className="connection-actions-heading">操作</th></tr></thead>
      <tbody>{connections.map(c => <tr key={c.id} className="connection-row">
        <td className="connection-identity"><strong>{c.name}</strong><span>{providerName(c.provider)}</span></td>
        <td className="connection-endpoint" data-label="协议 / 端点">{connectionProtocols(c).map(p => <div className="connection-protocol" key={p}><span>{protocolName(p)}</span><code>{c.endpoints[p]}</code></div>)}</td>
        <td className="connection-credential" data-label="凭据"><div className="connection-token">
          <span><KeyRound size={14}/>{c.provider === 'demo' ? '无需 Token' : c.has_token ? '已配置' : '未配置'}</span>
          {c.provider !== 'demo' && <button className="link" onClick={() => onReveal(c)}><Eye size={14}/>解锁查看</button>}
        </div></td>
        <td className="connection-state"><span className={'model-state ' + (c.enabled ? 'is-enabled' : '')}>{c.enabled ? '已启用' : '已停用'}</span></td>
        <td className="connection-operations"><div className="connection-actions">
          <button onClick={() => onEdit(c)}><Pencil size={15}/>编辑</button>
          <button className="danger" onClick={() => onDelete(c)}><Trash2 size={15}/>删除</button>
        </div></td>
      </tr>)}</tbody>
    </table>
  </section>;
}
