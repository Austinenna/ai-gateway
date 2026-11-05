import type { ReactNode } from 'react';

// Strings (with an optional following colon, which marks a key), literals and numbers.
const token = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

/** JsonText colours JSON-looking text like the console preview; other text passes through unchanged. */
export function JsonText({ text }: { text: string }) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(token)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) {
      out.push(
        <span key={at} className={m[2] ? 'j-key' : 'j-str'}>
          {m[1]}
        </span>,
      );
      if (m[2]) out.push(m[2]);
    } else
      out.push(
        <span key={at} className={m[3] ? 'j-lit' : 'j-num'}>
          {m[0]}
        </span>,
      );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
