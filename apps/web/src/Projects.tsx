import { useEffect, useRef, useState } from 'react';
import { FolderOpen, GitBranch, SquareTerminal, RefreshCw, LoaderCircle } from 'lucide-react';
import { groupRepositoryIds } from '../../../packages/protocol/index';
import type { Group, HostState, ProjectInspection, Repository, TerminalInfo, Worktree, WorktreeOperation } from '../../../packages/protocol/index';
import { Modal } from './App';
import { terminalLabel } from './worktree-labels';
import { WorktreeActions } from './WorktreeActions';

export type ProjectRequest=<T=any>(method:string,params:Record<string,unknown>)=>Promise<T>;
type Request=ProjectRequest;
type Navigation=(groupId:string)=>(terminalId?:string)=>void;
const message=(error:unknown)=>error instanceof Error?error.message:'작업을 완료하지 못했습니다.';
function readRecent(key:string){try{return localStorage.getItem(key)||undefined;}catch{return undefined;}}
const slug=(name:string)=>name.normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,40)||'work';

export function ProjectOpenModal({group,state,request,pickDirectory,onClose,onConnected,onPlainGroup}:{group?:Group;state:HostState;request:Request;pickDirectory?:(path:string)=>Promise<string|null>;onClose:()=>void;onConnected:(result:{groupId:string;terminalId?:string;warning?:string})=>void;onPlainGroup:(path:string)=>void}){
  const [path,setPath]=useState(group?.cwd||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function attach(value:string){
    setBusy(true);setError('');
    try{const result=await request('projects.attach',{path:value,...(group?{groupId:group.id,revision:group.revision}:{})});if(mounted.current)onConnected(result);}
    catch(error){if(mounted.current)setError(message(error));}
    finally{if(mounted.current)setBusy(false);}
  }
  async function browse(){if(!pickDirectory)return;setBusy(true);setError('');try{const chosen=await pickDirectory(path);if(!mounted.current)return;if(chosen){setPath(chosen);await attach(chosen);}}catch(error){if(mounted.current)setError(message(error));}finally{if(mounted.current)setBusy(false);}}
  useEffect(()=>{if(pickDirectory)void browse();},[]);
  return <Modal title={group?'프로젝트 연결':'프로젝트 열기'} onClose={onClose}><form onSubmit={e=>{e.preventDefault();if(!busy)void attach(path.trim());}}><div className="modal-body">
    <p className="project-context"><FolderOpen size={16}/>{group?.name||'기존 Git 프로젝트'}<span>· {state.name}</span></p>
    <label className="field"><span className="field-label">프로젝트 폴더</span><input className="input" autoFocus required maxLength={4096} value={path} onChange={e=>setPath(e.target.value)} disabled={busy} placeholder="접속한 컴퓨터의 폴더 전체 경로"/></label>
    {pickDirectory&&<button type="button" className="button" disabled={busy} onClick={()=>void browse()}><FolderOpen size={15}/>폴더 선택</button>}
    <p className="hint">{pickDirectory?'기존 Git 폴더를 선택하면 워크트리를 함께 찾습니다.':`${state.name}에 있는 폴더 경로를 입력하세요. 이 기기의 폴더를 대신 열지 않습니다.`}</p>
    {error&&<p className="error-text" role="alert">{error}</p>}
    {error.includes('Git 저장소가 아닙니다')&&<button className="button subtle" type="button" onClick={()=>onPlainGroup(path.trim())}>일반 그룹으로 열기</button>}
  </div><div className="modal-footer"><button className="button" type="button" onClick={onClose}>취소</button><button className="button primary" disabled={busy}>{busy?'프로젝트 확인 중…':group?'연결':'프로젝트 열기'}</button></div></form></Modal>;
}

export function ProjectWorktrees({group,state,activeId,connected,request,beginNavigation,onError,refresh}:{group:Group;state:HostState;activeId:string;connected:boolean;request:Request;beginNavigation:Navigation;onError:(message:string)=>void;refresh:(repositoryId:string)=>Promise<ProjectInspection|undefined>}){
  const [opening,setOpening]=useState<string>(),[choosing,setChoosing]=useState<string>(),[renaming,setRenaming]=useState<Worktree>(),[deleting,setDeleting]=useState<Worktree>();
  const [name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const repositories=state.repositories?.filter(item=>groupRepositoryIds(group).includes(item.id))||[];
  const worktrees=state.worktrees?.filter(item=>repositories.some(repo=>repo.id===item.repositoryId))||[];
  const operations=state.worktreeOperations?.filter(item=>item.groupId===group.id)||[];
  const pending=operations.filter(item=>item.status==='pending'||item.status==='running');
  const latest=operations.at(-1);
  async function open(worktree:Worktree,preferredId?:string){
    if(opening)return;setOpening(worktree.id);
    const finish=beginNavigation(group.id),recent=readRecent(`mongle.worktree.${state.hostId}.${group.id}.${worktree.id}`);
    try{const terminal=await request<TerminalInfo>('worktrees.open',{groupId:group.id,worktreeId:worktree.id,preferredId:preferredId||recent,...(state.terminals.some(t=>t.id===activeId&&t.groupId===group.id)?{tabTarget:activeId}:{})});finish(terminal.id);setChoosing(undefined);}
    catch(error){onError(message(error));}finally{setOpening(undefined);}
  }
  if(!repositories.length)return null;
  return <div className="worktree-list" aria-label={`${group.name} 워크트리`}>
    {worktrees.map(worktree=>{
      const terminals=state.terminals.filter(t=>t.groupId===group.id&&t.worktreeId===worktree.id),selected=terminals.some(t=>t.id===activeId);
      return <div className={`worktree-row ${selected?'selected':''}`} key={worktree.id}>
        <button className="worktree-main" aria-label={`${worktree.name} 워크트리 열기`} aria-current={selected?'true':undefined} disabled={!connected||Boolean(opening)||worktree.status==='removing'||(!terminals.length&&worktree.status!=='ready')} onClick={()=>void open(worktree)} title={`${worktree.path}${worktree.reason?` · ${worktree.reason}`:''}`}>
          {opening===worktree.id?<LoaderCircle size={15} className="spin"/>:<GitBranch size={15}/>}<span><strong>{worktree.name}</strong><small>{worktree.status==='ready'?(worktree.branch||`커밋 ${worktree.head.slice(0,7)}`):worktree.status==='removing'?'삭제 중…':'폴더 확인 필요'}</small>{repositories.length>1&&<small className="worktree-repository" title={repositories.find(repo=>repo.id===worktree.repositoryId)?.root}>{repositories.find(repo=>repo.id===worktree.repositoryId)?.root.split(/[\\/]/).at(-1)}</small>}</span>
        </button>
        {terminals.length>0?<button className="worktree-count" aria-label={`${worktree.name} 터미널 ${terminals.length}개 선택`} title={`열려 있는 터미널 ${terminals.length}개`} onClick={()=>setChoosing(worktree.id)}><SquareTerminal size={12}/>{terminals.length}</button>:<span className="worktree-empty" title="이름을 누르면 터미널이 열립니다">없음</span>}
        <WorktreeActions name={worktree.name} actions={[
          {label:'이름 변경',disabled:!connected,onSelect:()=>{setError('');setName(worktree.name);setRenaming(worktree);}},
          {label:'목록 새로고침',disabled:!connected,onSelect:()=>void refresh(worktree.repositoryId).catch(error=>onError(message(error)))},
          ...(!worktree.main&&worktree.managed?[{label:'워크트리 삭제…',danger:true,disabled:!connected||worktree.status==='removing',onSelect:()=>{setError('');setDeleting(worktree);}}]:[]),
        ]}/>
      </div>;
    })}
    {pending.length>0&&<p className="worktree-status" role="status"><LoaderCircle size={13} className="spin"/>워크트리 작업 {pending.length}개 진행 중…</p>}
    {repositories.some(repo=>repo.error)&&<p className="worktree-status warning">최근 확인 정보 · 갱신 필요</p>}
    {latest&&(latest.status==='failed'||latest.status==='attention'||latest.message?.includes('터미널을 열지 못'))&&<div className="worktree-result" role="status"><span>{latest.message}</span><button className="button subtle" disabled={!connected} onClick={()=>void refresh(latest.repositoryId).catch(error=>onError(message(error)))}><RefreshCw size={13}/>목록 새로고침</button></div>}
    {choosing&&<Modal title="워크트리 터미널" onClose={()=>setChoosing(undefined)}><div className="modal-body panel-list">{state.terminals.filter(t=>t.groupId===group.id&&t.worktreeId===choosing).map(t=><button key={t.id} className="device-row" disabled={!connected} onClick={()=>void open(worktrees.find(w=>w.id===choosing)!,t.id)}><SquareTerminal size={18}/><span className="device-info">{terminalLabel(t,worktrees)}<small>{t.status==='running'?'실행 중':'종료됨 · 출력 보관'}</small></span></button>)}</div></Modal>}
    {renaming&&<Modal title="워크트리 이름 변경" onClose={()=>setRenaming(undefined)}><form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{await request('worktrees.rename',{worktreeId:renaming.id,name:name.trim()});setRenaming(undefined);}catch(error){setError(message(error));}finally{setBusy(false);}}}><div className="modal-body"><label className="field"><span className="field-label">이름</span><input className="input" autoFocus required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><p className="hint">브랜치와 폴더 이름은 유지됩니다.</p>{error&&<p className="error-text" role="alert">{error}</p>}</div><div className="modal-footer"><button className="button primary" disabled={busy}>저장</button></div></form></Modal>}
    {deleting&&<Modal title="워크트리 삭제" onClose={()=>setDeleting(undefined)}><div className="modal-body"><p><strong>{deleting.name}</strong>의 작업 폴더를 삭제합니다. 브랜치와 커밋은 남아 있습니다.</p><p className="worktree-path">{deleting.path}</p><p className="hint">연결된 터미널과 남은 파일이 있으면 삭제하지 않습니다. ignored 파일도 확인합니다.</p>{error&&<p className="error-text" role="alert">{error}</p>}</div><div className="modal-footer"><button className="button" onClick={()=>setDeleting(undefined)}>취소</button><button className="button danger" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await request('worktrees.remove',{requestId:crypto.randomUUID(),groupId:group.id,worktreeId:deleting.id,confirmed:true});setDeleting(undefined);}catch(error){setError(message(error));}finally{setBusy(false);}}}>워크트리 삭제</button></div></Modal>}
  </div>;
}

export function WorktreeCreateModal({group,state,repository,inspection,request,refresh,activeId,onClose,onDone,prepareFocus}:{group:Group;state:HostState;repository:Repository;inspection:ProjectInspection;request:Request;refresh:()=>Promise<ProjectInspection|undefined>;activeId:string;onClose:()=>void;onDone:(op:WorktreeOperation)=>void;prepareFocus:()=>((id?:string)=>void)}){
  const [name,setName]=useState(''),[baseRef,setBaseRef]=useState(inspection.baseRef),[branch,setBranch]=useState<string>(),[destination,setDestination]=useState<string>(),[existing,setExisting]=useState(false),[openTerminal,setOpenTerminal]=useState(true),[branches,setBranches]=useState<string[]>(inspection.branches),[requestId,setRequestId]=useState(()=>crypto.randomUUID()),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [attempt,setAttempt]=useState<{params:Record<string,unknown>;operationId?:string}>();
  const finishFocus=useRef<((id?:string)=>void)|undefined>(undefined);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;void refresh().then(value=>{if(mounted.current&&value)setBranches(value.branches);}).catch(()=>{});return()=>{mounted.current=false;};},[]);
  const suffix=`${slug(name)}-${requestId.slice(0,8)}`,branchName=branch??`worktree/${suffix}`,folder=destination??`${repository.worktreeRoot.replace(/[\\/]+$/,'')}\\${suffix}`;
  const locked=busy||Boolean(attempt),occupied=new Set(state.worktrees?.filter(w=>w.repositoryId===repository.id).map(w=>w.branch));
  async function submit(){
    if(busy)return;setBusy(true);setError('');
    const current=attempt||{params:{requestId,groupId:group.id,repositoryId:repository.id,name:name.trim(),baseRef:baseRef.trim(),branch:branchName,path:folder,existingBranch:existing,openTerminal,...(state.terminals.some(t=>t.id===activeId&&t.groupId===group.id)?{tabTarget:activeId}:{})}};
    if(!attempt){finishFocus.current=prepareFocus();setAttempt(current);}
    try{
      let op=await request<WorktreeOperation>(current.operationId?'worktrees.operation':'worktrees.create',current.operationId?{id:current.operationId}:current.params);
      if(!mounted.current)return;setAttempt({...current,operationId:op.id});
      if(op.status==='attention'){await refresh();op=await request('worktrees.operation',{id:op.id});}
      while(mounted.current&&(op.status==='pending'||op.status==='running')){await new Promise(resolve=>setTimeout(resolve,700));if(!mounted.current)return;op=await request('worktrees.operation',{id:op.id});}
      if(!mounted.current)return;
      if(op.status!=='succeeded'){if(op.status==='failed'){setAttempt(undefined);setRequestId(crypto.randomUUID());}throw new Error(op.message||'워크트리 작업 결과를 확인해 주세요.');}
      onDone(op);if(current.params.openTerminal&&op.terminalId)finishFocus.current?.(op.terminalId);
    }catch(error){if(mounted.current)setError(message(error));}finally{if(mounted.current)setBusy(false);}
  }
  return <Modal title="워크트리 만들기" onClose={onClose}><form onSubmit={e=>{e.preventDefault();void submit();}}><div className="modal-body">
    <p className="project-context"><GitBranch size={16}/>{repository.root.split(/[\\/]/).at(-1)}<span>· {state.name}</span></p>
    <p className="worktree-path" aria-label="대상 저장소">{repository.root}</p>
    <label className="field"><span className="field-label">워크트리 이름</span><input className="input" autoFocus required maxLength={100} placeholder="예: 로그인 수정" value={name} disabled={locked} onChange={e=>setName(e.target.value)}/></label>
    <label className="field"><span className="field-label">기준 브랜치</span><input className="input" required list="worktree-base-branches" value={baseRef} disabled={locked||existing} maxLength={300} onChange={e=>setBaseRef(e.target.value)}/><datalist id="worktree-base-branches">{branches.map(value=><option key={value} value={value}/>)}</datalist></label>
    <p className="hint">{existing?'선택한 기존 브랜치의 커밋으로 시작합니다.':'기준 브랜치의 커밋으로 시작합니다. 커밋하지 않은 변경은 복사하지 않습니다.'}</p>
    <div className="worktree-preview"><span><GitBranch size={13}/>{branchName}</span><small>{folder}</small></div>
    <details className="worktree-advanced"><summary>고급 설정</summary><label className="worktree-check"><input type="checkbox" checked={existing} disabled={locked} onChange={e=>{setExisting(e.target.checked);setBranch(e.target.checked?'':undefined);}}/>기존 브랜치 연결</label>
      <label className="field"><span className="field-label">{existing?'연결할 브랜치':'새 브랜치 이름'}</span>{existing?<select className="select" required value={branchName} disabled={locked} onChange={e=>setBranch(e.target.value)}><option value="">브랜치 선택</option>{branches.map(value=><option key={value} value={value} disabled={occupied.has(value)}>{value}{occupied.has(value)?' · 사용 중':''}</option>)}</select>:<input className="input" required maxLength={200} value={branchName} disabled={locked} onChange={e=>setBranch(e.target.value)}/>}</label>
      <label className="field"><span className="field-label">생성 위치</span><input className="input" required maxLength={4096} value={folder} disabled={locked} onChange={e=>setDestination(e.target.value)}/></label>
    </details>
    <label className="worktree-check primary-choice"><input type="checkbox" checked={openTerminal} disabled={locked} onChange={e=>setOpenTerminal(e.target.checked)}/><span>생성 후 터미널 열기<small>{openTerminal?'새 탭에서 바로 작업을 시작합니다.':'나중에 워크트리 이름을 누르면 터미널이 열립니다.'}</small></span></label>
    {error&&<p className="error-text" role="alert">{error}</p>}{busy?<p className="hint" role="status">워크트리 작업을 확인하는 중입니다. 창을 닫아도 호스트에서 작업은 계속됩니다.</p>:attempt&&<p className="hint">이전 요청의 결과를 확인합니다. 같은 워크트리를 중복으로 만들지 않습니다.</p>}
  </div><div className="modal-footer"><button className="button" type="button" onClick={onClose}>{locked?'닫기':'취소'}</button><button className="button primary" disabled={busy}>{busy?<><LoaderCircle className="spin" size={15}/>처리 중…</>:attempt?'결과 확인':openTerminal?'만들고 터미널 열기':'워크트리 만들기'}</button></div></form></Modal>;
}
