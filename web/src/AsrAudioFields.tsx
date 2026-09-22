import { useEffect, useId, useRef, useState } from 'react';
import { audioFormat } from './asr.mjs';

export type AsrAudio = { name: string; data: string; format: string };

export function AsrAudioFields({ audio, onAudio, hotwords, onHotwords, disabled = false }: {
  audio: AsrAudio | null; onAudio: (audio: AsrAudio | null) => void;
  hotwords: string; onHotwords: (value: string) => void; disabled?: boolean;
}) {
  const [error, setError] = useState(''), [reading, setReading] = useState(false);
  const reader = useRef<FileReader | null>(null);
  const hintID = useId();
  useEffect(() => () => reader.current?.abort(), []);
  function select(file?: File) {
    reader.current?.abort(); onAudio(null); setError(''); setReading(false);
    if (!file) return;
    try {
      const { format, mime } = audioFormat(file);
      const next = new FileReader(); reader.current = next; setReading(true);
      next.onload = () => {
        if (reader.current !== next) return;
        const encoded = String(next.result).split(',')[1];
        if (encoded) onAudio({ name: file.name, format, data: `data:${mime};base64,${encoded}` });
        else setError('无法读取音频，请重新选择。');
        setReading(false);
      };
      next.onerror = () => { if (reader.current === next) { setError('无法读取音频，请重新选择。'); setReading(false); } };
      next.readAsDataURL(file);
    } catch (e) { setError((e as Error).message); }
  }
  return <div className="asr-audio-fields">
    <label className="field"><span>音频文件</span><input type="file" aria-label="音频文件" aria-describedby={hintID} accept=".mp3,.wav,.m4a,.flac,.ogg" disabled={disabled} onChange={e => select(e.target.files?.[0])}/><small id={hintID}>MP3、WAV、M4A、FLAC、OGG，最大 20 MiB。默认识别中文，同步返回完整转写。</small></label>
    {reading && <p role="status">正在读取音频…</p>}
    {audio && <p className="muted small">已选择：{audio.name}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <label className="field"><span>热词（可选）</span><textarea rows={2} value={hotwords} disabled={disabled} onChange={e => onHotwords(e.target.value)} placeholder="例如：AI Gateway、百炼"/></label>
  </div>;
}
