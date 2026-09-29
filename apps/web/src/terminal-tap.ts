/** A completed, single-pointer tap may start input; browsing gestures may not. */
export function attachTerminalTap(element:HTMLElement,hasSelection:()=>boolean,onTap:()=>void):()=>void {
  let gesture:{id:number;touch:boolean;x:number;y:number;started:number;valid:boolean;ended:boolean}|undefined;
  const pointers=new Set<number>();
  const down=(event:PointerEvent)=>{
    pointers.add(event.pointerId);
    if(pointers.size>1){if(gesture)gesture.valid=false;return;}
    if(!element.contains(event.target as Node))return;
    gesture={id:event.pointerId,touch:event.pointerType==='touch',x:event.clientX,y:event.clientY,started:performance.now(),valid:event.isPrimary&&event.button===0&&!hasSelection(),ended:false};
  };
  const move=(event:PointerEvent)=>{if(gesture?.id===event.pointerId&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>=6)gesture.valid=false;};
  const up=(event:PointerEvent)=>{
    move(event);pointers.delete(event.pointerId);
    if(gesture?.id===event.pointerId){gesture.ended=true;gesture.valid&&=performance.now()-gesture.started<500&&pointers.size===0;}
  };
  const cancel=(event:PointerEvent)=>{pointers.delete(event.pointerId);if(gesture)gesture.valid=false;};
  const invalidate=()=>{if(gesture)gesture.valid=false;};
  const mouseDown=(event:MouseEvent)=>{
    // xterm focuses its textarea on mousedown. Before control is acquired it
    // is read-only: defer that focus to the completed tap so mobile sees the
    // first editable focus within the same trusted click.
    if(event.button===0&&gesture?.touch&&gesture.valid&&gesture.ended&&element.querySelector<HTMLTextAreaElement>('textarea')?.readOnly){event.preventDefault();event.stopImmediatePropagation();}
  };
  const click=(event:MouseEvent)=>{
    const tapped=gesture?.valid&&gesture.ended&&!hasSelection();gesture=undefined;
    if(tapped&&event.button===0)onTap();
  };
  // Document tracking also rejects a second finger that starts outside the pane.
  document.addEventListener('pointerdown',down,true);
  document.addEventListener('pointermove',move,true);
  document.addEventListener('pointerup',up,true);
  document.addEventListener('pointercancel',cancel,true);
  element.addEventListener('contextmenu',invalidate,true);
  element.addEventListener('wheel',invalidate,{capture:true,passive:true});
  element.addEventListener('click',click,true);
  element.addEventListener('mousedown',mouseDown,true);
  return()=>{
    document.removeEventListener('pointerdown',down,true);
    document.removeEventListener('pointermove',move,true);
    document.removeEventListener('pointerup',up,true);
    document.removeEventListener('pointercancel',cancel,true);
    element.removeEventListener('contextmenu',invalidate,true);
    element.removeEventListener('wheel',invalidate,true);
    element.removeEventListener('click',click,true);
    element.removeEventListener('mousedown',mouseDown,true);
  };
}
