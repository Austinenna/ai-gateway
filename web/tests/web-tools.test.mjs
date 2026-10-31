import test from 'node:test';
import assert from 'node:assert/strict';
import { isWebTool, webToolInput, webToolPath, webToolRequest, webToolText } from '../src/web-tools.mjs';

test('search and fetch map to DeepSeek-native bodies and gateway paths', () => {
  assert.ok(isWebTool('deepseek-search') && isWebTool('deepseek-fetch') && !isWebTool('chat'));
  assert.equal(webToolPath('deepseek-search'), '/tools/search');
  assert.equal(webToolPath('deepseek-fetch'), '/tools/fetch');
  assert.deepEqual(webToolRequest('deepseek-search', 'DeepSeek'), { query: 'DeepSeek', count: 5 });
  assert.deepEqual(webToolRequest('deepseek-fetch', 'https://example.com/'), { url: 'https://example.com/' });
});

test('results become readable text and the inspector shows the query or URL', () => {
  const search = JSON.stringify({ results: [{ title: 'Search & Fetch', url: 'https://api-docs.deepseek.com/guides/search/', snippet: '$0.75 per 1,000' }] });
  assert.equal(webToolText(search), '1. Search & Fetch\n   https://api-docs.deepseek.com/guides/search/\n   $0.75 per 1,000');
  assert.equal(webToolText(JSON.stringify({ title: '文档', content: '# 标题' })), '文档\n\n# 标题');
  assert.equal(webToolText('{"error":{"message":"bad"}}'), '');
  assert.equal(webToolInput('{"query":"DeepSeek 价格","count":5}'), 'DeepSeek 价格');
  assert.equal(webToolInput('{"url":"https://example.com/"}'), 'https://example.com/');
});
