import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, Folder, FolderOpen, Keyboard, Menu, Monitor, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Settings as SettingsIcon, SquareTerminal, Trash2, X, WifiOff } from 'lucide-react';
import { createClient, type ConnectionInfo, type SavedHost } from '../../../packages/client/index';
import { APP_VERSION, findLeaf, leafIds, groupRepositoryIds, type LayoutLeaf, type Group, type HostState, type LayoutNode, type TerminalInfo, type ProjectInspection } from '../../../packages/protocol/index';
import { updateRatio } from '../../../packages/ui/layout';
import { TerminalPane, type PaneActions } from './TerminalPane';
import { Settings, type SettingsTab } from './Settings';
import { UpdateNotice } from './UpdateNotice';
import { SplitTree } from './SplitTree';
import { usePaneDrag } from './use-pane-drag';
import { FileExplorer } from './FileExplorer';
import { explorerClient } from './explorer-queue';
import { useFileDocuments } from './use-file-documents';
import { touchScrollSpeed } from '../../../packages/terminal/touch-scrollback';
const FileEditorPanel = lazy(() => import('./FileEditorPanel').then(module => ({ default: module.FileEditorPanel })));
import { HostPicker } from './HostPicker';
import { WorkspaceHeader } from './WorkspaceHeader';
import { TerminalTabs } from './TerminalTabs';
import { ProjectOpenModal, ProjectWorktrees } from './Projects';
import { aggregateTerminalStatus, terminalStatus, terminalStatusDescription, TerminalStatusBadge, TerminalStatusStale } from './TerminalStatus';
import { useTerminalNotifications } from './use-terminal-notifications';

type Editor = {kind:'group';group?:Group;cwd?:string} | {kind:'terminal';terminal:TerminalInfo} | {kind:'new-terminal';splitTarget?:string;tabTarget?:string;axis?:'horizontal'|'vertical'} | {kind:'host'};
type Dialog = {title:string;description:string;action:string;danger?:boolean;detail?:string;focusAction?:boolean;resolve:(value:boolean)=>void};
function preference<T>(key:string,fallback:T):T {try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}}
function savePreference(key:string,value:unknown){try{localStorage.setItem(key,JSON.stringify(value));}catch{/* Preferences are optional; host state remains server owned. */}}

export function App(){
  const [client] = useState(createClient);
  const [state,setState] = useState<HostState>();
  const [connection,setConnection] = useState<ConnectionInfo>({status:'connecting',owner:Boolean(window.mongle)});
  const [hosts,setHosts] = useState<SavedHost[]>([]);
  const [groupId,setGroupId] = useState('');
  const [activeId,setActiveId] = useState('');
  const activeTerminal = useRef(activeId);activeTerminal.current=activeId;
  const [maximized,setMaximized] = useState<string>();
  const [paneTabs,setPaneTabs] = useState<Record<string,Record<string,string>>>({});
  const [sidebarOpen,setSidebarOpen] = useState(false);
  const [sidebarCollapsed,setSidebarCollapsed] = useState(()=>preference<unknown>('mongle.sidebarCollapsed',false)===true);
  useEffect(()=>savePreference('mongle.sidebarCollapsed',sidebarCollapsed),[sidebarCollapsed]);
  const [panelsOpen,setPanelsOpen] = useState(false);
  const [filesOpen,setFilesOpen] = useState(()=>preference<unknown>('mongle.files.open',false)===true);
  useEffect(()=>savePreference('mongle.files.open',filesOpen),[filesOpen]);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [settingsTab,setSettingsTab] = useState<SettingsTab>();
  const [editor,setEditor] = useState<Editor>();
  const currentEditor = useRef(editor);currentEditor.current=editor;
  const [projectEditor,setProjectEditor] = useState<{group?:Group}>();
  const [collapsedProjects,setCollapsedProjects] = useState<Record<string,boolean>>({});
  const projectNavigation = useRef(0);
  const projectRefreshes = useRef(new Map<string,Promise<ProjectInspection|undefined>>());
  const projectReadQueues = useRef(new Map<string,Promise<unknown>>());
  const [moving,setMoving] = useState<TerminalInfo>();
  const [dialog,setDialog] = useState<Dialog>();
  const [toast,setToast] = useState('');
  const [theme,setTheme] = useState<'dark'|'light'>(()=>preference('mongle.theme','dark'));
  const [fontSize,setFontSize] = useState(()=>{const fallback=matchMedia('(max-width:700px)').matches?11:13;const size=preference<unknown>('mongle.fontSize',fallback);return typeof size==='number'&&Number.isInteger(size)&&size>=10&&size<=24?size:fallback;});
  const [mobileCompact,setMobileCompact] = useState(()=>preference<unknown>('mongle.mobileCompact',false)===true);
  const [scrollSpeed,setScrollSpeed] = useState(()=>touchScrollSpeed(preference<unknown>('mongle.touchScrollSpeed',undefined)));
  useEffect(()=>savePreference('mongle.touchScrollSpeed',scrollSpeed),[scrollSpeed]);
  const [sidebarWidth,setSidebarWidth] = useState(()=>{const width=preference<unknown>('mongle.sidebarWidth',212);return typeof width==='number'&&Number.isFinite(width)?Math.max(180,Math.min(360,width)):212;});
  const [mobile,setMobile] = useState(()=>matchMedia('(max-width:700px)').matches);
  const [ctrl,setCtrl] = useState(false);const [alt,setAlt] = useState(false);
  const actions = useRef(new Map<string,PaneActions>());
  const layoutQueue = useRef<Promise<void>>(Promise.resolve());
  const hostSelection = useRef(0);
  const stateEvents = useRef(0);
  const stateRequests = useRef(0);
  const notify = useCallback((message:string)=>setToast(message),[]);
  const connected=connection.status==='connected';
  const [fileClient] = useState(() => explorerClient(client));
  const fileDocs = useFileDocuments(fileClient, state, connected, connection.connectionId);
  const [fileMaximized,setFileMaximized] = useState(false);
  const [fileWidth,setFileWidth] = useState(()=>{const width=preference<unknown>('mongle.editor.width',720);return typeof width==='number'&&Number.isFinite(width)?Math.max(440,Math.min(1200,width)):720;});
  useEffect(()=>savePreference('mongle.editor.width',fileWidth),[fileWidth]);
  const group=state?.groups.find(g=>g.id===groupId);
  const panelIds=leafIds(group?.layout||null);
  const tabsKey=`mongle.tabs.${state?.hostId}.${groupId}`;
  const savedTabs=paneTabs[tabsKey]||preference<Record<string,string>>(tabsKey,{});
  function selectedTab(leaf:LayoutLeaf){const ids=leafIds(leaf);return ids.includes(activeId)?activeId:ids.map(id=>savedTabs[id]).find(id=>ids.includes(id))||ids[0];}
  useEffect(()=>{
    if(!state||!group||!panelIds.includes(activeId))return;
    const leaf=findLeaf(group.layout,activeId);if(!leaf)return;
    const next=Object.fromEntries(panelIds.filter(id=>savedTabs[id]).map(id=>[id,savedTabs[id]]));
    for(const id of leafIds(leaf))next[id]=activeId;
    if(JSON.stringify(next)!==JSON.stringify(savedTabs)){setPaneTabs(values=>({...values,[tabsKey]:next}));savePreference(tabsKey,next);}
  },[state?.hostId,groupId,activeId,panelIds.join(','),JSON.stringify(savedTabs)]);
  const notifications=useTerminalNotifications(state,activeId,connected&&panelIds.includes(activeId)&&(!maximized||maximized===activeId)&&!settingsOpen&&!editor&&!projectEditor&&!dialog&&!moving&&!panelsOpen&&!(mobile&&sidebarOpen)&&!(fileDocs.visible&&(mobile||fileMaximized))&&!(mobile&&filesOpen));
  const groupStatuses=new Map(state?.groups.map(item=>[item.id,aggregateTerminalStatus(state.terminals.filter(info=>info.groupId===item.id),notifications.notices)]));
  const otherPanelsStatus=aggregateTerminalStatus(state?.terminals.filter(info=>info.groupId===groupId&&info.id!==activeId)||[],notifications.notices);
  const activeStatus=terminalStatus(state?.terminals.find(info=>info.id===activeId),notifications.notices.get(activeId));
  const allTerminalStatus=aggregateTerminalStatus(state?.terminals.filter(info=>info.id!==activeId)||[],notifications.notices);
  // Switchers summarize terminals the user is not looking at; the visible one shows its own state.
  const elsewhere=(text?:string)=>text&&`다른 터미널 · ${text}`;
  const selectedHost=hosts.find(h=>h.selected);
  const layoutContext=useRef({hostId:state?.hostId,bootId:state?.bootId,groupId,connected});layoutContext.current={hostId:state?.hostId,bootId:state?.bootId,groupId,connected};
  const register=useCallback((id:string,action:PaneActions|null)=>{if(action)actions.current.set(id,action);else actions.current.delete(id);},[]);
  const ask=useCallback((options:Omit<Dialog,'resolve'>)=>new Promise<boolean>(resolve=>setDialog({...options,resolve})),[]);
  const confirmPaste=useCallback((text:string)=>/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)?ask({title:'여러 줄을 붙여넣을까요?',description:'줄바꿈이나 제어문자가 포함되어 있습니다. 명령이 실행될 수 있으니 내용을 확인해 주세요.',action:'붙여넣기',detail:text,focusAction:true}):Promise.resolve(true),[ask]);
  const refreshHosts=useCallback(async()=>{if(window.mongle)setHosts(await window.mongle.listHosts());},[]);
  const loadState=useCallback(async()=>{
    const selection=hostSelection.current,events=stateEvents.current,request=++stateRequests.current;
    // IPC replies can arrive after a newer host event or a later state lookup.
    // Those complete snapshots already describe the current workspace.
    const current=()=>selection===hostSelection.current&&events===stateEvents.current&&request===stateRequests.current;
    try{const next=await client.request<HostState>('state.get');if(current())setState(next);}
    catch(error){if(current())notify(error instanceof Error?error.message:'컴퓨터를 불러오지 못했습니다.');}
  },[client,notify]);
  const paneDrag=usePaneDrag({client,state,group,enabled:connected&&!mobile&&!maximized&&!editor&&!settingsOpen&&!dialog&&Boolean(group?.layout),hostSelection,queue:layoutQueue,refreshState:loadState,onError:notify,onSelect:setActiveId});
  useEffect(()=>{
    const off=client.subscribe(event=>{if(event.type==='state'){stateEvents.current++;setState(event.state);}else if(event.type==='notice')notify(event.message);});
    const offConnection=client.onConnection(next=>{if(next.status==='connecting')hostSelection.current++;if(next.status!=='connected'){stateRequests.current++;setEditor(undefined);}setConnection(next);if(next.status==='connected')void loadState();});
    void refreshHosts().catch(error=>notify(error.message));
    const heartbeat=setInterval(()=>{void client.request('heartbeat').catch(()=>{});},10000);
    return()=>{stateRequests.current++;off();offConnection();clearInterval(heartbeat);client.close();};
  },[client,loadState,notify,refreshHosts]);
  useEffect(()=>{if(!state)return;if(!state.groups.some(g=>g.id===groupId)){const stored=preference<string>(`mongle.group.${state.hostId}`,'');setGroupId(state.groups.some(g=>g.id===stored)?stored:state.groups[0]?.id||'');}},[state,groupId]);
  useEffect(()=>{if(!panelIds.includes(activeId)){const saved=state&&groupId?preference<string>(`mongle.active.${state.hostId}.${groupId}`,''):'';setActiveId(panelIds.includes(saved)?saved:panelIds[0]||'');}if(maximized&&!panelIds.includes(maximized))setMaximized(undefined);},[panelIds.join(','),activeId,maximized,state?.hostId,groupId]);
  useEffect(()=>{if(state&&groupId&&panelIds.includes(activeId))savePreference(`mongle.active.${state.hostId}.${groupId}`,activeId);},[state?.hostId,groupId,activeId,panelIds.join(',')]);
  useEffect(()=>{const terminal=state?.terminals.find(t=>t.id===activeId);if(terminal?.worktreeId&&terminal.groupId===groupId){try{localStorage.setItem(`mongle.worktree.${state!.hostId}.${groupId}.${terminal.worktreeId}`,terminal.id);}catch{}}},[state?.hostId,groupId,activeId,state?.terminals.find(t=>t.id===activeId)?.worktreeId]);
  useEffect(()=>{setProjectEditor(undefined);},[state?.hostId,state?.bootId,connected]);
  useEffect(()=>{
    if(!connected||!group||!state?.capabilities?.includes('worktrees.manage'))return;
    const refresh=()=>{if(document.visibilityState!=='hidden')for(const id of groupRepositoryIds(group))void refreshProject(id).catch(()=>{});};
    refresh();window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[state?.hostId,state?.bootId,group&&groupRepositoryIds(group).join(','),connected]);
  useEffect(()=>{if(state&&groupId)savePreference(`mongle.group.${state.hostId}`,groupId);setMaximized(undefined);setCtrl(false);setAlt(false);},[groupId,state?.hostId]);
  useEffect(()=>{setCtrl(false);setAlt(false);},[activeId]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;savePreference('mongle.theme',theme);void window.mongle?.setWindowTheme?.(theme).catch(()=>{});},[theme]);
  useEffect(()=>savePreference('mongle.fontSize',fontSize),[fontSize]);
  useEffect(()=>savePreference('mongle.mobileCompact',mobileCompact),[mobileCompact]);
  useEffect(()=>savePreference('mongle.sidebarWidth',sidebarWidth),[sidebarWidth]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),6500);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{const closeMenus=(event:MouseEvent)=>{const target=event.target as HTMLElement;for(const menu of document.querySelectorAll<HTMLDetailsElement>('details.command-menu[open]')){if(!menu.contains(target)||target.closest('button.menu-item'))menu.open=false;}};document.addEventListener('click',closeMenus);return()=>document.removeEventListener('click',closeMenus);},[]);
  useEffect(()=>{const media=matchMedia('(max-width:700px)');const change=()=>setMobile(media.matches);media.addEventListener('change',change);const viewport=()=>document.documentElement.style.setProperty('--app-height',`${window.visualViewport?.height||window.innerHeight}px`);viewport();window.visualViewport?.addEventListener('resize',viewport);return()=>{media.removeEventListener('change',change);window.visualViewport?.removeEventListener('resize',viewport);};},[]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(document.querySelector('[role=dialog],[role=alertdialog]'))return;if(e.key==='Escape'){setSidebarOpen(false);setPanelsOpen(false);}if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='n'&&state){e.preventDefault();setEditor({kind:'group'});}if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='t'&&group){e.preventDefault();setEditor({kind:'new-terminal',...(state?.capabilities?.includes('layout.tabs')&&activeId?{tabTarget:activeId}:{})});}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[group,state,activeId]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if((event.target as HTMLElement)?.closest('.file-editor-panel')||document.querySelector('[role=dialog],[role=alertdialog]')||mobile||editor||settingsOpen||dialog||moving||panelsOpen||event.isComposing||!event.ctrlKey||event.altKey||event.metaKey||event.key!=='Tab')return;
      const ids=leafIds(findLeaf(group?.layout||null,activeId)||null);if(!ids.length)return;
      event.preventDefault();event.stopPropagation();
      if(ids.length<2)return;
      const index=ids.indexOf(activeId),id=ids[(index+(event.shiftKey?-1:1)+ids.length)%ids.length];
      selectTerminal(id,true);
    };
    window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
  },[mobile,editor,settingsOpen,dialog,moving,panelsOpen,activeId,maximized,panelIds.join(',')]);
  function selectTerminal(id:string,focusTab=false){
    if(activeTerminal.current!==id)projectNavigation.current++;
    activeTerminal.current=id;setActiveId(id);if(maximized)setMaximized(id);
    if(focusTab){
      const focus=(attempt=0)=>{
        if(activeTerminal.current!==id)return;
        const tab=document.getElementById(`terminal-tab-${id}`);
        // Tabs move between the visible pane instances. Focusing the old pane's
        // copy would invoke its onFocusCapture and reselect the previous session.
        if(tab?.closest('[data-terminal-id]')?.getAttribute('data-terminal-id')===id)tab.focus();
        else if(attempt<3)requestAnimationFrame(()=>focus(attempt+1));
      };
      requestAnimationFrame(()=>focus());
    }
  }
  async function projectRequest<T=any>(method:string,params:Record<string,unknown>):Promise<T>{
    if(!state||!connected)throw new Error('컴퓨터에 다시 연결해 주세요.');
    const hostId=state.hostId,bootId=state.bootId,selection=hostSelection.current;
    const check=()=>{if(selection!==hostSelection.current||layoutContext.current.hostId!==hostId||layoutContext.current.bootId!==bootId)throw new Error('접속한 컴퓨터가 바뀌었습니다. 이전 작업의 결과는 해당 컴퓨터에서 확인해 주세요.');};
    const send=()=>{check();return client.request<T>(method,{hostId,bootId,...params});};
    let result:T;
    if(method==='projects.inspect'||method==='worktrees.refresh'){
      // Many visible panes must not exhaust the host's bounded Git-read slots.
      const key=`${hostId}:${bootId}`,previous=projectReadQueues.current.get(key)||Promise.resolve();
      const task=previous.catch(()=>{}).then(send);projectReadQueues.current.set(key,task);
      try{result=await task;}finally{if(projectReadQueues.current.get(key)===task)projectReadQueues.current.delete(key);}
    }else result=await send();
    check();if(method!=='projects.inspect')await loadState();return result;
  }
  function refreshProject(repositoryId:string):Promise<ProjectInspection|undefined>{
    const key=`${state?.hostId}:${state?.bootId}:${repositoryId}`,pending=projectRefreshes.current.get(key);if(pending)return pending;
    const task=projectRequest<ProjectInspection>('worktrees.refresh',{repositoryId}).finally(()=>projectRefreshes.current.delete(key));projectRefreshes.current.set(key,task);return task;
  }
  function projectFocus(groupId:string,navigate:boolean){
    const token=++projectNavigation.current,hostId=state?.hostId,bootId=state?.bootId,initialGroup=layoutContext.current.groupId,selection=hostSelection.current;
    if(navigate){layoutContext.current.groupId=groupId;setGroupId(groupId);setSidebarOpen(false);}
    return (id?:string)=>{
      if(token!==projectNavigation.current||selection!==hostSelection.current||layoutContext.current.hostId!==hostId||layoutContext.current.bootId!==bootId||layoutContext.current.groupId!==(navigate?groupId:initialGroup))return;
      setGroupId(groupId);setSidebarOpen(false);if(id)selectTerminal(id,true);
    };
  }
  async function mutate(method:string,params:unknown){try{const result=await client.request(method,params);await loadState();return result;}catch(error){notify(error instanceof Error?error.message:'요청을 완료하지 못했습니다.');return undefined;}}
  async function chooseHost(id:string){if(!window.mongle)return;hostSelection.current++;setState(undefined);setGroupId('');setActiveId('');setSidebarOpen(false);setConnection({status:'connecting',owner:false});try{const next=await window.mongle.selectHost(id);setConnection(next);await refreshHosts();if(next.status==='connected')await loadState();}catch(error){setConnection({status:'offline',owner:false,error:error instanceof Error?error.message:'연결 실패'});}}
  async function removeHost(){if(!selectedHost||selectedHost.local||!window.mongle)return;const host=selectedHost;if(await ask({title:`‘${host.name}’ 등록을 해제할까요?`,description:'이 기기에 저장된 접속 정보를 삭제합니다. 대상 컴퓨터의 터미널 작업은 계속됩니다.',action:'등록 해제',danger:true})){try{setState(undefined);await window.mongle.removeHost(host.id);await refreshHosts();}catch(error){notify(error instanceof Error?error.message:'컴퓨터 등록을 해제하지 못했습니다.');}}}
  async function removeGroup(target:Group){const count=state?.terminals.filter(t=>t.groupId===target.id&&t.status==='running').length||0;if(await ask({title:`‘${target.name}’ 그룹을 삭제할까요?`,description:count?`실행 중인 터미널 ${count}개와 그룹의 기록을 함께 종료하고 삭제합니다.`:'그룹과 이 그룹의 터미널 기록을 삭제합니다.',action:'그룹 삭제',danger:true}))await mutate('groups.delete',{id:target.id,revision:target.revision,terminate:true});}
  async function closeTerminal(info:TerminalInfo){const ref={id:info.id,hostId:state?.hostId,bootId:state?.bootId,generation:info.generation};if(await ask({title:`‘${info.title}’ 패널을 닫을까요?`,description:info.status==='running'?'터미널의 실행 중인 작업을 종료하고 패널을 삭제합니다. 창을 닫으면 작업을 유지할 수 있습니다.':'이 패널과 저장된 출력을 삭제합니다.',action:info.status==='running'?'종료하고 닫기':'패널 닫기',danger:true}))await mutate('terminals.remove',{...ref,terminate:true});}
  async function restartTerminal(info:TerminalInfo){const ref={id:info.id,hostId:state?.hostId,bootId:state?.bootId,generation:info.generation};if(info.status==='running'&&!await ask({title:'새 셸로 다시 열까요?',description:'현재 셸과 실행 중인 작업을 종료합니다. 이전 명령은 자동 실행하지 않습니다.',action:'새 셸로 다시 열기',danger:true}))return;await mutate('terminals.restart',{...ref,confirmed:true});}
  async function terminateTerminal(info:TerminalInfo){const ref={id:info.id,hostId:state?.hostId,bootId:state?.bootId,generation:info.generation};if(await ask({title:'실행 중인 작업을 종료할까요?',description:'셸과 실행 중인 작업을 종료합니다. 패널과 이전 출력은 남겨 둡니다.',action:'작업 종료',danger:true}))await mutate('terminals.terminate',ref);}
  async function clearHistory(info:TerminalInfo){if(await ask({title:'저장된 출력을 지울까요?',description:'터미널의 이전 출력 기록을 지웁니다. 실행 중인 작업은 계속됩니다.',action:'출력 지우기',danger:true}))await mutate('history.clear',{id:info.id});}
  function changeLayout(transform:(layout:LayoutNode)=>LayoutNode){
    if(!group||!state||!connected)return Promise.resolve();
    const id=group.id,revision=group.revision,hostId=state.hostId,bootId=state.bootId,selection=hostSelection.current;
    const same=()=>hostSelection.current===selection&&layoutContext.current.connected&&layoutContext.current.groupId===id&&layoutContext.current.hostId===hostId&&layoutContext.current.bootId===bootId;
    layoutQueue.current=layoutQueue.current.catch(()=>{}).then(async()=>{try{
      if(!same())return;const latest=await client.request<HostState>('state.get');if(!same()||latest.hostId!==hostId||latest.bootId!==bootId)return;
      const currentGroup=latest.groups.find(item=>item.id===id);if(!currentGroup?.layout)return;
      if(currentGroup.revision!==revision){notify('배치가 바뀌었습니다. 다시 크기를 조절해 주세요.');return;}
      await client.request('groups.layout',{id,revision:currentGroup.revision,layout:transform(currentGroup.layout)});if(same())await loadState();
    }catch(error){if(same()){notify(error instanceof Error?error.message:'배치를 저장하지 못했습니다.');await loadState();}}});return layoutQueue.current;
  }
  function renderPane(id:string,leaf?:LayoutLeaf,visible=true){const info=state?.terminals.find(t=>t.id===id);if(!state||!info)return null;return <TerminalPane key={`${state.hostId}:${id}:${info.generation}`} client={client} state={state} info={info} connected={connected} owner={connection.owner} connectionId={connection.connectionId} selected={activeId===id} maximized={maximized===id} tabbed={!mobile} tabs={!mobile&&leaf&&visible?<TerminalTabs notices={notifications.notices} terminals={leafIds(leaf).map(tab=>state!.terminals.find(terminal=>terminal.id===tab)).filter((terminal):terminal is TerminalInfo=>Boolean(terminal))} activeId={selectedTab(leaf)} connected={connected} worktrees={state.worktrees} insertion={paneDrag.preview?.target===id?paneDrag.preview.insertion:undefined} onSelect={selectTerminal} onClose={terminal=>void closeTerminal(terminal)} onRename={terminal=>setEditor({kind:'terminal',terminal})} clickAllowed={paneDrag.clickAllowed} dragEnabled={paneDrag.enabled} onDragStart={(event,tabId)=>paneDrag.start(event,tabId,'tab')} onDragEnd={paneDrag.cancel}/>:undefined} worktreeActions={visible?{request:projectRequest,refresh:refreshProject,prepareFocus:id=>projectFocus(id,false),onError:notify}:undefined} onNewTab={()=>setEditor({kind:'new-terminal',tabTarget:leaf?leafIds(leaf).at(-1):id})} canAddTab={state.capabilities?.includes('layout.tabs')} fontSize={fontSize} touchScrollSpeed={scrollSpeed} theme={theme} ctrl={ctrl} alt={alt} onSelect={()=>selectTerminal(id)} onSplit={axis=>setEditor({kind:'new-terminal',splitTarget:id,axis})} onMaximize={()=>setMaximized(maximized===id?undefined:id)} onClose={()=>void closeTerminal(info)} onRename={()=>setEditor({kind:'terminal',terminal:info})} onRestart={()=>void restartTerminal(info)} onMove={()=>setMoving(info)} onClearHistory={()=>void clearHistory(info)} onTerminate={()=>void terminateTerminal(info)} dragEnabled={paneDrag.enabled} onPaneDragStart={event=>paneDrag.start(event,id)} onPaneDragEnd={paneDrag.cancel} onPaneDragOver={event=>paneDrag.over(id,event)} onPaneDrop={event=>paneDrag.drop(id,event)} onPanePointerStart={paneDrag.pointerStart} dragClickAllowed={paneDrag.clickAllowed} dropPreview={paneDrag.preview?.target===id?paneDrag.preview:undefined} onError={notify} confirmPaste={confirmPaste} register={register} onPresentedNotification={notifications.onPresented}/>;}
  const hostName=state?.name||selectedHost?.name||(window.mongle?'이 PC':location.hostname);

  const hostPicker=(window.mongle?<HostPicker hosts={hosts} fallback={hostName} onSelect={id=>void chooseHost(id)}/>:<div className="host-picker"><div className="host-select"><span className="host-device-icon"><Monitor size={18}/></span><span className="host-label"><strong title={hostName}>{hostName}</strong><small>접속 중인 컴퓨터</small></span></div></div>);
  const hostActions=(<div className="connection-status"><span className={`connection-dot ${connected?'connected':connection.status==='connecting'?'connecting':'offline'}`}/>{connected?'연결됨':connection.status==='connecting'?'연결 중…':connection.status==='pairing'?'기기 승인 필요':'연결 끊김'}{window.mongle&&<button className="icon-button" title="다른 컴퓨터 추가" aria-label="컴퓨터 추가" onClick={()=>setEditor({kind:'host'})}><Plus size={14}/></button>}{selectedHost&&!selectedHost.local&&<button className="icon-button" title="이 컴퓨터 등록 해제" aria-label="이 컴퓨터 등록 해제" onClick={()=>void removeHost()}><Trash2 size={13}/></button>}</div>);
  function selectGroup(id:string){projectNavigation.current++;setGroupId(id);setSidebarOpen(false);}
  return <TerminalStatusStale.Provider value={!connected}><div className={`app-shell ${mobile&&mobileCompact&&group?.layout&&connection.status!=='pairing'?'mobile-compact':''} ${!mobile&&sidebarCollapsed?'sidebar-collapsed':''}`} style={{'--sidebar-width':`${mobile?240:sidebarCollapsed?44:sidebarWidth}px`} as React.CSSProperties}>
    {!mobile&&<WorkspaceHeader groupStatuses={groupStatuses} hostPicker={hostPicker} hostActions={hostActions} groups={state?.groups||[]} activeId={groupId} connected={connected} native={Boolean(window.mongle?.titleBarOverlay)} onSelect={selectGroup} onNewGroup={()=>setEditor({kind:'group'})}/>}
    {mobile&&sidebarOpen&&<div className="drawer-backdrop" onClick={()=>setSidebarOpen(false)}/>}
    <aside id="workspace-sidebar" aria-label="작업 탐색" className={`sidebar ${sidebarOpen?'open':''}`}>
      <div className="sidebar-mobile-chrome"><div className="sidebar-brand"><span className="brand-mark brand-image"><img src="./icon-192.png" alt="" draggable={false}/></span><span className="brand-text">몽글<span>터미널</span></span><button className="icon-button sidebar-toggle" aria-label="메뉴 닫기" onClick={()=>setSidebarOpen(false)}><X size={18}/></button></div>
      {mobile&&hostPicker}{mobile&&hostActions}</div>
      {!mobile&&<div className="sidebar-toggle-row"><button className="sidebar-collapse-toggle" aria-label={`사이드바 ${sidebarCollapsed?'펼치기':'접기'}`} title={`사이드바 ${sidebarCollapsed?'펼치기':'접기'}`} aria-expanded={!sidebarCollapsed} aria-controls="workspace-sidebar" onClick={()=>setSidebarCollapsed(value=>!value)}>
        {sidebarCollapsed?<PanelLeftOpen size={18}/>:<PanelLeftClose size={18}/>}{!sidebarCollapsed&&<span>사이드바 접기</span>}
      </button></div>}
      {!mobile&&sidebarCollapsed&&<nav className="sidebar-rail" aria-label="접힌 작업 탐색">
        <button className="icon-button notification-indicator" aria-description={elsewhere(terminalStatusDescription(otherPanelsStatus))} aria-label="터미널 전환" title="터미널 전환" disabled={!panelIds.length} onClick={()=>setPanelsOpen(true)}><SquareTerminal size={18}/><TerminalStatusBadge status={otherPanelsStatus} compact/></button>
        {state?.capabilities?.includes('worktrees.manage')&&<button className="icon-button" aria-label="프로젝트 열기" title="프로젝트 열기" disabled={!connected} onClick={()=>setProjectEditor({})}><Plus size={18}/></button>}
      </nav>}
      <div className="sidebar-section" hidden={!mobile&&sidebarCollapsed}>{state?.capabilities?.includes('worktrees.manage')&&<button className="button subtle project-open" disabled={!connected} onClick={()=>setProjectEditor({})}><FolderOpen size={16}/>프로젝트 열기</button>}<div className="sidebar-section-label"><span>작업 그룹</span><button className="icon-button" title="새 그룹" aria-label="새 그룹" disabled={!connected} onClick={()=>setEditor({kind:'group'})}><Plus size={15}/></button></div><nav className="group-list" aria-label="작업 그룹">
        {state?.groups.map(item=>{const count=leafIds(item.layout).length,repositoryIds=groupRepositoryIds(item),hasItems=count>0||(repositoryIds.length>0&&state.capabilities?.includes('worktrees.manage'));return <div key={item.id} className="project-group"><div className={`group-row ${item.id===groupId?'active':''}`} draggable onDragStart={e=>{e.dataTransfer.setData('application/x-mongle-group',item.id);}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const source=e.dataTransfer.getData('application/x-mongle-group');if(!source||source===item.id||!state)return;const ids=state.groups.map(g=>g.id).filter(id=>id!==source);ids.splice(ids.indexOf(item.id),0,source);void mutate('groups.reorder',{ids});}}>{hasItems&&<button className="icon-button group-collapse" aria-label={`${item.name} 작업 목록 ${collapsedProjects[item.id]?'펼치기':'접기'}`} aria-expanded={!collapsedProjects[item.id]} onClick={()=>setCollapsedProjects(value=>({...value,[item.id]:!value[item.id]}))}>{collapsedProjects[item.id]?<ChevronRight size={14}/>:<ChevronDown size={14}/>}</button>}<button className="group-main" aria-description={terminalStatusDescription(groupStatuses.get(item.id))} onClick={()=>{projectNavigation.current++;setGroupId(item.id);setSidebarOpen(false);}}><Folder size={16}/><span className="group-name">{item.name}<span className="group-meta">{count?`터미널 ${count}개`:'비어 있는 그룹'}</span></span><TerminalStatusBadge status={groupStatuses.get(item.id)}/></button><details className="command-menu group-actions"><summary className="icon-button" aria-label={`${item.name} 그룹 메뉴`}>···</summary><div><button className="menu-item" onClick={()=>setEditor({kind:'group',group:item})}>그룹 설정</button>{repositoryIds.length>0&&<button className="menu-item" disabled={!connected} onClick={()=>void Promise.all(repositoryIds.map(refreshProject)).catch(error=>notify(error.message))}>목록 새로고침</button>}<button className="menu-item" disabled={state.groups[0]?.id===item.id} onClick={()=>{const ids=state.groups.map(g=>g.id);const at=ids.indexOf(item.id);[ids[at-1],ids[at]]=[ids[at],ids[at-1]];void mutate('groups.reorder',{ids});}}>위로 이동</button><button className="menu-item" disabled={state.groups.at(-1)?.id===item.id} onClick={()=>{const ids=state.groups.map(g=>g.id);const at=ids.indexOf(item.id);[ids[at+1],ids[at]]=[ids[at],ids[at+1]];void mutate('groups.reorder',{ids});}}>아래로 이동</button><button className="menu-item danger" onClick={()=>void removeGroup(item)}>그룹 삭제</button></div></details></div>{hasItems&&!collapsedProjects[item.id]&&<ProjectWorktrees notices={notifications.notices} key={`${state.hostId}:${state.bootId}:${item.id}`} group={item} state={state} activeId={activeId} connected={connected} request={projectRequest} beginNavigation={id=>projectFocus(id,true)} onError={notify} refresh={refreshProject} onRenameTerminal={terminal=>setEditor({kind:'terminal',terminal})}/>}</div>;})}
        {state&&!state.groups.length&&<p className="hint sidebar-empty">그룹을 만들어 작업을<br/>한곳에 모아 보세요.</p>}
      </nav></div>
      <div className="sidebar-footer">
        {window.mongle&&<UpdateNotice compact={!mobile&&sidebarCollapsed} onExpand={()=>setSidebarCollapsed(false)} onOpenSettings={state?()=>{setSettingsTab('updates');setSettingsOpen(true);}:undefined}/>}
        {!mobile&&group?.layout&&<><button className="button subtle new-terminal-drag" aria-label="새 터미널" disabled={!connected} draggable={paneDrag.enabled} title="새 터미널 · 끌어서 원하는 위치에 분할" onPointerDown={paneDrag.pointerStart} onDragStart={event=>paneDrag.start(event)} onDragEnd={paneDrag.cancel} onClick={()=>{if(paneDrag.clickAllowed())setEditor({kind:'new-terminal'});}}><Plus size={16}/><span className="sidebar-action-label">새 터미널</span></button></>}
        {!mobile&&<button className="button subtle" aria-label="파일 탐색기" aria-expanded={filesOpen} disabled={!state} onClick={()=>setFilesOpen(open=>!open)} title="파일 탐색기"><Folder size={17}/><span className="sidebar-action-label">파일 탐색기</span></button>}
        <button className="button subtle" aria-label="설정" disabled={!state} onClick={()=>setSettingsOpen(true)} title="설정"><SettingsIcon size={17}/><span className="sidebar-action-label">설정</span><span className="version">v{state?.version||APP_VERSION}</span></button><div className="sidebar-note"><span className="connection-dot connected"/>창을 닫아도 작업은 계속돼요</div>
      </div>
      <div className="sidebar-resizer" hidden={!mobile&&sidebarCollapsed} role="separator" aria-label="사이드바 너비" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={360} aria-valuenow={sidebarWidth} tabIndex={0} onDoubleClick={()=>setSidebarWidth(212)} onPointerDown={e=>e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))setSidebarWidth(Math.max(180,Math.min(360,e.clientX)));}} onPointerUp={e=>e.currentTarget.releasePointerCapture(e.pointerId)} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setSidebarWidth(width=>Math.max(180,Math.min(360,width+(e.key==='ArrowLeft'?-10:10))));}}}/>
    </aside>
    <main className="main-area">
      {(mobile||!group?.layout)&&<header className="workspace-header" hidden={!mobile}>
        <button className="icon-button sidebar-toggle notification-indicator" aria-description={elsewhere(terminalStatusDescription(allTerminalStatus))} aria-label="그룹 메뉴 열기" onClick={()=>setSidebarOpen(true)}><Menu size={19}/><TerminalStatusBadge status={allTerminalStatus} compact/></button>
        <div className="workspace-heading" title={`${hostName}${selectedHost&&!selectedHost.local?' · 원격':''}`}><h1 className="workspace-title">{group?.name||'나의 작업 공간'}</h1></div>
        {group&&<button className="button primary new-terminal-drag" aria-label="터미널 추가" disabled={!connected} draggable={paneDrag.enabled} title={paneDrag.enabled?'새 터미널 · 끌어서 원하는 위치에 분할':'새 터미널 (Ctrl+Shift+T)'} onPointerDown={paneDrag.pointerStart} onDragStart={event=>paneDrag.start(event)} onDragEnd={paneDrag.cancel} onClick={()=>{if(paneDrag.clickAllowed())setEditor({kind:'new-terminal'});}}><Plus size={16}/><span className="button-label">터미널</span></button>}
        <div className="toolbar">{mobile&&<>
          <button className="icon-button" aria-label="파일 탐색기" title="파일 탐색기" aria-expanded={filesOpen} disabled={!state} onClick={()=>setFilesOpen(open=>!open)}><Folder size={17}/></button><button className="icon-button" aria-label="설정" title="설정" disabled={!state} onClick={()=>setSettingsOpen(true)}><SettingsIcon size={17}/></button></>}
        </div>
      </header>}
      {connection.status!=='connected'&&connection.status!=='pairing'&&<div className={`connection-banner ${connection.status==='offline'?'warning':''}`}><WifiOff size={15}/><span>{connection.error||(connection.status==='connecting'?'컴퓨터에 연결하고 있습니다…':'컴퓨터에 연결할 수 없습니다. 실행 중인 작업은 호스트에서 계속됩니다.')}</span><button className="button subtle" onClick={()=>client.reconnect()}><RefreshCw size={14}/>다시 연결</button></div>}
      {state?.storageError&&<div className="connection-banner warning">기록을 저장하지 못했습니다: {state.storageError}</div>}
      {connection.status==='pairing'?<Pairing client={client} notify={notify}/>:!state?<div className="empty-state"><div className="empty-icon"><Monitor size={32}/></div><h2 className="empty-title">{connection.status==='connecting'?'작업 공간을 불러오는 중':'컴퓨터 연결을 확인해 주세요'}</h2><p className="empty-copy">접속할 컴퓨터와 몽글 호스트가 켜져 있어야 합니다.</p><button className="button" onClick={()=>client.reconnect()}>다시 연결</button></div>:!group?<div className="empty-state"><div className="empty-icon"><Folder size={32}/></div><h2 className="empty-title">작업의 시작은, 한 그룹부터</h2><p className="empty-copy">프로젝트별로 터미널을 모으고<br/>어디서든 하던 작업을 이어가세요.</p><button className="button primary" disabled={!connected} onClick={()=>setEditor({kind:'group'})}><Plus size={16}/>첫 그룹 만들기</button></div>:!group.layout?<div className="empty-state"><div className="empty-icon"><SquareTerminal size={32}/></div><h2 className="empty-title">터미널을 열어 시작하세요</h2><p className="empty-copy">PowerShell부터 자주 쓰는 셸까지.<br/>필요할 때 화면을 나누어 함께 사용할 수 있어요.</p><button className="button primary" disabled={!connected} onClick={()=>setEditor({kind:'new-terminal'})}><Plus size={16}/>새 터미널</button><span className="hint">이 컴퓨터에서 설치된 셸만 표시합니다.</span></div>:<>
        {mobile&&<div className="mobile-display-bar">
          <button className="mobile-panel-switcher" aria-description={[activeStatus&&`이 터미널 · ${terminalStatusDescription(activeStatus)}`,elsewhere(terminalStatusDescription(otherPanelsStatus))].filter(Boolean).join(' / ')||undefined} aria-label="터미널 전환" onClick={()=>setPanelsOpen(true)}><SquareTerminal size={14}/><span className="mobile-panel-title">{state.terminals.find(t=>t.id===activeId)?.title}</span><TerminalStatusBadge status={activeStatus} compact/><span className="mobile-panel-count">{panelIds.indexOf(activeId)+1}/{panelIds.length}</span><span className="mobile-panel-others"><TerminalStatusBadge status={otherPanelsStatus} compact/></span><ChevronDown size={13}/></button>
          <div className="mobile-font-controls" role="group" aria-label="터미널 글자 크기">
            <button aria-label="터미널 글자 작게" title="글자 작게" disabled={fontSize===10} onPointerDown={e=>e.preventDefault()} onClick={()=>setFontSize(size=>Math.max(10,size-1))}>A−</button>
            <button className="mobile-font-reset" aria-label={`글자 크기 ${fontSize}px · 기본 11px로 복원`} title="기본 크기 11px로 복원" onPointerDown={e=>e.preventDefault()} onClick={()=>setFontSize(11)}>{fontSize}</button>
            <button aria-label="터미널 글자 크게" title="글자 크게" disabled={fontSize===24} onPointerDown={e=>e.preventDefault()} onClick={()=>setFontSize(size=>Math.min(24,size+1))}>A+</button>
          </div>
          <button className="mobile-compact-toggle" aria-pressed={mobileCompact} onPointerDown={e=>e.preventDefault()} onClick={()=>setMobileCompact(compact=>!compact)}>{mobileCompact?'기본 화면':'화면 넓게'}</button>
        </div>}
        <div className="workspace-content">
        <div className={`terminal-workspace ${paneDrag.dragging?'pane-dragging':''}`}>{mobile?renderPane(activeId):<SplitTree node={group.layout} renderPane={renderPane} selectedTab={selectedTab} focusedId={maximized} onRatio={(path,ratio)=>void changeLayout(layout=>updateRatio(layout,path,ratio))}/>}</div>
        {(filesOpen||fileDocs.visible)&&<div className={`file-workspace ${fileDocs.visible?'with-editor':''} ${fileDocs.visible&&fileMaximized?'maximized':''}`} style={{'--editor-width':`${fileWidth}px`} as React.CSSProperties}>
          {fileDocs.visible&&<div className="file-workspace-resizer" role="separator" aria-label="파일 작업 영역 너비" aria-orientation="vertical" aria-valuemin={440} aria-valuemax={1200} aria-valuenow={fileWidth} tabIndex={0} onDoubleClick={()=>setFileWidth(720)} onPointerDown={event=>{if(event.button===0)event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))setFileWidth(Math.max(440,Math.min(1200,event.currentTarget.parentElement!.getBoundingClientRect().right-event.clientX)));}} onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();setFileWidth(width=>event.key==='Home'?720:Math.max(440,Math.min(1200,width+(event.key==='ArrowLeft'?20:-20))));}}}/>}
          {filesOpen&&<FileExplorer client={fileClient} hostId={state.hostId} bootId={state.bootId} terminal={state.terminals.find(t=>t.id===activeId)} supported={state.capabilities?.includes('files.read')===true} gitSupported={state.capabilities?.includes('git.read')===true} connected={connected} onClose={()=>setFilesOpen(false)} onError={notify} onOpenFile={async(ref,path)=>{await fileDocs.open(ref,path);if(mobile)setFilesOpen(false);}}/>}
          {fileDocs.visible&&<Suspense fallback={<p className="file-message">편집기를 여는 중…</p>}><FileEditorPanel files={fileDocs} treeOpen={filesOpen} onToggleTree={()=>setFilesOpen(value=>!value)} maximized={fileMaximized} onMaximize={()=>setFileMaximized(value=>!value)} onError={notify}/></Suspense>}
        </div>}
        </div>
        {mobile&&<div className="mobile-keys" aria-label="터미널 보조 키">{[['Esc','\x1b'],['Tab','\t']].map(([label,key])=><button key={label} className="key-button" onPointerDown={e=>e.preventDefault()} onClick={()=>actions.current.get(activeId)?.key(key)}>{label}</button>)}<button className={`key-button ${ctrl?'latched':''}`} aria-pressed={ctrl} onPointerDown={e=>e.preventDefault()} onClick={()=>setCtrl(!ctrl)}>Ctrl</button><button className={`key-button ${alt?'latched':''}`} aria-pressed={alt} onPointerDown={e=>e.preventDefault()} onClick={()=>setAlt(!alt)}>Alt</button><button className="key-button" onPointerDown={e=>e.preventDefault()} onClick={()=>actions.current.get(activeId)?.key('\x03')}>^C</button>{[[ArrowLeft,'\x1b[D','왼쪽'],[ArrowDown,'\x1b[B','아래'],[ArrowUp,'\x1b[A','위'],[ArrowRight,'\x1b[C','오른쪽']].map(([Icon,key,label])=>{const Component=Icon as typeof ArrowLeft;return <button className="key-button" key={String(label)} aria-label={String(label)} onPointerDown={e=>e.preventDefault()} onClick={()=>actions.current.get(activeId)?.key(String(key))}><Component size={17}/></button>;})}<button className="key-button" aria-label="키보드 열기" onPointerDown={e=>e.preventDefault()} onClick={()=>actions.current.get(activeId)?.focus()}><Keyboard size={18}/></button></div>}
      </>}
      {fileDocs.visible&&!group?.layout&&<div className="orphan-file-editor"><Suspense fallback={<p className="file-message">편집기를 여는 중…</p>}><FileEditorPanel files={fileDocs} treeOpen={false} onToggleTree={()=>setFilesOpen(true)} maximized={true} onMaximize={()=>fileDocs.setVisible(false)} onError={notify}/></Suspense></div>}
      <footer className="status-bar"><span><span className={`connection-dot ${connected?'connected':'offline'}`}/>{connected?'세션 연결됨':'오프라인'}</span><span>{state?`${state.terminals.filter(t=>t.status==='running').length}개 실행 중`:'연결 대기'}</span>{fileDocs.documents.length>0&&<button className="open-files-status" onClick={()=>fileDocs.setVisible(true)}>열린 파일 {fileDocs.documents.length}{fileDocs.unsaved?` · 수정 중 ${fileDocs.unsaved}`:''}</button>}<span className="status-right">{connection.owner?'이 컴퓨터':'원격 연결'} · {group?.cwd||'몽글터미널'}</span></footer>
    </main>
    {settingsOpen&&state&&<Settings initialTab={settingsTab} client={client} state={state} owner={connection.owner} theme={theme} fontSize={fontSize} scrollSpeed={scrollSpeed} onScrollSpeed={setScrollSpeed} refreshBlocked={fileDocs.unsaved > 0 || fileDocs.documents.some(doc => doc.saving)} onTheme={setTheme} onFontSize={setFontSize} onClose={()=>{setSettingsOpen(false);setSettingsTab(undefined);}} onError={notify}/>}
    {editor&&<EditorModal key={`${state?.hostId}:${group?.id}:${editor.kind}:${editor.kind==='group'?editor.group?.id:editor.kind==='new-terminal'?editor.tabTarget||editor.splitTarget:''}`} editor={editor} state={state} group={group} activeId={activeId} pickDirectory={connected&&connection.owner&&window.mongle?.selectDirectory?path=>window.mongle!.selectDirectory!(path):undefined} onClose={()=>setEditor(undefined)} onSubmit={async values=>{
      const selection=hostSelection.current,navigation=projectNavigation.current,hostId=state?.hostId,bootId=state?.bootId;
      const sameHost=()=>selection===hostSelection.current&&layoutContext.current.hostId===hostId&&layoutContext.current.bootId===bootId;
      // Closing this editor does not undo an accepted host operation, but its
      // eventual reply must not close a replacement editor or redirect the user.
      const current=()=>selection===hostSelection.current&&currentEditor.current===editor&&projectNavigation.current===navigation&&(editor.kind==='host'||sameHost());
      if(editor.kind==='host'){if(!window.mongle)return;const host=await window.mongle.addHost({name:values.name,url:values.url});await refreshHosts();if(current()){setEditor(undefined);await chooseHost(host.id);}return;}
      let result:any;
      if(editor.kind==='group')result=await client.request(editor.group?'groups.update':'groups.create',{...(editor.group?{id:editor.group.id,revision:editor.group.revision}:{}),name:values.name,...(values.cwd?{cwd:values.cwd}:{}),profileId:values.profileId});
      else if(editor.kind==='terminal')result=await client.request('terminals.rename',{id:editor.terminal.id,title:values.name});
      else {if(!group)return;result=await client.request('terminals.create',{groupId:group.id,profileId:values.profileId,...(values.cwd?{cwd:values.cwd}:{}),...(editor.tabTarget?{tabTarget:editor.tabTarget}:{splitTarget:editor.splitTarget||activeId||undefined,axis:editor.axis||'horizontal'})});}
      if(sameHost())await loadState();if(!current())return;
      if(editor.kind==='new-terminal'){setActiveId(result.id);if(!editor.tabTarget)setMaximized(undefined);else if(maximized)setMaximized(result.id);}
      if(editor.kind==='group'&&!editor.group)setGroupId(result.id);setEditor(undefined);
    }}/>}
    {dialog&&<Modal title={dialog.title} onClose={()=>{dialog.resolve(false);setDialog(undefined);}}><div className="modal-body"><p>{dialog.description}</p>{dialog.detail&&<pre className="paste-preview">{dialog.detail}</pre>}</div><div className="modal-footer"><button className="button" onClick={()=>{dialog.resolve(false);setDialog(undefined);}}>취소</button><button data-initial-focus={dialog.focusAction || undefined} className={`button ${dialog.danger?'danger':'primary'}`} onClick={()=>{dialog.resolve(true);setDialog(undefined);}}>{dialog.action}</button></div></Modal>}
    {moving&&state&&<Modal title="다른 그룹으로 이동" onClose={()=>setMoving(undefined)}><div className="modal-body panel-list"><p className="hint">실행 중인 작업을 유지하면서 터미널을 옮깁니다.</p>{state.groups.filter(g=>g.id!==moving.groupId).map(g=><button key={g.id} className="device-row" onClick={async()=>{const result=await mutate('terminals.move',{id:moving.id,hostId:state.hostId,bootId:state.bootId,generation:moving.generation,groupId:g.id});if(result){setGroupId(g.id);setActiveId(moving.id);setMoving(undefined);}}}><Folder size={18}/>{g.name}</button>)}{state.groups.length<2&&<p>옮길 그룹이 없습니다. 먼저 새 그룹을 만들어 주세요.</p>}</div></Modal>}
    {panelsOpen&&state&&<Modal title="터미널 전환" onClose={()=>setPanelsOpen(false)}><div className="modal-body panel-list">{panelIds.map(id=>{const info=state.terminals.find(t=>t.id===id);return <button key={id} className="device-row" aria-description={terminalStatusDescription(terminalStatus(info,notifications.notices.get(id)))} onClick={()=>{selectTerminal(id);setPanelsOpen(false);}}><SquareTerminal size={20}/><span className="device-info">{info?.title}<small>{info?.cwd}</small></span><TerminalStatusBadge status={terminalStatus(info,notifications.notices.get(id))}/>{id===activeId&&<Check size={17}/>}</button>;})}</div></Modal>}
    {projectEditor&&state&&<ProjectOpenModal key={`${state.hostId}:${state.bootId}:${projectEditor.group?.id||'new'}`} group={projectEditor.group} state={state} request={projectRequest} pickDirectory={connected&&connection.owner&&window.mongle?.selectDirectory?path=>window.mongle!.selectDirectory!(path):undefined} onClose={()=>setProjectEditor(undefined)} onConnected={result=>{setProjectEditor(undefined);setGroupId(result.groupId);setSidebarOpen(false);if(result.terminalId)selectTerminal(result.terminalId,true);if(result.warning)notify(result.warning);}} onPlainGroup={cwd=>{setProjectEditor(undefined);setEditor({kind:'group',cwd});}}/>}
    {toast&&<div className="toast" role="status"><span>{toast}</span><button className="icon-button" aria-label="알림 닫기" onClick={()=>setToast('')}><X size={14}/></button></div>}
  </div></TerminalStatusStale.Provider>;
}

export function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  const panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement;const target=panel.current;const focusables=()=>Array.from(target?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')||[]);(target?.querySelector<HTMLElement>('[data-initial-focus="true"],[autofocus]')||focusables()[0])?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();onClose();}if(e.key==='Tab'){const elements=focusables();const first=elements[0],last=elements.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};target?.addEventListener('keydown',key);return()=>{target?.removeEventListener('keydown',key);previous?.focus();};},[]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={panel} className="modal" role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={18}/></button></header>{children}</div></div>;
}

function EditorModal({editor,state,group,activeId,pickDirectory,onClose,onSubmit}:{editor:Editor;state?:HostState;group?:Group;activeId?:string;pickDirectory?:(currentPath:string)=>Promise<string|null>;onClose:()=>void;onSubmit:(values:Record<string,string>)=>Promise<void>}){
  const [name,setName]=useState(editor.kind==='group'?editor.group?.name||'':editor.kind==='terminal'?editor.terminal.title:'');
  const source=editor.kind==='new-terminal'?state?.terminals.find(terminal=>terminal.id===(editor.tabTarget||editor.splitTarget||activeId)):undefined;
  const [cwd,setCwd]=useState(editor.kind==='group'?editor.group?.cwd||editor.cwd||group?.cwd||state?.groups[0]?.cwd||'':source?.currentCwd||source?.cwd||group?.cwd||'');
  const [profileId,setProfileId]=useState(editor.kind==='group'?editor.group?.profileId||group?.profileId||state?.profiles[0]?.id||'':source?.profileId||group?.profileId||state?.profiles[0]?.id||'');
  const [url,setUrl]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [choosing,setChoosing]=useState(false);
  async function browse(){if(!pickDirectory||busy||choosing)return;setChoosing(true);setError('');try{const selected=await pickDirectory(cwd.trim());if(selected!==null)setCwd(selected);}catch(error){setError(error instanceof Error?error.message:'폴더를 선택하지 못했습니다.');}finally{setChoosing(false);}}
  const title=editor.kind==='host'?'컴퓨터 추가':editor.kind==='group'?(editor.group?'그룹 설정':'새 작업 그룹'):editor.kind==='terminal'?'터미널 이름 변경':editor.tabTarget?'새 터미널 탭':editor.splitTarget?(editor.axis==='vertical'?'상하 분할':'좌우 분할'):'새 터미널';
  return <Modal title={title} onClose={onClose}><form onSubmit={async e=>{e.preventDefault();if(busy||choosing)return;setBusy(true);setError('');try{await onSubmit({name:name.trim(),cwd:cwd.trim(),profileId,url:url.trim()});}catch(error){setError(error instanceof Error?error.message:'저장하지 못했습니다.');}finally{setBusy(false);}}}><div className="modal-body">
    {source&&<p className="hint">{source.title}의 {source.currentCwd?'현재 폴더':'시작 폴더'}를 기본값으로 사용합니다. 폴더는 자유롭게 변경할 수 있습니다.</p>}
    {editor.kind!=='new-terminal'&&<label className="field"><span className="field-label">{editor.kind==='host'?'컴퓨터 이름':'이름'}</span><input className="input" autoFocus required maxLength={80} placeholder={editor.kind==='host'?'집 PC':editor.kind==='group'?'프로젝트 이름':'터미널 이름'} value={name} onChange={e=>setName(e.target.value)}/></label>}
    {editor.kind==='terminal'&&<p className="hint">사이드바와 탭에 표시할 이름입니다. 작업 폴더와 실행 중인 셸은 그대로 유지됩니다.</p>}
    {editor.kind==='host'?<><label className="field"><span className="field-label">몽글 접속 주소</span><input className="input" type="url" required placeholder="https://my-pc.tailnet.ts.net" value={url} onChange={e=>setUrl(e.target.value)}/></label><p className="hint">연결할 컴퓨터의 몽글 설정 → 원격 접속에서 주소를 복사하세요. 두 기기에서 Tailscale이 연결되어 있어야 합니다.</p></>:editor.kind!=='terminal'&&<><label className="field"><span className="field-label">셸</span><select className="select" required value={profileId} onChange={e=>setProfileId(e.target.value)}>{state?.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><div className="field"><label className="field-label" htmlFor="starting-directory">시작 폴더</label><div className="directory-input"><input id="starting-directory" className="input" placeholder="기본 사용자 폴더" maxLength={4096} value={cwd} disabled={busy||choosing} onChange={e=>setCwd(e.target.value)}/>{pickDirectory&&<button type="button" className="button" disabled={busy||choosing} onClick={()=>void browse()}><Folder size={16}/>{choosing?'선택 중…':'찾아보기'}</button>}</div></div><p className="hint">{pickDirectory?'찾아보기로 폴더를 선택하거나 전체 경로를 입력하세요.':'접속한 컴퓨터의 폴더 경로를 입력하세요. 휴대폰이나 다른 PC의 폴더는 사용할 수 없습니다.'}{editor.kind==='group'&&editor.group&&' 변경한 폴더는 이후 새로 여는 터미널에 적용됩니다.'}</p></>}
    {error&&<p className="error-text" role="alert">{error}</p>}</div><div className="modal-footer"><button type="button" className="button" onClick={onClose}>취소</button><button className="button primary" disabled={busy||choosing}>{busy?'처리 중…':editor.kind==='host'?'추가하고 연결':editor.kind==='new-terminal'?'터미널 열기':'저장'}</button></div></form></Modal>;
}

function Pairing({client,notify}:{client:ReturnType<typeof createClient>;notify:(message:string)=>void}){
  const [code,setCode]=useState('');const [name,setName]=useState('');const [request,setRequest]=useState<{requestId:string;requesterSecret:string;expiresAt:number}>();const [status,setStatus]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{if(!request)return;let stopped=false;let inFlight=false;const poll=async()=>{if(inFlight)return;inFlight=true;try{const result=await client.pairingStatus(request.requestId,request.requesterSecret);if(stopped)return;setStatus(result.status);if(result.status==='approved'){await client.pairingClaim(request.requestId,request.requesterSecret);notify('기기가 연결되었습니다.');setRequest(undefined);client.reconnect();}else if(['expired','rejected'].includes(result.status)){setError(result.status==='expired'?'연결 요청이 만료되었습니다. 새 코드로 다시 요청해 주세요.':'이 컴퓨터에서 연결 요청을 거절했습니다.');setRequest(undefined);}}catch(error){if(!stopped)setError(error instanceof Error?error.message:'승인 상태를 확인하지 못했습니다.');}finally{inFlight=false;}};void poll();const timer=setInterval(()=>void poll(),2500);return()=>{stopped=true;clearInterval(timer);};},[request,client,notify]);
  return <div className="pairing-page"><form className="pairing-card" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const result=await client.pairingRequest(code.trim(),name.trim());setRequest(result);setStatus('pending');}catch(error){setError(error instanceof Error?error.message:'연결 요청 실패');}finally{setBusy(false);}}}><div className="empty-icon"><Monitor size={30}/></div><h2>이 기기를 연결하세요</h2><p>접속할 컴퓨터에서 <strong>설정 → 원격 접속</strong>을 열고 기기 연결 코드를 만들어 주세요.</p><label className="field"><span className="field-label">이 기기의 이름</span><input className="input" required maxLength={80} placeholder="내 휴대폰" value={name} onChange={e=>setName(e.target.value)} disabled={Boolean(request)}/></label><label className="field"><span className="field-label">일회용 연결 코드</span><input className="input" required autoComplete="off" placeholder="PC에 표시된 코드" value={code} onChange={e=>setCode(e.target.value)} disabled={Boolean(request)}/></label>{error&&<p className="error-text" role="alert">{error}</p>}{request?<div className="connection-banner">{status==='approved'?'승인되었습니다. 연결하는 중…':'컴퓨터에서 이 기기의 요청을 승인해 주세요.'}</div>:<button className="button primary" disabled={busy}>{busy?'요청 중…':'연결 요청'}</button>}<p className="hint">등록한 기기만 터미널에 접근할 수 있습니다. 연결 코드는 신뢰할 수 있는 기기에서만 사용하세요.</p></form></div>;
}
