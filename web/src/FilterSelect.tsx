import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './filter-select.css';

export type FilterOption = { value: string; label: string; hint?: string };

export function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string; options: FilterOption[]; onChange: (value: string) => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 300 });
  const typed = useRef({ text: '', time: 0 });
  const selected = options.findIndex(option => option.value === value);
  const current = options[selected];

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 14, above = rect.top - 14;
      const height = Math.min(300, Math.max(below, above));
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 24);
      if (menu.current) menu.current.style.width = `${width}px`;
      const menuHeight = Math.min(menu.current?.scrollHeight || height, height);
      setPosition({ top: below >= menuHeight ? rect.bottom + 6 : rect.top - menuHeight - 6,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width, maxHeight: height });
    };
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) place(); };
    place();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open, options.length]);
  useEffect(() => {
    if (open) menu.current?.querySelectorAll('[role=option]')[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function choose(index: number) {
    if (options[index]) onChange(options[index].value);
    setOpen(false);
    trigger.current?.focus();
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = options.length - 1;
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Escape') { if (open) event.preventDefault(); setOpen(false); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : event.key === 'End' ? last : !open ? Math.max(0, selected) :
        Math.max(0, Math.min(last, active + (event.key === 'ArrowDown' ? 1 : -1))));
      setOpen(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active); else { setActive(Math.max(0, selected)); setOpen(true); }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.time < 700 ? typed.current.text : '') + event.key.toLowerCase(), time: now };
      const match = options.findIndex(option => option.label.toLowerCase().startsWith(typed.current.text));
      if (match >= 0) { setActive(match); setOpen(true); }
    }
  }

  return <>
    <button ref={trigger} type="button" role="combobox" className={'filter-select-trigger' + (selected > 0 ? ' has-value' : '')}
      aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
      title={current?.label} onKeyDown={keyDown} onBlur={() => setOpen(false)}
      onClick={() => { setActive(Math.max(0, selected)); setOpen(!open); }}>
      <span>{current?.label || '请选择'}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} className="filter-select-menu" style={position}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option"
        aria-selected={option.value === value} className={'filter-select-option' + (active === index ? ' is-active' : '')}
        onPointerDown={event => event.preventDefault()}
        onClick={() => choose(index)} onMouseMove={() => setActive(index)}>
        <span><span>{option.label}</span>{option.hint && <small>{option.hint}</small>}</span>
        {option.value === value && <Check size={15} aria-hidden="true"/>}
      </div>)}
    </div>, document.body)}
  </>;
}
