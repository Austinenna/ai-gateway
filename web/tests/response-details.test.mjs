import test from 'node:test';
import assert from 'node:assert/strict';
import { responseDetails, responsePlaceholder } from '../src/response-details.mjs';

const sse = (...frames) => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
test('Chat merges reasoning and interleaved tool argument fragments by choice and tool index', () => {
  const result = responseDetails(sse(
    { choices: [{ delta: { role: 'assistant', reasoning_content: '先检查' } }] },
    { choices: [{ delta: { reasoning_content: '文件。', tool_calls: [
      { index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"path":' } },
      { index: 1, id: 'call_b', function: { name: 'Re', arguments: '{"path":' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 1, function: { name: 'ad', arguments: '"b.md"}' } },
      { index: 0, function: { arguments: '"a.md"}' } },
    ] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 4 } },
  ));
  assert.equal(result.parts.length, 3);
  assert.equal(result.parts[0].text, '先检查文件。');
  assert.equal(result.parts[1].arguments, '{"path":"a.md"}');
  assert.equal(result.parts[2].arguments, '{"path":"b.md"}');
  assert.equal(result.parts[2].name, 'Read');
  assert.equal(result.toolCount, 2);
  assert.deepEqual(result.finishReasons, ['tool_calls']);
  assert.match(responsePlaceholder(result), /已返回思考文本和2 个工具调用/);
  const multiple = responseDetails(sse({ choices: [
    { index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{}' } }] } },
    { index: 1, delta: { tool_calls: [{ index: 0, id: 'b', function: { name: 'Write', arguments: '{}' } }] } },
  ] }));
  assert.deepEqual(multiple.parts.map(p => [p.choice, p.name]), [[0, 'Read'], [1, 'Write']]);
});

test('Messages preserves thinking, tools and text order and replaces initial empty tool input with argument deltas', () => {
  const result = responseDetails(sse(
    { type: 'message_start', message: { content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '检查一下。' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_m', name: 'Read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"test.md"}' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '现在' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '读取。' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ));
  assert.deepEqual(result.parts.map(p => p.kind), ['thinking', 'tool', 'text']);
  assert.equal(result.parts[0].text, '检查一下。');
  assert.equal(result.parts[1].arguments, '{"path":"test.md"}');
  assert.equal(result.parts[2].text, '现在读取。');
  assert.deepEqual(result.finishReasons, ['tool_use']);
});

test('Nonstream Chat and Messages retain reasoning, tool calls, text, errors and unknown blocks', () => {
  const chat = responseDetails(JSON.stringify({ choices: [{ message: { reasoning_content: '想一想', content: '回答', tool_calls: [{ id: 'a', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'stop' }] }));
  assert.deepEqual(chat.parts.map(p => p.kind), ['thinking', 'text', 'tool']);
  const messages = responseDetails(JSON.stringify({ content: [
    { type: 'thinking', thinking: '检查' }, { type: 'tool_use', id: 'a', name: 'Read', input: { path: 'a' } },
    { type: 'text', text: '正文' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'future', value: '保留内容' },
  ], stop_reason: 'end_turn' }));
  assert.equal(messages.parts[1].arguments, '{"path":"a"}');
  assert.match(messages.parts[3].text, /不可读/);
  assert.match(messages.parts[4].text, /保留内容/);
  const error = responseDetails('{"error":{"message":"模拟上游错误"}}');
  assert.equal(error.parts[0].kind, 'error');
  assert.equal(error.parts[0].text, '模拟上游错误');
});

test('Truncated arguments and invalid frames stay inspectable without fabricating missing output', () => {
  const result = responseDetails(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Read', arguments: '{"path":' } }] } }] }) + 'data: {"choices":');
  assert.equal(result.parts[0].arguments, '{"path":');
  assert.equal(result.warnings.length, 1);
  assert.equal(responseDetails('not-json').parts.length, 0);
  assert.equal(responseDetails('null').hasData, false);
  const metadata = responseDetails(sse({ choices: [{ delta: { role: 'assistant', content: '' } }] }, { choices: [], usage: { completion_tokens: 0 } }));
  assert.equal(metadata.parts.length, 0);
  assert.equal(metadata.hasData, true);
  assert.match(responsePlaceholder(metadata), /已收到上游数据/);
});
