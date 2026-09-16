import type { RequestAdaptation } from './monitoring';

export function RequestAdaptations({ changes }: { changes?: RequestAdaptation[] }) {
  if (!changes?.length) return null;
  return <section className="request-adaptations" aria-label="网关参数适配">
    <h3>网关参数适配</h3>
    {changes.map((change, index) => <div key={`${change.rule}-${index}`}>
      <strong>{change.rule === 'minimax-m3-messages-thinking' ? 'MiniMax M3 · 开启思考' : change.rule}</strong>
      <p><code>{change.field}</code>：<code>{change.before}</code> → <code>{change.after}</code></p>
      {!!change.removed_fields?.length && <p>已移除：<code>{change.removed_fields.join('、')}</code>。
        {change.removed_fields.includes('thinking.budget_tokens') && '客户端指定的思考预算不再生效，max_tokens 总输出上限保持原值。'}</p>}
    </div>)}
    <small>原始数据保留适配前的请求；以上为网关转发前应用的参数转换。</small>
  </section>;
}
