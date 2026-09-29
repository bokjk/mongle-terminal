import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Columns2, Rows2, Maximize2, Minimize2, X, Search, Copy, ClipboardPaste, RotateCcw, Pencil, Keyboard, Eye, SquareTerminal, GripVertical } from 'lucide-react';
import { BrowserPresentationAdapter } from '../../../packages/terminal/browser';
import type { AppClient } from '../../../packages/client/index';
import type { HostState, SnapshotEvent, TerminalInfo } from '../../../packages/protocol/index';
import { transformInput } from '../../../packages/ui/layout';
import type { PaneDropPreview } from './use-pane-drag';

export interface PaneActions { key(data:string):void; paste(text:string):void; focus():void; search():void; }
export interface PaneProps {
  client: AppClient; state: HostState; info: TerminalInfo; connected: boolean; owner:boolean; selected:boolean; maximized:boolean; fontSize:number; theme:'dark'|'light'; ctrl:boolean; alt:boolean;
  onSelect():void; onSplit(axis:'horizontal'|'vertical'):void; onMaximize():void; onClose():void; onRename():void; onRestart():void; onMove():void; onClearHistory():void; onTerminate():void;
  dragEnabled?:boolean;dropPreview?:PaneDropPreview;onPaneDragStart?(event:DragEvent<HTMLElement>):void;onPaneDragEnd?():void;onPaneDragOver?(event:DragEvent<HTMLElement>):void;onPaneDrop?(event:DragEvent<HTMLElement>):void;onPanePointerStart?():void;dragClickAllowed?():boolean;
  onError(message:string):void; confirmPaste(text:string):Promise<boolean>; register(id:string, actions:PaneActions|null):void;
}
const themes = {
  dark:{background:'#18191c',foreground:'#d8dcdf',cursor:'#b9e9cc',selectionBackground:'#44564e',black:'#26282c',red:'#ec9296',green:'#a8d9b6',yellow:'#e3cc91',blue:'#9dbde2',magenta:'#c8a5da',cyan:'#93d2ce',white:'#e7e9ed',brightBlack:'#777e88',brightWhite:'#ffffff'},
  light:{background:'#ffffff',foreground:'#303640',cursor:'#2d7253',selectionBackground:'#d1e7da',black:'#303640',red:'#a83f50',green:'#2d7253',yellow:'#8d691b',blue:'#3b69a0',magenta:'#8453a2',cyan:'#257f82',white:'#eef0f3',brightBlack:'#727984',brightWhite:'#ffffff'}
};
// Keep uncertainty across pane remounts (group changes/maximize/reconnect) for
// this client and exact live session. A new shell generation has a new latch.
const inputSafety = new WeakMap<AppClient,Map<string,{blocked:boolean}>>();
function inputLatch(client:AppClient,state:HostState,info:TerminalInfo){let sessions=inputSafety.get(client);if(!sessions){sessions=new Map();inputSafety.set(client,sessions);}const key=`${state.hostId}:${state.bootId}:${info.id}:${info.generation}`;let latch=sessions.get(key);if(!latch){latch={blocked:false};sessions.set(key,latch);}return latch;}
export function TerminalPane(props:PaneProps) {
  const {client,state,info} = props;
  const mount = useRef<HTMLDivElement>(null);
  const toolbarDrag = useRef(false);
  const current = useRef(props); current.current = props;
  const termRef = useRef<Terminal | undefined>(undefined);
  const adapterRef = useRef<BrowserPresentationAdapter | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const searchRef = useRef<SearchAddon | undefined>(undefined);
  const epoch = useRef<number | undefined>(undefined);
  const ready = useRef(false);
  const lastSeq = useRef(-1);
  const inputSeq = useRef(0);
  const resizeInput = useRef<{epoch:number;inputs:Array<{data:string;encoding:'utf8'|'binary'}>;bytes:number} | undefined>(undefined);
  const uncertain = useRef(inputLatch(client,state,info));
  const acknowledgedEpoch = useRef<number | undefined>(undefined);
  const [controlled,setControlled] = useState(false);
  const [searchOpen,setSearchOpen] = useState(false);
  const [query,setQuery] = useState('');
  const [busy,setBusy] = useState(false);
  const [inputUncertain,setInputUncertain] = useState(uncertain.current.blocked);
  const [searchMatch,setSearchMatch] = useState(true);
  const [frameError,setFrameError] = useState('');
  const [historyTruncated,setHistoryTruncated] = useState(false);
  const connectionId = useRef<string | undefined>(undefined);
  const target = () => ({id:info.id,hostId:state.hostId,bootId:state.bootId,generation:info.generation});
  const targetRef = useRef(target); targetRef.current = target;
  const applyFrame = useRef<(event:SnapshotEvent, lease?:number, wait?:boolean)=>Promise<boolean>>(async()=>false);
  const acquireRef = useRef<(focus?:boolean)=>Promise<void>>(async()=>{});
  const resizeRef = useRef<()=>Promise<void>>(async()=>{});
  const dimensions = () => { const dims = fitRef.current?.proposeDimensions(); return {cols:Math.max(20,Math.min(400,dims?.cols || info.cols)),rows:Math.max(5,Math.min(200,dims?.rows || info.rows))}; };

  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    const terminal = new Terminal({cols:info.cols,rows:info.rows,fontSize:props.fontSize,fontFamily:'Cascadia Mono, Cascadia Code, Consolas, Menlo, monospace',lineHeight:1.15,scrollback:5000,cursorBlink:true,theme:themes[props.theme],allowProposedApi:true,convertEol:false});
    termRef.current = terminal;
    const fit = new FitAddon(); const search = new SearchAddon(); terminal.loadAddon(fit); terminal.loadAddon(search); fitRef.current = fit; searchRef.current = search;
    terminal.open(mount.current);
    terminal.textarea?.setAttribute('autocapitalize','off'); terminal.textarea?.setAttribute('autocomplete','off'); terminal.textarea?.setAttribute('autocorrect','off'); terminal.textarea?.setAttribute('spellcheck','false'); terminal.textarea?.setAttribute('aria-label',`${info.title} 터미널 입력`);
    // Terminal-generated clipboard writes are never applied to the system clipboard.
    const osc52 = terminal.parser.registerOscHandler(52,() => true);
    const inputBytes=(data:string,encoding:'utf8'|'binary')=>encoding==='binary'?data.length:new TextEncoder().encode(data).length;
    const leaseActive=(lease:number)=>!disposed&&!uncertain.current.blocked&&epoch.current===lease&&current.current.connected&&current.current.info.status==='running'&&current.current.info.controller?.epoch===lease&&current.current.info.controller.connectionId===connectionId.current;
    const sendInput=(data:string,encoding:'utf8'|'binary',lease:number)=>client.request('terminal.input',{...targetRef.current(),epoch:lease,inputId:crypto.randomUUID(),clientInputSeq:++inputSeq.current,data,encoding});
    const failInput=(error:unknown)=>{resizeInput.current=undefined;uncertain.current.blocked=true;ready.current=false;if(!disposed){adapter.setInputEnabled(false);setInputUncertain(true);current.current.onError(error instanceof Error?error.message:'입력 전달을 확인하지 못했습니다.');}};
    const adapter = new BrowserPresentationAdapter(terminal,(data,encoding) => {
      if (disposed||uncertain.current.blocked||epoch.current===undefined||!current.current.connected||current.current.info.status!=='running')return;
      const transformed=transformInput(data,current.current.ctrl,current.current.alt);
      const pending=resizeInput.current;
      if(pending&&leaseActive(pending.epoch)){
        const bytes=inputBytes(transformed,encoding);
        if(pending.bytes+bytes>65536){failInput(new Error('화면 동기화가 지연되어 입력을 멈췄습니다. 내용을 확인하고 제어권을 다시 가져와 주세요.'));return;}
        const last=pending.inputs.at(-1);if(last?.encoding===encoding)last.data+=transformed;else pending.inputs.push({data:transformed,encoding});
        pending.bytes+=bytes;return;
      }
      if(!ready.current)return;
      void sendInput(transformed,encoding,epoch.current).catch(failInput);
    });
    adapterRef.current = adapter;
    const handlePaste=(event:ClipboardEvent)=>{const text=event.clipboardData?.getData('text/plain');if(text===undefined)return;event.preventDefault();event.stopImmediatePropagation();void current.current.confirmPaste(text).then(approved=>{if(approved&&!disposed)adapter.paste(text);});};
    mount.current.addEventListener('paste',handlePaste,true);
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'c') { void copy(); return false; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') { void paste(); return false; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {setSearchOpen(true);return false;}
      return true;
    });
    lastSeq.current = -1; setControlled(false); setFrameError('');
    // Only one frame is being rendered and one latest complete frame waits.
    // A long mobile IME composition must not retain an unbounded snapshot chain.
    type PendingFrame={event:SnapshotEvent;lease?:number;waiters:Array<(applied:boolean)=>void>};
    let pendingFrame:PendingFrame|undefined;let processing=false;let synchronizing=false;
    const drain = async() => {
      if(processing)return;processing=true;
      while(pendingFrame&&!disposed){
        const item=pendingFrame;pendingFrame=undefined;let applied=false;
        try{
          if(item.event.seq>=lastSeq.current){await adapter.applySnapshot(item.event.snapshot);if(disposed)break;lastSeq.current=item.event.seq;setHistoryTruncated(Boolean((item.event.snapshot as any).historyTruncated));}
          const ackEpoch=item.lease??epoch.current;
          await client.request('terminal.ack',{...targetRef.current(),seq:lastSeq.current,...(ackEpoch!==undefined?{epoch:ackEpoch}:{})});
          if(ackEpoch!==undefined)acknowledgedEpoch.current=ackEpoch;
          applied=true;
          if(!disposed&&!synchronizing&&epoch.current!==undefined&&ackEpoch===epoch.current){ready.current=!uncertain.current.blocked;adapter.setInputEnabled(ready.current&&current.current.connected&&current.current.info.status==='running');}
          if(!disposed)setFrameError('');
        }catch(error){resizeInput.current=undefined;if(!disposed){ready.current=false;adapter.setInputEnabled(false);setFrameError(error instanceof Error?error.message:'화면을 동기화하지 못했습니다.');}}
        finally{item.waiters.forEach(resolve=>resolve(applied));}
      }
      processing=false;
    };
    applyFrame.current = (event,lease,wait=false) => {
      if(disposed||event.generation!==info.generation||event.bootId!==state.bootId)return Promise.resolve(false);
      const waiters=pendingFrame?.waiters||[];
      let promise=Promise.resolve(false);if(wait)promise=new Promise<boolean>(resolve=>waiters.push(resolve));
      const newest=pendingFrame&&pendingFrame.event.seq>event.seq?pendingFrame.event:event;
      pendingFrame={event:newest,lease:lease??pendingFrame?.lease,waiters};void drain();return promise;
    };
    acquireRef.current = async(focus=false) => {
      if (!current.current.connected || current.current.info.status !== 'running') return;
      if(epoch.current!==undefined&&!uncertain.current.blocked&&(ready.current||synchronizing)){if(focus)terminal.focus();return;}
      if(synchronizing)return;
      synchronizing=true;setBusy(true);ready.current=false;epoch.current=undefined;connectionId.current=undefined;
      // Mobile browsers must see an editable focus inside this click, before
      // the lease request yields. The adapter still blocks all outgoing input.
      adapter.setInputEnabled(false,{preserveKeyboard:focus});
      if(focus)terminal.focus();
      try {
        const result=await client.request('control.acquire',{...targetRef.current(),...dimensions()});if(disposed)return;
        epoch.current=result.epoch;acknowledgedEpoch.current=undefined;connectionId.current=result.connectionId;setControlled(true);
        const applied=await applyFrame.current(result.frame,result.epoch,true);
        if(!applied||disposed||epoch.current!==result.epoch||acknowledgedEpoch.current!==result.epoch)return;
        uncertain.current.blocked=false;setInputUncertain(false);ready.current=true;adapter.setInputEnabled(current.current.connected&&current.current.info.status==='running');
        adapter.setFocused(document.activeElement===terminal.textarea);
      }catch(error){if(!disposed){adapter.setInputEnabled(false);current.current.onError(error instanceof Error?error.message:'제어권을 가져오지 못했습니다.');}}
      finally{synchronizing=false;if(!disposed){setBusy(false);if(ready.current)void resizeRef.current();}}
    };
    const unsubscribe = client.subscribe(event => {if(event.type === 'snapshot' && event.terminalId === info.id) void applyFrame.current(event);});
    const attach = () => {
      void client.request<SnapshotEvent>('terminals.attach',targetRef.current()).then(async frame => { if (disposed) return; await applyFrame.current(frame,undefined,true); if (!uncertain.current.blocked && current.current.owner && !current.current.info.controller && current.current.info.status === 'running' && !matchMedia('(max-width: 700px)').matches) await acquireRef.current(); }).catch(error => {if(!disposed)setFrameError(error.message);});
    };
    if(props.connected) attach();
    resizeRef.current=async()=>{
      if(disposed||synchronizing||!ready.current||epoch.current===undefined||!current.current.connected)return;
      const dims=dimensions();if(dims.cols===terminal.cols&&dims.rows===terminal.rows)return;
      const lease=epoch.current;synchronizing=true;ready.current=false;
      // Keep native input capture alive while only the transport waits for the
      // resize ACK. These are new keystrokes, scoped to this exact live lease.
      const pending={epoch:lease,inputs:[] as Array<{data:string;encoding:'utf8'|'binary'}>,bytes:0};resizeInput.current=pending;
      try{
        const result=await client.request('terminal.resize',{...targetRef.current(),epoch:lease,...dims});
        if(!leaseActive(lease)||resizeInput.current!==pending)return;
        const applied=await applyFrame.current(result.frame,lease,true);
        if(!applied||!leaseActive(lease)||resizeInput.current!==pending)return;
        while(pending.inputs.length&&leaseActive(lease)&&resizeInput.current===pending){
          const input=pending.inputs.shift()!;pending.bytes-=inputBytes(input.data,input.encoding);
          // Remove before sending and await acceptance. A failed response is
          // never retried; uncertainty discards every remaining buffered byte.
          try{await sendInput(input.data,input.encoding,lease);}catch(error){failInput(error);return;}
        }
        if(!leaseActive(lease)||resizeInput.current!==pending)return;
        resizeInput.current=undefined;ready.current=true;adapter.setInputEnabled(true);
      }catch(error){if(!disposed){adapter.setInputEnabled(false);current.current.onError(error instanceof Error?error.message:'화면 크기를 동기화하지 못했습니다.');}}
      finally{if(resizeInput.current===pending)resizeInput.current=undefined;synchronizing=false;if(!disposed&&ready.current)void resizeRef.current();}
    };
    let resizeTimer:ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>void resizeRef.current(),120);});observer.observe(mount.current);
    const keyMap:Record<string,'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight'>={'\x1b[A':'ArrowUp','\x1b[B':'ArrowDown','\x1b[C':'ArrowRight','\x1b[D':'ArrowLeft'};
    current.current.register(info.id,{key:data=>keyMap[data]?adapter.sendKey(keyMap[data]):adapter.sendInput(data),paste:text=>adapter.paste(text),focus:()=>terminal.focus(),search:()=>setSearchOpen(true)});
    const pasteTarget=mount.current;
    return()=>{disposed=true;resizeInput.current=undefined;ready.current=false;epoch.current=undefined;connectionId.current=undefined;pendingFrame?.waiters.forEach(resolve=>resolve(false));pendingFrame=undefined;unsubscribe();observer.disconnect();clearTimeout(resizeTimer);pasteTarget?.removeEventListener('paste',handlePaste,true);osc52.dispose();adapter.dispose();terminal.dispose();current.current.register(info.id,null);void client.request('terminals.detach',{id:info.id}).catch(()=>{});};
  },[client,info.id,info.generation,state.bootId,props.connected]);

  useEffect(()=>{if(termRef.current){termRef.current.options.fontSize=props.fontSize;termRef.current.options.theme=themes[props.theme];}const frame=requestAnimationFrame(()=>void resizeRef.current());return()=>cancelAnimationFrame(frame);},[props.fontSize,props.theme]);
  useEffect(()=>{
    if(epoch.current !== undefined && (!info.controller || info.controller.epoch!==epoch.current || (connectionId.current && info.controller.connectionId!==connectionId.current))){resizeInput.current=undefined;epoch.current=undefined;ready.current=false;setControlled(false);adapterRef.current?.setInputEnabled(false);}
    if(!props.connected || info.status!=='running'){resizeInput.current=undefined;ready.current=false;adapterRef.current?.setInputEnabled(false);}
  },[info.controller,info.status,props.connected]);
  useEffect(()=>{adapterRef.current?.setFocused(props.selected);},[props.selected]);
  async function copy(){const text=termRef.current?.getSelection();if(!text){props.onError('복사할 내용을 먼저 선택해 주세요.');return;}try{await navigator.clipboard.writeText(text);}catch{props.onError('클립보드에 접근할 수 없습니다. 브라우저의 복사 메뉴를 사용해 주세요.');}}
  async function paste(){try{const text=await navigator.clipboard.readText();if(await props.confirmPaste(text))adapterRef.current?.paste(text);}catch{props.onError('클립보드를 읽을 수 없습니다. 터미널을 선택한 뒤 붙여넣기를 사용해 주세요.');}}
  function doSearch(backward=false){if(!query){searchRef.current?.clearDecorations();setSearchMatch(true);return;}setSearchMatch(Boolean(backward ? searchRef.current?.findPrevious(query) : searchRef.current?.findNext(query)));}
  function focusTitle(){if(props.dragClickAllowed?.()===false)return;props.onSelect();termRef.current?.focus();}
  return <section className={`pane ${props.selected?'active':''} ${props.maximized?'maximized':''}`} data-terminal-id={info.id} aria-label={`${info.title} 패널`} onPointerDown={event=>{const target=event.target as Element;if(props.dragEnabled&&target.closest('.pane-header')&&!target.closest('.pane-toolbar'))return;props.onSelect();}} onDragOverCapture={event=>{event.preventDefault();event.stopPropagation();props.onPaneDragOver?.(event);}} onDropCapture={event=>{event.preventDefault();event.stopPropagation();props.onPaneDrop?.(event);}}>
    <header className="pane-header" draggable={Boolean(props.dragEnabled)} onPointerDown={event=>{toolbarDrag.current=Boolean((event.target as Element).closest('.pane-toolbar'));props.onPanePointerStart?.();}} onDragStart={event=>{if(!props.dragEnabled||toolbarDrag.current||(event.target as Element).closest('.pane-toolbar')){event.preventDefault();return;}props.onPaneDragStart?.(event);}} onDragEnd={props.onPaneDragEnd}>
      {props.dragEnabled?<><span className="pane-drag-handle" title="끌어서 패널 배치" aria-label="패널 끌어서 배치"><GripVertical size={15}/></span><span className="pane-title" onDoubleClick={props.onRename} onClick={focusTitle} title={`${info.cwd} · 끌어서 패널 배치`}>{info.title}</span></>:<><SquareTerminal size={14}/><button className="pane-title" onPointerDown={event=>event.preventDefault()} onDoubleClick={props.onRename} onClick={focusTitle} title={info.cwd}>{info.title}</button></>}
      <span className="pane-meta">{info.status==='running'?(controlled?'제어 중':'보기 전용'):info.status==='interrupted'?'중단됨':'종료됨'}</span>
      <div className="pane-toolbar">
        <button className="icon-button" title="터미널 검색" aria-label="터미널 검색" onClick={()=>setSearchOpen(!searchOpen)}><Search size={14}/></button>
        <button className="icon-button" title="좌우 분할" aria-label="좌우 분할" disabled={!props.connected} onClick={()=>props.onSplit('horizontal')}><Columns2 size={14}/></button>
        <button className="icon-button" title="상하 분할" aria-label="상하 분할" disabled={!props.connected} onClick={()=>props.onSplit('vertical')}><Rows2 size={14}/></button>
        <details className="command-menu"><summary className="icon-button" aria-label="터미널 메뉴">···</summary><div>
          <button className="menu-item" onClick={props.onRename}><Pencil size={14}/>이름 변경</button>
          <button className="menu-item" onClick={props.onMove}>다른 그룹으로 이동</button>
          <button className="menu-item" onClick={()=>void copy()}><Copy size={14}/>선택 내용 복사</button>
          <button className="menu-item" disabled={!controlled} onClick={()=>void paste()}><ClipboardPaste size={14}/>붙여넣기</button>
          <button className="menu-item" onClick={props.onRestart}><RotateCcw size={14}/>새 셸로 다시 열기</button>
          <button className="menu-item" onClick={props.onClearHistory}>저장된 출력 지우기</button>
          {info.status==='running'&&<button className="menu-item danger" onClick={props.onTerminate}>작업 종료 · 기록 유지</button>}
        </div></details>
        <button className="icon-button" title={props.maximized?'분할로 돌아가기':'최대화'} aria-label={props.maximized?'분할로 돌아가기':'최대화'} onClick={props.onMaximize}>{props.maximized?<Minimize2 size={14}/>:<Maximize2 size={14}/>}</button>
        <button className="icon-button" title="터미널 종료 및 패널 닫기" aria-label="터미널 닫기" onClick={props.onClose}><X size={14}/></button>
      </div>
    </header>
    {searchOpen&&<form className="searchbar" onSubmit={e=>{e.preventDefault();doSearch();}}><Search size={14}/><input autoFocus className="input" placeholder="출력에서 찾기" aria-label="출력 검색" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setSearchOpen(false);termRef.current?.focus();}if(e.key==='Enter'&&e.shiftKey){e.preventDefault();doSearch(true);}}}/><span>{!searchMatch?'결과 없음':''}</span><button className="button subtle" type="button" onClick={()=>doSearch(true)}>이전</button><button className="button subtle">다음</button><button className="icon-button" type="button" aria-label="검색 닫기" onClick={()=>setSearchOpen(false)}><X size={14}/></button></form>}
    <div className="pane-body"><div className="terminal-canvas" ref={mount}/></div>
    {props.dropPreview&&<div className="pane-drop-preview" data-drop-position={props.dropPreview.position} aria-live="polite"><span>{props.dropPreview.label}</span></div>}
    {(frameError||inputUncertain)&&<div className="connection-banner warning">{inputUncertain?'마지막 입력의 전달 여부를 확인해 주세요. 확인 후 제어권을 다시 가져올 수 있습니다.':frameError}</div>}
    {info.restoreError&&<div className="connection-banner warning">{info.restoreError}{info.historyAvailable?' 이전 기록은 그대로 남아 있습니다.':''}</div>}
    {historyTruncated&&<div className="history-notice">오래된 출력 일부를 생략하고 최근 기록을 표시합니다.</div>}
    <footer className="pane-footer"><span title={info.cwd}>{info.cwd}</span>{info.status==='running'?<button className={`control-chip ${controlled?'controlled':''}`} disabled={!props.connected||busy} onPointerDown={e=>e.preventDefault()} onClick={()=>void acquireRef.current(true)}>{controlled&&!inputUncertain?<Keyboard size={12}/>:<Eye size={12}/>} {busy?'연결 중…':controlled&&!inputUncertain?'여기서 제어 중':info.controller?`${info.controller.deviceName}에서 제어 · 가져오기`:'여기서 제어'}</button>:<button className="button subtle" onClick={props.onRestart}>새 셸 열기 {info.exitCode!==undefined?`· 종료 ${info.exitCode}`:''}</button>}</footer>
  </section>;
}


