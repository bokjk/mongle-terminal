import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Action = { label: string; disabled?: boolean; danger?: boolean; onSelect: () => void };

export function WorktreeActions({ name, actions }: { name: string; actions: Action[] }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const firstFocus = useRef<'first' | 'last'>('first');
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current!, popup = menu.current!, sidebar = button.closest('.sidebar');
    // A body portal avoids the sidebar's scroll clipping and mobile transform.
    const position = () => {
      if (window.matchMedia('(max-width: 700px)').matches && !sidebar?.classList.contains('open')) { setOpen(false); return; }
      const anchor = button.getBoundingClientRect(), bounds = popup.getBoundingClientRect();
      const margin = 8, gap = 4;
      const left = Math.max(margin, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - margin));
      const below = anchor.bottom + gap;
      const top = below + bounds.height <= window.innerHeight - margin ? below : Math.max(margin, anchor.top - bounds.height - gap);
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    };
    const outside = (event: Event) => {
      if (!button.contains(event.target as Node) && !popup.contains(event.target as Node)) setOpen(false);
    };
    const scroll = (event: Event) => {
      if (popup.contains(event.target as Node)) return;
      const anchor = button.getBoundingClientRect(), list = button.closest('.group-list')?.getBoundingClientRect();
      if (list && (anchor.top < list.top || anchor.bottom > list.bottom)) setOpen(false);
      else position();
    };
    position();
    const items = popup.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    ((firstFocus.current === 'last' ? items[items.length - 1] : items[0]) || popup).focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(popup);
    observer.observe(sidebar || button);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  return <>
    <button ref={trigger} type="button" className="icon-button worktree-actions" aria-label={`${name} 워크트리 메뉴`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { firstFocus.current = 'first'; setOpen(value => !value); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); firstFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'; setOpen(true);
        }
      }}>···</button>
    {open && createPortal(<div ref={menu} id={id} className="worktree-menu" role="menu" tabIndex={-1} aria-label={`${name} 워크트리 작업`}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') close();
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}>
      {actions.map(action => <button key={action.label} type="button" role="menuitem" tabIndex={-1} className={`menu-item${action.danger ? ' danger' : ''}`} disabled={action.disabled}
        onClick={() => { close(); action.onSelect(); }}>{action.label}</button>)}
    </div>, document.body)}
  </>;
}
