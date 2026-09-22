export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const formats = { mp3: 'audio/mp3', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg' };

export function audioFormat(file) {
  if (!file || !file.size) throw new Error('请选择非空音频文件。');
  if (file.size > MAX_AUDIO_BYTES) throw new Error('音频文件不能超过 20 MiB。');
  const format = file.name.split('.').at(-1)?.toLowerCase();
  if (!Object.hasOwn(formats, format)) throw new Error('请选择 MP3、WAV、M4A、FLAC 或 OGG 音频。');
  return { format, mime: formats[format] };
}

export function asrRequest(model, audio, hotwords = '') {
  if (!audio?.data || !Object.hasOwn(formats, audio.format)) throw new Error('请先选择音频文件。');
  return {
    model,
    input: { messages: [
      ...(hotwords.trim() ? [{ role: 'system', content: [{ text: hotwords.trim() }] }] : []),
      { role: 'user', content: [{ audio: audio.data }] },
    ] },
    parameters: { format: audio.format, asr_options: { language: 'zh', enable_itn: true } },
  };
}

export function asrExample(model) {
  return JSON.stringify(asrRequest(model || 'asr', { format: 'mp3', data: 'data:audio/mp3;base64,<音频文件的 Base64>' }, '可选热词，例如：AI Gateway、百炼'), null, 2);
}

export function asrTestRequest(audio, hotwords = '') {
  const { input, parameters } = asrRequest('', audio, hotwords);
  return { protocol: 'dashscope-asr', input, parameters };
}
