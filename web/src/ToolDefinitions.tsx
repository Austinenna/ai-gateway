import { ChevronRight } from 'lucide-react';
import { readable } from './protocol.mjs';

function toolName(tool: unknown, index: number): string {
  if (tool && typeof tool === 'object') {
    const value = tool as { name?: unknown; function?: { name?: unknown } | null };
    for (const name of [value.function?.name, value.name]) {
      if (typeof name === 'string' && name.trim()) return name;
    }
  }
  return `工具 ${index + 1}`;
}

export function ToolDefinitions({ content }: { content: unknown }) {
  const tools = Array.isArray(content) ? content : [content];
  return <div className="tool-definitions">
    {tools.map((tool, index) => <details className="tool-definition" key={index}>
      <summary><ChevronRight size={14} aria-hidden="true"/><code>{toolName(tool, index)}</code></summary>
      <pre>{readable(tool)}</pre>
    </details>)}
  </div>;
}
