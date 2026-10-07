import { useEffect, useRef, type DragEvent, type KeyboardEvent } from 'react';
import { GitBranch, SquareTerminal, X } from 'lucide-react';
import type { TerminalInfo, Worktree } from '../../../packages/protocol/index';
import { terminalLabel } from './worktree-labels';
import type { TabInsertion } from '../../../packages/ui/layout';
import { terminalStatus, terminalStatusDescription, TerminalStatusBadge } from './TerminalStatus';

export function TerminalTabs({terminals,activeId,connected,worktrees,insertion,onSelect,onClose,onRename,clickAllowed,dragEnabled,onDragStart,onDragEnd,unread}:{
  terminals:TerminalInfo[];activeId:string;connected:boolean;worktrees?:Worktree[];
  onSelect:(id:string,focusTab?:boolean)=>void;onClose:(terminal:TerminalInfo)=>void;onRename:(terminal:TerminalInfo)=>void;clickAllowed:()=>boolean;
  dragEnabled:boolean;onDragStart:(event:DragEvent<HTMLElement>,id:string)=>void;onDragEnd:()=>void;
  insertion?:TabInsertion;
  unread?:ReadonlySet<string>;
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
    {terminals.map(terminal=>{const worktree=worktrees?.find(w=>w.id===terminal.worktreeId);const Icon=worktree?GitBranch:SquareTerminal;const status=terminalStatus(terminal,unread?.has(terminal.id)===true);return <div key={terminal.id} className={`terminal-tab ${terminal.id===activeId?'active':''}`} data-tab-id={terminal.id} data-drop-side={insertion?.id===terminal.id?insertion.side:undefined}>
      <button ref={button=>{if(button)buttons.current.set(terminal.id,button);else buttons.current.delete(terminal.id);}}
        id={`terminal-tab-${terminal.id}`} className="terminal-tab-select pane-title" role="tab"
        aria-label={terminalLabel(terminal,worktrees)} aria-selected={terminal.id===activeId}
        aria-description={terminalStatusDescription(status)}
        aria-controls={`terminal-panel-${terminal.id}`}
        draggable={dragEnabled} onDragStart={event=>{event.stopPropagation();onDragStart(event,terminal.id);}} onDragEnd={event=>{event.stopPropagation();onDragEnd();}}
        tabIndex={terminal.id===activeId?0:-1} title={`${terminalLabel(terminal,worktrees)} · ${terminal.currentCwd||terminal.cwd}${terminal.status==='running'?'':' · 종료됨'}${dragEnabled?' · 끌어서 탭 순서 변경·다른 영역에 합치기·분할':''}`}
        onClick={()=>{if(clickAllowed())onSelect(terminal.id);}} onDoubleClick={()=>onRename(terminal)} onKeyDown={event=>navigate(event,terminal)}>
        {worktree?.main?<span className="worktree-kind worktree-kind-main" title="이 저장소의 기본 작업">기본</span>:<Icon size={14} aria-label={worktree?'워크트리':'일반 터미널'}/>}<span className="terminal-tab-title">{terminalLabel(terminal,worktrees)}</span>
        <TerminalStatusBadge status={status} compact/>
        {terminal.status!=='running'&&<span className="terminal-tab-ended" aria-hidden="true"/>}
      </button>
      <button className="terminal-tab-close" tabIndex={-1} aria-label={`${terminalLabel(terminal,worktrees)} 탭 닫기`} title="터미널 종료 및 탭 닫기" disabled={!connected} onClick={()=>onClose(terminal)}><X size={13}/></button>
    </div>;})}
  </div>;
}
