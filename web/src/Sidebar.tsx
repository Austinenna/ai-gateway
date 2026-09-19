import { useState, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, Waypoints } from 'lucide-react';
import './sidebar.css';

const preferenceKey = 'ai-gateway.sidebar-collapsed';

export function Sidebar({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(preferenceKey) === 'true'; }
    catch { return false; }
  });
  const toggleLabel = collapsed ? '展开侧边栏' : '收起侧边栏';

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(preferenceKey, String(next)); }
    catch { /* The toggle still works when browser storage is unavailable. */ }
  }

  return <aside className={'sidebar' + (collapsed ? ' is-collapsed' : '')} aria-label="侧边栏">
    <div className="sidebar-header">
      <div className="brand" title="AI Gateway">
        <span className="brand-icon"><Waypoints size={20} aria-hidden="true"/></span>
        <span className="sidebar-label">AI Gateway</span>
      </div>
      <button type="button" className="icon-btn sidebar-toggle" onClick={toggle}
        aria-label={toggleLabel} title={toggleLabel} aria-expanded={!collapsed} aria-controls="workspace-navigation">
        {collapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}
      </button>
    </div>
    {children}
  </aside>;
}
