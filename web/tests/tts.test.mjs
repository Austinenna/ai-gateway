import test from 'node:test';
import assert from 'node:assert/strict';
import { ttsAudioSource, ttsExample, ttsRequest, ttsSummary } from '../src/tts.mjs';
import { messageList } from '../src/protocol.mjs';

test('tts request is the DashScope-native body', () => {
  assert.deepEqual(ttsRequest('tts', '你好', ' anmingyuan_v3.1 '), { model: 'tts', input: { text: '你好', voice: 'anmingyuan_v3.1', format: 'mp3', sample_rate: 24000 } });
  assert.throws(() => ttsRequest('tts', ' ', 'v'));
  assert.throws(() => ttsRequest('tts', '你好', ''));
  assert.equal(JSON.parse(ttsExample('voice')).model, 'voice');
});

test('tts response plays inline data first, then an http url', () => {
  assert.equal(ttsAudioSource({ output: { audio: { data: 'QUJD', url: 'https://oss.test/a.mp3' } } }), 'data:audio/mp3;base64,QUJD');
  assert.equal(ttsAudioSource({ output: { audio: { data: '', url: 'https://oss.test/a.mp3' } } }), 'https://oss.test/a.mp3');
  assert.equal(ttsAudioSource({ output: { audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?Signature=x' } } }), 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?Signature=x');
  assert.equal(ttsAudioSource({ output: { audio: { url: 'javascript:alert(1)' } } }), '');
  // Stored records replace data with a summary object; it must not be played.
  assert.equal(ttsAudioSource({ output: { audio: { data: { omitted: 'audio' } } } }), '');
  assert.match(ttsSummary({ output: { audio: { url: 'https://oss.test/a.mp3' } }, usage: { characters: 12 } }), /计费 12 字符/);
  assert.equal(ttsSummary({ error: { message: 'x' } }), '');
});

test('tts input text shows as the user message', () => {
  assert.deepEqual(messageList(JSON.stringify({ model: 'tts', input: { text: '你好', voice: 'v1' } })).map(m => m.role), ['user']);
});
