import { Plus, Trash2 } from 'lucide-react';
import { type ModelPrice, type PeakPrice, parsePriceDate, priceDate, today } from './costs';
import { isWebTool } from './web-tools.mjs';

type Key = Exclude<keyof ModelPrice, 'effective_from' | 'peak'>;
const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
const defaultPeak: PeakPrice = { weekdays: [1, 2, 3, 4, 5], hours: ['09:00-12:00', '14:00-18:00'] };
const textFields: [Key, string][] = [['input_per_mtok', '输入'], ['output_per_mtok', '输出'], ['cache_read_per_mtok', '缓存读取'], ['cache_write_per_mtok', '缓存写入']];

function fieldsFor(protocols: string[]) {
  const out: [Key, string, string][] = [];
  if (protocols.some(p => p === 'chat' || p === 'messages')) out.push(...textFields.map(([k, l]) => [k, l, '元 / 百万 Token'] as [Key, string, string]));
  if (protocols.includes('dashscope-asr')) out.push(['audio_per_minute', '音频', '元 / 分钟']);
  if (protocols.includes('dashscope-tts')) {
    // Qwen-Audio 3.1 TTS is billed by tokens, 3.0 by characters; token prices win when both are set.
    if (!out.some(([k]) => k === 'input_per_mtok')) out.push(['input_per_mtok', '输入（3.1 等按 Token 计费）', '元 / 百万 Token'], ['output_per_mtok', '输出（3.1 等按 Token 计费）', '元 / 百万 Token']);
    out.push(['per_10k_characters', '语音合成（3.0 等按字符计费）', '元 / 万字符']);
  }
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
      <label className="check"><input type="checkbox" checked={!!version.peak} onChange={e => update(version, { ...version, peak: e.target.checked ? { ...defaultPeak } : null })}/>高峰时段另计价（如 DeepSeek 工作日白天）</label>
      {version.peak && <PeakFields peak={version.peak} fields={fields} onChange={peak => update(version, { ...version, peak })}/>}
    </div>)}
    {new Set(prices.map(p => p.effective_from)).size < prices.length && <p className="error">两个价格版本的生效日期相同，请调整。</p>}
    <button type="button" className="link" onClick={add}><Plus size={14}/>{prices.length ? '添加价格变动' : '设置单价'}</button>
  </section>;
}

function PeakFields({ peak, fields, onChange }: { peak: PeakPrice; fields: [Key, string, string][]; onChange: (peak: PeakPrice) => void }) {
  const toggle = (day: number) => onChange({ ...peak, weekdays: peak.weekdays.includes(day) ? peak.weekdays.filter(d => d !== day) : [...peak.weekdays, day].sort() });
  return <div className="price-peak">
    <div className="field"><span>高峰日（北京时间）</span><div className="weekday-picker" role="group" aria-label="高峰日">{weekdayNames.map((name, i) =>
      <button type="button" key={name} aria-pressed={peak.weekdays.includes(i + 1)} onClick={() => toggle(i + 1)}>周{name}</button>)}</div><small>法定节假日按普通日期处理，会按高峰价估算。</small></div>
    <label className="field"><span>高峰时间段</span><input defaultValue={peak.hours.join(', ')} placeholder="09:00-12:00, 14:00-18:00"
      onBlur={e => onChange({ ...peak, hours: e.target.value.split(/[,，\s]+/).filter(Boolean) })}/><small>多个时间段用逗号分隔，结束时刻不含。</small></label>
    <div className="form-grid price-grid">{fields.map(([key, label, unit]) => <label className="field" key={key}><span>高峰{label}</span>
      <input type="number" min="0" step="any" inputMode="decimal" value={peak[key] ?? ''} placeholder="同平时价"
        onChange={e => onChange({ ...peak, [key]: e.target.value === '' ? null : Number(e.target.value) })}/><small>{unit}</small></label>)}</div>
  </div>;
}
