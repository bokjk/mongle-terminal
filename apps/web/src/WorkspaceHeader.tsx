import { Folder, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Group } from '../../../packages/protocol/index';
import { terminalStatusDescription, TerminalStatusBadge, type TerminalStatusSummary } from './TerminalStatus';

/** The desktop title bar contains global navigation; pane tabs stay local to each split. */
export function WorkspaceHeader({ hostPicker, hostActions, groups, activeId, connected, native, onSelect, onNewGroup, groupStatuses }: {
  hostPicker: ReactNode; hostActions: ReactNode; groups: Group[]; activeId: string;
  connected: boolean; native: boolean;
  groupStatuses?: ReadonlyMap<string, TerminalStatusSummary | undefined>;
  onSelect(id: string): void; onNewGroup(): void;
}) {
  return <header className={`desktop-header ${native ? 'native-titlebar' : ''}`}>
    <div className="desktop-brand"><img src="./icon-192.png" alt="" draggable={false}/><span>몽글<span>터미널</span></span></div>
    {hostPicker}{hostActions}
    <nav className="workspace-switcher" aria-label="작업 공간 전환">
      {groups.map(group => <button key={group.id} className="workspace-switch" aria-current={group.id === activeId ? 'page' : undefined} aria-description={terminalStatusDescription(groupStatuses?.get(group.id))} title={group.name} onClick={() => onSelect(group.id)}><Folder size={14}/><span className="workspace-switch-name">{group.name}</span><TerminalStatusBadge status={groupStatuses?.get(group.id)} compact/></button>)}
    </nav>
    <button className="icon-button" aria-label="새 작업 공간" title="새 작업 그룹" disabled={!connected} onClick={onNewGroup}><Plus size={16}/></button>
    <div className="titlebar-drag-space" aria-hidden="true"/>
    <h1 className="screen-reader-only">{groups.find(group => group.id === activeId)?.name || '나의 작업 공간'}</h1>
  </header>;
}
