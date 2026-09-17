import type { RequestRecord } from './monitoring';

export type ModelPricing = {
  mode: 'unconfigured' | 'token' | 'subscription';
  currency?: 'CNY' | 'USD'; cache_mode?: 'uniform' | 'separate';
  input_per_million?: number; output_per_million?: number;
  cache_read_per_million?: number; cache_write_per_million?: number;
  source?: string; note?: string; updated_at?: number;
};
export type RequestCost = {
  status: string; currency?: string; amount: number | null; pricing?: ModelPricing;
  lines?: { kind: string; tokens: number; rate: number; amount: number }[];
  missing?: string[];
};
export type CostAggregate = {
  amounts: Record<string, number>; eligible: number; complete: number; partial: number;
  unconfigured: number; unknown: number; subscription: number; historical: number; pending: number;
};
export const money = (n: number, currency = 'CNY') => `${currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency + ' '}${n > 0 && n < 0.000001 ? '<0.000001' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
export const costAmounts = (cost?: CostAggregate) => {
  const entries = Object.entries(cost?.amounts || {}).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([currency, amount]) => money(amount, currency)).join(' · ') : '—';
};
export const costCoverage = (c?: CostAggregate) => c ? [
  `完整估算 ${c.complete} / ${c.eligible} 次`,
  c.partial && `部分估算 ${c.partial} 次`, c.unconfigured && `未配价 ${c.unconfigured} 次`,
  c.unknown && `用量待确认 ${c.unknown} 次`, c.subscription && `套餐 ${c.subscription} 次`,
  c.historical && `旧记录 ${c.historical} 次`, c.pending && `进行中 ${c.pending} 次`,
].filter(Boolean).join(' · ') : '尚无费用统计';
const statuses: Record<string, string> = {
  complete: '估算费用', partial: '部分估算', unconfigured: '未配置价格', subscription: '订阅套餐',
  unknown: '用量不足，费用未知', not_forwarded: '未转发，不计费', demo: '本地演示', pending: '等待用量',
};
export const requestCostText = (r: RequestRecord) => {
  if (r.state === 'running') return '费用待结算';
  if (r.state === 'interrupted' && (!r.cost || r.cost.status === 'pending')) return '调用中断 · 费用未知';
  if (!r.cost) return '旧记录 · 未记录价格';
  const label = statuses[r.cost.status] || '费用未知';
  return r.cost.amount == null ? label : `${label} ${money(r.cost.amount, r.cost.currency)}`;
};

export function PricingSummary({ pricing: p }: { pricing?: ModelPricing }) {
  if (!p || p.mode === 'unconfigured') return <span className="muted">未配置价格</span>;
  if (p.mode === 'subscription') return <span>订阅套餐<small>{p.note || '用量单列，不折算单次费用'}</small></span>;
  return <span>输入 {money(p.input_per_million!, p.currency)} / 输出 {money(p.output_per_million!, p.currency)}<small>每百万 Token · {p.cache_mode === 'uniform' ? '缓存同价' : '缓存单独计价'}</small><small>1 万输入＋1 千输出、无缓存 ≈ {money((10000 * p.input_per_million! + 1000 * p.output_per_million!) / 1e6, p.currency)}</small></span>;
}

export function ModelPricingFields({ value, onChange }: { value?: ModelPricing; onChange: (p: ModelPricing) => void }) {
  const p = value || { mode: 'unconfigured' };
  const rate = (label: string, key: 'input_per_million' | 'output_per_million' | 'cache_read_per_million' | 'cache_write_per_million', required = false) => <label className="field"><span>{label}</span><input aria-label={label} type="number" min="0" max="1000000" step="any" required={required} value={p[key] ?? ''} placeholder={required ? '填写单价，免费填 0' : '未知留空，不当作免费'} onChange={e => onChange({ ...p, [key]: e.target.value === '' ? undefined : Number(e.target.value) })}/></label>;
  return <section className="model-pricing-fields">
    <h3>价格与计费</h3>
    <label className="field"><span>计费方式</span><select aria-label="计费方式" value={p.mode} onChange={e => onChange(e.target.value === 'token' ? { mode: 'token', currency: 'CNY', cache_mode: 'separate', source: p.source, note: p.note } : { mode: e.target.value as ModelPricing['mode'], source: p.source, note: p.note })}><option value="unconfigured">未配置价格</option><option value="token">按 Token 计费</option><option value="subscription">订阅／包月套餐</option></select></label>
    {p.mode === 'token' && <>
      <div className="form-grid"><label className="field"><span>价格币种</span><select aria-label="价格币种" value={p.currency} onChange={e => onChange({ ...p, currency: e.target.value as 'CNY' | 'USD' })}><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select></label><label className="field"><span>缓存计价</span><select aria-label="缓存计价" value={p.cache_mode} onChange={e => onChange({ ...p, cache_mode: e.target.value as 'uniform' | 'separate' })}><option value="separate">缓存单独计价</option><option value="uniform">所有输入同价（含缓存）</option></select></label></div>
      <p className="muted small">以下价格单位均为每百万 Token；按当前连接的实际计费规则填写。</p>
      <div className="form-grid">{rate('输入单价', 'input_per_million', true)}{rate('输出单价', 'output_per_million', true)}{p.cache_mode === 'separate' && <>{rate('缓存读取单价', 'cache_read_per_million')}{rate('缓存写入单价', 'cache_write_per_million')}</>}</div>
      {p.input_per_million != null && p.output_per_million != null && <p className="pricing-reference">用量参考：1 万输入＋1 千输出、无缓存 ≈ <b>{money((10000 * p.input_per_million + 1000 * p.output_per_million) / 1e6, p.currency)}</b>。用于同等用量比较，不代表完成任务的实际费用。</p>}
    </>}
    {p.mode === 'subscription' && <p className="pricing-reference">单列套餐调用与 Token 用量，不将订阅费用重复分摊到每个模型，也不把调用记成免费。剩余额度及超额扣款以厂商账单为准。</p>}
    {p.mode !== 'unconfigured' && <><label className="field"><span>价格来源</span><input type="url" aria-label="价格来源" placeholder="https:// 官方或服务商价格页" maxLength={2048} value={p.source || ''} onChange={e => onChange({ ...p, source: e.target.value })}/></label><label className="field"><span>计费备注</span><textarea aria-label="计费备注" rows={2} maxLength={500} placeholder="实际套餐、折扣、适用范围等" value={p.note || ''} onChange={e => onChange({ ...p, note: e.target.value })}/></label></>}
    <p className="muted small">保存后用于新请求，历史费用保留原价格。当前按固定单价估算，暂不自动同步价格或计算峰谷、阶梯价；此类连接请在备注中说明，或保留未配置。不同币种分别汇总。</p>
    {!!p.updated_at && <p className="muted small">价格生效于 {new Date(p.updated_at).toLocaleString('zh-CN')}</p>}
  </section>;
}

const missing: Record<string, string> = {
  input_usage: '输入用量', output_usage: '输出用量', cache_read_usage: '缓存读取用量', cache_write_usage: '缓存写入用量',
  input_price: '输入价格', output_price: '输出价格', cache_read_price: '缓存读取价格', cache_write_price: '缓存写入价格',
  input_cache_split: '输入与缓存拆分', final_usage: '最终用量确认', input_total: '有效输入总量',
};
const kinds: Record<string, string> = { input: '输入', output: '输出（含厂商计入的思考）', cache_read: '缓存读取', cache_write: '缓存写入' };
export function RequestCostDetails({ record: r }: { record: RequestRecord }) {
  const c = r.cost;
  return <section className="detail-cost"><h3>费用明细</h3><p className="request-cost-total">{requestCostText(r)}</p>
    {!!c?.lines?.length && <div className="table-scroll"><table><thead><tr><th>计费项</th><th>Token</th><th>单价 / 百万 Token</th><th>估算费用</th></tr></thead><tbody>{c.lines.map(l => <tr key={l.kind}><td>{kinds[l.kind] || l.kind}</td><td>{l.tokens.toLocaleString('zh-CN')}</td><td>{money(l.rate, c.currency)}</td><td>{money(l.amount, c.currency)}</td></tr>)}</tbody></table></div>}
    {!!c?.missing?.length && <p className="metric-explanation">尚缺：{c.missing.map(k => missing[k] || k).join('、')}。金额仅包含可计算的部分。</p>}
    {c?.pricing?.note && <p className="metric-explanation">计费备注：{c.pricing.note}</p>}
    {c?.pricing?.source && <p className="metric-explanation"><a href={c.pricing.source} target="_blank" rel="noreferrer">查看当时记录的价格来源</a></p>}
    {!!c?.pricing?.updated_at && <p className="metric-explanation">使用价格版本：{new Date(c.pricing.updated_at).toLocaleString('zh-CN')}。后续改价不影响本条记录。</p>}
    <p className="metric-explanation">{c?.status === 'subscription' ? '套餐内调用单列，不折算为零元。订阅费、剩余额度与超额扣款请核对厂商账单。' : !c ? '此历史记录没有当时的价格快照，不使用现在的价格追算。' : '按已上报用量与当时配置的价格估算；失败或中断也可能产生费用。未知不当作零，实际扣款以厂商账单为准。'}</p>
  </section>;
}
