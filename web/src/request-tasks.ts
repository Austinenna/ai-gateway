import type { RequestRecord } from './monitoring';

export type WorkBuddyGrouping = {
  client: string; root_id: string; session_id: string; turn_id?: string;
  parent_session_id?: string; agent_type: string; client_request_id?: string; source: string;
};
export type RequestTask = {
  id: string; project_id: string; project_name: string; grouped: boolean; title: string; state: string;
  started: number; updated: number; duration_ms: number; calls: number; active: number; failed: number;
  missing_records: number; input_tokens: number; output_tokens: number; input_samples: number; output_samples: number;
  question_record_id?: string; reply_record_id?: string; grouping?: WorkBuddyGrouping;
  models: string[]; providers: string[];
};
export type TaskDetail = { task: RequestTask; calls: RequestRecord[]; total: number; offset: number; has_more: boolean };
export const taskState = (t: RequestTask) => t.grouped ? ({ running: '调用中', replied: '已回复', waiting: '等待后续', error: '调用异常' }[t.state] || '状态未知') : '独立调用';
export const agentName = (r: RequestRecord) => !r.grouping ? '未分组' : r.grouping.agent_type === 'main' ? '主代理' : `${r.grouping.agent_type === 'team' ? '团队代理' : '子代理'} · ${r.grouping.session_id.slice(0, 8)}`;
export function userQuestion(input: string) {
  try {
    const messages = JSON.parse(input).messages;
    if (!Array.isArray(messages)) return '';
    for (const m of [...messages].reverse()) {
      if (m?.role !== 'user') continue;
      const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p: {type?: string; text?: string}) => p?.type === 'text' && typeof p.text === 'string').map((p: {text: string}) => p.text).join('') : '';
      if (text.trim()) return text;
    }
  } catch { /* Missing or truncated body: use the explicitly labeled excerpt. */ }
  return '';
}
