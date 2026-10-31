// DeepSeek Search / Fetch borrow a model entry; requests use DeepSeek's native body.
export const isWebTool = protocol => protocol === 'deepseek-search' || protocol === 'deepseek-fetch';
export const webToolPath = protocol => protocol === 'deepseek-fetch' ? '/tools/fetch' : '/tools/search';

export function webToolRequest(protocol, text) {
  return protocol === 'deepseek-fetch' ? { url: text } : { query: text, count: 5 };
}

export function webToolExample(protocol) {
  const sample = protocol === 'deepseek-fetch' ? 'https://api-docs.deepseek.com/guides/search/' : 'DeepSeek Search API 价格';
  return JSON.stringify(webToolRequest(protocol, sample), null, 2);
}

// The query or URL the project sent, for the request inspector.
export function webToolInput(input) {
  let value; try { value = JSON.parse(input); } catch { return ''; }
  return typeof value?.query === 'string' ? value.query : typeof value?.url === 'string' ? value.url : '';
}

// Readable results: fetch returns {title, content}; search returns a result list.
export function webToolText(output) {
  let value; try { value = JSON.parse(output); } catch { return ''; }
  if (typeof value?.content === 'string') return `${value.title || ''}\n\n${value.content}`.trim();
  const results = Array.isArray(value?.results) ? value.results : Array.isArray(value?.data) ? value.data : [];
  return results.map((r, i) => `${i + 1}. ${r?.title || ''}\n   ${r?.url || ''}${r?.snippet ? '\n   ' + r.snippet : ''}`).join('\n');
}
