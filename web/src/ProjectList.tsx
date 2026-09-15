import { Copy, ShieldCheck, Terminal, Trash2 } from 'lucide-react';

type ProjectInfo = { id: string; name: string; token_prefix: string; enabled: boolean; model_ids: string[] };
type ModelInfo = { id: string; alias: string };

export function ProjectList<T extends ProjectInfo>({ projects, models, onEdit, onAccess, onTest, onDelete }: {
  projects: T[];
  models: ModelInfo[];
  onEdit: (project: T) => void;
  onAccess: (project: T) => void;
  onTest: (project: T) => void;
  onDelete: (project: T) => void;
}) {
  const aliases = new Map(models.map(m => [m.id, m.alias]));
  return <section className="panel projects-panel" aria-label="项目列表">
    <table className="projects-table">
      <colgroup><col className="project-name-col"/><col className="project-models-col"/><col className="project-state-col"/><col className="project-actions-col"/></colgroup>
      <thead><tr><th scope="col">项目 / 凭证</th><th scope="col">授权模型</th><th scope="col">状态</th><th scope="col" className="project-actions-heading">操作</th></tr></thead>
      <tbody>{projects.map(p => <tr key={p.id} className="project-card project-row">
        <td className="project-identity-cell"><div className="project-identity">
          <span className="project-symbol"><Terminal size={18}/></span>
          <div><strong>{p.name}</strong><code>{p.token_prefix}••••••••</code></div>
        </div></td>
        <td className="project-grants-cell" data-label="授权模型">
          <div className="project-grants">{p.model_ids.length ? p.model_ids.map(id => <code className="project-grant-chip" key={id}>{aliases.get(id) || id}</code>) : <span className="project-no-grants">尚未授权模型</span>}</div>
        </td>
        <td className="project-state-cell"><span className={'project-state ' + (p.enabled ? 'is-enabled' : '')}><span className="dot"/>{p.enabled ? '启用' : '停用'}</span></td>
        <td className="project-actions-cell"><div className="project-row-actions">
          <button className="project-access-action" onClick={() => onAccess(p)}><Copy size={14}/>接入信息</button>
          <button onClick={() => onEdit(p)}><ShieldCheck size={14}/>编辑权限</button>
          <button onClick={() => onTest(p)}><Terminal size={14}/>试调用</button>
          <button className="danger project-delete-action" onClick={() => onDelete(p)}><Trash2 size={14}/>删除</button>
        </div></td>
      </tr>)}</tbody>
    </table>
  </section>;
}
