import { useMemo } from 'react';
import { responseDetails } from './response-details.mjs';

function formatArguments(value: string) {
  if (!value) return { text: '未返回参数', incomplete: false };
  try { return { text: JSON.stringify(JSON.parse(value), null, 2), incomplete: false }; }
  catch { return { text: value, incomplete: true }; }
}

export function ResponseDetails({ output }: { output: string }) {
  const result = useMemo(() => responseDetails(output), [output]);
  const multipleChoices = new Set(result.parts.map(p => p.choice)).size > 1;
  return <div className="response-details">
    <div className="response-summary">
      <h3>本次模型返回</h3>
      <div className="response-counts"><span>思考文本 {result.thinkingCount} 段</span><span>工具调用 {result.toolCount} 个</span></div>
      <p>按返回顺序整理内容。思考文本仅展示上游实际返回的部分。</p>
    </div>
    {result.warnings.map(warning => <p className="response-warning" key={warning}>{warning}</p>)}
    {!result.parts.length && <p className="muted">{result.hasData ? '上游返回了数据，但没有可识别的正文、思考文本或工具调用。请查看原始数据。' : '没有可解析的响应内容，请查看原始数据。'}</p>}
    {result.parts.map((part, index) => {
      const args = formatArguments(part.arguments);
      const label = part.kind === 'thinking' ? '思考文本' : part.kind === 'tool' ? '工具调用' : part.kind === 'text' ? '回答正文' : part.kind === 'error' ? '上游错误' : '其他内容';
      return <details className={'response-part response-part-' + part.kind} key={index} open>
        <summary><span className="response-part-label">{label}</span>{part.kind === 'tool' && <code>{part.name || '工具名称未返回'}</code>}{multipleChoices && <span className="muted">候选 {part.choice + 1}</span>}</summary>
        <div className="response-part-body">
          {part.kind === 'tool' ? <>
            {part.id && <p className="response-call-id">调用 ID <code>{part.id}</code></p>}
            <div className="response-argument-label">调用参数</div>
            <pre>{args.text}</pre>
            {args.incomplete && <p className="response-warning">参数不是完整 JSON，按收到的内容展示；可能尚未收齐或格式不符合预期。</p>}
          </> : <p className="response-text">{part.text}</p>}
        </div>
      </details>;
    })}
    {result.finishReasons.length > 0 && <p className="response-finish">结束原因 {result.finishReasons.map(reason => <code key={reason}>{reason}</code>)}</p>}
    {result.toolCount > 0 && <p className="response-note">这里是模型返回的工具调用指令。执行结果由客户端带入后续请求，可在对应请求的 TOOL 消息中查看。</p>}
  </div>;
}
