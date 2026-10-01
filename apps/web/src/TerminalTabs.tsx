import { useEffect, useRef, type DragEvent, type KeyboardEvent } from 'react';
import { SquareTerminal, X } from 'lucide-react';
import type { TerminalInfo } from '../../../packages/protocol/index';

export function TerminalTabs({terminals,activeId,connected,onSelect,onClose,onRename,clickAllowed,dragEnabled,onDragStart,onDragEnd}:{
  terminals:TerminalInfo[];activeId:string;connected:boolean;
  onSelect:(id:string,focusTab?:boolean)=>void;onClose:(terminal:TerminalInfo)=>void;onRename:(terminal:TerminalInfo)=>void;clickAllowed:()=>boolean;
  dragEnabled:boolean;onDragStart:(event:DragEvent<HTMLElement>,id:string)=>void;onDragEnd:()=>void;
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
    onSelect(id,true);
  }
  return <div className="terminal-tabs" role="tablist" aria-label="터미널 탭">
    {terminals.map(terminal=><div key={terminal.id} className={`terminal-tab ${terminal.id===activeId?'active':''}`}>
      <button ref={button=>{if(button)buttons.current.set(terminal.id,button);else buttons.current.delete(terminal.id);}}
        id={`terminal-tab-${terminal.id}`} className="terminal-tab-select pane-title" role="tab"
        aria-label={terminal.title} aria-selected={terminal.id===activeId}
        aria-controls={`terminal-panel-${terminal.id}`}
        draggable={dragEnabled} onDragStart={event=>{event.stopPropagation();onDragStart(event,terminal.id);}} onDragEnd={event=>{event.stopPropagation();onDragEnd();}}
        tabIndex={terminal.id===activeId?0:-1} title={`${terminal.title} · ${terminal.currentCwd||terminal.cwd}${terminal.status==='running'?'':' · 종료됨'}${dragEnabled?' · 끌어서 이 탭 분할·이동':''}`}
        onClick={()=>{if(clickAllowed())onSelect(terminal.id);}} onDoubleClick={()=>onRename(terminal)} onKeyDown={event=>navigate(event,terminal)}>
        <SquareTerminal size={14}/><span className="terminal-tab-title">{terminal.title}</span>
        {terminal.status!=='running'&&<span className="terminal-tab-ended" aria-hidden="true"/>}
      </button>
      <button className="terminal-tab-close" tabIndex={-1} aria-label={`${terminal.title} 탭 닫기`} title="터미널 종료 및 탭 닫기" disabled={!connected} onClick={()=>onClose(terminal)}><X size={13}/></button>
    </div>)}
  </div>;
}
