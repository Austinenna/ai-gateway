import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { connectionProtocols, protocolName } from './connection-protocols';

type CatalogModel = { id: string; display_name: string; created_at?: number };
type Catalog = { models: CatalogModel[]; protocol: string; truncated: boolean };
type Connection = { id: string; provider: string; enabled: boolean; endpoints: Record<string, string> };

export function ModelCatalogField({ connection, value, onChange, onSelect }: {
  connection?: Connection; value: string; onChange: (value: string) => void;
  onSelect: (id: string, name: string) => void;
}) {
  const protocols = connectionProtocols(connection);
  const [protocol, setProtocol] = useState<string>(protocols[0] || '');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState('10');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function discover() {
    if (!connection || !protocol) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true); setError(''); setCatalog(null);
    try {
      const response = await fetch('/api/admin/connections/' + connection.id + '/models', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Gateway-Admin': '1' },
        body: JSON.stringify({ protocol }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '获取失败，请重试或手动填写模型 ID');
      if (!controller.signal.aborted) setCatalog(result);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '获取失败，请手动填写模型 ID');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const matches = catalog?.models.filter(m => (m.id + ' ' + m.display_name).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) || [];
  const visible = limit === 'all' ? matches : matches.slice(0, Number(limit));
  const dated = catalog?.models.filter(m => m.created_at).length || 0;
  return <div className="model-catalog-field">
    <label className="field"><span>厂商模型 ID</span>
      <input required value={value} onChange={e => onChange(e.target.value)} placeholder="厂商提供的模型 ID"/>
      <small>可从厂商获取后选择，也可手动填写。</small>
    </label>
    <div className="catalog-source">
      {protocols.length > 1 && <label><span>获取协议</span><select aria-label="获取协议" value={protocol} onChange={e => {
        pending.current?.abort(); setLoading(false); setProtocol(e.target.value); setCatalog(null); setError(''); setSearch('');
      }}>{protocols.map(p => <option key={p} value={p}>{protocolName(p)}</option>)}</select></label>}
      <button type="button" disabled={loading || !connection?.enabled || !protocol} onClick={discover}>
        {catalog ? <RefreshCw size={14}/> : <Download size={14}/>}{loading ? '获取中…' : catalog ? '刷新模型列表' : '获取模型列表'}
      </button>
    </div>
    {!connection && <p className="catalog-note">请先选择所属连接。</p>}
    {connection && !connection.enabled && <p className="catalog-note">连接已停用，启用后可获取列表；仍可手动填写。</p>}
    {error && <p className="error catalog-error" role="alert">{error}</p>}
    {catalog && <section className="model-catalog" aria-label="厂商模型列表">
      <div className="catalog-filters">
        <label className="field"><span>搜索模型</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="模型 ID 或名称"/></label>
        <label className="field"><span>显示数量</span><select value={limit} onChange={e => setLimit(e.target.value)}><option value="10">前 10 个</option><option value="20">前 20 个</option><option value="50">前 50 个</option><option value="all">全部</option></select></label>
      </div>
      <p className="catalog-note" role="status">{catalog.models.length ? `已获取 ${catalog.models.length} 个，显示 ${visible.length} 个。` : '厂商返回的模型列表为空，可手动填写。'}{catalog.models.length > 0 && (dated ? `按厂商提供的时间从新到旧排列${dated < catalog.models.length ? '，时间未知的排在后面' : ''}。` : '未提供有效时间，无法判断新旧，按模型 ID 排列。')}</p>
      {catalog.truncated && <p className="catalog-note catalog-partial">仅获取了部分结果，不能保证包含全部模型中的最新项。</p>}
      {matches.length === 0 && catalog.models.length > 0 && <p className="catalog-note">没有匹配的模型，仍可手动填写。</p>}
      {visible.length > 0 && <ul className="catalog-results">{visible.map(m => <li key={m.id}>
        <button type="button" aria-label={'选择 ' + m.id} aria-pressed={value === m.id} onClick={() => onSelect(m.id, m.display_name)}>
          <span><strong>{m.display_name}</strong>{m.display_name !== m.id && <code>{m.id}</code>}</span>
          <small>{m.created_at ? new Date(m.created_at * 1000).toISOString().slice(0, 10) : '时间未知'}</small>
        </button>
      </li>)}</ul>}
      <p className="catalog-note">列表来自 {protocolName(catalog.protocol)} 端点；套餐权限及所勾选协议的可用性，请保存后通过模型测试确认。</p>
    </section>}
  </div>;
}
