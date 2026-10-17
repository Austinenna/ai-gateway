import test from 'node:test';
import assert from 'node:assert/strict';
import { chatError, conversationHistory, createChatResponse } from '../src/chat-response.mjs';

const frame = value => 'data: ' + JSON.stringify(value) + '\r\n\r\n';
test('chat events survive every chunk boundary, CRLF and trailing usage after finish', () => {
  const source = ': heartbeat\r\n\r\ndata:\r\n\r\n' + frame({ choices: [{ delta: { reasoning_content: '推理' } }] }) +
    frame({ choices: [{ delta: { content: '你好🙂' } }] }) + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    frame({ choices: [], usage: { completion_tokens: 3 } });
  for (let split = 0; split <= source.length; split++) {
    const parser = createChatResponse('chat'); parser.push(source.slice(0, split)); parser.push(source.slice(split));
    assert.deepEqual(parser.finish(), { text: '你好🙂', thinking: '推理', error: '', ended: true, hasData: true, toolCalls: false, finishReason: 'stop' });
  }
});
test('Messages isolates thinking and tools and requires a message_stop event', () => {
  const parser = createChatResponse('messages');
  for (const event of [
    { type: 'message_start', message: { content: [] } },
    { type: 'content_block_start', content_block: { type: 'thinking', thinking: '先分析' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '再回答' } },
    { type: 'content_block_start', content_block: { type: 'text', text: '结论：' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '可以。' } },
    { type: 'content_block_start', content_block: { type: 'tool_use', name: 'unexpected_tool' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]) parser.push(frame(event));
  assert.equal(parser.snapshot().ended, false);
  parser.push(frame({ type: 'message_stop' }));
  assert.deepEqual(parser.finish(), { text: '结论：可以。', thinking: '先分析再回答', error: '', ended: true, hasData: true, toolCalls: true, finishReason: 'end_turn' });
});
test('EOF, malformed events, and late upstream errors do not silently succeed', () => {
  const unfinished = createChatResponse('chat'); unfinished.push(frame({ choices: [{ delta: { content: '部分正文' } }] }));
  assert.equal(unfinished.finish().ended, false);
  const malformed = createChatResponse('chat'); malformed.push('data: {"choices":');
  assert.match(malformed.finish().error, /不完整/);
  const error = createChatResponse('chat'); error.push(frame({ choices: [{ delta: { content: '部分正文' }, finish_reason: 'stop' }] }) + frame({ error: { message: 'limit reached' } }));
  assert.equal(error.finish().error, 'limit reached'); assert.equal(error.snapshot().text, '部分正文');
  assert.equal(chatError({ error: { message: {} } }), '模型调用失败，请查看请求详情。');
});
test('complete JSON and SSE multiline data preserve text without rendering objects', () => {
  const chat = createChatResponse('chat');
  assert.equal(chat.json({ choices: [{ message: { content: [{ type: 'text', text: '正文' }] }, finish_reason: 'stop' }] }).text, '正文');
  const messages = createChatResponse('messages');
  assert.equal(messages.json({ content: [{ type: 'thinking', thinking: '推理' }, { type: 'text', text: '正文' }] }).thinking, '推理');
  const multiline = createChatResponse('chat');
  multiline.push('data: {"choices":\ndata: [{"delta":{"content":"正文"}}]}\n\ndata: [DONE]');
  assert.equal(multiline.finish().ended, true); assert.equal(multiline.snapshot().text, '正文');
});
test('conversation history excludes thinking, diagnostics, and empty replies', () => {
  assert.deepEqual(conversationHistory([
    { role: 'user', text: '问题' }, { role: 'assistant', text: '', thinking: '内部思考', error: '上游失败' },
    { role: 'user', text: '追问' }, { role: 'assistant', text: '收到的部分正文', thinking: '不要带入上下文', status: 'stopped' },
  ]), [{ role: 'user', content: '问题' }, { role: 'user', content: '追问' }, { role: 'assistant', content: '收到的部分正文' }]);
});
