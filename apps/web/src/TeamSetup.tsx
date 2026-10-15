import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Crown, LoaderCircle, Plus, RotateCcw, Star, Users, X, XCircle } from 'lucide-react';
import type { Group, HostState, Team, TeamCheck, TeamScopeFolder, TeamTemplate } from '../../../packages/protocol/index';
import { Modal } from './Modal';
import { addMember, addScopeFolder, DEFAULT_TEMPLATE_KEY, draftsFrom, makeLead, modelSuggestions, removeMember, renameMember, ROLE_DEFAULTS, ROLES, scopeDraft, scopeProblems, specsFrom, TEAM_MAX_MEMBERS, teamProblems, toggleScopeFolder, withRole, type MemberDraft, type ScopeDraft } from './team-model';
import { TeamScopePicker } from './TeamScope';

type Request = <T = unknown>(method: string, params?: unknown) => Promise<T>;
const message = (error: unknown) => error instanceof Error ? error.message : '요청을 완료하지 못했습니다.';
function storedDefault(): string { try { return JSON.parse(localStorage.getItem(DEFAULT_TEMPLATE_KEY) || 'null') || ''; } catch { return ''; } }

/**
 * Starting work with an AI team: pick a template, adjust its members, then a pre-start check that must
 * pass before the team starts. The team works across the folders chosen in its scope (older hosts: the group's folder).
 */
export function TeamSetup({state, groupId, request, onClose, onStarted, pickDirectory}: {state: HostState; groupId: string; request: Request; onClose(): void; onStarted(team: Team): void; pickDirectory?(current?: string): Promise<string | null>}) {
  const groups = state.groups;
  const [target, setTarget] = useState(groups.some(group => group.id === groupId) ? groupId : groups[0]?.id ?? '');
  const group: Group | undefined = groups.find(item => item.id === target);
  const [templates, setTemplates] = useState<TeamTemplate[]>();
  const [templateId, setTemplateId] = useState('');
  const [defaultId, setDefaultId] = useState(storedDefault);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [members, setMembers] = useState<MemberDraft[]>([]);
  const [open, setOpen] = useState<string>();
  const [step, setStep] = useState<'compose' | 'check'>('compose');
  const [check, setCheck] = useState<{ready: boolean; checks: TeamCheck[]}>();
  const [busy, setBusy] = useState<'' | 'check' | 'start' | 'save'>('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string>();
  const host = {hostId: state.hostId, bootId: state.bootId};
  const scopeSupported = state.capabilities?.includes('agent.teams.scope') === true;
  const [scope, setScope] = useState<ScopeDraft>();
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeError, setScopeError] = useState('');
  useEffect(() => {
    if (!scopeSupported || !target) return;
    let alive = true;
    setScope(undefined); setScopeError(''); setScopeLoading(true);
    request<{folders: TeamScopeFolder[]}>('teams.scope', {...host, groupId: target})
      .then(result => { if (alive) setScope(scopeDraft(result.folders)); })
      .catch(error => { if (alive) setScopeError(message(error)); })
      .finally(() => { if (alive) setScopeLoading(false); });
    return () => { alive = false; };
  }, [target]);
  const changeScope = (change: Partial<ScopeDraft>) => { setCheck(undefined); setScope(value => value && {...value, ...change}); };
  async function addFolder(path: string) {
    const [folder] = (await request<{folders: TeamScopeFolder[]}>('teams.scope', {...host, groupId: target, paths: [path]})).folders;
    if (folder) { setCheck(undefined); setScope(value => value && addScopeFolder(value, folder)); }
  }
  /** Several folders share one working copy each; members then all work in them, never in their own worktree. */
  const shared = (scope?.checked.length ?? 0) > 1;

  function choose(template: TeamTemplate) {
    setTemplateId(template.id); setMembers(draftsFrom(template.members)); setOpen(undefined); setCheck(undefined);
    if (!nameEdited) setName(template.name.slice(0, 30));
  }
  useEffect(() => {
    let alive = true;
    request<TeamTemplate[]>('teams.templates').then(list => {
      if (!alive) return;
      setTemplates(list);
      const first = list.find(item => item.id === defaultId) ?? list[0];
      if (first) choose(first);
    }).catch(error => { if (alive) setError(message(error)); });
    return () => { alive = false; };
  }, []);
  function toggleDefault(id: string) {
    const next = defaultId === id ? '' : id;
    setDefaultId(next);
    try { localStorage.setItem(DEFAULT_TEMPLATE_KEY, JSON.stringify(next)); } catch { /* only a preference */ }
  }
  const edit = (index: number, change: Partial<MemberDraft>) => { setCheck(undefined); setMembers(list => list.map((item, at) => at === index ? {...item, ...change} : item)); };
  const specs = useMemo(() => specsFrom(members), [members]);
  const problems = useMemo(() => [...teamProblems(name, specs), ...(scope ? scopeProblems(scope) : [])], [name, specs, scope]);
  /** The scope must be loaded before a newer host can check it. */
  const scopeWaiting = scopeSupported && !scope;
  const worktrees = !shared && members.some(member => member.folder === 'worktree');
  const selected = templates?.find(item => item.id === templateId);
  const payload = () => scope
    ? {...host, groupId: target, name: name.trim(), cwd: scope.start, members: shared ? specs.map(member => ({...member, folder: 'base' as const})) : specs, scope: {start: scope.start, folders: scope.checked, ...(scope.align && scope.branch.trim() ? {branch: scope.branch.trim()} : {})}}
    : {...host, groupId: target, name: name.trim(), cwd: group?.cwd ?? '', members: specs};

  async function runCheck() {
    if (!group || problems.length || scopeWaiting || busy) return;
    setBusy('check'); setError(''); setStep('check');
    try { setCheck(await request<{ready: boolean; checks: TeamCheck[]}>('teams.check', payload())); }
    catch (error) { setCheck(undefined); setError(message(error)); }
    finally { setBusy(''); }
  }
  async function start() {
    if (!check?.ready || busy) return;
    setBusy('start'); setError('');
    try { onStarted(await request<Team>('teams.start', payload())); }
    catch (error) { setError(message(error)); setBusy(''); }
  }
  async function saveTemplate() {
    const title = (saving ?? '').trim();
    if (!title || busy) return;
    setBusy('save'); setError('');
    try {
      const mine = selected && !selected.builtIn && selected.name === title ? selected.id : undefined;
      const saved = await request<TeamTemplate>('teams.templates.save', {...(mine ? {id: mine} : {}), name: title, members: specs});
      setTemplates(list => mine ? list?.map(item => item.id === mine ? saved : item) : [...(list ?? []), saved]);
      setTemplateId(saved.id); setSaving(undefined);
    } catch (error) { setError(message(error)); }
    finally { setBusy(''); }
  }

  return <Modal title="AI 팀으로 작업 시작" onClose={onClose}>
    <form className="team-setup" onSubmit={event => { event.preventDefault(); if (step === 'compose') void runCheck(); else void start(); }}>
      <ol className="team-steps" aria-label="진행 단계">
        <li aria-current={step === 'compose' ? 'step' : undefined}><span>1</span>팀 구성</li>
        <li aria-current={step === 'check' ? 'step' : undefined}><span>2</span>시작 전 점검</li>
      </ol>
      <div className="modal-body team-setup-body">
        {step === 'compose' ? <>
          <div className="team-setup-row">
            <label className="field"><span className="field-label">작업할 그룹</span>
              <select className="select" value={target} onChange={event => { setTarget(event.target.value); setCheck(undefined); }}>
                {groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <span className="hint" title={group?.cwd}>{!group ? '그룹을 먼저 만들어 주세요.' : scopeSupported ? '이 그룹의 폴더가 아래 작업 범위에 나옵니다.' : '작업 폴더: ' + group.cwd}</span>
            </label>
            <label className="field"><span className="field-label">팀 이름</span>
              <input className="input" value={name} maxLength={30} placeholder="예: 로그인 개선" onChange={event => { setName(event.target.value); setNameEdited(true); }}/>
              <span className="hint">왼쪽 AI 팀 목록과 구성원에게 알려 주는 이름입니다.</span>
            </label>
          </div>
          {scopeSupported && <TeamScopePicker scope={scope} loading={scopeLoading} error={scopeError} onChange={changeScope} onToggle={path => { setCheck(undefined); setScope(value => value && toggleScopeFolder(value, path)); }} onAdd={addFolder} pickDirectory={pickDirectory}/>}
          <fieldset className="team-templates">
            <legend className="field-label">템플릿</legend>
            {!templates && !error && <p className="hint"><LoaderCircle size={13} className="spin"/> 템플릿을 불러오는 중…</p>}
            <div className="team-template-list" role="radiogroup" aria-label="팀 템플릿">
              {templates?.map(template => <div key={template.id} className={'team-template' + (template.id === templateId ? ' selected' : '')}>
                <button type="button" role="radio" aria-checked={template.id === templateId} className="team-template-main" onClick={() => choose(template)}>
                  <strong>{template.name}</strong>
                  <small>{template.members.map(member => member.name).join(' · ')}{template.builtIn ? ' · 기본 제공' : ' · 내 템플릿'}</small>
                </button>
                <button type="button" className={'icon-button team-template-star' + (template.id === defaultId ? ' on' : '')} aria-pressed={template.id === defaultId} aria-label={template.name + (template.id === defaultId ? ' 기본 템플릿 해제' : '을 기본 템플릿으로')} title={template.id === defaultId ? '기본 템플릿 해제' : '다음에도 이 템플릿을 먼저 고르기'} onClick={() => toggleDefault(template.id)}><Star size={14}/></button>
              </div>)}
            </div>
          </fieldset>
          <div className="team-members" role="table" aria-label="구성원">
            <div className="team-member-head" role="row">
              <span role="columnheader">이름</span><span role="columnheader">역할</span><span role="columnheader">도구</span><span role="columnheader">모델</span><span role="columnheader">끝나면 보고</span><span role="columnheader">작업 폴더</span><span role="columnheader">읽기 전용</span><span role="columnheader"><span className="sr-only">더 보기와 빼기</span></span>
            </div>
            {members.map((member, index) => {
              const expanded = open === member.key, lead = index === 0;
              const listId = 'team-models-' + member.key;
              return <div key={member.key} className={'team-member' + (expanded ? ' expanded' : '')} role="rowgroup">
                <div className="team-member-row" role="row">
                  <span role="cell" className="team-member-name">{lead ? <Crown size={13} aria-label="팀장" className="team-lead-mark"/> : <span className="team-lead-mark" aria-hidden="true"/>}<input className="input" aria-label={(index + 1) + '번 구성원 이름'} value={member.name} maxLength={30} onChange={event => { setCheck(undefined); setMembers(list => renameMember(list, index, event.target.value)); }}/></span>
                  <span role="cell"><select className="select" aria-label={member.name + ' 역할'} value={member.role} onChange={event => { setCheck(undefined); setMembers(list => list.map((item, at) => at === index ? withRole(item, event.target.value as MemberDraft['role']) : item)); }}>{ROLES.map(role => <option key={role} value={role}>{ROLE_DEFAULTS[role].label}</option>)}</select></span>
                  <span role="cell"><select className="select" aria-label={member.name + ' 도구'} value={member.provider} onChange={event => edit(index, {provider: event.target.value as MemberDraft['provider'], model: ''})}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></span>
                  <span role="cell"><input className="input" aria-label={member.name + ' 모델'} list={listId} value={member.model} maxLength={80} placeholder="도구 기본값" onChange={event => edit(index, {model: event.target.value.trim()})}/><datalist id={listId}>{modelSuggestions(member.provider, templates ?? []).map(model => <option key={model} value={model}/>)}</datalist></span>
                  <span role="cell"><select className="select" aria-label={member.name + ' 끝나면 보고'} value={member.reportKey} onChange={event => edit(index, {reportKey: event.target.value})}><option value="user">나</option>{members.filter((other, at) => at !== index).map(other => <option key={other.key} value={other.key}>{other.name.trim() || '(이름 없음)'}</option>)}{member.reportKey === '' && <option value="">{member.reportTo} (없음)</option>}</select></span>
                  <span role="cell"><select className="select" aria-label={member.name + ' 작업 폴더'} value={shared ? 'base' : member.folder} disabled={shared} title={shared ? '여러 폴더를 함께 쓰는 팀은 구성원 모두가 기본 폴더에서 일합니다' : undefined} onChange={event => edit(index, {folder: event.target.value as MemberDraft['folder']})}><option value="base">기본 폴더</option><option value="worktree">새 워크트리</option></select></span>
                  <span role="cell" className="team-member-check"><input type="checkbox" aria-label={member.name + ' 읽기 전용'} checked={member.readOnly} onChange={event => edit(index, {readOnly: event.target.checked})}/></span>
                  <span role="cell" className="team-member-actions">
                    <button type="button" className="icon-button" aria-expanded={expanded} aria-label={member.name + ' 지시문 ' + (expanded ? '접기' : '펼치기')} title="역할 지시문과 덧붙일 말" onClick={() => setOpen(expanded ? undefined : member.key)}>{expanded ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button>
                    <button type="button" className="icon-button" aria-label={member.name + ' 빼기'} title="이 구성원 빼기" disabled={members.length < 2} onClick={() => { setCheck(undefined); setOpen(undefined); setMembers(list => removeMember(list, index)); }}><X size={14}/></button>
                  </span>
                </div>
                {expanded && <div className="team-member-detail">
                  <label className="field"><span className="field-label">역할 지시문 <button type="button" className="button subtle team-reset" disabled={member.instructions === ROLE_DEFAULTS[member.role].instructions} onClick={() => edit(index, {instructions: ROLE_DEFAULTS[member.role].instructions})}><RotateCcw size={12}/>역할 기본값으로</button></span>
                    <textarea className="textarea" value={member.instructions} maxLength={4000} placeholder="이 구성원이 맡을 일과 지킬 규칙을 적어 주세요." onChange={event => edit(index, {instructions: event.target.value})}/>
                    {!member.instructions.trim() && <span className="hint team-warning">지시문이 비어 있으면 사용자가 맡기는 일만 처리합니다.</span>}
                  </label>
                  <label className="field"><span className="field-label">이번 팀에서 덧붙일 말</span>
                    <textarea className="textarea team-extra" value={member.extra ?? ''} maxLength={2000} placeholder="예: 테스트는 npm test로 실행합니다." onChange={event => edit(index, {extra: event.target.value})}/>
                  </label>
                  <p className="hint">몽글이 팀 이름, 구성원 목록, 보고 대상, 메시지 받는 방법을 지시문 앞에 자동으로 붙입니다. 읽기 전용은 지시문이 아니라 {member.provider === 'claude' ? 'Claude Code의 도구 제한(Read·Grep·Glob만 허용)' : 'Codex의 읽기 전용 샌드박스와 권한 상승 금지'}으로 막습니다.</p>
                  {!lead && <button type="button" className="button subtle" onClick={() => { setCheck(undefined); setMembers(list => makeLead(list, index)); }}><Crown size={13}/>팀장으로 바꾸기</button>}
                </div>}
              </div>;
            })}
          </div>
          <div className="team-members-footer">
            <button type="button" className="button subtle" disabled={members.length >= TEAM_MAX_MEMBERS} onClick={() => { setCheck(undefined); setMembers(list => addMember(list)); }}><Plus size={14}/>구성원 추가</button>
            <span className="hint">맨 위 구성원이 팀장입니다. 한 팀은 {TEAM_MAX_MEMBERS}명까지입니다.</span>
            {saving === undefined
              ? <button type="button" className="button subtle team-save-template" disabled={!members.length} onClick={() => setSaving(selected && !selected.builtIn ? selected.name : name.trim())}>템플릿으로 저장</button>
              : <span className="team-save-form"><input className="input" aria-label="템플릿 이름" autoFocus maxLength={30} value={saving} onChange={event => setSaving(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveTemplate(); } }}/><button type="button" className="button" disabled={!saving.trim() || busy === 'save'} onClick={() => void saveTemplate()}>저장</button><button type="button" className="icon-button" aria-label="템플릿 저장 취소" onClick={() => setSaving(undefined)}><X size={14}/></button></span>}
          </div>
          {worktrees && <p className="hint">새 워크트리를 고른 구성원은 작업 폴더의 Git 저장소에서 브랜치를 따로 받아 일합니다. 작업 폴더가 Git 저장소가 아니거나 아직 커밋이 없으면 기본 폴더에서 일합니다. 결과는 Git 변경 검토에서 구성원별로 확인하고, 합칠지는 직접 정합니다.</p>}
          {shared && <p className="hint">여러 폴더를 함께 쓰는 팀은 구성원 모두가 기본 폴더에서 일합니다. 팀장이 일을 나눠 같은 파일을 동시에 고치지 않게 하고, 검토는 읽기 전용으로 둡니다. 템플릿의 워크트리 설정은 그대로 저장됩니다.</p>}
          {problems.length > 0 && <ul className="team-problems" role="status">{problems.map(problem => <li key={problem}><AlertTriangle size={13}/>{problem}</li>)}</ul>}
        </> : <>
          <p className="hint team-check-intro">{name.trim()} · 구성원 {members.length}명 · {group?.name}. 필수 항목이 모두 통과해야 팀을 시작할 수 있습니다. 모델 요청은 보내지 않습니다.</p>
          {busy === 'check' && <p className="hint"><LoaderCircle size={13} className="spin"/> 확인하는 중…</p>}
          {check && <ul className="team-checks" aria-label="시작 전 점검 결과">{check.checks.map(item => <li key={item.id + item.message} className={'team-check ' + item.status}>
            {item.status === 'ok' ? <Check size={15} aria-label="통과"/> : item.status === 'warning' ? <AlertTriangle size={15} aria-label="주의"/> : <XCircle size={15} aria-label="해결 필요"/>}
            <span><strong>{item.label}</strong><small>{item.message}</small></span>
          </li>)}</ul>}
          {check && !check.ready && <p className="hint team-warning" role="status">빨간 항목을 해결한 뒤 다시 확인해 주세요.</p>}
          {busy === 'start' && <p className="hint" role="status"><LoaderCircle size={13} className="spin"/> 구성원 터미널을 열고 CLI를 실행하는 중… 워크트리를 만들면 조금 걸립니다.</p>}
        </>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="modal-footer">
        {step === 'compose'
          ? <><button type="button" className="button" onClick={onClose}>취소</button><button className="button primary" disabled={!group || !members.length || problems.length > 0 || scopeWaiting || Boolean(busy)}>다음: 시작 전 점검</button></>
          : <><button type="button" className="button" disabled={busy === 'start'} onClick={() => { setStep('compose'); setError(''); }}>이전</button><button type="button" className="button" disabled={Boolean(busy)} onClick={() => void runCheck()}>다시 확인</button><button className="button primary" disabled={!check?.ready || Boolean(busy)}><Users size={14}/>{busy === 'start' ? '시작하는 중…' : '팀 시작'}</button></>}
      </div>
    </form>
  </Modal>;
}
