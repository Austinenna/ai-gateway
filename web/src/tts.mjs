export const DEFAULT_TTS_VOICE = 'anmingyuan_v3.1';

export function ttsRequest(model, text, voice) {
  if (!text?.trim()) throw new Error('请填写要合成的文字。');
  if (!voice?.trim()) throw new Error('请填写音色 ID。');
  return { model, input: { text, voice: voice.trim(), format: 'mp3', sample_rate: 24000 } };
}

export function ttsExample(model) {
  return JSON.stringify(ttsRequest(model || 'tts', '要合成的文字', DEFAULT_TTS_VOICE), null, 2);
}

// Playable source from a DashScope response: inline base64 first, else the temporary URL.
export function ttsAudioSource(value) {
  const audio = value?.output?.audio;
  if (typeof audio?.data === 'string' && audio.data) return 'data:audio/mp3;base64,' + audio.data;
  return typeof audio?.url === 'string' && /^https?:\/\//.test(audio.url) ? audio.url : '';
}

export function ttsSummary(value) {
  const characters = value?.usage?.characters;
  if (!value?.output?.audio) return '';
  return '合成完成' + (typeof characters === 'number' ? `，计费 ${characters} 字符` : '') + (value.output.audio.url ? `\n音频地址（有时效）：${value.output.audio.url}` : '');
}
