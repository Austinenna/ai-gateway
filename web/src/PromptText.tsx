import { lazy, Suspense, useState } from 'react';
import { TextPreview } from './TextPreview';
import './prompt-text.css';

const MarkdownBody = lazy(() => import('./MarkdownBody'));
export function PromptText({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const formatted = /(?:^|\n) {0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|`{3,}|~{3,}|>|<[\w-]+[\s>])|\*\*|`[^`\n]+`|\[[^\]\n]+\]\(/.test(text);
  if (!formatted) return <TextPreview><p>{text}</p></TextPreview>;
  return <div className="prompt-text">
    <div className="prompt-toolbar"><span>Markdown</span><div role="group" aria-label="消息显示格式"><button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>格式化</button><button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>原文</button></div></div>
    {raw ? <TextPreview key="raw"><pre className="prompt-source">{text}</pre></TextPreview> : <TextPreview key="formatted"><Suspense fallback={<p>{text}</p>}><MarkdownBody text={text}/></Suspense></TextPreview>}
  </div>;
}
