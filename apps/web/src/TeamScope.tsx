import { useState } from 'react';
import { ArrowRight, FolderOpen, FolderPlus, GitBranch, LoaderCircle, X } from 'lucide-react';
import { branchMoves, checkedFolders, type ScopeDraft } from './team-model';

/**
 * The folders a team works across: checked folders are given to every CLI, the start folder is where they open,
 * and the checked Git folders can be put on one branch before the team starts.
 */
export function TeamScopePicker({scope, loading, error, onChange, onToggle, onAdd, pickDirectory}: {
  scope?: ScopeDraft; loading: boolean; error: string;
  onChange(change: Partial<ScopeDraft>): void; onToggle(path: string): void;
  /** Resolves the folder and adds it, or rejects with the reason. */
  onAdd(path: string): Promise<void>;
  pickDirectory?(current?: string): Promise<string | null>;
}) {
  const [adding, setAdding] = useState<string>();
  const [addError, setAddError] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = scope ? checkedFolders(scope) : [];
  const git = chosen.filter(folder => folder.git);
  const start = scope?.folders.find(folder => folder.path === scope.start);
  async function add(path: string) {
    const value = path.trim();
    if (!value || busy) return;
    setBusy(true); setAddError('');
    try { await onAdd(value); setAdding(undefined); }
    catch (error) { setAddError(error instanceof Error ? error.message : '폴더를 추가하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function browse() {
    if (!pickDirectory) return;
    try { const picked = await pickDirectory(adding || scope?.start); if (picked) await add(picked); }
    catch (error) { setAddError(error instanceof Error ? error.message : '폴더를 고르지 못했습니다.'); }
  }
  return <fieldset className="team-scope">
    <legend className="field-label">작업 범위{scope && chosen.length > 0 && <span className="team-scope-count">폴더 {chosen.length}개{start ? ' · ' + start.name + '에서 시작' : ''}</span>}</legend>
    <p className="hint">팀이 함께 보고 고칠 폴더입니다. 구성원은 모두 시작 폴더에서 CLI를 켜고, 체크한 나머지 폴더도 함께 받습니다.</p>
    {loading && <p className="hint"><LoaderCircle size={13} className="spin"/> 이 그룹의 폴더를 확인하는 중…</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {scope && <div className="team-scope-list" role="group" aria-label="작업 범위 폴더">
      <div className="team-scope-head" aria-hidden="true"><span>폴더</span><span>지금 브랜치</span><span>시작</span></div>
      {scope.folders.map(folder => {
        const on = scope.checked.includes(folder.path), first = folder.path === scope.start;
        return <div key={folder.path} className={'team-scope-row' + (on ? ' on' : '')}>
          <label className="team-scope-folder"><input type="checkbox" aria-label={folder.name + ' (' + folder.path + ')'} checked={on} onChange={() => onToggle(folder.path)}/><span><strong>{folder.name}</strong><small title={folder.path}>{folder.path}</small></span></label>
          <span className="team-scope-branch">{folder.git
            ? <><span className="team-chip" title={folder.branch ? folder.name + '의 지금 브랜치' : '브랜치가 아닌 커밋을 보고 있습니다'}><GitBranch size={11} aria-hidden="true"/>{folder.branch ?? '분리된 HEAD'}</span>{folder.changes ? <span className="team-chip changes" title="저장하지 않은 변경">변경 {folder.changes}</span> : null}</>
            : <span className="hint">Git 아님</span>}</span>
          <label className="team-scope-start" title={on ? folder.name + '에서 CLI를 켭니다' : '체크한 폴더만 시작 폴더가 될 수 있습니다'}><input type="radio" name="team-scope-start" checked={first} disabled={!on} onChange={() => onChange({start: folder.path})}/><span className="sr-only">{folder.name}에서 시작</span></label>
        </div>;
      })}
      <div className="team-scope-add">{adding === undefined
        ? <button type="button" className="button subtle" onClick={() => { setAdding(''); setAddError(''); }}><FolderPlus size={14}/>폴더 추가</button>
        : <span className="team-scope-add-form">
            <input className="input" aria-label="추가할 폴더 경로" autoFocus value={adding} placeholder="예: D:\work\backend" onChange={event => setAdding(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add(adding); } if (event.key === 'Escape') { event.preventDefault(); setAdding(undefined); } }}/>
            {pickDirectory && <button type="button" className="button subtle" disabled={busy} onClick={() => void browse()}><FolderOpen size={14}/>찾아보기</button>}
            <button type="button" className="button" disabled={!adding.trim() || busy} onClick={() => void add(adding)}>{busy ? '확인하는 중…' : '추가'}</button>
            <button type="button" className="icon-button" aria-label="폴더 추가 취소" onClick={() => setAdding(undefined)}><X size={14}/></button>
          </span>}
        {addError && <span className="error-text" role="alert">{addError}</span>}
      </div>
    </div>}
    {scope && git.length > 0 && <div className="team-branch">
      <span className="field-label">브랜치</span>
      <div className="team-branch-mode" role="radiogroup" aria-label="브랜치">
        <button type="button" role="radio" aria-checked={!scope.align} onClick={() => onChange({align: false})}>지금 브랜치 그대로</button>
        <button type="button" role="radio" aria-checked={scope.align} onClick={() => onChange({align: true})}>모두 같은 브랜치로 맞추기</button>
      </div>
      {scope.align && <>
        <input className="input team-branch-name" aria-label="맞출 브랜치 이름" autoFocus={!scope.branch} value={scope.branch} maxLength={200} placeholder="예: feature/login" onChange={event => onChange({branch: event.target.value})}/>
        <p className="hint">체크한 Git 저장소 {git.length}곳을 이 브랜치로 맞춥니다. 없는 곳에는 새로 만들고, 있는 곳은 그 브랜치로 바꿉니다. 원래 폴더의 브랜치가 바뀌므로, 그 폴더에서 열어 둔 다른 터미널도 같은 브랜치를 보게 됩니다. 저장하지 않은 변경은 함께 옮겨집니다.</p>
        {scope.branch.trim() && <ul className="team-branch-moves" aria-label="브랜치 바꿀 내용">{branchMoves(scope).map(move => <li key={move.name}><strong>{move.name}</strong>{move.same ? <span className="hint">이미 {move.to}</span> : <><span className="team-chip">{move.from}</span><ArrowRight size={12} aria-hidden="true"/><span className="team-chip to">{move.to}</span></>}</li>)}</ul>}
      </>}
    </div>}
  </fieldset>;
}
