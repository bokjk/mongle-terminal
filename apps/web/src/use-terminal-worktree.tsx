import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HostState, ProjectInspection, Repository, TerminalInfo } from '../../../packages/protocol';
import { WorktreeCreateModal, type ProjectRequest } from './Projects';

export interface TerminalWorktreeActions {
  request: ProjectRequest;
  refresh: (repositoryId:string)=>Promise<ProjectInspection|undefined>;
  prepareFocus: (groupId:string)=>(id?:string)=>void;
  onError: (message:string)=>void;
}

/** The repository context follows the visible tab, never the group's default folder. */
export function useTerminalWorktree(state:HostState, info:TerminalInfo, connected:boolean, actions?:TerminalWorktreeActions) {
  const path=info.currentCwd||info.cwd;
  const key=`${state.hostId}:${state.bootId}:${info.id}:${info.groupId}:${path}`;
  const supported=state.capabilities?.includes('worktrees.terminal-context');
  const wsl=state.profiles.find(profile=>profile.id===info.profileId)?.kind==='wsl';
  const enabled=Boolean(actions&&connected&&supported&&!wsl);
  const [inspection,setInspection]=useState<{key:string;value?:ProjectInspection;error?:string}>();
  const [creating,setCreating]=useState<{repository:Repository;inspection:ProjectInspection;groupId:string;terminalId:string}>();
  const [busy,setBusy]=useState(false);
  const recheck=useRef(()=>{});
  const current=useRef({state,info,key,actions,enabled});current.current={state,info,key,actions,enabled};
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!enabled)return;
    let disposed=false,inFlight=false,lastCheck=0;
    const inspect=async()=>{
      if(inFlight||Date.now()-lastCheck<2000)return;inFlight=true;lastCheck=Date.now();
      try{const value=await current.current.actions!.request<ProjectInspection>('projects.inspect',{path});if(!disposed)setInspection({key,value});}
      catch(error){if(!disposed)setInspection({key,error:error instanceof Error?error.message:'저장소를 확인하지 못했습니다.'});}
      finally{inFlight=false;}
    };
    recheck.current=()=>void inspect();
    const timer=setTimeout(()=>void inspect(),200);
    const focused=()=>void inspect();window.addEventListener('focus',focused);
    return()=>{disposed=true;recheck.current=()=>{};clearTimeout(timer);window.removeEventListener('focus',focused);};
  },[key,enabled]);
  const result=inspection?.key===key?inspection:undefined;
  const reason=!connected?'컴퓨터에 연결한 뒤 사용할 수 있습니다.':!supported?'워크트리를 만들려면 호스트 업데이트가 필요합니다.':wsl?'WSL 내부 저장소는 아직 지원하지 않습니다.':busy?'저장소를 확인하고 있습니다.':!result?'현재 폴더의 Git 저장소 확인 중…':result.error;
  async function open(){
    if(busy||reason||!actions)return;
    const group=state.groups.find(group=>group.id===info.groupId);if(!group)return;
    setBusy(true);
    try{
      const attached=await actions.request<{repository:Repository;inspection:ProjectInspection}>('projects.attach',{path,groupId:group.id,revision:group.revision});
      if(mounted.current&&current.current.key===key&&current.current.enabled)setCreating({...attached,groupId:group.id,terminalId:info.id});
    }catch(error){if(mounted.current&&current.current.key===key)actions.onError(error instanceof Error?error.message:'저장소를 확인하지 못했습니다.');}
    finally{if(mounted.current)setBusy(false);}
  }
  const group=creating&&state.groups.find(group=>group.id===creating.groupId);
  return {
    disabled:Boolean(reason),
    title:reason||`${result?.value?.root} · 현재 터미널에서 워크트리 만들기`,
    open,
    recheck:()=>recheck.current(),
    dialog:creating&&group&&actions?createPortal(<WorktreeCreateModal group={group} state={state} repository={creating.repository} inspection={creating.inspection} request={actions.request} refresh={()=>actions.refresh(creating.repository.id)} activeId={creating.terminalId} prepareFocus={()=>actions.prepareFocus(creating.groupId)} onClose={()=>setCreating(undefined)} onDone={op=>{setCreating(undefined);if(op.message)actions.onError(op.message);}}/>,document.body):null,
  };
}
