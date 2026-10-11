import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

// Return focus to the control that opened the dialog. An item in a menu is hidden once its menu closes,
// so focus the button that opens that menu instead of leaving focus on the page.
function restoreFocus(opener:HTMLElement|null){opener?.focus();if(opener&&document.activeElement!==opener)opener.closest('details')?.querySelector<HTMLElement>(':scope > summary')?.focus();}

export function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  const panel=useRef<HTMLDivElement>(null);
  // Remember the opener while rendering: a field with autoFocus inside the dialog takes focus before effects run.
  const [opener]=useState(()=>document.activeElement as HTMLElement|null);
  useEffect(()=>{const previous=opener;const target=panel.current;const focusables=()=>Array.from(target?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')||[]);if(!target?.contains(document.activeElement))(target?.querySelector<HTMLElement>('[data-initial-focus="true"],[autofocus]')||focusables()[0])?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();onClose();}if(e.key==='Tab'){const elements=focusables();const first=elements[0],last=elements.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};target?.addEventListener('keydown',key);return()=>{target?.removeEventListener('keydown',key);restoreFocus(previous);};},[]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={panel} className="modal" role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={18}/></button></header>{children}</div></div>;
}
