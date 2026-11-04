import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';

export function OutboundProxyPanel({
  value,
  proxiedCount,
  busy,
  onSave,
}: {
  value: string;
  proxiedCount: number;
  busy: boolean;
  onSave: (url: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  // A saved or externally changed address replaces the draft; a failed save keeps it.
  useEffect(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);
  const shown = editing ? draft : value;
  const status = value
    ? proxiedCount
      ? `${proxiedCount} 个连接走代理，其余直连。`
      : '已设置，但还没有连接开启「走出站代理」。'
    : '未设置：出站请求按服务器环境变量 HTTPS_PROXY / NO_PROXY 决定。';
  return (
    <section className="panel outbound-proxy" aria-label="出站代理">
      <div className="outbound-proxy-text">
        <h2>
          <Globe size={16} />
          出站代理
        </h2>
        <p className="muted small">{status}在连接里打开「走出站代理」即可让该厂商经此地址访问。</p>
      </div>
      <form
        className="outbound-proxy-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(shown.trim());
        }}
      >
        <input
          aria-label="代理地址"
          value={shown}
          placeholder="http://127.0.0.1:7890"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setEditing(true);
            setDraft(e.target.value);
          }}
        />
        <button className="primary" disabled={busy || shown.trim() === value}>
          {shown.trim() || !value ? '保存' : '清除'}
        </button>
      </form>
    </section>
  );
}
