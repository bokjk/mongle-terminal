import { appendTab, findLeaf, leafIds, removeLeaf, type LayoutNode } from '../protocol/index';
export function updateRatio(node: LayoutNode, path: string, ratio: number): LayoutNode {
  if (node.type === 'leaf') return node;
  if (!path) return {...node,ratio: Math.min(.85, Math.max(.15, ratio))};
  return {...node, [path[0] === '0' ? 'first' : 'second']: updateRatio(path[0] === '0' ? node.first : node.second,path.slice(1),ratio)};
}
export function swapLeaves(node: LayoutNode, first: string, second: string): LayoutNode {
  const a=findLeaf(node,first),b=findLeaf(node,second);
  if (!a || !b || a===b) return node;
  const swap=(current:LayoutNode):LayoutNode=>current===a?b:current===b?a:current.type==='leaf'?current:{...current,first:swap(current.first),second:swap(current.second)};
  return swap(node);
}

export type PaneDropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type TabInsertion = {id:string;side:'before'|'after'};

/** Insert a live tab at an exact position, including inside its current region. */
export function moveTab(node:LayoutNode,source:string,insertion:TabInsertion):LayoutNode {
  const sourceLeaf=findLeaf(node,source),targetLeaf=findLeaf(node,insertion.id);
  if(!sourceLeaf||!targetLeaf||source===insertion.id)return node;
  const ids=leafIds(targetLeaf).filter(id=>id!==source),index=ids.indexOf(insertion.id);
  ids.splice(index+(insertion.side==='after'?1:0),0,source);
  if(ids.length>16||sourceLeaf===targetLeaf&&ids.every((id,i)=>id===leafIds(targetLeaf)[i]))return node;
  const remaining=removeLeaf(node,source);
  if(!remaining)return node;
  const insert=(current:LayoutNode):LayoutNode=>{
    if(current.type==='leaf')return leafIds(current).includes(insertion.id)?{type:'leaf',terminalId:ids[0],...(ids.length>1?{tabs:ids.slice(1)}:{})}:current;
    const first=insert(current.first),second=insert(current.second);
    return first===current.first&&second===current.second?current:{...current,first,second};
  };
  return insert(remaining);
}

/** Move a whole split region, including its tabs, without creating a shell. */
export function dockLeaf(node: LayoutNode, source: string, target: string, position: PaneDropPosition): LayoutNode {
  if (source === target) return node;
  const sourceLeaf=findLeaf(node,source),targetLeaf=findLeaf(node,target);
  if (!sourceLeaf || !targetLeaf || sourceLeaf===targetLeaf) return node;
  if (position === 'center') return swapLeaves(node, source, target);

  const remove = (current: LayoutNode): LayoutNode | null => {
    if (current.type === 'leaf') return current===sourceLeaf ? null : current;
    const first = remove(current.first), second = remove(current.second);
    if (!first || !second) return first || second;
    return first === current.first && second === current.second ? current : {...current, first, second};
  };
  const insert = (current: LayoutNode): LayoutNode => {
    if (current.type === 'leaf') {
      if (!leafIds(current).includes(target)) return current;
      const before = position === 'left' || position === 'top';
      return {type:'split', axis:position === 'left' || position === 'right' ? 'horizontal' : 'vertical', ratio:0.5,
        first:before ? sourceLeaf : current, second:before ? current : sourceLeaf};
    }
    const first = insert(current.first), second = insert(current.second);
    return first === current.first && second === current.second ? current : {...current, first, second};
  };
  // A distinct target exists, so removing the source cannot empty this tree.
  return insert(remove(node)!);
}

/** Move one existing session into a split or another region's tab list. */
export function dockTab(node: LayoutNode, source: string, target: string, position: PaneDropPosition): LayoutNode {
  const sourceLeaf=findLeaf(node,source),targetLeaf=findLeaf(node,target);
  if (!sourceLeaf || !targetLeaf) return node;
  const sameRegion=sourceLeaf===targetLeaf;
  if (sameRegion && (position==='center' || leafIds(sourceLeaf).length<2)) return node;
  const remaining=removeLeaf(node,source);
  if (!remaining) return node;
  // Removing the primary tab promotes a sibling. Target that surviving region
  // even when the pointer was over the very tab being detached.
  const targetId=sameRegion?leafIds(sourceLeaf).find(id=>id!==source)!:target;
  if (position==='center') return appendTab(remaining,targetId,source);
  const insert=(current:LayoutNode):LayoutNode=>{
    if (current.type==='leaf') {
      if (!leafIds(current).includes(targetId)) return current;
      const moved:LayoutNode={type:'leaf',terminalId:source},before=position==='left'||position==='top';
      return {type:'split',axis:position==='left'||position==='right'?'horizontal':'vertical',ratio:0.5,
        first:before?moved:current,second:before?current:moved};
    }
    const first=insert(current.first),second=insert(current.second);
    return first===current.first&&second===current.second?current:{...current,first,second};
  };
  return insert(remaining);
}

/** Central half is a center drop; outer quarters dock to their nearest normalized edge. */
export function paneDropPosition(xRatio: number, yRatio: number, allowCenter = true): PaneDropPosition {
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  const x = clamp(xRatio), y = clamp(yRatio);
  if (allowCenter && x >= 0.25 && x <= 0.75 && y >= 0.25 && y <= 0.75) return 'center';
  const edges = [['left', x], ['right', 1-x], ['top', y], ['bottom', 1-y]] as const;
  let closest: typeof edges[number] = edges[0];
  // Horizontal edges win exact corner ties. Tolerance avoids floating-point
  // flicker when coordinates such as 0.1 and 0.9 have nominally equal distances.
  for (const edge of edges) if (edge[1] < closest[1] - 1e-9) closest = edge;
  return closest[0];
}
export function transformInput(data: string, ctrl: boolean, alt: boolean, source?: 'touch-scroll'): string {
  // Touch scroll is already a complete mouse report, not a keyboard chord.
  if (source === 'touch-scroll') return data;
  if (ctrl && data.length === 1) { const code = data.toUpperCase().charCodeAt(0); if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64); else if (data === ' ') data = '\x00'; }
  return alt ? '\x1b' + data : data;
}
