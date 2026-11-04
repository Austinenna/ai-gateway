export type ModelPrice = {
  effective_from: number;
  input_per_mtok?: number | null; output_per_mtok?: number | null;
  cache_read_per_mtok?: number | null; cache_write_per_mtok?: number | null;
  audio_per_minute?: number | null; per_10k_characters?: number | null; per_call?: number | null;
  peak?: PeakPrice | null;
};
// Weekdays use 1 = Monday … 7 = Sunday; hours are Asia/Shanghai "HH:MM-HH:MM", end exclusive.
export type PeakPrice = Omit<ModelPrice, 'effective_from' | 'peak'> & { weekdays: number[]; hours: string[] };
export type RecordCost = {
  status: 'none' | 'running' | 'priced' | 'partial' | 'usage_unknown' | 'unpriced';
  amount: number; currency: string; price_effective_from?: number; peak?: boolean;
  input_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; output_tokens?: number;
  audio_seconds?: number; tts_characters?: number; billable_calls?: number;
};
export type CostTotals = {
  requests: number; cost: number; priced: number; usage_partial: number; usage_unknown: number; unpriced: number;
  input_tokens: number; cache_read_tokens: number; cache_write_tokens: number; output_tokens: number; audio_seconds: number; tts_characters?: number;
};
export type UsageGroup = CostTotals & { key: string; label: string };
export type UsageCall = { id: string; started: number; project_id: string; project_name: string; model: string; protocol: string; category: string; task: string; state: string; cost: RecordCost };
export type BudgetStatus = { monthly_budget: number | null; month_spent: number; remaining: number | null; exceeded: boolean };
export type UsageReport = { currency: string; from: number; to: number; total: CostTotals; group_by?: string; groups?: UsageGroup[]; requests?: UsageCall[]; has_more?: boolean; budget?: BudgetStatus };

// Small amounts keep enough digits to stay visible; ¥0.0003 should not read as ¥0.00.
export function yuan(value: number | null | undefined) {
  if (value == null) return '—';
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return '¥' + value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

export const costStatusName = (status?: string) => ({
  none: '未到达厂商，不计费', running: '进行中', priced: '已按单价估算', partial: '用量不完整，按已报告部分估算',
  usage_unknown: '厂商未报告用量', unpriced: '模型未配置单价',
}[status || ''] || '—');

export function costText(cost?: RecordCost) {
  if (!cost || cost.status === 'running') return '—';
  if (cost.status === 'unpriced') return '未定价';
  if (cost.status === 'usage_unknown') return '用量未知';
  return yuan(cost.amount);
}

export function uncertainText(t: CostTotals) {
  const parts = [];
  if (t.unpriced) parts.push(`${t.unpriced} 次未定价`);
  if (t.usage_unknown) parts.push(`${t.usage_unknown} 次用量未知`);
  if (t.usage_partial) parts.push(`${t.usage_partial} 次用量不完整`);
  return parts.join('，');
}

const dayStart = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Price effective times are entered as local calendar days; 0 means "since the beginning".
export function priceDate(ms: number) {
  if (!ms) return '';
  const d = new Date(ms), pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parsePriceDate(value: string) {
  if (!value) return 0;
  const [y, m, d] = value.split('-').map(Number);
  return dayStart(new Date(y, m - 1, d).getTime());
}
export const today = () => dayStart(Date.now());
