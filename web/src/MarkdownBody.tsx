import Markdown from 'react-markdown';
import { frontMatterAsCode } from './prompt-format.mjs';

export default function MarkdownBody({ text }: { text: string }) {
  return <div className="prompt-markdown"><Markdown
    urlTransform={url => /^https?:\/\//i.test(url) ? url : ''}
    components={{
      // Viewing a stored prompt must not load remote images or navigate within the gateway.
      img: ({ alt }) => <span className="prompt-image">[图片{alt ? '：' + alt : ''}]</span>,
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    }}
  >{frontMatterAsCode(text)}</Markdown></div>;
}
