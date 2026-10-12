import { useRef } from 'react';
import { ArrowDown, ArrowUp, Minus, Plus, RotateCcw } from 'lucide-react';
import { KeyCap } from './KeyBar';
import { addKeyBarItem, DEFAULT_KEY_BAR, isDefaultKeyBar, KEY_BAR_KEYS, KEY_BAR_MAX, keyBarKey, moveKeyBarItem, removeKeyBarItem } from './key-bar';

const GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: '제어 키', ids: ['esc', 'tab', 'shift-tab', 'ctrl', 'alt', 'ctrl-c', 'ctrl-d', 'ctrl-z', 'ctrl-l', 'ctrl-r', 'enter'] },
  { title: '이동 키', ids: ['left', 'down', 'up', 'right', 'home', 'end', 'page-up', 'page-down'] },
  { title: '기호', ids: ['pipe', 'tilde', 'slash', 'backslash', 'dash'] },
];
// Every key belongs to exactly one group; a key added to the catalog without a group would never be offered.
for (const key of KEY_BAR_KEYS) if (!GROUPS.some(group => group.ids.includes(key.id))) throw new Error(`key bar group missing ${key.id}`);

/** Settings → 화면: which keys the phone key bar shows, in what order. Changes apply at once and stay on this device. */
export function KeyBarSettings({ ids, onChange }: { ids: readonly string[]; onChange(ids: string[]): void }) {
  const root = useRef<HTMLDivElement>(null);
  const full = ids.length >= KEY_BAR_MAX;
  const name = (id: string) => keyBarKey(id)?.name ?? id;
  // Rows move or leave the list after a press; keep keyboard and screen reader users where they were.
  const change = (next: string[], ...targets: string[]) => {
    onChange(next);
    requestAnimationFrame(() => { for (const target of targets) { const button = root.current?.querySelector<HTMLButtonElement>(target); if (button && !button.disabled) { button.focus(); return; } } });
  };
  const row = (id: string) => `[data-key="${id}"]`;
  return <div className="settings-section key-bar-settings" ref={root}>
    <h3 className="settings-title">모바일 보조 키</h3>
    <p className="settings-description">휴대폰에서 키보드 위에 보이는 키를 고르고 순서를 정합니다. 이 기기에 저장되며 바로 적용됩니다. 키보드 열기 버튼은 항상 맨 오른쪽에 있습니다.</p>
    <div className="key-bar-preview" aria-label="보조 키 미리 보기">{ids.map(id => <span key={id} className="key-button"><KeyCap id={id}/></span>)}{ids.length === 0 && <span className="hint">키를 추가해 주세요.</span>}</div>
    <h4 className="key-bar-heading">사용 중 <span className="hint">{ids.length}/{KEY_BAR_MAX}</span></h4>
    <ol className="key-bar-list" aria-label="사용 중인 보조 키">{ids.map((id, index) => <li key={id} className="key-bar-row" data-key={id}>
      <button type="button" className="icon-button key-bar-remove" aria-label={`${name(id)} 빼기`} onClick={() => { const next = removeKeyBarItem(ids, id); change(next, `${row(next[index] ?? next.at(-1) ?? '')} .key-bar-remove`, `.key-bar-add[data-add="${id}"]`); }}><Minus size={16}/></button>
      <span className="key-bar-cap"><KeyCap id={id}/></span><span className="key-bar-name">{name(id)}</span>
      <button type="button" className="icon-button" data-move="-1" aria-label={`${name(id)} 앞으로`} disabled={index === 0} onClick={() => change(moveKeyBarItem(ids, id, -1), `${row(id)} [data-move="-1"]`, `${row(id)} [data-move="1"]`)}><ArrowUp size={16}/></button>
      <button type="button" className="icon-button" data-move="1" aria-label={`${name(id)} 뒤로`} disabled={index === ids.length - 1} onClick={() => change(moveKeyBarItem(ids, id, 1), `${row(id)} [data-move="1"]`, `${row(id)} [data-move="-1"]`)}><ArrowDown size={16}/></button>
    </li>)}</ol>
    {GROUPS.map(group => {
      const available = group.ids.filter(id => !ids.includes(id));
      if (!available.length) return null;
      return <div key={group.title}>
        <h4 className="key-bar-heading">{group.title} 추가</h4>
        <ul className="key-bar-list" aria-label={`추가할 수 있는 ${group.title}`}>{available.map(id => <li key={id} className="key-bar-row">
          <button type="button" className="icon-button key-bar-add" data-add={id} aria-label={`${name(id)} 추가`} disabled={full} onClick={() => change(addKeyBarItem(ids, id), `${row(id)} .key-bar-remove`)}><Plus size={16}/></button>
          <span className="key-bar-cap"><KeyCap id={id}/></span><span className="key-bar-name">{name(id)}</span>
        </li>)}</ul>
      </div>;
    })}
    {full && <p className="hint">최대 {KEY_BAR_MAX}개까지 넣을 수 있습니다. 키를 빼면 다시 추가할 수 있습니다.</p>}
    <p className="hint">키가 많으면 보조 키 줄을 옆으로 밀어서 봅니다.</p>
    <div className="form-row"><button type="button" className="button subtle" disabled={isDefaultKeyBar(ids)} onClick={() => onChange([...DEFAULT_KEY_BAR])}><RotateCcw size={15}/>기본값으로 되돌리기</button></div>
  </div>;
}
