import { useEffect, useRef, useState, type DragEvent, type MutableRefObject } from 'react';
import type { AppClient } from '../../../packages/client/index';
import { findLeaf, leafIds, type Group, type HostState } from '../../../packages/protocol/index';
import { dockLeaf, dockTab, moveTab, paneDropPosition, type PaneDropPosition, type TabInsertion } from '../../../packages/ui/layout';

const MIME='application/x-mongle-pane-drag';
type Context={state?:HostState;group?:Group;enabled:boolean;selection:number};
type Session={token:string;source?:string;kind:'region'|'tab';hostId:string;bootId:string;groupId:string;revision:number;selection:number};
export type PaneDropPreview={target:string;position:PaneDropPosition|'tabs';label:string;insertion?:TabInsertion};
const labels:Record<PaneDropPosition,string>={left:'왼쪽에 분할',right:'오른쪽에 분할',top:'위쪽에 분할',bottom:'아래쪽에 분할',center:'위치 바꾸기'};

export function usePaneDrag({client,state,group,enabled,hostSelection,queue,onState,onError,onSelect}:{
  client:AppClient;state?:HostState;group?:Group;enabled:boolean;hostSelection:MutableRefObject<number>;queue:MutableRefObject<Promise<void>>;
  onState(state:HostState):void;onError(message:string):void;onSelect(id:string):void;
}){
  const context=useRef<Context>({state,group,enabled,selection:hostSelection.current});context.current={state,group,enabled,selection:hostSelection.current};
  const session=useRef<Session | undefined>(undefined);const suppressClick=useRef(false);
  const [preview,setPreview]=useState<PaneDropPreview>();
  const [dragging,setDragging]=useState(false);
  const cancel=()=>{session.current=undefined;setPreview(undefined);setDragging(false);};
  const same=(drag:Session,revision?:number)=>{
    const now=context.current;
    return now.enabled&&hostSelection.current===drag.selection&&now.state?.hostId===drag.hostId&&now.state?.bootId===drag.bootId&&now.group?.id===drag.groupId&&(revision===undefined||now.group.revision===revision);
  };
  useEffect(()=>{cancel();},[state?.hostId,state?.bootId,group?.id,group?.revision,enabled]);
  useEffect(()=>{
    const stop=()=>cancel();const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&session.current){event.preventDefault();event.stopPropagation();cancel();}};
    const outside=(event:globalThis.DragEvent)=>{if(!(event.target instanceof Element)||!event.target.closest('.pane[data-terminal-id]'))setPreview(undefined);};
    const leave=(event:globalThis.DragEvent)=>{if(!event.relatedTarget)setPreview(undefined);};
    window.addEventListener('dragend',stop);window.addEventListener('drop',stop);window.addEventListener('blur',stop);window.addEventListener('keydown',key,true);window.addEventListener('dragover',outside);window.addEventListener('dragleave',leave);
    return()=>{window.removeEventListener('dragend',stop);window.removeEventListener('drop',stop);window.removeEventListener('blur',stop);window.removeEventListener('keydown',key,true);window.removeEventListener('dragover',outside);window.removeEventListener('dragleave',leave);};
  },[]);
  function start(event:DragEvent<HTMLElement>,source?:string,kind:'region'|'tab'='region'){
    const now=context.current;
    if(!now.enabled||!now.state||!now.group?.layout||source&&!leafIds(now.group.layout).includes(source)){event.preventDefault();return;}
    const drag:Session={token:crypto.randomUUID(),source,kind,hostId:now.state.hostId,bootId:now.state.bootId,groupId:now.group.id,revision:now.group.revision,selection:hostSelection.current};
    session.current=drag;suppressClick.current=true;setDragging(true);setPreview(undefined);
    event.dataTransfer.effectAllowed=source?'move':'copy';event.dataTransfer.setData(MIME,drag.token);
  }
  function accept(target:string,event:DragEvent<HTMLElement>){
    const drag=session.current;
    if(!drag||!same(drag,drag.revision)||!leafIds(context.current.group?.layout||null).includes(target)||!event.dataTransfer.types.includes(MIME))return;
    const rect=event.currentTarget.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return;
    const x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;
    if(x<0||x>1||y<0||y>1)return;
    let insertion:TabInsertion|undefined;
    const tabStrip=event.currentTarget.querySelector<HTMLElement>('.terminal-tabs'),newTab=event.currentTarget.querySelector<HTMLElement>('.new-tab');
    const contains=(element:HTMLElement|null)=>{const box=element?.getBoundingClientRect();return box&&event.clientX>=box.left&&event.clientX<=box.right&&event.clientY>=box.top&&event.clientY<=box.bottom;};
    // Native HTML drag can retarget dragover to the accepted pane ancestor.
    // Use the visible strip geometry instead of the event target's ancestors.
    if(drag.kind==='tab'&&drag.source&&(contains(tabStrip)||contains(newTab))){
      if(!context.current.state?.capabilities?.includes('layout.tabs'))return;
      const tab=Array.from(tabStrip?.querySelectorAll<HTMLElement>('.terminal-tab[data-tab-id]')||[]).find(contains);
      const id=tab?.dataset.tabId||leafIds(findLeaf(context.current.group!.layout!,target)!).at(-1)!;
      const bounds=tab?.getBoundingClientRect();
      insertion={id,side:bounds&&event.clientX<bounds.left+bounds.width/2?'before':'after'};
      if(moveTab(context.current.group!.layout!,drag.source,insertion)===context.current.group!.layout)return;
    }
    const position=insertion?'tabs' as const:paneDropPosition(x,y,Boolean(drag.source));
    if(drag.source){
      const sourceLeaf=findLeaf(context.current.group?.layout||null,drag.source),targetLeaf=findLeaf(context.current.group?.layout||null,target);
      if(!sourceLeaf||!targetLeaf)return;
      if(sourceLeaf===targetLeaf&&(drag.kind==='region'||position==='center'||leafIds(sourceLeaf).length<2))return;
      if(drag.kind==='tab'&&position==='center'&&!context.current.state?.capabilities?.includes('layout.tabs'))return;
    }
    return {drag,position,insertion};
  }
  function over(target:string,event:DragEvent<HTMLElement>){
    const hit=accept(target,event);
    if(!hit){event.dataTransfer.dropEffect='none';setPreview(undefined);return;}
    event.preventDefault();event.dataTransfer.dropEffect=hit.drag.source?'move':'copy';
    const label=hit.position==='tabs'?'여기에 탭으로 이동':hit.drag.source?hit.drag.kind==='tab'?hit.position==='center'?'이 영역에 탭으로 이동':`탭을 ${labels[hit.position]}`:labels[hit.position]:`새 터미널 · ${labels[hit.position]}`;
    setPreview(previous=>previous?.target===target&&previous.position===hit.position&&previous.insertion?.id===hit.insertion?.id&&previous.insertion?.side===hit.insertion?.side?previous:{target,position:hit.position,label,insertion:hit.insertion});
  }
  function drop(target:string,event:DragEvent<HTMLElement>){
    event.preventDefault();const hit=accept(target,event);
    const valid=hit&&event.dataTransfer.getData(MIME)===hit.drag.token;cancel();
    if(!hit||!valid)return;
    const {drag,position,insertion}=hit;
    // Consume the session before scheduling: a duplicate drop cannot create a
    // second shell. Every asynchronous boundary rechecks the selected host.
    queue.current=queue.current.catch(()=>{}).then(async()=>{
      const refresh=async()=>{if(!same(drag))return;const next=await client.request<HostState>('state.get');if(same(drag)&&next.hostId===drag.hostId&&next.bootId===drag.bootId)onState(next);};
      try{
        if(!same(drag,drag.revision))return;
        const latest=await client.request<HostState>('state.get');
        if(!same(drag,drag.revision)||latest.hostId!==drag.hostId||latest.bootId!==drag.bootId)return;
        const current=latest.groups.find(item=>item.id===drag.groupId);
        if(!current?.layout||current.revision!==drag.revision||!leafIds(current.layout).includes(target))return;
        if(drag.source){
          const layout=insertion?moveTab(current.layout,drag.source,insertion):position==='tabs'?current.layout:(drag.kind==='tab'?dockTab:dockLeaf)(current.layout,drag.source,target,position);
          if(layout===current.layout)return;
          await client.request('groups.layout',{id:drag.groupId,revision:current.revision,layout});
          if(drag.kind==='tab'&&same(drag))onSelect(drag.source);
        }else if(position!=='tabs'){
          const created=await client.request<{id:string}>('terminals.create',{groupId:drag.groupId,splitTarget:target,axis:position==='top'||position==='bottom'?'vertical':'horizontal'});
          if(!same(drag))return;
          const next=await client.request<HostState>('state.get');
          if(!same(drag)||next.hostId!==drag.hostId||next.bootId!==drag.bootId)return;
          const nextGroup=next.groups.find(item=>item.id===drag.groupId);
          if(position==='left'||position==='top'){
            if(nextGroup?.layout&&nextGroup.revision===drag.revision+1&&leafIds(nextGroup.layout).includes(created.id)&&leafIds(nextGroup.layout).includes(target)){
              await client.request('groups.layout',{id:drag.groupId,revision:nextGroup.revision,layout:dockLeaf(nextGroup.layout,created.id,target,position)});
            }else onError('새 터미널은 열렸지만 배치가 바뀌어 요청한 위치로 옮기지 못했습니다. 다시 끌어 배치해 주세요.');
          }
          if(same(drag))onSelect(created.id);
        }
        await refresh();
      }catch(error){if(same(drag)){onError(error instanceof Error?error.message:'터미널 배치를 변경하지 못했습니다.');await refresh().catch(()=>{});}}
    });
  }
  function clickAllowed(){if(suppressClick.current){suppressClick.current=false;return false;}return true;}
  // A real subsequent pointer gesture is a fresh click, even after Escape.
  function pointerStart(){suppressClick.current=false;}
  return {enabled,dragging,preview,start,over,drop,cancel,clickAllowed,pointerStart};
}
