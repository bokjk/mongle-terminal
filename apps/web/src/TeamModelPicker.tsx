import { useId, useState } from 'react';
import { List } from 'lucide-react';
import type { TeamModel } from '../../../packages/protocol/index';

/** The menu entry that switches the cell to typing; no model id can look like it. */
export const CUSTOM_MODEL = '__custom__';

/**
 * A member's model: the CLI's own list (Codex's catalog, Claude Code's aliases) with the CLI default first and
 * "직접 입력…" last for any other name. Without a list (an older host, or a CLI that could not say), it is a
 * box with suggestions.
 */
export function TeamModelPicker({name, model, models, suggestions, onChange}: {name: string; model: string; models?: TeamModel[]; suggestions: string[]; onChange(model: string): void}) {
  const [typing, setTyping] = useState(false);
  const listId = useId();
  // With a list, the list button sits inside the box and replaces the suggestions, so a typed name has the whole cell.
  const listed = !!models?.length;
  if (!listed || typing) return <span className={'team-model-custom' + (listed ? ' with-list' : '')}>
    <input className="input" aria-label={name + ' 모델'} list={listed ? undefined : listId} value={model} maxLength={80} placeholder="도구 기본값" autoFocus={typing} onFocus={event => event.currentTarget.select()} onChange={event => onChange(event.target.value.trim())}/>
    {listed ? <button type="button" className="icon-button" aria-label={name + ' 모델을 목록에서 고르기'} title="목록에서 고르기" onClick={() => setTyping(false)}><List size={13}/></button> : <datalist id={listId}>{suggestions.map(item => <option key={item} value={item}/>)}</datalist>}
  </span>;
  const known = models.some(item => item.id === model);
  return <select className="select" aria-label={name + ' 모델'} value={model} title={models.find(item => item.id === model)?.description} onChange={event => { if (event.target.value === CUSTOM_MODEL) setTyping(true); else onChange(event.target.value); }}>
    <option value="">도구 기본값</option>
    {models.map(item => <option key={item.id} value={item.id} title={item.description}>{item.label}</option>)}
    {model && !known && <option value={model}>{model}</option>}
    <option value={CUSTOM_MODEL}>직접 입력…</option>
  </select>;
}
