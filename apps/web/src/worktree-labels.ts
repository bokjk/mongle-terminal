import type { TerminalInfo, Worktree } from '../../../packages/protocol/index';

export function worktreeName(worktree:Worktree){
  return worktree.main&&['원래 작업','원본 폴더'].includes(worktree.name)
    ?worktree.path.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1)||'기본 작업'
    :worktree.name;
}

export function terminalLabel(terminal:TerminalInfo,worktrees:Worktree[]=[]){
  const worktree=worktrees.find(item=>item.id===terminal.worktreeId),name=worktree&&worktreeName(worktree);
  return name?`${name} · ${terminal.title}`:terminal.title;
}
export function outsideWorktree(terminal:TerminalInfo,worktree?:Worktree){
  if(!worktree||!terminal.currentCwd)return false;
  const normalize=(value:string)=>value.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();
  const root=normalize(worktree.path),cwd=normalize(terminal.currentCwd);
  return cwd!==root&&!cwd.startsWith(root+'/');
}
