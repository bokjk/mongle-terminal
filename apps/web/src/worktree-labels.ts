import type { TerminalInfo, Worktree } from '../../../packages/protocol/index';

export function terminalLabel(terminal:TerminalInfo,worktrees:Worktree[]=[]){
  const name=worktrees.find(item=>item.id===terminal.worktreeId)?.name;
  return name?`${name} · ${terminal.title}`:terminal.title;
}
export function outsideWorktree(terminal:TerminalInfo,worktree?:Worktree){
  if(!worktree||!terminal.currentCwd)return false;
  const normalize=(value:string)=>value.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();
  const root=normalize(worktree.path),cwd=normalize(terminal.currentCwd);
  return cwd!==root&&!cwd.startsWith(root+'/');
}
