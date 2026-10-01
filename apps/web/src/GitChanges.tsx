import { useEffect, useId, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, FileText, GitBranch, GitCompareArrows } from 'lucide-react';
import type { GitChange, GitListing, Transport } from '../../../packages/protocol/index';

export type GitKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'untracked' | 'conflicted';
const presentations: Record<GitKind, { marker: string; label: string }> = {
  modified: { marker: 'M', label: '수정됨' }, added: { marker: 'A', label: '추가됨' }, deleted: { marker: 'D', label: '삭제됨' },
  renamed: { marker: 'R', label: '이름 변경' }, copied: { marker: 'C', label: '복사됨' }, 'type-changed': { marker: 'T', label: '유형 변경' },
  untracked: { marker: '?', label: '새 파일 · 아직 Git에 추가하지 않음' }, conflicted: { marker: 'U', label: '충돌 · 해결 필요' },
};
export function gitKind(change: GitChange, area?: 'index' | 'worktree'): GitKind {
  if (change.conflicted) return 'conflicted';
  if (change.untracked && !area) return 'untracked';
  const code = area ? change[area] : change.worktree || change.index;
  return ({ A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed', M: 'modified' } as const)[code || 'M'];
}
export const gitLabel = (kind: GitKind) => presentations[kind].label;
export function GitMarker({ kind }: { kind: GitKind }) {
  return <span className={`git-marker git-status-${kind}`} aria-hidden="true">{presentations[kind].marker}</span>;
}

export function useGitListing(client: Transport, reference: { id: string; hostId: string; bootId: string; generation: string; root: string }, enabled: boolean, revision: number) {
  const [listing, setListing] = useState<GitListing>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true, pending = false;
    async function load() {
      if (pending || document.hidden) return;
      pending = true; setBusy(true);
      try {
        const result = await client.request<GitListing>('git.status', reference);
        if (active) { setListing(result); setError(''); }
      } catch (error) {
        if (active) { setListing(undefined); setError(error instanceof Error ? error.message : 'Git 상태를 읽지 못했습니다.'); }
      } finally { pending = false; if (active) setBusy(false); }
    }
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    const focus = () => void load();
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [client, reference, enabled, revision]);
  return { listing, error, busy };
}

export function GitChanges({ listing, error, selected, onFile, onRetry }: { listing?: GitListing; error: string; selected: string; onFile(change: GitChange): void; onRetry(): void }) {
  if (error) return <div className="file-message" role="alert">{error}<button className="button subtle" onClick={onRetry}>다시 시도</button></div>;
  if (!listing) return <p className="file-message" role="status">Git 상태를 확인하는 중…</p>;
  if (listing.state !== 'repository') return <div className="git-empty"><GitBranch size={26}/><strong>{listing.message}</strong><p>{listing.state === 'not-repository' ? 'Git으로 관리하는 프로젝트 폴더의 터미널을 선택하세요.' : '파일 보기에서는 폴더를 계속 탐색할 수 있습니다.'}</p></div>;
  const conflicts = listing.changes.filter(change => change.conflicted);
  const staged = listing.changes.filter(change => !change.conflicted && Boolean(change.index));
  const working = listing.changes.filter(change => !change.conflicted && Boolean(change.worktree));
  const untracked = listing.changes.filter(change => change.untracked);
  return <>
    <div className="git-repository"><GitBranch size={15}/><span title={listing.repositoryRoot}>{listing.detached ? '분리된 HEAD' : listing.branch || '이름 없는 브랜치'}</span><span className="git-count">{listing.changes.length}{listing.truncated && '+'}</span></div>
    {listing.changes.length === 0 ? <div className="git-empty"><CheckCircle2 size={28}/><strong>변경된 파일이 없습니다</strong><p>현재 터미널 폴더의 작업 내용이 Git과 일치합니다.</p></div> : <>
      {conflicts.length > 0 && <ChangeGroup name="충돌" changes={conflicts} selected={selected} onFile={onFile}/>}
      {staged.length > 0 && <ChangeGroup name="스테이징됨" area="index" changes={staged} selected={selected} onFile={onFile}/>}
      {working.length > 0 && <ChangeGroup name="작업 폴더 변경" area="worktree" changes={working} selected={selected} onFile={onFile}/>}
      {untracked.length > 0 && <ChangeGroup name="새 파일" changes={untracked} selected={selected} onFile={onFile}/>}
    </>}
    {listing.truncated && <p className="file-message">변경이 많아 처음 1,000개만 표시합니다. 더 작은 폴더에서 확인해 주세요.</p>}
    <p className="git-footnote">현재 폴더 기준 · 읽기 전용<br/>파일을 누르면 작업 폴더의 현재 내용을 봅니다.</p>
  </>;
}

function ChangeGroup({ name, changes, area, selected, onFile }: { name: string; changes: GitChange[]; area?: 'index' | 'worktree'; selected: string; onFile(change: GitChange): void }) {
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  return <section className="git-change-group" aria-label={name}>
    <button className="git-group-heading" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<strong>{name}</strong><span className="git-count">{changes.length}</span></button>
    <ul id={id} className="file-entries" hidden={!expanded}>{changes.map(change => {
      const kind = gitKind(change, area), filename = change.path.split('/').pop()!, directory = change.path.slice(0, -filename.length).replace(/\/$/, '');
      const description = `${gitLabel(kind)}${change.originalPath ? ` · ${change.originalPath} → ${change.path}` : ` · ${change.path}`}`;
      return <li key={change.path}><button className={`git-change-row git-status-${kind} ${selected.replace(/\\/g, '/') === change.path ? 'selected' : ''}`} title={description} aria-label={`${change.path} · ${gitLabel(kind)}`} onClick={() => onFile(change)}>
        {kind === 'renamed' ? <GitCompareArrows size={15}/> : <FileText size={15}/>}<span className="git-file-label"><span className="git-file-name">{filename}</span>{directory && <span className="git-file-directory">{directory}</span>}</span><GitMarker kind={kind}/>
      </button></li>;
    })}</ul>
  </section>;
}
