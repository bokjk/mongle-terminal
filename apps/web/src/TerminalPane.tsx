import { useEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Columns2, Rows2, Maximize2, Minimize2, X, Search, Copy, ClipboardPaste, RotateCcw, Pencil, Keyboard, Eye, SquareTerminal, GripVertical } from 'lucide-react';
import { BrowserPresentationAdapter } from '../../../packages/terminal/browser';
import type { AppClient } from '../../../packages/client/index';
import type { HostState, SnapshotEvent, TerminalInfo } from '../../../packages/protocol/index';
import { transformInput } from '../../../packages/ui/layout';
import type { PaneDropPreview } from './use-pane-drag';
import { attachTerminalTap } from './terminal-tap';

export interface PaneActions { key(data:string):void; paste(text:string):void; focus():void; search():void; }
export interface PaneProps {
  client: AppClient; state: HostState; info: TerminalInfo; connected: boolean; owner:boolean; connectionId?:string; selected:boolean; maximized:boolean; fontSize:number; theme:'dark'|'light'; ctrl:boolean; alt:boolean;
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
type AcquireMode = 'background'|'intent'|'recover';
function inputLatch(client:AppClient,state:HostState,info:TerminalInfo){let sessions=inputSafety.get(client);if(!sessions){sessions=new Map();inputSafety.set(client,sessions);}const key=`${state.hostId}:${state.bootId}:${info.id}:${info.generation}`;let latch=sessions.get(key);if(!latch){latch={blocked:false};sessions.set(key,latch);}return latch;}
export function TerminalPane(props:PaneProps) {
  const {client,state,info} = props;
  const mount = useRef<HTMLDivElement>(null);
  const toolbarDrag = useRef(false);
  const contextPointer = useRef('mouse');
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
  const [controlError,setControlError] = useState(false);
  const [controlOwner,setControlOwner] = useState(info.controller);
  const [inputUncertain,setInputUncertain] = useState(uncertain.current.blocked);
  const [searchMatch,setSearchMatch] = useState(true);
  const [frameError,setFrameError] = useState('');
  const [historyTruncated,setHistoryTruncated] = useState(false);
  const [clipboardMenu,setClipboardMenu] = useState<{x:number;y:number}|null>(null);
  const [copied,setCopied] = useState(false);
  const connectionId = useRef<string | undefined>(undefined);
  const target = () => ({id:info.id,hostId:state.hostId,bootId:state.bootId,generation:info.generation});
  const targetRef = useRef(target); targetRef.current = target;
  const applyFrame = useRef<(event:SnapshotEvent, lease?:number, wait?:boolean)=>Promise<boolean>>(async()=>false);
  const acquireRef = useRef<(focus?:boolean,mode?:AcquireMode)=>Promise<number|undefined>>(async()=>undefined);
  const startInputRef = useRef<()=>void>(()=>{});
  const pasteInputRef = useRef<(text:string)=>Promise<boolean>>(async()=>false);
  const resizeRef = useRef<()=>Promise<void>>(async()=>{});
  const dimensions = () => { const dims = fitRef.current?.proposeDimensions(); return {cols:Math.max(20,Math.min(400,dims?.cols || info.cols)),rows:Math.max(5,Math.min(200,dims?.rows || info.rows))}; };

  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    let observedInfo=info;
    // The desktop bridge can deliver a control.acquire reply before the state
    // events the host broadcast ahead of it. Keep that grant until the ordered
    // state stream reports it or a newer lease; earlier snapshots predate it.
    let grant:{epoch:number;connectionId:string}|undefined;
    let acquireFailed=false;
    let pendingAcquisition:Promise<number|undefined>|undefined;
    const terminal = new Terminal({cols:info.cols,rows:info.rows,fontSize:props.fontSize,fontFamily:'Cascadia Mono, Cascadia Code, Consolas, Menlo, monospace',lineHeight:1.15,scrollback:5000,cursorBlink:true,theme:themes[props.theme],allowProposedApi:true,convertEol:false});
    termRef.current = terminal;
    const fit = new FitAddon(); const search = new SearchAddon(); terminal.loadAddon(fit); terminal.loadAddon(search); fitRef.current = fit; searchRef.current = search;
    terminal.open(mount.current);
    terminal.textarea?.setAttribute('autocapitalize','off'); terminal.textarea?.setAttribute('autocomplete','off'); terminal.textarea?.setAttribute('autocorrect','off'); terminal.textarea?.setAttribute('spellcheck','false'); terminal.textarea?.setAttribute('aria-label',`${info.title} 터미널 입력`);
    // Terminal-generated clipboard writes are never applied to the system clipboard.
    const osc52 = terminal.parser.registerOscHandler(52,() => true);
    const inputBytes=(data:string,encoding:'utf8'|'binary')=>encoding==='binary'?data.length:new TextEncoder().encode(data).length;
    const ownsLease=(lease:number)=>!disposed&&epoch.current===lease&&current.current.connected&&observedInfo.status==='running'&&(grant?grant.epoch===lease&&grant.connectionId===connectionId.current:observedInfo.controller?.epoch===lease&&observedInfo.controller.connectionId===connectionId.current);
    // Only another connection's lease makes background attachment wait. The host
    // already lets this same connection replace its own leftover lease.
    const otherController=()=>observedInfo.controller&&observedInfo.controller.connectionId!==current.current.connectionId?observedInfo.controller:undefined;
    const leaseActive=(lease:number)=>!uncertain.current.blocked&&ownsLease(lease);
    const sendInput=(data:string,encoding:'utf8'|'binary',lease:number)=>client.request('terminal.input',{...targetRef.current(),epoch:lease,inputId:crypto.randomUUID(),clientInputSeq:++inputSeq.current,data,encoding});
    const failInput=(error:unknown)=>{resizeInput.current=undefined;uncertain.current.blocked=true;ready.current=false;if(!disposed){adapter.setInputEnabled(false);setInputUncertain(true);current.current.onError(error instanceof Error?error.message:'입력 전달을 확인하지 못했습니다.');}};
    const adapter = new BrowserPresentationAdapter(terminal,(data,encoding) => {
      if (epoch.current===undefined||!leaseActive(epoch.current))return;
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
    // Match the Windows console workflow: finish a mouse selection to copy it.
    // Copy on release, never on every selection event (snapshots restore the
    // same selection repeatedly while output is streaming).
    let selecting = false;
    const beginSelection=(event:MouseEvent)=>{if(event.button===0)selecting=true;};
    const finishSelection=(event:MouseEvent)=>{if(event.button!==0||!selecting)return;selecting=false;if(terminal.hasSelection())void copy();};
    mount.current.addEventListener('mousedown',beginSelection);
    window.addEventListener('mouseup',finishSelection);
    const handlePaste=(event:ClipboardEvent)=>{const text=event.clipboardData?.getData('text/plain');if(text===undefined)return;event.preventDefault();event.stopImmediatePropagation();void current.current.confirmPaste(text).then(approved=>{if(approved&&!disposed)void runInputIntent(()=>adapter.paste(text));});};
    mount.current.addEventListener('paste',handlePaste,true);
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c' && (event.shiftKey || terminal.hasSelection())) { event.preventDefault(); void copy(); return false; }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') {
        // Plain Ctrl+V uses the native paste event, including browser permission
        // fallback. Ctrl+Shift+V is the explicit terminal paste shortcut.
        if(event.shiftKey){event.preventDefault();void paste();} return false;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {setSearchOpen(true);return false;}
      return true;
    });
    lastSeq.current = -1; setControlled(false); setFrameError('');setControlError(false);
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
          if(!disposed&&!synchronizing&&epoch.current!==undefined&&ackEpoch===epoch.current){ready.current=leaseActive(epoch.current);adapter.setInputEnabled(ready.current);}
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
    const acquireControl = async(focus=false,mode:AcquireMode='recover'):Promise<number|undefined> => {
      if (disposed || !current.current.connected || observedInfo.status !== 'running') return;
      if(epoch.current!==undefined&&leaseActive(epoch.current)&&(ready.current||resizeInput.current?.epoch===epoch.current)){if(focus)terminal.focus();return epoch.current;}
      if(mode!=='recover'&&(uncertain.current.blocked||acquireFailed))return;
      if(mode==='background'&&(!current.current.state.capabilities?.includes('control.acquire-if-free')||otherController()))return;
      if(synchronizing)return;
      synchronizing=true;setBusy(true);ready.current=false;epoch.current=undefined;connectionId.current=undefined;grant=undefined;
      // Mobile browsers must see an editable focus inside this click, before
      // the lease request yields. The adapter still blocks all outgoing input.
      adapter.setInputEnabled(false,{preserveKeyboard:focus});
      if(focus)terminal.focus();
      try {
        const result=await client.request('control.acquire',{...targetRef.current(),...dimensions(),...(mode==='background'?{takeover:false}:{})});if(disposed)return;
        // Lease epochs only grow. A newer lease already replaced this grant, so show
        // its frame as a viewer: the host holds later frames until this one is ACKed.
        const observed=observedInfo.controller;
        if(observed&&(observed.epoch>result.epoch||(observed.epoch===result.epoch&&observed.connectionId!==result.connectionId))){adapter.setInputEnabled(false);void applyFrame.current(result.frame);return;}
        if(observed?.epoch!==result.epoch)grant={epoch:result.epoch,connectionId:result.connectionId};
        epoch.current=result.epoch;acknowledgedEpoch.current=undefined;connectionId.current=result.connectionId;
        const applied=await applyFrame.current(result.frame,result.epoch,true);
        if(!applied||!ownsLease(result.epoch)||acknowledgedEpoch.current!==result.epoch){
          // Give up this grant completely. Releasing a lease the host still holds for
          // it leaves no orphan; later ACKs no longer carry its epoch.
          grant=undefined;epoch.current=undefined;connectionId.current=undefined;
          if(!disposed){adapter.setInputEnabled(false);void client.request('control.release',{id:info.id,epoch:result.epoch}).catch(()=>{});}
          return;
        }
        uncertain.current.blocked=false;setInputUncertain(false);acquireFailed=false;setControlError(false);setControlled(true);ready.current=true;adapter.setInputEnabled(true);
        adapter.setFocused(document.activeElement===terminal.textarea);
        return result.epoch as number;
      }catch(error){if(!disposed){
        setControlled(false);ready.current=false;epoch.current=undefined;connectionId.current=undefined;adapter.setInputEnabled(false);
        if(mode==='background'&&error instanceof Error&&(('code' in error&&error.code==='CONTROL_BUSY')||error.message.includes('다른 기기에서 제어 중입니다.'))){
          // Another device may win between the tap and the host's atomic check.
          // Refresh its name and leave an explicit takeover action, without a
          // warning banner or an automatic retry that would steal its lease.
          try{const fresh=await client.request<HostState>('state.get');if(!disposed&&fresh.hostId===state.hostId&&fresh.bootId===state.bootId){const latest=fresh.terminals.find(item=>item.id===info.id&&item.generation===info.generation);if(latest){observedInfo=latest;setControlOwner(latest.controller);}}}
          catch{if(!disposed){acquireFailed=true;setControlError(true);}}
        }else{acquireFailed=true;setControlError(true);current.current.onError(error instanceof Error?error.message:'제어권을 가져오지 못했습니다.');}
      }}
      finally{synchronizing=false;if(!disposed){setBusy(false);if(ready.current)void resizeRef.current();}}
    };
    acquireRef.current=(focus=false,mode='recover')=>{
      if(pendingAcquisition){if(focus)terminal.focus();return pendingAcquisition;}
      const pending=acquireControl(focus,mode);pendingAcquisition=pending;
      const clear=()=>{if(pendingAcquisition===pending)pendingAcquisition=undefined;};
      void pending.then(clear,clear);return pending;
    };
    // Starting/reconnecting a view never steals a lease. Deliberate input on
    // either desktop or mobile does, after the new screen is acknowledged.
    startInputRef.current=()=>{void acquireRef.current(true,'intent');};
    async function runInputIntent(action:()=>void):Promise<boolean>{
      if(disposed)return false;
      const lease=await acquireRef.current(false,'intent');
      if(lease===undefined||!leaseActive(lease)||(!ready.current&&resizeInput.current?.epoch!==lease))return false;
      action();return true;
    }
    pasteInputRef.current=text=>runInputIntent(()=>adapter.paste(text));
    const removeTap=attachTerminalTap(mount.current,()=>terminal.hasSelection()||Boolean(window.getSelection()?.toString()),()=>startInputRef.current());
    const unsubscribe = client.subscribe(event => {
      if(event.type === 'snapshot' && event.terminalId === info.id)void applyFrame.current(event);
      if(event.type==='state'&&event.state.hostId===state.hostId&&event.state.bootId===state.bootId){
        const latest=event.state.terminals.find(item=>item.id===info.id&&item.generation===info.generation);
        if(latest){
          // State events stay in host order. The first one reporting this grant or a
          // newer lease ends the wait; every earlier one predates the grant.
          if(grant&&latest.controller&&latest.controller.epoch>=grant.epoch)grant=undefined;
          observedInfo=latest;setControlOwner(latest.controller);
        }
        if(!latest||(epoch.current!==undefined&&!ownsLease(epoch.current))){grant=undefined;resizeInput.current=undefined;epoch.current=undefined;ready.current=false;setControlled(false);adapter.setInputEnabled(false);}
      }
    });
    // A pane unmounted while its first frame was applied has already sent its
    // detach. Acquiring after that would leave this connection an orphan lease.
    const attach = () => {
      void client.request<SnapshotEvent>('terminals.attach',targetRef.current()).then(async frame => { if (disposed) return; await applyFrame.current(frame,undefined,true); if (!disposed && !uncertain.current.blocked && current.current.owner && !otherController() && observedInfo.status === 'running' && !matchMedia('(max-width: 700px)').matches) await acquireRef.current(false,'background'); }).catch(error => {if(!disposed)setFrameError(error.message);});
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
        // Without the lease the frame is still shown: the host holds later frames until it is ACKed.
        if(!leaseActive(lease)||resizeInput.current!==pending){void applyFrame.current(result.frame);return;}
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
    current.current.register(info.id,{key:data=>{void runInputIntent(()=>keyMap[data]?adapter.sendKey(keyMap[data]):adapter.sendInput(data));},paste:text=>{void current.current.confirmPaste(text).then(approved=>{if(approved&&!disposed)void runInputIntent(()=>adapter.paste(text));});},focus:()=>startInputRef.current(),search:()=>setSearchOpen(true)});
    const pasteTarget=mount.current;
    return()=>{disposed=true;removeTap();resizeInput.current=undefined;ready.current=false;epoch.current=undefined;connectionId.current=undefined;pendingFrame?.waiters.forEach(resolve=>resolve(false));pendingFrame=undefined;unsubscribe();observer.disconnect();clearTimeout(resizeTimer);pasteTarget?.removeEventListener('paste',handlePaste,true);pasteTarget?.removeEventListener('mousedown',beginSelection);window.removeEventListener('mouseup',finishSelection);osc52.dispose();adapter.dispose();terminal.dispose();current.current.register(info.id,null);void client.request('terminals.detach',{id:info.id}).catch(()=>{});};
  },[client,info.id,info.generation,state.bootId,props.connected]);

  useEffect(()=>{if(termRef.current){termRef.current.options.fontSize=props.fontSize;termRef.current.options.theme=themes[props.theme];}const frame=requestAnimationFrame(()=>void resizeRef.current());return()=>cancelAnimationFrame(frame);},[props.fontSize,props.theme]);
  useEffect(()=>{setControlOwner(info.controller);},[info.controller]);
  // Lease changes come from the pane's ordered state stream above. App state can
  // also come from a state.get reply that is older than those events.
  useEffect(()=>{
    if(!props.connected || info.status!=='running'){resizeInput.current=undefined;ready.current=false;adapterRef.current?.setInputEnabled(false);}
  },[info.status,props.connected]);
  useEffect(()=>{adapterRef.current?.setFocused(props.selected);},[props.selected]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2000);return()=>clearTimeout(timer);},[copied]);
  useEffect(()=>{
    if(!clipboardMenu)return;
    const dismiss=(event:PointerEvent)=>{if(!(event.target as Element).closest('.terminal-clipboard-menu'))setClipboardMenu(null);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setClipboardMenu(null);termRef.current?.focus();}};
    const close=()=>setClipboardMenu(null);
    document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape,true);window.addEventListener('blur',close);window.addEventListener('resize',close);
    return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape,true);window.removeEventListener('blur',close);window.removeEventListener('resize',close);};
  },[clipboardMenu]);
  async function copy(){const text=termRef.current?.getSelection();setClipboardMenu(null);if(!text){current.current.onError('복사할 내용을 먼저 드래그로 선택해 주세요.');return;}try{if(window.mongle?.writeClipboard)await window.mongle.writeClipboard(text);else await navigator.clipboard.writeText(text);setCopied(true);}catch{current.current.onError('복사하지 못했습니다. 내용을 선택한 뒤 Ctrl+C를 사용해 주세요.');}}
  async function paste(){const input=pasteInputRef.current;setClipboardMenu(null);try{const text=window.mongle?.readClipboard?await window.mongle.readClipboard():await navigator.clipboard.readText();if(await current.current.confirmPaste(text)&&input===pasteInputRef.current&&await input(text))termRef.current?.focus();}catch{current.current.onError('클립보드를 읽을 수 없습니다. 터미널을 선택한 뒤 Ctrl+V를 사용해 주세요.');}}
  function doSearch(backward=false){if(!query){searchRef.current?.clearDecorations();setSearchMatch(true);return;}setSearchMatch(Boolean(backward ? searchRef.current?.findPrevious(query) : searchRef.current?.findNext(query)));}
  function focusTitle(){if(props.dragClickAllowed?.()===false)return;props.onSelect();startInputRef.current();}
  // A leftover lease of this same window is not another device; a tap re-acquires it.
  const otherOwner=controlOwner&&controlOwner.connectionId!==props.connectionId?controlOwner:undefined;
  return <section className={`pane ${props.selected?'active':''} ${props.maximized?'maximized':''}`} data-terminal-id={info.id} aria-label={`${info.title} 패널`} onPointerDown={event=>{contextPointer.current=event.pointerType;const target=event.target as Element;if(props.dragEnabled&&target.closest('.pane-header')&&!target.closest('.pane-toolbar'))return;props.onSelect();}} onDragOverCapture={event=>{event.preventDefault();event.stopPropagation();props.onPaneDragOver?.(event);}} onDropCapture={event=>{event.preventDefault();event.stopPropagation();props.onPaneDrop?.(event);}}>
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
          <button className="menu-item" title="드래그로 선택한 뒤 Ctrl+C · Ctrl+Shift+C" onClick={()=>void copy()}><Copy size={14}/>선택 내용 복사 <kbd className="shortcut-key">Ctrl+C</kbd></button>
          <button className="menu-item" title="Ctrl+V · Ctrl+Shift+V" disabled={!props.connected||info.status!=='running'||inputUncertain||controlError} onClick={()=>void paste()}><ClipboardPaste size={14}/>붙여넣기 <kbd className="shortcut-key">Ctrl+V</kbd></button>
          <button className="menu-item" onClick={props.onRestart}><RotateCcw size={14}/>새 셸로 다시 열기</button>
          <button className="menu-item" onClick={props.onClearHistory}>저장된 출력 지우기</button>
          {info.status==='running'&&<button className="menu-item danger" onClick={props.onTerminate}>작업 종료 · 기록 유지</button>}
        </div></details>
        <button className="icon-button" title={props.maximized?'분할로 돌아가기':'최대화'} aria-label={props.maximized?'분할로 돌아가기':'최대화'} onClick={props.onMaximize}>{props.maximized?<Minimize2 size={14}/>:<Maximize2 size={14}/>}</button>
        <button className="icon-button" title="터미널 종료 및 패널 닫기" aria-label="터미널 닫기" onClick={props.onClose}><X size={14}/></button>
      </div>
    </header>
    {searchOpen&&<form className="searchbar" onSubmit={e=>{e.preventDefault();doSearch();}}><Search size={14}/><input autoFocus className="input" placeholder="출력에서 찾기" aria-label="출력 검색" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setSearchOpen(false);termRef.current?.focus();}if(e.key==='Enter'&&e.shiftKey){e.preventDefault();doSearch(true);}}}/><span>{!searchMatch?'결과 없음':''}</span><button className="button subtle" type="button" onClick={()=>doSearch(true)}>이전</button><button className="button subtle">다음</button><button className="icon-button" type="button" aria-label="검색 닫기" onClick={()=>setSearchOpen(false)}><X size={14}/></button></form>}
    <div className="pane-body"><div className="terminal-canvas" ref={mount} onContextMenuCapture={event=>{
      if(termRef.current?.modes.mouseTrackingMode!=='none'&&!event.shiftKey)return;
      event.preventDefault();event.stopPropagation();props.onSelect();
      // A touch long press is browsing, not the desktop right-click paste action.
      if(!event.shiftKey&&contextPointer.current!=='touch'&&(event.nativeEvent as PointerEvent).pointerType!=='touch'){if(props.connected&&info.status==='running'&&!inputUncertain&&!controlError)void paste();return;}
      setClipboardMenu({x:Math.max(8,Math.min(event.clientX,window.innerWidth-244)),y:Math.max(8,Math.min(event.clientY,window.innerHeight-104))});
    }}/></div>
    {clipboardMenu&&createPortal(<div className="terminal-clipboard-menu" role="dialog" aria-label="터미널 복사와 붙여넣기" style={{left:clipboardMenu.x,top:clipboardMenu.y}}>
      <button autoFocus className="menu-item" disabled={!termRef.current?.hasSelection()} onClick={()=>void copy()}><Copy size={14}/>복사 <kbd className="shortcut-key">Ctrl+C</kbd></button>
      <button className="menu-item" disabled={!props.connected||info.status!=='running'||inputUncertain||controlError} onClick={()=>void paste()}><ClipboardPaste size={14}/>붙여넣기 <kbd className="shortcut-key">Ctrl+V</kbd></button>
    </div>,document.body)}
    {copied&&<div className="clipboard-feedback" role="status">선택한 내용을 복사했습니다.</div>}
    {props.dropPreview&&<div className="pane-drop-preview" data-drop-position={props.dropPreview.position} aria-live="polite"><span>{props.dropPreview.label}</span></div>}
    {(frameError||inputUncertain)&&<div className="connection-banner warning">{inputUncertain?'마지막 입력의 전달 여부를 확인해 주세요. 확인 후 제어권을 다시 가져올 수 있습니다.':frameError}</div>}
    {info.restoreError&&<div className="connection-banner warning">{info.restoreError}{info.historyAvailable?' 이전 기록은 그대로 남아 있습니다.':''}</div>}
    {historyTruncated&&<div className="history-notice">오래된 출력 일부를 생략하고 최근 기록을 표시합니다.</div>}
    <footer className="pane-footer"><span title={info.cwd}>{info.cwd}</span>{info.status==='running'?
      busy?<span className="control-chip" role="status">연결 중…</span>:
      controlled&&!inputUncertain&&!frameError?<span className="control-chip controlled"><Keyboard size={12}/>여기서 제어 중</span>:
      otherOwner||inputUncertain||controlError||frameError?<button className="control-chip" disabled={!props.connected} onPointerDown={e=>e.preventDefault()} onClick={()=>void acquireRef.current(true)}><Eye size={12}/>{inputUncertain?'입력 확인 후 다시 제어':controlError||frameError?'제어 다시 시도':otherOwner?`${otherOwner.deviceName}에서 제어 · 가져오기`:'여기서 제어'}</button>:
      <span className="control-chip">{props.connected?'화면을 눌러 입력':'연결 대기 중'}</span>
      :<button className="button subtle" onClick={props.onRestart}>새 셸 열기 {info.exitCode!==undefined?`· 종료 ${info.exitCode}`:''}</button>}</footer>
  </section>;
}


