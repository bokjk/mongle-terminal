import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { AppError, type ProjectInspection, type Repository, type Worktree } from '../protocol/index.js';
import { localPath, resolveFileRoot, within } from './files.js';
import { repositoryAt, safeMetadata } from './git.js';

const execute = promisify(execFile);
const limit = 2 * 1024 * 1024;
const flags = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false'];
export const samePath = (a: string, b: string) => path.relative(a, b) === '';
const validPath = (value: string) => localPath(value) && !/[\x00-\x1f]/.test(value) && !value.split(/[\\/]/).some(part => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part));

async function git(cwd: string, args: string[], mutation = false): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_LITERAL_PATHSPECS:'1'});
  try {
    return (await execute('git', [...flags, ...args], {cwd,env,windowsHide:true,encoding:'utf8',timeout:mutation?120000:15000,maxBuffer:limit})).stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {killed?:boolean};
    if (failure.code === 'ENOENT') throw new AppError('GIT_UNAVAILABLE', '이 컴퓨터에서 Git을 찾지 못했습니다. Git을 설치해 주세요.');
    if (failure.killed || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new AppError('GIT_LIMIT', 'Git 작업 시간이 길거나 결과가 너무 큽니다. 목록을 새로고침해 결과를 확인해 주세요.');
    // Git stderr may include filter output, private paths or credentials.
    throw new AppError('GIT_FAILED', mutation ? 'Git 작업을 마치지 못했습니다. 폴더 권한·브랜치·Git 필터를 확인하고 목록을 새로고침해 주세요.' : 'Git 정보를 읽지 못했습니다. 저장소 권한과 경로를 확인해 주세요.');
  }
}

export function parseWorktreeList(output: string): ProjectInspection['worktrees'] {
  const result: ProjectInspection['worktrees'] = [];
  let item: ProjectInspection['worktrees'][number] | undefined;
  for (const field of output.split('\0')) {
    if (!field) { if (item) { result.push(item); item = undefined; } continue; }
    if (field.startsWith('worktree ')) {
      if (item) throw new AppError('GIT_FAILED', '워크트리 목록 형식이 올바르지 않습니다.');
      item = {path:field.slice(9),head:'',branch:'',main:result.length===0,status:'ready'};
    } else if (item) {
      if (field.startsWith('HEAD ')) item.head = field.slice(5);
      else if (field.startsWith('branch refs/heads/')) item.branch = field.slice(18);
      else if (field === 'locked' || field.startsWith('locked ')) item.locked = field.slice(7) || '잠긴 워크트리';
      else if (field === 'bare') { item.status='unsupported'; item.reason='bare 저장소는 지원하지 않습니다.'; }
      else if (field === 'prunable' || field.startsWith('prunable ')) { item.status='missing'; item.reason='폴더 확인 필요'; }
    } else throw new AppError('GIT_FAILED', '워크트리 목록 형식이 올바르지 않습니다.');
  }
  if (item) result.push(item);
  if (!result.length || result.length > 128 || result.some(item => !validPath(item.path))) throw new AppError('WORKTREE_UNSUPPORTED', '워크트리 경로 또는 개수 한도를 확인해 주세요. 로컬 저장소의 워크트리 128개까지 지원합니다.');
  return result;
}

async function exists(file: string) {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function inspectProject(directory: string, dataDir: string): Promise<ProjectInspection> {
  if (!validPath(directory)) throw new AppError('WORKTREE_UNSUPPORTED', '이 호스트의 로컬 Windows 폴더 경로를 선택해 주세요.');
  const {base,protectedRoot} = await resolveFileRoot(directory, dataDir);
  const discovered = await repositoryAt(base, protectedRoot);
  if (!discovered) throw new AppError('NOT_REPOSITORY', 'Git 저장소가 아닙니다. 일반 그룹으로 열 수 있습니다.');
  const selectedPath = await safeMetadata((await git(base, ['rev-parse','--show-toplevel'])).trim(), protectedRoot);
  if (!samePath(discovered,selectedPath)) throw new AppError('WORKTREE_CHANGED', 'Git 작업 폴더가 바뀌었습니다. 다시 선택해 주세요.');
  // Once the repository boundary is verified, these independent read-only
  // queries can overlap process startup without caching possibly stale state.
  const queries = await Promise.allSettled([
    git(base, ['rev-parse','--path-format=absolute','--git-common-dir']).then(value=>safeMetadata(value.trim(),protectedRoot)),
    git(base, ['rev-parse','--show-superproject-working-tree']),
    git(base, ['rev-parse','--verify','HEAD^{commit}']).then(value=>value.trim()).catch(error=>{if(error instanceof AppError&&error.code==='GIT_FAILED')throw new AppError('NO_COMMIT','첫 커밋을 만든 뒤 워크트리를 추가할 수 있습니다.');throw error;}),
    git(base, ['worktree','list','--porcelain','-z']),
    // :short adds heads/ when a tag has the same name. These are explicitly
    // local branches, so always remove exactly refs/heads/ instead.
    git(base, ['for-each-ref','--format=%(refname:lstrip=2)','refs/heads/']),
  ]);
  // Keep the caller's concurrency slot until every child has settled, even if
  // one query fails, so repeated failures cannot accumulate Git processes.
  const [commonDir, superproject, head, worktreeOutput, branchOutput] = queries.map(result=>{if(result.status==='rejected')throw result.reason;return result.value;});
  if (superproject.trim()) throw new AppError('WORKTREE_UNSUPPORTED', '하위 모듈 저장소의 워크트리 관리는 아직 지원하지 않습니다.');
  const worktrees = parseWorktreeList(worktreeOutput);
  for (const item of worktrees) {
    try {
      const actual = await safeMetadata(item.path,protectedRoot);
      if (!samePath(actual,item.path)) throw new AppError('WORKTREE_CHANGED', '작업 폴더의 실제 위치가 바뀌었습니다.');
      if (await exists(path.join(actual,'.gitmodules'))) { item.status='unsupported'; item.reason='하위 모듈이 있는 작업 폴더는 관리하지 않습니다.'; }
      else if (!/^[0-9a-f]{40,64}$/.test(item.head)) { item.status='unsupported'; item.reason='유효한 커밋을 확인할 수 없습니다.'; }
    } catch (error) { item.status='missing'; item.reason=error instanceof AppError?error.message:'폴더 확인 필요'; }
  }
  const selected = worktrees.find(item=>samePath(item.path,selectedPath));
  if (!selected) throw new AppError('WORKTREE_CHANGED', '워크트리 목록에 선택한 작업 폴더가 없습니다.');
  const branches = branchOutput.split(/\r?\n/).filter(Boolean);
  if (branches.length>2000) throw new AppError('GIT_LIMIT', '브랜치가 너무 많습니다. 저장소를 정리한 뒤 다시 시도해 주세요.');
  return {commonDir,root:worktrees[0].path,selectedPath,baseRef:selected.branch||head,branches,worktrees};
}

export async function inspectKnownRepository(repository: Repository, dataDir: string) {
  const inspection = await inspectProject(repository.root,dataDir);
  if (!samePath(inspection.commonDir,repository.commonDir)) throw new AppError('WORKTREE_CHANGED', '등록한 Git 저장소의 실제 위치가 달라졌습니다. 프로젝트를 다시 확인해 주세요.');
  return inspection;
}

export async function validateWorktree(repository: Repository, worktree: Worktree, dataDir: string) {
  if (worktree.status!=='ready') throw new AppError('WORKTREE_UNAVAILABLE', worktree.reason||'이 워크트리는 지금 열 수 없습니다. 목록을 새로고침해 주세요.');
  const inspected = await inspectProject(worktree.path,dataDir);
  if (!samePath(inspected.commonDir,repository.commonDir) || !samePath(inspected.selectedPath,worktree.path)) throw new AppError('WORKTREE_CHANGED', '워크트리 연결이 바뀌었습니다. 목록을 새로고침해 주세요.');
  const actual=inspected.worktrees.find(item=>samePath(item.path,worktree.path));
  if (!actual || actual.status!=='ready') throw new AppError('WORKTREE_UNAVAILABLE', actual?.reason||'워크트리를 확인하지 못했습니다.');
  return actual;
}

export function worktreeSlug(name: string) {
  return name.normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,40) || 'work';
}

async function newPath(candidate: string, inspection: ProjectInspection, dataDir: string) {
  if (!validPath(candidate)) throw new AppError('INVALID_WORKTREE_PATH', '올바른 로컬 폴더의 전체 경로를 입력해 주세요.');
  const desired=path.resolve(candidate);
  if (await exists(desired)) throw new AppError('WORKTREE_PATH_EXISTS', '이 위치에 폴더가 이미 있습니다. 새 폴더 이름을 입력해 주세요.');
  let parent=path.dirname(desired);
  while (!(await exists(parent))) {
    const next=path.dirname(parent);
    if(next===parent)throw new AppError('INVALID_WORKTREE_PATH','폴더를 만들 위치를 찾지 못했습니다.');
    parent=next;
  }
  const actualParent=await realpath(parent);
  const resolved=path.resolve(actualParent,path.relative(parent,desired));
  if(!validPath(resolved))throw new AppError('INVALID_WORKTREE_PATH','로컬 폴더만 사용할 수 있습니다.');
  const protectedRoot=await realpath(dataDir);
  const forbidden=[inspection.commonDir,protectedRoot,...inspection.worktrees.map(item=>item.path)];
  if(forbidden.some(root=>within(root,resolved)||within(resolved,root)))throw new AppError('INVALID_WORKTREE_PATH','원래 작업·다른 워크트리·Git 정보·앱 데이터 밖의 새 폴더를 선택해 주세요.');
  return resolved;
}

export interface CreateWorktreeInput { name:string; branch:string; baseRef:string; path:string; existingBranch:boolean; }
export interface PreparedWorktree { path:string; branch:string; head:string; existingBranch:boolean; }
export async function prepareWorktree(repository:Repository, input:CreateWorktreeInput, dataDir:string):Promise<PreparedWorktree> {
  const inspection=await inspectKnownRepository(repository,dataDir);
  if(inspection.worktrees.length>=128)throw new AppError('LIMIT_REACHED','워크트리는 저장소당 128개까지 지원합니다. 사용하지 않는 워크트리를 정리해 주세요.');
  if(inspection.worktrees.some(item=>item.status==='unsupported'&&item.main))throw new AppError('WORKTREE_UNSUPPORTED','이 저장소는 워크트리 생성을 지원하지 않습니다.');
  if(!input.branch || input.branch.startsWith('-') || input.branch.length>200)throw new AppError('INVALID_BRANCH','사용할 브랜치 이름을 확인해 주세요.');
  try{await git(repository.root,['check-ref-format','--branch',input.branch]);}catch(error){if(error instanceof AppError&&error.code==='GIT_FAILED')throw new AppError('INVALID_BRANCH','Git 브랜치 이름에 사용할 수 없는 문자가 있습니다.');throw error;}
  if(inspection.worktrees.some(item=>item.branch===input.branch))throw new AppError('BRANCH_IN_USE','다른 워크트리에서 사용 중인 브랜치입니다.');
  if(input.existingBranch?!inspection.branches.includes(input.branch):inspection.branches.includes(input.branch))throw new AppError('BRANCH_EXISTS',input.existingBranch?'기존 브랜치를 찾지 못했습니다.':'이미 있는 브랜치 이름입니다. 다른 이름을 쓰거나 기존 브랜치 연결을 선택해 주세요.');
  let head:string;
  const baseRef=input.existingBranch?'refs/heads/'+input.branch:inspection.branches.includes(input.baseRef)?'refs/heads/'+input.baseRef:input.baseRef;
  try{head=(await git(repository.root,['rev-parse','--verify','--end-of-options',`${baseRef}^{commit}`])).trim();}catch(error){if(error instanceof AppError&&error.code==='GIT_FAILED')throw new AppError('INVALID_BASE','기준 브랜치 또는 커밋을 찾지 못했습니다.');throw error;}
  if((await git(repository.root,['ls-tree','-r','--format=%(objectmode)',head])).split(/\r?\n/).includes('160000'))throw new AppError('WORKTREE_UNSUPPORTED','하위 모듈이 있는 기준 커밋의 워크트리 생성은 아직 지원하지 않습니다.');
  return {path:await newPath(input.path,inspection,dataDir),branch:input.branch,head,existingBranch:input.existingBranch};
}

export async function addWorktree(repository:Repository, prepared:PreparedWorktree, dataDir:string) {
  const inspection=await inspectKnownRepository(repository,dataDir);
  if(!samePath(await newPath(prepared.path,inspection,dataDir),prepared.path))throw new AppError('WORKTREE_CHANGED','생성할 폴더의 실제 위치가 바뀌었습니다.');
  if(prepared.existingBranch && (await git(repository.root,['rev-parse','--verify',`refs/heads/${prepared.branch}^{commit}`])).trim()!==prepared.head)throw new AppError('WORKTREE_CHANGED','기존 브랜치가 변경되었습니다. 다시 확인해 주세요.');
  await mkdir(path.dirname(prepared.path),{recursive:true});
  // Reserve the empty destination exclusively. Never overwrite or remove a folder on failure.
  if(!samePath(await realpath(path.dirname(prepared.path)),path.dirname(prepared.path)))throw new AppError('WORKTREE_CHANGED','생성 위치가 변경되었습니다.');
  await mkdir(prepared.path);
  await git(repository.root,['worktree','add',...(prepared.existingBranch?[]:['-b',prepared.branch]),'--',prepared.path,prepared.existingBranch?prepared.branch:prepared.head],true);
  const result=await inspectKnownRepository(repository,dataDir),created=result.worktrees.find(item=>samePath(item.path,prepared.path));
  if(!created||created.head!==prepared.head||created.branch!==prepared.branch)throw new AppError('WORKTREE_CHANGED','생성 중 브랜치가 변경되었습니다. 폴더를 보존했으니 목록을 새로고침해 확인해 주세요.');
  return result;
}

export async function removeWorktree(repository:Repository, worktree:Worktree, dataDir:string, beforeRemove:()=>void) {
  if(worktree.main || !worktree.managed)throw new AppError('WORKTREE_PROTECTED','앱에서 만든 연결 워크트리만 삭제할 수 있습니다.');
  const actual=await validateWorktree(repository,{...worktree,status:'ready'},dataDir);
  if(actual.locked)throw new AppError('WORKTREE_LOCKED','잠긴 워크트리는 삭제할 수 없습니다. Git에서 잠금 상태를 먼저 확인해 주세요.');
  const changes=await git(worktree.path,['status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching','--ignore-submodules=none']);
  if(changes.length)throw new AppError('WORKTREE_DIRTY','수정되었거나 추적되지 않은 파일이 있습니다. ignored 파일도 보존하므로 폴더를 정리한 뒤 다시 시도해 주세요.');
  const files=await git(worktree.path,['ls-files','--stage','-z']);
  if(files.split('\0').some(line=>line.startsWith('160000 ')))throw new AppError('WORKTREE_UNSUPPORTED','하위 모듈이 있는 워크트리는 삭제하지 않습니다.');
  await validateWorktree(repository,{...worktree,status:'ready'},dataDir);
  beforeRemove();
  await git(repository.root,['worktree','remove','--',worktree.path],true);
  return inspectKnownRepository(repository,dataDir);
}
