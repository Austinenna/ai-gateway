import { Plus, Trash2 } from 'lucide-react';
import { type ModelPrice, parsePriceDate, priceDate, today } from './costs';
import { isWebTool } from './web-tools.mjs';

type Key = Exclude<keyof ModelPrice, 'effective_from'>;
const textFields: [Key, string][] = [['input_per_mtok', '输入'], ['output_per_mtok', '输出'], ['cache_read_per_mtok', '缓存读取'], ['cache_write_per_mtok', '缓存写入']];

function fieldsFor(protocols: string[]) {
  const out: [Key, string, string][] = [];
  if (protocols.some(p => p === 'chat' || p === 'messages')) out.push(...textFields.map(([k, l]) => [k, l, '元 / 百万 Token'] as [Key, string, string]));
  if (protocols.includes('dashscope-asr')) out.push(['audio_per_minute', '音频', '元 / 分钟']);
  if (protocols.some(isWebTool)) out.push(['per_call', '每次调用', '元 / 次']);
  return out;
}

export function ModelPriceFields({ protocols, prices, onChange }: { protocols: string[]; prices: ModelPrice[]; onChange: (prices: ModelPrice[]) => void }) {
  const fields = fieldsFor(protocols);
  const sorted = [...prices].sort((a, b) => b.effective_from - a.effective_from);
  const update = (version: ModelPrice, next: ModelPrice) => onChange(prices.map(p => p === version ? next : p));
  const add = () => {
    const latest = sorted[0], from = today();
    if (prices.some(p => p.effective_from === from)) return;
    onChange([...prices, { ...(latest || {}), effective_from: latest ? from : 0 }]);
  };
  return <section className="model-prices">
    <h3>单价（人民币）</h3>
    <p className="muted small">用于估算成本和项目预算，按调用开始时生效的版本计算。价格变动时添加新版本，旧调用仍按旧价；改已有版本会重算其生效期内的历史费用。缓存单价留空按输入价计。</p>
    {sorted.map(version => <div className="price-version" key={version.effective_from + ':' + prices.indexOf(version)}>
      <div className="price-version-head">
        <label className="field"><span>生效日期</span><input type="date" value={priceDate(version.effective_from)} onChange={e => update(version, { ...version, effective_from: parsePriceDate(e.target.value) })}/><small>{version.effective_from ? '当天 0 点起' : '留空：适用于全部历史调用'}</small></label>
        <button type="button" className="icon-btn" aria-label="删除这个价格版本" onClick={() => onChange(prices.filter(p => p !== version))}><Trash2 size={15}/></button>
      </div>
      <div className="form-grid price-grid">{fields.map(([key, label, unit]) => <label className="field" key={key}><span>{label}</span>
        <input type="number" min="0" step="any" inputMode="decimal" value={version[key] ?? ''} placeholder={key.startsWith('cache') ? '同输入价' : ''}
          onChange={e => update(version, { ...version, [key]: e.target.value === '' ? null : Number(e.target.value) })}/><small>{unit}</small></label>)}</div>
    </div>)}
    {new Set(prices.map(p => p.effective_from)).size < prices.length && <p className="error">两个价格版本的生效日期相同，请调整。</p>}
    <button type="button" className="link" onClick={add}><Plus size={14}/>{prices.length ? '添加价格变动' : '设置单价'}</button>
  </section>;
}
