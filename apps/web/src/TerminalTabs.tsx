import { useEffect, useRef, type KeyboardEvent } from 'react';
import { SquareTerminal, X } from 'lucide-react';
import type { TerminalInfo } from '../../../packages/protocol/index';

export function TerminalTabs({terminals,activeId,tabbed,connected,onSelect,onClose}:{
  terminals:TerminalInfo[];activeId:string;tabbed:boolean;connected:boolean;
  onSelect:(id:string)=>void;onClose:(terminal:TerminalInfo)=>void;
}){
  const buttons=useRef(new Map<string,HTMLButtonElement>());
  const ids=terminals.map(terminal=>terminal.id).join(',');
  useEffect(()=>{buttons.current.get(activeId)?.scrollIntoView({block:'nearest',inline:'nearest'});},[activeId,ids]);
  function navigate(event:KeyboardEvent<HTMLButtonElement>,terminal:TerminalInfo){
    if(event.altKey||event.ctrlKey||event.metaKey)return;
    if(event.key==='Delete'){event.preventDefault();if(connected)onClose(terminal);return;}
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const index=terminals.findIndex(item=>item.id===terminal.id);
    const next=event.key==='Home'?0:event.key==='End'?terminals.length-1:(index+(event.key==='ArrowLeft'?-1:1)+terminals.length)%terminals.length;
    const id=terminals[next]?.id;if(!id)return;
    onSelect(id);buttons.current.get(id)?.focus();
  }
  return <div className="terminal-tabs" role={tabbed?'tablist':'group'} aria-label="터미널 탭">
    {terminals.map(terminal=><div key={terminal.id} className={`terminal-tab ${terminal.id===activeId?'active':''}`}>
      <button ref={button=>{if(button)buttons.current.set(terminal.id,button);else buttons.current.delete(terminal.id);}}
        id={`terminal-tab-${terminal.id}`} className="terminal-tab-select" role={tabbed?'tab':undefined}
        aria-label={terminal.title} aria-selected={tabbed?terminal.id===activeId:undefined}
        aria-pressed={tabbed?undefined:terminal.id===activeId} aria-controls={tabbed?`terminal-panel-${terminal.id}`:undefined}
        tabIndex={terminal.id===activeId?0:-1} title={`${terminal.title} · ${terminal.currentCwd||terminal.cwd}${terminal.status==='running'?'':' · 종료됨'}`}
        onClick={()=>onSelect(terminal.id)} onKeyDown={event=>navigate(event,terminal)}>
        <SquareTerminal size={14}/><span className="terminal-tab-title">{terminal.title}</span>
        {terminal.status!=='running'&&<span className="terminal-tab-ended" aria-hidden="true"/>}
      </button>
      <button className="terminal-tab-close" tabIndex={-1} aria-label={`${terminal.title} 탭 닫기`} title="터미널 종료 및 탭 닫기" disabled={!connected} onClick={()=>onClose(terminal)}><X size={13}/></button>
    </div>)}
  </div>;
}
