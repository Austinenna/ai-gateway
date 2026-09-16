import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

// Clipping a preview never creates a second scroll area inside the message.
export function TextPreview({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

  useLayoutEffect(() => {
    const body = bodyRef.current!, window = windowRef.current!;
    const measure = () => {
      if (!body.getClientRects().length) return;
      const limit = parseFloat(getComputedStyle(window).getPropertyValue('--preview-height'));
      setLong(body.scrollHeight > limit + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  function toggle() {
    setExpanded(value => !value);
    if (expanded) requestAnimationFrame(() => windowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
  }

  return <div className="text-preview">
    <div ref={windowRef} id={contentId} className={'text-preview-window' + (expanded ? ' is-expanded' : long ? ' is-clipped' : '')}>
      <div ref={bodyRef} className="text-preview-body">{children}</div>
    </div>
    {long && <button type="button" className="text-preview-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={toggle}>
      {expanded ? '收起全文' : '展开全文'}<ChevronDown size={13} aria-hidden="true"/>
    </button>}
  </div>;
}
