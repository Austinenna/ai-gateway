export function dataFrames(text) {
  return text.replaceAll('\r\n', '\n').split('\n\n').filter(Boolean).map(frame => {
    const data = frame.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch { return null; }
  }).filter(Boolean);
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x => x && x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('');
  return '';
}
export function responseText(output) {
  let value;
  try { value = JSON.parse(output); } catch { value = null; }
  if (value) return contentText(value.choices?.[0]?.message?.content) || contentText(value.content) || contentText(value.error?.message);
  return dataFrames(output).map(x => contentText(x.choices?.[0]?.delta?.content) || (x.delta?.type === 'text_delta' ? contentText(x.delta.text) : '') || (x.content_block?.type === 'text' ? contentText(x.content_block.text) : '') || '').join('');
}
export function messageList(input) {
  let value; try { value = JSON.parse(input); } catch { return []; }
  if (!value || typeof value !== 'object') return [];
  const result = [];
  if (value.system) result.push({role: 'system', content: value.system});
  if (Array.isArray(value.messages)) for (const message of value.messages) {
    if (!message || typeof message !== 'object') continue;
    result.push({role: typeof message.role === 'string' ? message.role : 'unknown', content: message.content ?? '', tool_calls: message.tool_calls});
  }
  if (value.tools) result.push({role: 'tools', content: value.tools});
  return result;
}
export function readable(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
