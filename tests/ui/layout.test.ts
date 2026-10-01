import assert from 'node:assert/strict';
import test from 'node:test';
import { appendTab, findLeaf, leafIds, removeLeaf, splitLeaf, type LayoutNode } from '../../packages/protocol/index.js';
import { dockLeaf, dockTab, paneDropPosition, swapLeaves, transformInput, updateRatio, type PaneDropPosition } from '../../packages/ui/layout.js';
const tree:LayoutNode={type:'split',axis:'horizontal',ratio:.5,first:{type:'leaf',terminalId:'a'},second:{type:'split',axis:'vertical',ratio:.4,first:{type:'leaf',terminalId:'b'},second:{type:'leaf',terminalId:'c'}}};
test('nested resize preserves every terminal and parent ratio; clamps unusable sizes',()=>{const changed=updateRatio(tree,'1',.99);assert.deepEqual(leafIds(changed),['a','b','c']);assert.equal(changed.type==='split'&&changed.ratio,.5);assert.equal(changed.type==='split'&&changed.second.type==='split'&&changed.second.ratio,.85);assert.equal(tree.second.type==='split'&&tree.second.ratio,.4);});
test('swapping distant leaves preserves split topology and all sessions',()=>{const changed=swapLeaves(tree,'a','c');assert.deepEqual(leafIds(changed),['c','b','a']);assert.equal(changed.type==='split'&&changed.second.type==='split'&&changed.second.axis,'vertical');assert.deepEqual(leafIds(tree),['a','b','c']);});
test('mobile Ctrl and Alt encode terminal bytes without mangling Korean input',()=>{assert.equal(transformInput('c',true,false),'\x03');assert.equal(transformInput('[',true,false),'\x1b');assert.equal(transformInput('x',false,true),'\x1bx');assert.equal(transformInput('몽글',true,false),'몽글');assert.equal(transformInput('\x1b[A',false,false),'\x1b[A');});

test('tabs stay inside their region when splitting, resizing, docking and swapping',()=>{
  const tabs=appendTab(appendTab(tree,'a','a2'),'c','c2');
  assert.deepEqual(findLeaf(tabs,'a2'),{type:'leaf',terminalId:'a',tabs:['a2']});
  for(const position of ['left','right','top','bottom','center'] as const){
    const moved=dockLeaf(tabs,'a2','c2',position);
    assert.deepEqual(findLeaf(moved,'a'),findLeaf(tabs,'a'));
    assert.deepEqual(findLeaf(moved,'c'),findLeaf(tabs,'c'));
    assert.deepEqual(leafIds(moved).sort(),['a','a2','b','c','c2']);
  }
  assert.equal(dockLeaf(tabs,'a','a2','center'),tabs);
  const split=splitLeaf(tabs,'a2','d','vertical');
  assert.deepEqual(findLeaf(split,'a2'),findLeaf(tabs,'a'));
  assert.deepEqual(leafIds(split),['a','a2','d','b','c','c2']);
  assert.deepEqual(findLeaf(updateRatio(tabs,'',.35),'a2'),findLeaf(tabs,'a'));
});

test('closing a tab promotes another in the same region; only its last tab collapses a split',()=>{
  const tabs=appendTab(appendTab(tree,'a','a2'),'a2','a3');
  const promoted=removeLeaf(tabs,'a')!;
  assert.deepEqual(findLeaf(promoted,'a3'),{type:'leaf',terminalId:'a2',tabs:['a3']});
  assert.equal(promoted.type==='split'&&promoted.ratio,.5);
  assert.deepEqual(findLeaf(removeLeaf(promoted,'a2'),'a3'),{type:'leaf',terminalId:'a3'});
  assert.deepEqual(removeLeaf(removeLeaf(promoted,'a2'),'a3'),tree.second);
  assert.deepEqual(removeLeaf(tabs,'a2')?.type==='split'&&findLeaf(removeLeaf(tabs,'a2'),'a'),{type:'leaf',terminalId:'a',tabs:['a3']});
});

test('each tab can split off at every edge of its own region, including the primary tab',()=>{
  const tabs=appendTab(appendTab(tree,'a','a2'),'a','a3');
  const original=structuredClone(tabs);
  for(const source of ['a','a2','a3']) for(const target of ['a','a2','a3']) for(const position of ['left','right','top','bottom'] as const){
    const changed=dockTab(tabs,source,target,position);
    assert.equal(changed.type,'split');if(changed.type!=='split')throw new Error('Expected original outer split');
    assert.equal(changed.ratio,tree.ratio);assert.deepEqual(changed.second,tree.second);
    assert.equal(changed.first.type,'split');if(changed.first.type!=='split')throw new Error('Expected a new split inside the source region');
    const rest=['a','a2','a3'].filter(id=>id!==source),remaining={type:'leaf',terminalId:rest[0],tabs:rest.slice(1)};
    assert.equal(changed.first.axis,position==='left'||position==='right'?'horizontal':'vertical');assert.equal(changed.first.ratio,.5);
    assert.deepEqual(changed.first.first,position==='left'||position==='top'?{type:'leaf',terminalId:source}:remaining);
    assert.deepEqual(changed.first.second,position==='left'||position==='top'?remaining:{type:'leaf',terminalId:source});
    assert.deepEqual(leafIds(changed).sort(),['a','a2','a3','b','c']);
  }
  assert.deepEqual(tabs,original);
});

test('tab edge drops move only one session and collapse a region when its final tab moves',()=>{
  const tabs=appendTab(appendTab(tree,'a','a2'),'c','c2');
  const changed=dockTab(tabs,'a','c2','bottom');
  assert.deepEqual(findLeaf(changed,'a2'),{type:'leaf',terminalId:'a2'});
  assert.deepEqual(findLeaf(changed,'a'),{type:'leaf',terminalId:'a'});
  assert.deepEqual(findLeaf(changed,'c2'),findLeaf(tabs,'c2'));
  assert.equal(changed.type==='split'&&changed.ratio,.5);
  const moved=dockTab(tree,'a','c','left');
  assert.deepEqual(moved,{type:'split',axis:'vertical',ratio:.4,first:{type:'leaf',terminalId:'b'},second:{type:'split',axis:'horizontal',ratio:.5,first:{type:'leaf',terminalId:'a'},second:{type:'leaf',terminalId:'c'}}});
});

test('tab center drops merge into the target; self-center, a lone self-tab and missing ids do nothing',()=>{
  const tabs=appendTab(appendTab(tree,'a','a2'),'c','c2');
  const merged=dockTab(tabs,'a','c2','center');
  assert.deepEqual(findLeaf(merged,'a2'),{type:'leaf',terminalId:'a2'});
  assert.deepEqual(findLeaf(merged,'a'),{type:'leaf',terminalId:'c',tabs:['c2','a']});
  assert.equal(merged.type==='split'&&merged.second.type==='split'&&merged.second.ratio,.4);
  const collapsed=dockTab(tree,'a','b','center');
  assert.deepEqual(collapsed,{type:'split',axis:'vertical',ratio:.4,first:{type:'leaf',terminalId:'b',tabs:['a']},second:{type:'leaf',terminalId:'c'}});
  assert.equal(dockTab(tabs,'a','a2','center'),tabs);
  for(const position of ['left','right','top','bottom','center'] as const){
    assert.equal(dockTab(tree,'b','b',position),tree);
    assert.equal(dockTab(tabs,'missing','c',position),tabs);assert.equal(dockTab(tabs,'a','missing',position),tabs);
  }
});

test('all tab placements preserve membership exactly once without mutating nested layouts',()=>{
  const nested:LayoutNode={type:'split',axis:'vertical',ratio:.3,first:appendTab(tree,'a','a2'),second:{type:'split',axis:'horizontal',ratio:.7,first:{type:'leaf',terminalId:'d',tabs:['d2','d3']},second:{type:'leaf',terminalId:'e'}}};
  const before=structuredClone(nested),ids=leafIds(nested).sort();
  const freeze=(node:LayoutNode)=>{Object.freeze(node);if(node.type==='split'){freeze(node.first);freeze(node.second);}else if(node.tabs)Object.freeze(node.tabs);};freeze(nested);
  for(const source of ids)for(const target of ids)for(const position of ['left','right','top','bottom','center'] as const){
    const changed=dockTab(nested,source,target,position);
    assert.deepEqual(leafIds(changed).sort(),ids,`${source} -> ${target}: ${position}`);
    assert.equal(leafIds(findLeaf(changed,source)!).includes(source),true);
  }
  assert.deepEqual(nested,before);
});

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
