import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Globe2, Monitor } from 'lucide-react';
import type { SavedHost } from '../../../packages/client/index';

export function HostPicker({ hosts, fallback, onSelect }: { hosts: SavedHost[]; fallback: string; onSelect(id: string): void }) {
  const selected = hosts.find(host => host.selected);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const id = useId();
  const activeIndex = Math.min(active, Math.max(0, hosts.length - 1));
  const Icon = selected?.local === false ? Globe2 : Monitor;
  function show() { setActive(Math.max(0, hosts.findIndex(host => host.selected))); search.current.text = ''; setOpen(true); }
  function close(restore = false) { setOpen(false); if (restore) trigger.current?.focus(); }
  function choose(host: SavedHost) { close(true); if (!host.selected) onSelect(host.id); }
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [open, activeIndex, id]);
  useEffect(() => { setOpen(false); }, [selected?.id]);
  function navigate(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (hosts[activeIndex]) choose(hosts[activeIndex]); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : event.key === 'End' ? hosts.length - 1 : (activeIndex + (event.key === 'ArrowDown' ? 1 : hosts.length - 1)) % hosts.length);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
      const now = Date.now();
      search.current.text = (now - search.current.time < 600 ? search.current.text : '') + event.key.toLocaleLowerCase(); search.current.time = now;
      const match = hosts.findIndex(host => host.name.toLocaleLowerCase().startsWith(search.current.text));
      if (match >= 0) { event.preventDefault(); setActive(match); }
    }
  }
  return <div className="host-picker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}>
    <button ref={trigger} type="button" className="host-select" aria-label="접속할 컴퓨터" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={!hosts.length}
      onClick={() => open ? close() : show()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}>
      <span className="host-device-icon"><Icon size={18}/></span><span className="host-label"><strong title={selected?.name || fallback}>{selected?.name || fallback}</strong><small>{selected ? selected.local ? '이 PC' : '원격 컴퓨터' : '컴퓨터 불러오는 중…'}</small></span><ChevronDown className="host-chevron" size={15}/>
    </button>
    {open && <div className="host-popover"><div className="host-menu-heading">컴퓨터 전환<span>{hosts.length}</span></div>
      <div id={id} className="host-options" ref={list} role="listbox" aria-label="접속할 컴퓨터 목록" tabIndex={0} aria-activedescendant={hosts.length ? `${id}-${activeIndex}` : undefined} onKeyDown={navigate}>
        {hosts.map((host, index) => { const DeviceIcon = host.local ? Monitor : Globe2; return <div id={`${id}-${index}`} key={host.id} role="option" aria-selected={host.selected} aria-label={`${host.name} · ${host.local ? '이 PC' : '원격 컴퓨터'}`} className={`host-option ${index === activeIndex ? 'highlighted' : ''}`} onPointerMove={() => setActive(index)} onClick={() => choose(host)}>
          <span className="host-device-icon"><DeviceIcon size={18}/></span><span className="host-label"><strong title={host.name}>{host.name}</strong><small>{host.local ? '이 PC' : '원격 컴퓨터'}</small></span>{host.selected && <Check className="host-check" size={17} aria-hidden="true"/>}
        </div>; })}
      </div>
    </div>}
  </div>;
}
