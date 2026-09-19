import Markdown from 'react-markdown';

export default function MarkdownBody({ text }: { text: string }) {
  const source = (node?: {position?: {start: {offset?: number}; end: {offset?: number}}}) => {
    const start = node?.position?.start.offset, end = node?.position?.end.offset;
    return start != null && end != null ? text.slice(start, end) : '';
  };
  return <div className="prompt-markdown"><Markdown
    urlTransform={url => /^https?:\/\//i.test(url) ? url : ''}
    components={{
      // Keep original image/link syntax when rendering it could trigger a request or unsafe navigation.
      img: ({ node }) => <span>{source(node)}</span>,
      a: ({ href, children, node }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{source(node) || children}</span>,
    }}
  >{text}</Markdown></div>;
}
