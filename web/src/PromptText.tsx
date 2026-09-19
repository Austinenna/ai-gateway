import { lazy, Suspense, useMemo, useState } from 'react';
import { TextPreview } from './TextPreview';
import { environmentFields, hasPromptFormatting, promptSections, type PromptNode } from './prompt-format.mjs';
import './prompt-text.css';

const MarkdownBody = lazy(() => import('./MarkdownBody'));
const environmentNames: Record<string, string> = { 'OS Version': '操作系统', Shell: 'Shell', 'IDE Theme': '界面主题', 'Workspace Folder': '工作目录', Note: '说明' };
function FormattedParts({ nodes }: { nodes: PromptNode[] }) {
  return <>{nodes.map((node, i) => {
    if (node.type === 'text') return node.raw.trim() ? <Suspense key={i} fallback={<p className="prompt-plain">{node.raw}</p>}><MarkdownBody text={node.raw}/></Suspense> : null;
    const fields = node.tag === 'user_info' ? environmentFields(node.body) : null;
    return <details className="prompt-section" key={i} open={!node.collapsed}>
      <summary><b>{node.label}</b><code>&lt;{node.tag}&gt;</code><small>{node.body.length.toLocaleString('zh-CN')} 字符</small></summary>
      <div className="prompt-section-body">
        {node.attributes && <p className="prompt-attributes">{node.attributes}</p>}
        {fields ? <dl className="prompt-environment">{fields.map((field, j) => <div key={j}><dt>{environmentNames[field.name] || field.name}</dt><dd>{field.value}</dd></div>)}</dl> : <FormattedParts nodes={node.children}/>}
      </div>
    </details>;
  })}</>;
}
export function PromptText({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const nodes = useMemo(() => promptSections(text), [text]);
  const structured = nodes.some(n => n.type === 'section');
  const formatted = structured || hasPromptFormatting(text);
  if (!formatted) return <TextPreview><p>{text}</p></TextPreview>;
  return <div className="prompt-text">
    <div className="prompt-toolbar"><span>{structured ? '已识别上下文区块' : 'Markdown'}</span><div role="group" aria-label="消息显示格式"><button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>格式化</button><button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>原文</button></div></div>
    {raw ? <TextPreview key="raw"><pre className="prompt-source">{text}</pre></TextPreview> : structured ? <div className="prompt-parts"><FormattedParts nodes={nodes}/></div> : <TextPreview key="formatted"><FormattedParts nodes={nodes}/></TextPreview>}
  </div>;
}
