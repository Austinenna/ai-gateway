import { responseText } from './protocol.mjs';

export function AsrResponseDetails({ output }: { output: string }) {
  let value;
  try { value = JSON.parse(output); } catch { value = null; }
  const text = responseText(output);
  return <div className="response-details">
    <section className="response-summary"><h3>转写结果</h3><p className="response-text">{text || (value?.output ? '未识别到文字。' : '没有可解析的转写结果，请查看原始数据。')}</p></section>
    {value?.output?.sentence && <section className="response-part"><div className="response-part-body"><h3>句子与词时间戳</h3><p className="muted small">按厂商返回的字段和时间单位展示。</p><pre>{JSON.stringify(value.output.sentence, null, 2)}</pre></div></section>}
    {value?.usage && <section className="response-part"><div className="response-part-body"><h3>厂商用量</h3><pre>{JSON.stringify(value.usage, null, 2)}</pre></div></section>}
  </div>;
}
