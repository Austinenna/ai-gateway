import test from 'node:test';
import assert from 'node:assert/strict';
import { audioFormat, asrRequest, asrTestRequest, asrExample, MAX_AUDIO_BYTES } from '../src/asr.mjs';
import { messageList, responseText } from '../src/protocol.mjs';

test('ASR sends native audio JSON, preserves format and omits LLM controls', () => {
  const request = asrRequest('speech', { data: 'data:audio/wav;base64,UklGRg==', format: 'wav' }, '  百炼、网关  ');
  assert.equal(request.model, 'speech');
  assert.deepEqual(request.input.messages, [
    { role: 'system', content: [{ text: '百炼、网关' }] },
    { role: 'user', content: [{ audio: 'data:audio/wav;base64,UklGRg==' }] },
  ]);
  assert.deepEqual(request.parameters, { format: 'wav', asr_options: { language: 'zh', enable_itn: true } });
  assert.equal('stream' in request, false);
  assert.equal('max_tokens' in request, false);
  assert.equal(asrRequest('speech', { data: 'data:audio/mp3;base64,AA==', format: 'mp3' }).input.messages.length, 1);
  assert.throws(() => asrRequest('speech', null), /选择音频/);
  assert.equal(JSON.parse(asrExample('my-asr')).model, 'my-asr');
  const admin = asrTestRequest({ data: 'data:audio/wav;base64,UklGRg==', format: 'wav' });
  assert.deepEqual(Object.keys(admin).sort(), ['input', 'parameters', 'protocol']);
});

test('audio files reject empty, oversized and unsupported formats before reading', () => {
  assert.deepEqual(audioFormat({ name: 'sample.WAV', size: MAX_AUDIO_BYTES }), { format: 'wav', mime: 'audio/wav' });
  assert.deepEqual(audioFormat({ name: 'sample.m4a', size: 32 }), { format: 'm4a', mime: 'audio/mp4' });
  assert.throws(() => audioFormat({ name: 'sample.mp3', size: 0 }), /非空/);
  assert.throws(() => audioFormat({ name: 'sample.mp3', size: MAX_AUDIO_BYTES + 1 }), /20 MiB/);
  assert.throws(() => audioFormat({ name: 'sample.txt', size: 32 }), /MP3/);
});

test('ASR transcript and sanitized native messages are readable without flattening timestamps', () => {
  const native = { output: { text: '你好，百炼。', sentence: { text: '你好，百炼。', words: [{ text: '你好', begin_time: 0, end_time: 420 }] } }, usage: { duration: 1.25 } };
  assert.equal(responseText(JSON.stringify(native)), '你好，百炼。');
  assert.equal(responseText(JSON.stringify({ output: { sentence: { text: '备用句子' } } })), '备用句子');
  assert.equal(responseText(JSON.stringify({ output: { choices: [{ message: { content: [{ text: '旧版 ' }, { text: 'ASR' }] } }] } })), '旧版 ASR');
  const request = { input: { messages: [{ role: 'user', content: [{ audio: '[音频已省略]' }] }] } };
  assert.deepEqual(messageList(JSON.stringify(request)), [{ role: 'user', content: [{ audio: '[音频已省略]' }], tool_calls: undefined }]);
  assert.equal(native.output.sentence.words[0].end_time, 420);
});
