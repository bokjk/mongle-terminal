import { findLeaf, leafIds, type LayoutNode } from '../protocol/index';
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

/** Central half swaps panes; outer quarters dock to their nearest normalized edge. */
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
export function transformInput(data: string, ctrl: boolean, alt: boolean): string {
  if (ctrl && data.length === 1) { const code = data.toUpperCase().charCodeAt(0); if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64); else if (data === ' ') data = '\x00'; }
  return alt ? '\x1b' + data : data;
}
