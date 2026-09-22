import type { RequestRecord } from './monitoring';
import type { FilterOption } from './FilterSelect';

type Model = { id: string; alias: string; name: string };
type Connection = { provider: string };
export const recordModelValue = (record: RequestRecord) => record.model_id ? `id:${record.model_id}` : record.alias ? `alias:${record.alias}` : 'unknown';
export const recordProviderValue = (record: RequestRecord) => record.provider || 'unknown';
const providerName = (value: string) => ({ zhipu: '智谱', minimax: 'MiniMax', deepseek: 'DeepSeek', dashscope: '阿里云百炼', custom: '自定义', demo: '本地演示', unknown: '未记录厂商' }[value] || value);

export function requestFilterOptions(records: RequestRecord[], models: Model[], connections: Connection[]) {
  const modelOptions = new Map<string, FilterOption>(models.map(model => [
    `id:${model.id}`, { value: `id:${model.id}`, label: model.alias, hint: model.name },
  ]));
  for (const record of records) {
    const value = recordModelValue(record);
    if (!modelOptions.has(value)) modelOptions.set(value, {
      value, label: record.alias || '未识别模型',
      hint: record.model_id ? '已删除模型' : record.alias ? '未匹配模型' : '请求未记录模型',
    });
  }
  // Only use the recorded provider: editing today's model connection must not reclassify history.
  const providers = new Set([...connections.map(connection => connection.provider), ...records.map(recordProviderValue)].filter(Boolean));
  return {
    models: [{ value: 'all', label: '所有模型' }, ...modelOptions.values()],
    providers: [{ value: 'all', label: '所有厂商' }, ...[...providers].map(value => ({ value, label: providerName(value) }))],
  };
}
