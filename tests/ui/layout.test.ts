import assert from 'node:assert/strict';
import test from 'node:test';
import { leafIds, type LayoutNode } from '../../packages/protocol/index.js';
import { dockLeaf, paneDropPosition, swapLeaves, transformInput, updateRatio, type PaneDropPosition } from '../../packages/ui/layout.js';
const tree:LayoutNode={type:'split',axis:'horizontal',ratio:.5,first:{type:'leaf',terminalId:'a'},second:{type:'split',axis:'vertical',ratio:.4,first:{type:'leaf',terminalId:'b'},second:{type:'leaf',terminalId:'c'}}};
test('nested resize preserves every terminal and parent ratio; clamps unusable sizes',()=>{const changed=updateRatio(tree,'1',.99);assert.deepEqual(leafIds(changed),['a','b','c']);assert.equal(changed.type==='split'&&changed.ratio,.5);assert.equal(changed.type==='split'&&changed.second.type==='split'&&changed.second.ratio,.85);assert.equal(tree.second.type==='split'&&tree.second.ratio,.4);});
test('swapping distant leaves preserves split topology and all sessions',()=>{const changed=swapLeaves(tree,'a','c');assert.deepEqual(leafIds(changed),['c','b','a']);assert.equal(changed.type==='split'&&changed.second.type==='split'&&changed.second.axis,'vertical');assert.deepEqual(leafIds(tree),['a','b','c']);});
test('mobile Ctrl and Alt encode terminal bytes without mangling Korean input',()=>{assert.equal(transformInput('c',true,false),'\x03');assert.equal(transformInput('[',true,false),'\x1b');assert.equal(transformInput('x',false,true),'\x1bx');assert.equal(transformInput('몽글',true,false),'몽글');assert.equal(transformInput('\x1b[A',false,false),'\x1b[A');});

test('docking each edge replaces the target with an equal split and collapses the old parent',()=>{
  const original = structuredClone(tree);
  const cases: Array<[PaneDropPosition,'horizontal'|'vertical',string[]]> = [
    ['left','horizontal',['a','c']], ['right','horizontal',['c','a']],
    ['top','vertical',['a','c']], ['bottom','vertical',['c','a']],
  ];
  for (const [position,axis,order] of cases) {
    const changed = dockLeaf(tree,'a','c',position);
    assert.equal(changed.type,'split');
    if (changed.type !== 'split') throw new Error('Expected the surviving b/c branch');
    assert.equal(changed.axis,'vertical');assert.equal(changed.ratio,0.4);
    assert.deepEqual(changed.first,{type:'leaf',terminalId:'b'});
    assert.equal(changed.second.type,'split');
    if (changed.second.type !== 'split') throw new Error('Expected a new target split');
    assert.equal(changed.second.axis,axis);assert.equal(changed.second.ratio,0.5);
    assert.deepEqual(leafIds(changed.second),order);
    assert.deepEqual(leafIds(changed).sort(),['a','b','c']);
  }
  assert.deepEqual(tree,original);
});

test('sibling docking changes only that branch, center swaps, and invalid targets are identity no-ops',()=>{
  const changed = dockLeaf(tree,'b','c','right');
  assert.equal(changed.type,'split');
  if (changed.type !== 'split') throw new Error('Expected a root split');
  assert.equal(changed.first,tree.first);assert.equal(changed.ratio,tree.ratio);
  assert.deepEqual(changed.second,{type:'split',axis:'horizontal',ratio:0.5,first:{type:'leaf',terminalId:'c'},second:{type:'leaf',terminalId:'b'}});
  assert.deepEqual(dockLeaf(tree,'a','c','center'),swapLeaves(tree,'a','c'));
  assert.equal(dockLeaf(tree,'a','a','top'),tree);
  assert.equal(dockLeaf(tree,'missing','b','left'),tree);
  assert.equal(dockLeaf(tree,'b','missing','center'),tree);
});

test('all source/target placements in a nested tree preserve each session once and leave input immutable',()=>{
  const nested: LayoutNode={type:'split',axis:'vertical',ratio:0.3,first:tree,second:{type:'split',axis:'horizontal',ratio:0.7,first:{type:'leaf',terminalId:'d'},second:{type:'leaf',terminalId:'e'}}};
  const before=structuredClone(nested),ids=leafIds(nested).sort();
  const freeze=(node:LayoutNode)=>{Object.freeze(node);if(node.type==='split'){freeze(node.first);freeze(node.second);}};
  freeze(nested);
  for (const source of ids) for (const target of ids) for (const position of ['left','right','top','bottom','center'] as const) {
    const changed=dockLeaf(nested,source,target,position);
    assert.deepEqual(leafIds(changed).sort(),ids,`${source} -> ${target}: ${position}`);
  }
  const changed=dockLeaf(nested,'a','c','bottom');
  assert.equal(changed.type==='split'&&changed.second,nested.second);
  assert.equal(changed.type==='split'&&changed.ratio,0.3);
  assert.deepEqual(nested,before);
});

test('pane drop zones have a stable center, nearest edge, and deterministic corner ties',()=>{
  assert.equal(paneDropPosition(0.5,0.5),'center');
  assert.equal(paneDropPosition(0.25,0.75),'center');
  assert.equal(paneDropPosition(0.1,0.5),'left');
  assert.equal(paneDropPosition(0.9,0.5),'right');
  assert.equal(paneDropPosition(0.5,0.1),'top');
  assert.equal(paneDropPosition(0.5,0.9),'bottom');
  assert.equal(paneDropPosition(0.1,0.9),'left');
  assert.equal(paneDropPosition(0.9,0.1),'right');
  assert.equal(paneDropPosition(0.5,0.5,false),'left');
  assert.equal(paneDropPosition(-1,0.4),'left');
  assert.equal(paneDropPosition(0.6,2),'bottom');
});
