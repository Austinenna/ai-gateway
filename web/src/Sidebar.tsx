import { useState, type ReactNode } from 'react';
import { PanelLeft, Waypoints } from 'lucide-react';
import './sidebar.css';

const preferenceKey = 'ai-gateway.sidebar-collapsed';

export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(preferenceKey) === 'true'; }
    catch { return false; }
  });
  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(preferenceKey, String(next)); }
    catch { /* The toggle still works when browser storage is unavailable. */ }
  }

  return { collapsed, toggle };
}

export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? '展开侧边栏' : '收起侧边栏';
  return <button type="button" className="icon-btn sidebar-toggle" onClick={onToggle}
    aria-label={label} title={label} aria-expanded={!collapsed} aria-controls="workspace-navigation">
    <PanelLeft size={18} aria-hidden="true"/>
  </button>;
}

export function Sidebar({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return <aside className={'sidebar' + (collapsed ? ' is-collapsed' : '')} aria-label="侧边栏">
    <div className="sidebar-header">
      <div className="brand" title="AI Gateway">
        <span className="brand-icon"><Waypoints size={20} aria-hidden="true"/></span>
        <span className="sidebar-label">AI Gateway</span>
      </div>
    </div>
    {children}
  </aside>;
}
