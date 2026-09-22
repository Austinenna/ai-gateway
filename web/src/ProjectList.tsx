import { Check, Copy, ShieldCheck, Terminal, Trash2, X } from 'lucide-react';

import { protocolName } from './connection-protocols';

type ProjectInfo = { id: string; name: string; token_prefix: string; enabled: boolean; model_ids: string[] };
export type ProjectApplication = { id:string; project_id:string; client:string; protocol:string; models:string[]; note:string; created:number; decided:number; status:'pending'|'approved'|'rejected' };
type ModelInfo = { id: string; alias: string };

export function ProjectList<T extends ProjectInfo>({ projects, models, applications = [], deciding = false, onDecision, onEdit, onAccess, onTest, onDelete }: {
  projects: T[];
  applications?: ProjectApplication[];
  deciding?: boolean;
  onDecision?: (application: ProjectApplication, decision: 'approve'|'reject') => void;
  models: ModelInfo[];
  onEdit: (project: T) => void;
  onAccess: (project: T) => void;
  onTest: (project: T) => void;
  onDelete: (project: T) => void;
}) {
  const aliases = new Map(models.map(m => [m.id, m.alias]));
  const byProject = new Map(applications.map(a => [a.project_id, a]));
  return <section className="panel projects-panel" aria-label="项目列表">
    <table className="projects-table">
      <colgroup><col className="project-name-col"/><col className="project-models-col"/><col className="project-state-col"/><col className="project-actions-col"/></colgroup>
      <thead><tr><th scope="col">项目 / 凭证</th><th scope="col">授权模型</th><th scope="col">状态</th><th scope="col" className="project-actions-heading">操作</th></tr></thead>
      <tbody>{projects.map(p => { const application=byProject.get(p.id); const pending=application?.status==='pending'; const rejected=application?.status==='rejected'; return <tr key={p.id} className={'project-card project-row'+(pending?' project-pending':'')}>
        <td className="project-identity-cell"><div className="project-identity">
          <span className="project-symbol"><Terminal size={18}/></span>
          <div><strong>{p.name}</strong><code>{p.token_prefix}••••••••</code>{application&&<div className="project-applicant"><span>{application.client} · {protocolName(application.protocol)}</span>{application.note&&<small>{application.note}</small>}{pending&&<small>客户端已领取 Token，批准后即可调用。</small>}</div>}</div>
        </div></td>
        <td className="project-grants-cell" data-label="授权模型">
          <div className="project-grants">{p.model_ids.length ? p.model_ids.map(id => <code className="project-grant-chip" key={id}>{aliases.get(id) || id}</code>) : <span className="project-no-grants">尚未授权模型</span>}</div>
        </td>
        <td className="project-state-cell"><span className={'project-state ' + (p.enabled ? 'is-enabled' : '')}><span className="dot"/>{pending?'待批准':rejected?'已拒绝':p.enabled?'启用':'停用'}</span></td>
        <td className="project-actions-cell"><div className="project-row-actions">
          {pending?<><button className="primary" disabled={deciding} onClick={()=>onDecision?.(application!,'approve')}><Check size={14}/>批准</button><button disabled={deciding} onClick={()=>onDecision?.(application!,'reject')}><X size={14}/>拒绝</button></>:!rejected&&<><button className="project-access-action" onClick={() => onAccess(p)}><Copy size={14}/>接入信息</button>
          <button onClick={() => onEdit(p)}><ShieldCheck size={14}/>编辑权限</button>
          <button onClick={() => onTest(p)}><Terminal size={14}/>试调用</button>
          </>}<button className="danger project-delete-action" onClick={() => onDelete(p)}><Trash2 size={14}/>删除</button>
        </div></td>
      </tr>})}</tbody>
    </table>
  </section>;
}
