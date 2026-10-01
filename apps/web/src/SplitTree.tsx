import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { leafIds, type LayoutLeaf, type LayoutNode } from '../../../packages/protocol/index';

type Length={percent:number;pixels:number};
type Rectangle={x:Length;y:Length;width:Length;height:Length};
type Divider={path:string;axis:'horizontal'|'vertical';ratio:number;bounds:Rectangle;rect:Rectangle};
const zero={percent:0,pixels:0},full={percent:100,pixels:0};
const add=(a:Length,b:Length):Length=>({percent:a.percent+b.percent,pixels:a.pixels+b.pixels});
const scale=(a:Length,ratio:number):Length=>({percent:a.percent*ratio,pixels:a.pixels*ratio});
const css=(value:Length)=>`calc(${value.percent}% + ${value.pixels}px)`;
const style=(rect:Rectangle):CSSProperties=>({left:css(rect.x),top:css(rect.y),width:css(rect.width),height:css(rect.height)});
const measure=(value:Length,extent:number)=>extent*value.percent/100+value.pixels;

/** Stable sibling slots keep each live terminal mounted when the tree changes. */
export function SplitTree({node,renderPane,onRatio,focusedId,selectedTab}:{node:LayoutNode;renderPane:(id:string,leaf:LayoutLeaf,visible:boolean)=>ReactNode;onRatio:(path:string,ratio:number)=>void;focusedId?:string;selectedTab:(leaf:LayoutLeaf)=>string}){
  const box=useRef<HTMLDivElement>(null);
  const paneOrder=useRef<string[]>([]);
  const [drag,setDrag]=useState<{path:string;ratio:number}>();
  const active=useRef<{path:string;ratio:number} | undefined>(undefined);
  const layoutSignature=JSON.stringify(node);
  useEffect(()=>{active.current=undefined;setDrag(undefined);},[layoutSignature]);
  const panes:Array<{id:string;leaf:LayoutLeaf;rect:Rectangle;visible:boolean}>=[],dividers:Divider[]=[];
  function visit(item:LayoutNode,rect:Rectangle,path=''){
    if(item.type==='leaf'){for(const id of leafIds(item))panes.push({id,leaf:item,rect,visible:id===selectedTab(item)&&(!focusedId||leafIds(item).includes(focusedId))});return;}
    const ratio=drag?.path===path?drag.ratio:item.ratio;
    const horizontal=item.axis==='horizontal',length=horizontal?rect.width:rect.height;
    const first=scale(add(length,{percent:0,pixels:-9}),ratio);
    const next=add(first,{percent:0,pixels:9});
    const last=scale(add(length,{percent:0,pixels:-9}),1-ratio);
    dividers.push({path,axis:item.axis,ratio,bounds:rect,rect:horizontal?{...rect,x:add(rect.x,first),width:{percent:0,pixels:9}}:{...rect,y:add(rect.y,first),height:{percent:0,pixels:9}}});
    visit(item.first,horizontal?{...rect,width:first}:{...rect,height:first},path+'0');
    visit(item.second,horizontal?{...rect,x:add(rect.x,next),width:last}:{...rect,y:add(rect.y,next),height:last},path+'1');
  }
  visit(node,{x:zero,y:zero,width:full,height:full});
  const liveIds=new Set(panes.map(pane=>pane.id));
  paneOrder.current=paneOrder.current.filter(id=>liveIds.has(id));
  for(const pane of panes)if(!paneOrder.current.includes(pane.id))paneOrder.current.push(pane.id);
  panes.sort((a,b)=>paneOrder.current.indexOf(a.id)-paneOrder.current.indexOf(b.id));
  return <div ref={box} className={`split-tree split-flat ${focusedId?'focused':''}`}>
    {panes.map(pane=><div key={pane.id} className="split-child split-pane-slot" hidden={!pane.visible} style={style(focusedId?{x:zero,y:zero,width:full,height:full}:pane.rect)}>{renderPane(pane.id,pane.leaf,pane.visible)}</div>)}
    {dividers.map(divider=><div key={`divider:${divider.path}`} role="separator" aria-label={divider.axis==='horizontal'?'좌우 분할 크기':'상하 분할 크기'} aria-orientation={divider.axis==='horizontal'?'vertical':'horizontal'} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(divider.ratio*100)} tabIndex={0} className={`split-divider ${divider.axis==='vertical'?'split-divider-horizontal':''}`} style={style(divider.rect)} title="끌어서 크기 조절 · 두 번 클릭하면 반반" onDoubleClick={()=>onRatio(divider.path,.5)} onKeyDown={event=>{if(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Home'].includes(event.key)){event.preventDefault();onRatio(divider.path,event.key==='Home'?.5:divider.ratio+(['ArrowLeft','ArrowUp'].includes(event.key)?-.05:.05));}}} onPointerDown={event=>{if(event.button!==0)return;active.current={path:divider.path,ratio:divider.ratio};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{
      if(active.current?.path!==divider.path||!box.current)return;
      const bounds=box.current.getBoundingClientRect(),horizontal=divider.axis==='horizontal';
      const origin=horizontal?measure(divider.bounds.x,bounds.width):measure(divider.bounds.y,bounds.height);
      const extent=horizontal?measure(divider.bounds.width,bounds.width):measure(divider.bounds.height,bounds.height);
      const pointer=horizontal?event.clientX-bounds.left:event.clientY-bounds.top;
      const ratio=Math.max(.15,Math.min(.85,(pointer-origin-4.5)/Math.max(1,extent-9)));
      active.current={path:divider.path,ratio};setDrag({path:divider.path,ratio});
    }} onPointerUp={event=>{
      const value=active.current;if(value?.path!==divider.path)return;active.current=undefined;
      if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
      if(Math.abs(value.ratio-divider.ratio)>.001||drag)onRatio(divider.path,value.ratio);setDrag(undefined);
    }} onPointerCancel={()=>{active.current=undefined;setDrag(undefined);}} onLostPointerCapture={()=>{active.current=undefined;setDrag(undefined);}}/>)}
  </div>;
}
