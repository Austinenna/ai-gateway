export type ModelDefaults = {
  temperature?: number;
  max_tokens?: number;
  reasoning_split?: boolean;
  thinking?: { type: 'adaptive' | 'disabled' };
};

export function ModelThinkingDefaults({ provider, protocols, defaults, onChange }: {
  provider?: string;
  protocols: string[];
  defaults: ModelDefaults;
  onChange: (value: ModelDefaults) => void;
}) {
  if (provider !== 'minimax' || !protocols.length) return null;
  return <div className="thinking-defaults">
    <h3>MiniMax 思考默认设置</h3>
    <p className="muted small">只补充请求中缺少的参数，客户端明确传入的值优先。</p>
    {protocols.includes('chat') && <label className="field">
      <span>Chat · 思考拆分</span>
      <select aria-label="Chat · 思考拆分" value={defaults.reasoning_split === undefined ? '' : String(defaults.reasoning_split)} onChange={e => {
        const next = { ...defaults };
        if (e.target.value === '') delete next.reasoning_split;
        else next.reasoning_split = e.target.value === 'true';
        onChange(next);
      }}>
        <option value="">不补充参数</option>
        <option value="true">开启拆分</option>
        <option value="false">关闭拆分</option>
      </select>
      <small>将思考与正文分开返回，不改变模型是否开启思考。仅用于 Chat Completions。</small>
    </label>}
    {protocols.includes('messages') && <label className="field">
      <span>Messages · 思考模式</span>
      <select aria-label="Messages · 思考模式" value={defaults.thinking?.type ?? ''} onChange={e => {
        const next = { ...defaults };
        if (e.target.value === '') delete next.thinking;
        else next.thinking = { type: e.target.value as 'adaptive' | 'disabled' };
        onChange(next);
      }}>
        <option value="">不补充参数</option>
        <option value="adaptive">开启思考（adaptive）</option>
        <option value="disabled">关闭思考（disabled）</option>
      </select>
      <small>M3 可开启或关闭思考；M2 系列始终开启。Messages 会用独立内容块返回思考，无需拆分参数。</small>
    </label>}
  </div>;
}
