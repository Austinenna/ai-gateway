export function ModelContextWindow({ value, onChange }: {
  value?: number;
  onChange: (value: number) => void;
}) {
  return <label className="field">
    <span>上下文窗口（Token，可选）</span>
    <input type="number" min="1" max="2147483647" step="1" value={value || ''}
      placeholder="填写模型支持的最大 Token 数"
      onChange={e => onChange(e.target.value === '' ? 0 : Number(e.target.value))}/>
    <small>模型可容纳的总 Token 数，包含输入与输出；留空表示未设置。单次输出长度由 max_tokens 单独控制。</small>
  </label>;
}
