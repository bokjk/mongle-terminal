import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { readFile, realpath, stat, unlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import * as pty from 'node-pty';
import { z } from 'zod';
import { APP_VERSION, PROTOCOL_VERSION, AppError, appendTab, dimensionSchema, groupRepositoryIds, idSchema, leafIds, removeLeaf, splitLeaf } from '../protocol/index.js';
import type { ConnectionContext, Group, HostSettings, HostState, LayoutNode, PresentationSnapshot, Send, ShellProfile, SnapshotEvent, TerminalInfo, Repository, Worktree, WorktreeOperation, ProjectInspection } from '../protocol/index.js';
import { HostStore, type PersistedHost, type PersistedSnapshot } from '../storage/index.js';
import { agentInputSignal, validAgentSession, type AgentSessionIdentity } from '../terminal/agent-status.js';
import { AGENT_PIPE_NAME, agentResumeCommand, isTerminalReportOnly, resolveAgentExecutable } from '../shell-profiles/agent-resume.js';
import { detectShellProfiles, resolveShellLaunch, safeShellEnvironment } from '../shell-profiles/index.js';
import { TerminalEngine } from '../terminal/engine.js';
import { shellIntegration } from '../shell-profiles/integration.js';
import { inspectFiles, within } from './files.js';
import { openFileDocument, saveFileDocument } from './file-editor.js';
import { readPdfChunk } from './pdf-files.js';
import { inspectGit } from './git.js';
import { inspectProject, inspectKnownRepository, validateWorktree, prepareWorktree, addWorktree, removeWorktree, samePath, worktreeSlug } from './worktrees.js';

const nameSchema = z.string().trim().min(1).max(100);
const cwdSchema = z.string().min(1).max(4096);
const exportedSettingsSchema=z.object({version:z.literal(1),name:nameSchema,recordHistory:z.boolean(),groups:z.array(z.object({name:nameSchema,cwd:cwdSchema,profileId:z.string().max(300)}).strict()).max(100)}).strict();
const terminalRef = z.object({ id: idSchema, hostId: idSchema, bootId: idSchema, generation: idSchema });
const hostRef = z.object({hostId:idSchema,bootId:idSchema});
const layoutSchema: z.ZodType<LayoutNode> = z.lazy(() => z.union([
  z.object({type: z.literal('leaf'), terminalId: idSchema, tabs: z.array(idSchema).min(1).max(15).optional()}).strict(),
  z.object({type: z.literal('split'), axis: z.enum(['horizontal','vertical']), ratio: z.number().min(0.05).max(0.95), first: layoutSchema, second: layoutSchema}).strict(),
]));
const LEASE_MS = 15_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
type Attachment = { lastSent: number; lastAck: number; pending?: SnapshotEvent };
type Client = { ctx: ConnectionContext; send: Send; attached: Map<string, Attachment> };
type Lease = { connectionId: string; deviceName: string; epoch: number; expires: number; ready: boolean; syncSeq: number; inputSeq: number; dedupe: Map<string, {seq:number; hash:string}> };
type Runtime = { info: TerminalInfo; engine: TerminalEngine; pty?: pty.IPty; stopPty?:()=>Promise<void>; seq: number; epoch: number; lease?: Lease; timer?: ReturnType<typeof setTimeout>; framePending?: boolean; frameDirty?: boolean; checkpointAt: number; lastFrame?: SnapshotEvent; disposed: boolean; stopping?: boolean; pendingBytes: number; directoryChanged?: boolean; notificationChanged?: boolean; agentToken?: string; pendingResume?: { command: string; timer: ReturnType<typeof setTimeout> } };
/** Host-private: the exact agent conversation last verified in a terminal generation. Never in TerminalInfo/state. */
type AgentSessionRecord = { generation: string; session: AgentSessionIdentity };
const RESUME_PROMPT_TIMEOUT_MS = 15_000;

/** Owns the shells, independent of every GUI/browser attachment. */
export class HostCore {
  private store!: HostStore;
  private hostId = '';
  private readonly bootId = randomUUID();
  private settings: HostSettings;
  private profiles: ShellProfile[] = [];
  private groups: Group[] = [];
  private terminals: TerminalInfo[] = [];
  private agentSessions = new Map<string, AgentSessionRecord>();
  private repositories: Repository[] = [];
  private worktrees: Worktree[] = [];
  private worktreeOperations: WorktreeOperation[] = [];
  private projectTasks = new Map<string,Promise<void>>();
  private projectReads = 0;
  private metadataVersion = 0;
  private runtimes = new Map<string, Runtime>();
  private archivedSequences = new Map<string, number>();
  private archivedFrames = new Map<string, PresentationSnapshot>();
  private clients = new Map<string, Client>();
  private queue: Promise<unknown> = Promise.resolve();
  private leaseTimer?: ReturnType<typeof setInterval>;
  private closing = false;
  private shutdownPrepared = false;
  private initialized = false;
  private initialization?: Promise<void>;
  private storageError?: string;
  private fileReads = new Map<string, number>();
  private fileDocuments = new Map<string, { client: Client; root: string; path: string; absolutePath: string }>();

  constructor(private options: { dataDir: string; name?: string; claudeIntegration?: import('../protocol/index.js').ClaudeIntegration; codexIntegration?: { status: 'installed' | 'unavailable'; message: string } }) {
    this.settings = {name: options.name || hostname(), recordHistory: true, scrollback: 5000};
  }
  async init(): Promise<void> {
    return this.initialization ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.store = new HostStore(this.options.dataDir);
    const saved = this.store.load();
    this.profiles = await detectShellProfiles();
    this.hostId = saved?.hostId || randomUUID();
    const legacyResume=await this.legacyResumeIntent(saved);
    if (saved) {
      this.settings = saved.settings;
      this.groups = saved.groups;
      this.repositories = saved.repositories || [];
      this.worktrees = (saved.worktrees || []).map(item=>item.status==='removing'?{...item,status:'missing',reason:'삭제 결과를 확인하려면 목록을 새로고침해 주세요.'}:item);
      this.worktreeOperations = (saved.worktreeOperations || []).map(item=>item.status==='pending'||item.status==='running'?{...item,status:'attention',message:'호스트가 재시작되었습니다. 목록을 새로고침해 작업 결과를 확인해 주세요.'}:item);
      this.terminals = saved.terminals.map(({controller, pid, agentStatus, agentProvider, agentNotificationCount, ...info}) => ({...info, status: info.status === 'running' ? 'interrupted' : info.status, resumeOnBoot: info.status === 'running' || info.resumeOnBoot === true || legacyResume.has(info.id), historyAvailable: Boolean(this.settings.recordHistory && this.store.getSnapshot(info.id, info.generation))}));
      // Only an exact, validated conversation bound to the saved generation of a
      // terminal that will be restored survives; anything else is dropped.
      for (const [id, record] of Object.entries(saved.agentSessions || {})) {
        const info = this.terminals.find(item => item.id === id), session = validAgentSession(record?.session);
        if (info && session && info.resumeOnBoot && record.generation === info.generation) this.agentSessions.set(id, {generation:record.generation, session});
      }
    } else {
      this.groups = [{id:randomUUID(),name:'기본 그룹',cwd:homedir(),profileId:this.profiles[0]?.id || '',revision:0,layout:null}];
    }
    this.persist(true,this.settings.recordHistory?undefined:'all');
    for (const info of this.terminals) if (info.resumeOnBoot) await this.restoreTerminal(info);
    this.persist(true);
    // The durable intent above is now authoritative, including failed restores.
    // Leaving a stale bridge file on deletion failure cannot override explicit flags.
    try{await unlink(join(this.options.dataDir,'workspace-resume.json'));}catch{}
    this.initialized = true;
    for(const runtime of this.runtimes.values()){
      if(runtime.info.status==='running')this.scheduleFrame(runtime);
      else await this.archiveExited(runtime);
    }
    this.leaseTimer = setInterval(() => this.expireLeases(), 1000);
    this.leaseTimer.unref();
  }
  private async legacyResumeIntent(saved:PersistedHost|undefined):Promise<Set<string>> {
    const result=new Set<string>();if(!saved)return result;
    try{
      const file=join(this.options.dataDir,'workspace-resume.json');if((await stat(file)).size>16*1024)return result;
      const schema=z.object({version:z.literal(1),hostId:idSchema,bootId:idSchema,terminals:z.array(z.object({id:idSchema,generation:idSchema}).strict()).max(32)}).strict();
      const manifest=schema.parse(JSON.parse(await readFile(file,'utf8')));
      if(manifest.hostId!==saved.hostId || new Set(manifest.terminals.map(info=>info.id)).size!==manifest.terminals.length)return result;
      for(const target of manifest.terminals){
        const info=saved.terminals.find(value=>value.id===target.id);
        if(info && info.generation===target.generation && info.resumeOnBoot===undefined)result.add(info.id);
      }
    }catch{/* Optional one-time bridge from an older host; never block host startup. */}
    return result;
  }
  getState(): HostState {
    return structuredClone({ hostId:this.hostId, bootId:this.bootId, name:this.settings.name, version:APP_VERSION, protocolVersion:PROTOCOL_VERSION, capabilities:['control.acquire-if-free','files.read','files.edit','files.pdf','git.read','layout.tabs','worktrees.manage','worktrees.terminal-context'], groups:this.groups, terminals:this.terminals, repositories:this.repositories,worktrees:this.worktrees,worktreeOperations:this.worktreeOperations,profiles:this.profiles, settings:this.settings, ...(this.options.claudeIntegration ? {claudeIntegration:this.options.claudeIntegration} : {}), ...(this.options.codexIntegration ? {codexIntegration:this.options.codexIntegration} : {}), ...(this.storageError ? {storageError:this.storageError} : {}) });
  }
  connect(ctx: ConnectionContext, send: Send): void {
    if (!this.initialized || this.closing || this.shutdownPrepared) throw new AppError('HOST_UNAVAILABLE','호스트가 준비되지 않았습니다.');
    if (this.clients.has(ctx.id)) this.disconnect(ctx.id);
    const client = {ctx:{...ctx},send,attached:new Map<string, Attachment>()};
    this.clients.set(ctx.id,client);
    this.send(client,{type:'state',state:this.getState()});
  }
  disconnect(id: string): void {
    this.clients.delete(id);
    for (const [token, document] of this.fileDocuments) if (document.client.ctx.id === id) this.fileDocuments.delete(token);
    let changed = false;
    for (const runtime of this.runtimes.values()) if (runtime.lease?.connectionId === id) {this.revoke(runtime); changed = true;}
    if (changed) this.broadcastState();
  }
  async handle(method: string, params: unknown, ctx: ConnectionContext): Promise<any> {
    // Lease renewal must not wait for a slow snapshot or filesystem mutation.
    if (method === 'heartbeat') return this.route(method, params ?? {}, this.connectedClient(ctx));
    // Filesystem latency must not block heartbeat, terminal input or shutdown.
    if (method === 'files.list' || method === 'files.preview' || method === 'files.open' || method === 'files.pdf' || method === 'git.status') return this.readFiles(method, params, ctx);
    if (method === 'files.save' || method === 'files.close' || method === 'files.reload') return this.editFile(method, params, ctx);
    if (method.startsWith('projects.') || method.startsWith('worktrees.')) return this.projectRequest(method,params,ctx);
    if(method==='terminals.create'||method==='terminals.restart') {
      const client=this.connectedClient(ctx);
      const p=z.object({worktreeId:idSchema.optional(),cwd:cwdSchema.optional(),tabTarget:idSchema.optional(),splitTarget:idSchema.optional(),id:idSchema.optional()}).passthrough().parse(params);
      const source=this.terminals.find(t=>t.id===(method==='terminals.restart'?p.id:p.tabTarget||p.splitTarget));
      const linked=this.worktrees.find(w=>w.id===(p.worktreeId||source?.worktreeId));
      const directory=p.cwd||source?.currentCwd||source?.cwd;
      if(linked&&(method==='terminals.restart'||p.worktreeId||(directory&&within(linked.path,directory))))await this.projectRead(()=>validateWorktree(this.repository(linked.repositoryId),linked,this.options.dataDir),client);
    }
    const task = this.queue.then(async () => {
      if (this.closing || this.shutdownPrepared) throw new AppError('HOST_UNAVAILABLE','호스트가 종료 중입니다.');
      const client = this.clients.get(ctx.id);
      if (!client || client.ctx.deviceId !== ctx.deviceId) throw new AppError('NOT_CONNECTED','연결을 다시 열어 주세요.');
      const reversible=['groups.create','groups.update','groups.layout','groups.reorder','terminals.create','terminals.rename','terminals.move','settings.update','settings.import'].includes(method);
      const before=reversible?this.getState():undefined;
      try{return await this.route(method, params ?? {}, client);}catch(error){
        if(before && error instanceof AppError && error.code==='STORAGE_ERROR'){
          this.settings=before.settings;this.groups=before.groups;
          // A PTY can exit while cwd validation awaits I/O. Roll back only the
          // metadata owned by this mutation, retaining actual lifecycle state.
          this.terminals=before.terminals.map(old=>{const current=this.terminals.find(t=>t.id===old.id)||old;Object.assign(current,{title:old.title,groupId:old.groupId,profileId:old.profileId,cwd:old.cwd,worktreeId:old.worktreeId});if(method==='settings.update')current.historyAvailable=old.historyAvailable;return current;});
        }
        if(error instanceof AppError && error.code==='STORAGE_ERROR')this.broadcastState();
        throw error;
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  private connectedClient(ctx:ConnectionContext) {
    if(this.closing||this.shutdownPrepared)throw new AppError('HOST_UNAVAILABLE','호스트가 종료 중입니다.');
    const client=this.clients.get(ctx.id);
    if(!client||client.ctx.deviceId!==ctx.deviceId)throw new AppError('NOT_CONNECTED','연결을 다시 열어 주세요.');
    return client;
  }
  private async projectRead<T>(read:()=>Promise<T>,client:Client) {
    if(this.projectReads>=4)throw new AppError('WORKTREE_BUSY','다른 프로젝트 조회가 끝난 뒤 다시 시도해 주세요.');
    this.projectReads++;
    try{const value=await read();this.requireClient(client);if(this.closing||this.shutdownPrepared)throw new AppError('HOST_UNAVAILABLE','호스트가 종료 중입니다.');return value;}
    finally{this.projectReads--;}
  }
  /** Only short metadata/PTY commits use the terminal queue; Git never runs on it. */
  private projectCommit<T>(change:()=>T|Promise<T>):Promise<T> {
    const task=this.queue.then(async()=>{
      const before=this.getState(),version=this.metadataVersion;
      try{return await change();}
      catch(error){
        if((error instanceof AppError&&error.code==='STORAGE_ERROR')||version===this.metadataVersion){
          this.groups=before.groups;this.repositories=before.repositories||[];this.worktrees=before.worktrees||[];this.worktreeOperations=before.worktreeOperations||[];
          this.terminals=before.terminals.map(old=>{const current=this.terminals.find(t=>t.id===old.id)||old;Object.assign(current,{groupId:old.groupId,worktreeId:old.worktreeId});return current;});
          this.broadcastState();
        }
        throw error;
      }
    });
    this.queue=task.catch(()=>undefined);return task;
  }
  private repository(id:string){const value=this.repositories.find(item=>item.id===id);if(!value)throw new AppError('PROJECT_NOT_FOUND','프로젝트를 찾을 수 없습니다.');return value;}
  private worktree(id:string){const value=this.worktrees.find(item=>item.id===id);if(!value)throw new AppError('WORKTREE_NOT_FOUND','워크트리를 찾을 수 없습니다.');return value;}
  private operation(id:string){const value=this.worktreeOperations.find(item=>item.id===id);if(!value)throw new AppError('OPERATION_NOT_FOUND','워크트리 작업 기록을 찾을 수 없습니다.');return value;}
  private mergeProject(repository:Repository,inspection:ProjectInspection) {
    if(!samePath(repository.commonDir,inspection.commonDir))throw new AppError('WORKTREE_CHANGED','저장소 연결이 바뀌었습니다.');
    repository.checkedAt=Date.now();delete repository.error;
    const previous=this.worktrees.filter(item=>item.repositoryId===repository.id);
    const next=inspection.worktrees.map(item=>{
      const old=previous.find(old=>samePath(old.path,item.path));
      const recovered=this.worktreeOperations.find(op=>op.repositoryId===repository.id&&op.kind==='create'&&op.path&&samePath(op.path,item.path)&&op.head===item.head&&op.branch===item.branch);
      return {...old,...item,id:old?.id||recovered?.worktreeId||randomUUID(),repositoryId:repository.id,name:old?.name||recovered?.name||(item.main?basename(item.path)||'기본 작업':item.branch||basename(item.path)),managed:old?.managed||Boolean(recovered),...(old?.status==='removing'?{status:'removing' as const}:{})};
    });
    for(const old of previous)if(!next.some(item=>item.id===old.id))next.push({...old,status:'missing',reason:'폴더 확인 필요'});
    this.worktrees=[...this.worktrees.filter(item=>item.repositoryId!==repository.id),...next];
    for(const op of this.worktreeOperations.filter(op=>op.repositoryId===repository.id&&op.status==='attention')){
      if(op.kind==='create'&&next.some(item=>item.id===op.worktreeId&&item.status==='ready'))Object.assign(op,{status:'succeeded',message:'워크트리를 다시 연결했습니다. 이름을 누르면 터미널을 열 수 있습니다.'});
      if(op.kind==='remove'&&!inspection.worktrees.some(item=>op.path&&samePath(item.path,op.path))){this.worktrees=this.worktrees.filter(item=>item.id!==op.worktreeId);Object.assign(op,{status:'succeeded',message:'워크트리 삭제 결과를 확인했습니다. 브랜치는 남아 있습니다.'});}
    }
  }
  private assertNoWorktreeTerminals(worktree:Worktree) {
    if(this.terminals.some(t=>t.worktreeId===worktree.id||within(worktree.path,t.cwd)||(t.currentCwd&&within(worktree.path,t.currentCwd))))throw new AppError('WORKTREE_IN_USE','이 폴더를 사용하는 터미널이 있습니다. 다른 그룹의 터미널과 종료된 탭도 먼저 닫아 주세요.');
  }
  private async openWorktree(worktree:Worktree,group:Group,client:Client,preferredId?:string,tabTarget?:string):Promise<TerminalInfo> {
    this.requireClient(client);
    if(this.closing||this.shutdownPrepared)throw new AppError('HOST_UNAVAILABLE','호스트가 종료 중입니다.');
    if(!groupRepositoryIds(group).includes(worktree.repositoryId))throw new AppError('WORKTREE_CHANGED','이 그룹에 연결되지 않은 저장소의 워크트리입니다.');
    const terminals=this.terminals.filter(t=>t.groupId===group.id&&t.worktreeId===worktree.id);
    const existing=terminals.find(t=>t.id===preferredId)||terminals.find(t=>t.status==='running')||terminals[0];
    if(existing)return structuredClone(existing);
    const target=tabTarget&&leafIds(group.layout).includes(tabTarget)?tabTarget:leafIds(group.layout)[0];
    return this.route('terminals.create',{groupId:group.id,worktreeId:worktree.id,...(target?{tabTarget:target}:{})},client);
  }
  private async projectRequest(method:string,params:unknown,ctx:ConnectionContext):Promise<any> {
    const client=this.connectedClient(ctx),ref=hostRef.passthrough().parse(params);
    if(ref.hostId!==this.hostId||ref.bootId!==this.bootId)throw new AppError('HOST_CHANGED','호스트가 바뀌었습니다. 다시 연결해 주세요.');
    const check=()=>{this.requireClient(client);if(this.closing||this.shutdownPrepared)throw new AppError('HOST_UNAVAILABLE','호스트가 종료 중입니다.');};
    if(method==='projects.inspect'){
      const p=hostRef.extend({path:cwdSchema}).strict().parse(params);
      return this.projectRead(()=>inspectProject(p.path,this.options.dataDir),client);
    }
    if(method==='projects.attach'){
      const p=hostRef.extend({path:cwdSchema,groupId:idSchema.optional(),revision:z.number().int().nonnegative().optional()}).strict().parse(params);
      const inspection=await this.projectRead(()=>inspectProject(p.path,this.options.dataDir),client);
      return this.projectCommit(async()=>{
        check();
        let repository=this.repositories.find(item=>samePath(item.commonDir,inspection.commonDir));
        let group=p.groupId?this.group(p.groupId):repository?this.groups.find(item=>groupRepositoryIds(item).includes(repository!.id)):undefined;
        if(p.groupId)this.revision(group!,p.revision??-1);
        if(!repository){
          if(this.repositories.length>=100)throw new AppError('LIMIT_REACHED','프로젝트는 호스트당 100개까지 등록할 수 있습니다.');
          repository={id:randomUUID(),commonDir:inspection.commonDir,root:inspection.root,baseRef:inspection.baseRef,worktreeRoot:join(dirname(inspection.root),`${basename(inspection.root)}.worktrees`),checkedAt:Date.now()};this.repositories.push(repository);
        }
        if(!group){
          if(this.groups.length>=100)throw new AppError('LIMIT_REACHED','그룹 개수 한도에 도달했습니다.');
          const profile=this.profiles.find(p=>p.kind!=='wsl');if(!profile)throw new AppError('PROFILE_NOT_FOUND','프로젝트를 열 로컬 셸이 없습니다.');
          group={id:randomUUID(),name:basename(inspection.root),cwd:inspection.selectedPath,profileId:profile.id,revision:0,layout:null};this.groups.push(group);
        }
        group.repositoryIds=[...new Set([...groupRepositoryIds(group),repository.id])];delete group.repositoryId;group.revision++;
        this.mergeProject(repository,inspection);
        for(const terminal of this.terminals.filter(t=>t.groupId===group!.id&&!t.worktreeId)){
          const directory=await realpath(terminal.cwd).catch(()=>terminal.cwd);
          const match=this.worktrees.find(w=>w.repositoryId===repository!.id&&w.status==='ready'&&within(w.path,directory));if(match)terminal.worktreeId=match.id;
        }
        this.persist(true);this.broadcastState();
        const worktree=this.worktrees.find(w=>w.repositoryId===repository!.id&&samePath(w.path,inspection.selectedPath))!;
        let terminalId:string|undefined,warning:string|undefined;
        if(!p.groupId){try{terminalId=(await this.openWorktree(worktree,group,client)).id;}catch(error){warning=error instanceof AppError?error.message:'프로젝트는 연결했지만 터미널을 열지 못했습니다.';}}
        return {groupId:group.id,repository:structuredClone(repository),inspection,worktreeId:worktree.id,terminalId,warning};
      });
    }
    if(method==='worktrees.refresh'){
      const p=hostRef.extend({repositoryId:idSchema}).strict().parse(params),repository=this.repository(p.repositoryId);
      if(this.projectTasks.has(repository.id))throw new AppError('WORKTREE_BUSY','워크트리 작업을 처리하고 있습니다. 완료 후 갱신됩니다.');
      try{
        const inspection=await this.projectRead(()=>inspectKnownRepository(repository,this.options.dataDir),client);
        return await this.projectCommit(()=>{check();if(this.projectTasks.has(repository.id))throw new AppError('WORKTREE_BUSY','워크트리 작업 완료 후 다시 갱신됩니다.');this.mergeProject(this.repository(repository.id),inspection);this.persist(true);this.broadcastState();return inspection;});
      }catch(error){if(error instanceof AppError&&error.code!=='WORKTREE_BUSY')await this.projectCommit(()=>{check();this.repository(repository.id).error=error.message;this.persist(true);this.broadcastState();});throw error;}
    }
    if(method==='worktrees.open'){
      const p=hostRef.extend({worktreeId:idSchema,groupId:idSchema,preferredId:idSchema.optional(),tabTarget:idSchema.optional()}).strict().parse(params);
      const worktree=this.worktree(p.worktreeId),group=this.group(p.groupId);
      // An exited/history tab remains useful even when its folder has disappeared.
      if(!this.terminals.some(t=>t.groupId===group.id&&t.worktreeId===worktree.id))await this.projectRead(()=>validateWorktree(this.repository(worktree.repositoryId),worktree,this.options.dataDir),client);
      return this.projectCommit(()=>{check();return this.openWorktree(this.worktree(p.worktreeId),this.group(p.groupId),client,p.preferredId,p.tabTarget);});
    }
    if(method==='worktrees.rename'){
      const p=hostRef.extend({worktreeId:idSchema,name:nameSchema}).strict().parse(params);
      return this.projectCommit(()=>{check();const worktree=this.worktree(p.worktreeId);worktree.name=p.name;this.persist(true);this.broadcastState();return structuredClone(worktree);});
    }
    if(method==='worktrees.operation'){
      const p=hostRef.extend({id:idSchema}).strict().parse(params);return structuredClone(this.operation(p.id));
    }
    if(method==='worktrees.create'||method==='worktrees.remove'){
      const createSchema=hostRef.extend({requestId:idSchema,groupId:idSchema,repositoryId:idSchema.optional(),name:nameSchema,baseRef:z.string().min(1).max(300),branch:z.string().min(1).max(200).optional(),path:cwdSchema.optional(),existingBranch:z.boolean().default(false),openTerminal:z.boolean(),tabTarget:idSchema.optional()}).strict();
      const removeSchema=hostRef.extend({requestId:idSchema,groupId:idSchema,worktreeId:idSchema,confirmed:z.literal(true)}).strict();
      const p=method==='worktrees.create'?createSchema.parse(params):removeSchema.parse(params);
      const fingerprint=createHash('sha256').update(JSON.stringify({...p,hostId:undefined,bootId:undefined,requestId:undefined})).digest('hex');
      return this.projectCommit(()=>{
        check();const old=this.worktreeOperations.find(op=>op.requestId===p.requestId);
        if(old){if(old.fingerprint!==fingerprint)throw new AppError('REQUEST_CHANGED','같은 요청으로 다른 작업을 보낼 수 없습니다. 새로 시도해 주세요.');return structuredClone(old);}
        const group=this.group(p.groupId),repositoryIds=groupRepositoryIds(group);
        const repositoryId='worktreeId' in p?this.worktree(p.worktreeId).repositoryId:p.repositoryId||(repositoryIds.length===1?repositoryIds[0]:undefined);
        if(!repositoryId||!repositoryIds.includes(repositoryId))throw new AppError('PROJECT_NOT_FOUND','워크트리를 만들 저장소를 터미널에서 선택해 주세요.');
        const repository=this.repository(repositoryId);
        if(this.worktreeOperations.filter(op=>op.status==='pending'||op.status==='running').length>=8)throw new AppError('WORKTREE_BUSY','진행 중인 워크트리 작업이 많습니다. 완료 후 다시 시도해 주세요.');
        const worktreeId='worktreeId' in p?p.worktreeId:randomUUID();
        if('worktreeId' in p){const target=this.worktree(worktreeId);if(target.repositoryId!==repository.id||target.main||!target.managed)throw new AppError('WORKTREE_PROTECTED','이 프로젝트에서 앱이 만든 연결 워크트리만 삭제할 수 있습니다.');this.assertNoWorktreeTerminals(target);if(target.status!=='ready')throw new AppError('WORKTREE_UNAVAILABLE','먼저 목록을 새로고침해 폴더 상태를 확인해 주세요.');target.status='removing';}
        const op:WorktreeOperation={id:randomUUID(),requestId:p.requestId,fingerprint,kind:'name' in p?'create':'remove',repositoryId:repository.id,groupId:group.id,worktreeId,status:'pending',createdAt:Date.now(),...('name' in p?{name:p.name}:{path:this.worktree(worktreeId).path})};
        // Retain the latest 256 finished requests as a bounded retry journal.
        if(this.worktreeOperations.length>=256){const oldest=this.worktreeOperations.findIndex(item=>item.status==='succeeded'||item.status==='failed');if(oldest<0)throw new AppError('LIMIT_REACHED','확인이 필요한 작업을 먼저 정리해 주세요.');this.worktreeOperations.splice(oldest,1);}
        this.worktreeOperations.push(op);this.persist(true);this.broadcastState();
        const previous=this.projectTasks.get(repository.id)||Promise.resolve();
        const job=previous.catch(()=>{}).then(async()=>{
          try{
            if('name' in p){
              const slug=worktreeSlug(p.name),input={name:p.name,branch:p.branch||`worktree/${slug}-${worktreeId.slice(0,8)}`,baseRef:p.baseRef,path:p.path||join(repository.worktreeRoot,`${slug}-${worktreeId.slice(0,8)}`),existingBranch:p.existingBranch};
              const prepared=await prepareWorktree(repository,input,this.options.dataDir);
              await this.projectCommit(()=>{Object.assign(this.operation(op.id),prepared,{status:'running'});this.persist(true);this.broadcastState();});
              const inspection=await addWorktree(repository,prepared,this.options.dataDir);
              await this.projectCommit(()=>{const current=this.repository(repository.id);current.baseRef=p.baseRef;this.mergeProject(current,inspection);this.persist(true);this.broadcastState();});
              let terminalId:string|undefined,message:string|undefined;
              if(p.openTerminal){
                try{terminalId=(await this.projectCommit(()=>this.openWorktree(this.worktree(worktreeId),this.group(group.id),client,undefined,p.tabTarget))).id;}
                catch(error){message=`워크트리는 만들었지만 터미널을 열지 못했습니다. ${error instanceof AppError?error.message:'이름을 눌러 다시 열어 주세요.'}`;}
              }
              await this.projectCommit(()=>{Object.assign(this.operation(op.id),{status:'succeeded',terminalId,message});this.persist(true);this.broadcastState();});
            }else{
              await this.projectCommit(()=>{this.operation(op.id).status='running';this.persist(true);this.broadcastState();});
              const target=this.worktree(worktreeId);
              const inspection=await removeWorktree(repository,target,this.options.dataDir,()=>this.assertNoWorktreeTerminals(this.worktree(worktreeId)));
              await this.projectCommit(()=>{this.worktrees=this.worktrees.filter(w=>w.id!==worktreeId);this.mergeProject(this.repository(repository.id),inspection);Object.assign(this.operation(op.id),{status:'succeeded',message:'워크트리를 삭제했습니다. 브랜치는 남아 있습니다.'});this.persist(true);this.broadcastState();});
            }
          }catch(error){
            try{await this.projectCommit(()=>{const current=this.operation(op.id);current.status=current.status==='running'?'attention':'failed';current.message=error instanceof AppError?error.message:'작업 결과를 확인하지 못했습니다. 목록을 새로고침해 주세요.';const target=this.worktrees.find(w=>w.id===worktreeId);if(target?.status==='removing')target.status='ready';this.persist(true);this.broadcastState();});}
            catch{this.notice('STORAGE_ERROR','워크트리 작업 결과를 저장하지 못했습니다. 목록을 새로고침해 실제 결과를 확인해 주세요.');}
          }
        }).finally(()=>{if(this.projectTasks.get(repository.id)===job)this.projectTasks.delete(repository.id);});
        this.projectTasks.set(repository.id,job);return structuredClone(op);
      });
    }
    throw new AppError('UNKNOWN_METHOD','지원하지 않는 프로젝트 요청입니다.');
  }
  private async readFiles(method: string, params: unknown, ctx: ConnectionContext) {
    const schema = terminalRef.extend({ root: cwdSchema, path: z.string().max(4096).default('') });
    const pdfParams = method === 'files.pdf' ? schema.extend({ offset: z.number().int().min(0).max(8 * 1024 * 1024), version: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(params) : undefined;
    const p = pdfParams || schema.strict().parse(params);
    if (method === 'git.status' && p.path !== '') throw new AppError('INVALID_REQUEST', 'Git 상태는 현재 터미널 폴더에서 확인해 주세요.');
    const originalClient = this.clients.get(ctx.id);
    const check = () => {
      if (this.closing || this.shutdownPrepared) throw new AppError('HOST_UNAVAILABLE', '호스트가 종료 중입니다.');
      const client = this.clients.get(ctx.id);
      if (!client || client !== originalClient || client.ctx.deviceId !== ctx.deviceId) throw new AppError('NOT_CONNECTED', '연결을 다시 열어 주세요.');
      const info = this.target(p);
      if ((info.currentCwd || info.cwd) !== p.root) throw new AppError('FILES_ROOT_CHANGED', '터미널의 현재 폴더가 바뀌었습니다. 새로고침해 주세요.');
    };
    check();
    const count = this.fileReads.get(ctx.id) || 0;
    if (count >= 2 || [...this.fileReads.values()].reduce((a, b) => a + b, 0) >= 8) throw new AppError('FILES_BUSY', '파일을 읽는 중입니다. 잠시 후 다시 시도해 주세요.');
    this.fileReads.set(ctx.id, count + 1);
    try {
      const result = pdfParams ? await readPdfChunk(p.root, p.path, this.options.dataDir, pdfParams.offset, pdfParams.version) : method === 'git.status' ? await inspectGit(p.root, this.options.dataDir) : method === 'files.open' ? await openFileDocument(p.root, p.path, this.options.dataDir) : await inspectFiles(p.root, p.path, this.options.dataDir, method === 'files.preview');
      check();
      if (method === 'files.open' && 'version' in result && result.version && 'absolutePath' in result && !('readOnlyReason' in result && result.readOnlyReason)) {
        if ([...this.fileDocuments.values()].filter(item => item.client === originalClient).length >= 32 || this.fileDocuments.size >= 128) throw new AppError('FILES_LIMIT', '열린 파일이 많습니다. 사용하지 않는 파일 탭을 닫아 주세요.');
        const documentId = randomUUID();
        // The connection-scoped grant keeps an opened file editable after cd or pane selection changes.
        const openedRoot = await realpath(p.root);
        check();
        this.fileDocuments.set(documentId, { client: originalClient!, root: openedRoot, path: p.path, absolutePath: result.absolutePath });
        return { ...result, documentId };
      }
      return result;
    } finally {
      const remaining = (this.fileReads.get(ctx.id) || 1) - 1;
      if (remaining) this.fileReads.set(ctx.id, remaining); else this.fileReads.delete(ctx.id);
    }
  }
  private async editFile(method: string, params: unknown, ctx: ConnectionContext) {
    const reference = hostRef.extend({ documentId: idSchema });
    const p = method === 'files.save' ? reference.extend({ version: z.string().regex(/^[a-f0-9]{64}$/), contentBase64: z.string().max(87384) }).strict().parse(params) : reference.strict().parse(params);
    const grant = this.fileDocuments.get(p.documentId);
    const check = () => {
      if (this.closing || this.shutdownPrepared) throw new AppError('HOST_UNAVAILABLE', '호스트가 종료 중입니다.');
      const client = this.clients.get(ctx.id);
      if (!client || client.ctx.deviceId !== ctx.deviceId) throw new AppError('NOT_CONNECTED', '컴퓨터에 다시 연결해 주세요.');
      if (p.hostId !== this.hostId || p.bootId !== this.bootId) throw new AppError('HOST_CHANGED', '접속한 컴퓨터가 바뀌었습니다.');
      if (!grant || grant.client !== client || this.fileDocuments.get(p.documentId) !== grant) throw new AppError('FILES_DOCUMENT_EXPIRED', '연결이 바뀌어 파일을 다시 열어야 합니다. 내 수정 내용을 복사한 뒤 디스크 파일을 다시 열어 주세요.');
    };
    check();
    if (method === 'files.close') { this.fileDocuments.delete(p.documentId); return { ok: true }; }
    const count = this.fileReads.get(ctx.id) || 0;
    if (count >= 2 || [...this.fileReads.values()].reduce((a, b) => a + b, 0) >= 8) throw new AppError('FILES_BUSY', '파일 작업 중입니다. 잠시 후 다시 시도해 주세요.');
    this.fileReads.set(ctx.id, count + 1);
    try {
      if (method === 'files.reload') {
        const result = await openFileDocument(grant!.root, grant!.path, this.options.dataDir);
        check();
        return { ...result, documentId: p.documentId };
      }
      if (!('version' in p) || typeof p.version !== 'string' || !('contentBase64' in p) || typeof p.contentBase64 !== 'string') throw new AppError('INVALID_REQUEST', '저장할 내용을 확인해 주세요.');
      const result = await saveFileDocument(grant!.root, grant!.path, this.options.dataDir, p.version, p.contentBase64, check);
      return { ...result, documentId: p.documentId };
    } finally {
      const remaining = (this.fileReads.get(ctx.id) || 1) - 1;
      if (remaining) this.fileReads.set(ctx.id, remaining); else this.fileReads.delete(ctx.id);
    }
  }
  private async route(method: string, params: unknown, client: Client): Promise<any> {
    switch (method) {
      case 'state.get': return this.getState();
      case 'connection.info': return {...client.ctx};
      case 'host.shutdown': {
        if(!client.ctx.owner)throw new AppError('OWNER_REQUIRED','이 컴퓨터에서 완전히 종료해 주세요.');
        z.object({}).strict().parse(params);
        await this.prepareShutdown();
        return {ok:true};
      }
      case 'heartbeat':
        for (const runtime of this.runtimes.values()) if (runtime.lease?.connectionId === client.ctx.id) runtime.lease.expires = Date.now()+LEASE_MS;
        return {bootId:this.bootId, now:Date.now(), connectionId:client.ctx.id};
      case 'groups.create': {
        const p = z.object({name:nameSchema,cwd:cwdSchema.optional(),profileId:z.string().max(300).optional()}).strict().parse(params);
        if (this.groups.length >= 100) throw new AppError('LIMIT_REACHED','그룹은 최대 100개까지 만들 수 있습니다.');
        const profile = this.profile(p.profileId || this.profiles[0]?.id || '');
        const launch = await resolveShellLaunch(profile,p.cwd || homedir());
        this.requireClient(client);
        const group: Group = {id:randomUUID(),name:p.name,cwd:launch.cwd,profileId:profile.id,revision:0,layout:null};
        this.groups.push(group);this.persist(true);this.broadcastState();return structuredClone(group);
      }
      case 'groups.update': {
        const p = z.object({id:idSchema,name:nameSchema.optional(),cwd:cwdSchema.optional(),profileId:z.string().max(300).optional(),revision:z.number().int().nonnegative()}).strict().parse(params);
        const group = this.group(p.id); this.revision(group,p.revision);
        const profile = this.profile(p.profileId || group.profileId);
        const launch = await resolveShellLaunch(profile,p.cwd || group.cwd);
        this.requireClient(client);
        Object.assign(group,{name:p.name || group.name,profileId:profile.id,cwd:launch.cwd,revision:group.revision+1});
        this.persist(true);this.broadcastState();return structuredClone(group);
      }
      case 'groups.layout': {
        // Bound recursion before the recursive Zod parser to avoid adversarial stack exhaustion.
        this.checkTreeSize((params as any)?.layout);
        const p = z.object({id:idSchema,layout:layoutSchema.nullable(),revision:z.number().int().nonnegative()}).strict().parse(params);
        const group = this.group(p.id);this.revision(group,p.revision);
        const ids = leafIds(p.layout), expected = this.terminals.filter(t=>t.groupId===group.id).map(t=>t.id);
        if (new Set(ids).size !== ids.length || ids.length !== expected.length || ids.some(id=>!expected.includes(id))) throw new AppError('INVALID_LAYOUT','그룹의 터미널을 각각 한 번씩 배치해야 합니다.');
        group.layout=p.layout;group.revision++;this.persist(true);this.broadcastState();return structuredClone(group);
      }
      case 'groups.reorder': {
        const p=z.object({ids:z.array(idSchema).max(100)}).strict().parse(params);
        if (p.ids.length!==this.groups.length || new Set(p.ids).size!==p.ids.length || p.ids.some(id=>!this.groups.some(g=>g.id===id))) throw new AppError('INVALID_ORDER','모든 그룹을 한 번씩 지정해 주세요.');
        this.groups=p.ids.map(id=>this.group(id));this.persist(true);this.broadcastState();return structuredClone(this.groups);
      }
      case 'groups.delete': {
        const p=z.object({id:idSchema,terminate:z.boolean(),revision:z.number().int().nonnegative()}).strict().parse(params);this.revision(this.group(p.id),p.revision);
        if(this.worktreeOperations.some(op=>op.groupId===p.id&&(op.status==='pending'||op.status==='running')))throw new AppError('WORKTREE_BUSY','워크트리 작업이 끝난 뒤 프로젝트를 제거해 주세요.');
        const terminals=this.terminals.filter(t=>t.groupId===p.id);
        if (!p.terminate && terminals.some(t=>t.status==='running')) throw new AppError('CONFIRM_REQUIRED','실행 중인 터미널을 종료하려면 확인이 필요합니다.');
        for (const info of terminals) await this.removeTerminal(info);
        this.groups=this.groups.filter(g=>g.id!==p.id);this.persist(true);this.broadcastState();return {removed:true};
      }
      case 'terminals.create': {
        const p=z.object({groupId:idSchema,profileId:z.string().max(300).optional(),cwd:cwdSchema.optional(),splitTarget:idSchema.optional(),tabTarget:idSchema.optional(),axis:z.enum(['horizontal','vertical']).optional(),worktreeId:idSchema.optional()}).strict().parse(params);
        const group=this.group(p.groupId);
        if (this.terminals.filter(t=>t.groupId===group.id).length>=16 || this.terminals.filter(t=>t.status==='running').length>=32 || this.terminals.length>=128) throw new AppError('LIMIT_REACHED','터미널 한도에 도달했습니다. 사용하지 않는 터미널을 정리해 주세요.');
        if (p.splitTarget && !leafIds(group.layout).includes(p.splitTarget)) throw new AppError('INVALID_TARGET','분할할 터미널을 찾을 수 없습니다.');
        if (p.tabTarget && (p.splitTarget || p.axis || !leafIds(group.layout).includes(p.tabTarget))) throw new AppError('INVALID_TARGET','탭을 추가할 분할 영역을 찾을 수 없습니다.');
        const target=p.tabTarget || p.splitTarget;
        const source=target ? this.terminal(target) : undefined;
        const worktree=p.worktreeId?this.worktree(p.worktreeId):undefined;
        if(worktree&&worktree.status!=='ready')throw new AppError('WORKTREE_UNAVAILABLE','워크트리 폴더를 사용할 수 없습니다. 목록을 새로고침해 주세요.');
        const profile=this.profile(p.profileId || source?.profileId || group.profileId);
        if(worktree&&profile.kind==='wsl')throw new AppError('WORKTREE_UNSUPPORTED','워크트리 터미널은 PowerShell·CMD·Git Bash로 열어 주세요. WSL 내부 경로는 아직 지원하지 않습니다.');
        const launch=await resolveShellLaunch(profile,p.cwd || worktree?.path || source?.currentCwd || source?.cwd || group.cwd);
        // Git reports canonical paths; TEMP and user-selected directories may
        // use an 8.3 alias or junction. Keep the chosen cwd, compare its location.
        const worktreeCwd=profile.kind==='wsl'?launch.cwd:await realpath(launch.cwd);
        if(worktree&&!within(worktree.path,worktreeCwd))throw new AppError('INVALID_CWD','연결된 워크트리 안의 시작 폴더를 선택해 주세요.');
        const associated=worktree||(profile.kind!=='wsl'?this.worktrees.filter(w=>w.status==='ready'&&within(w.path,worktreeCwd)).sort((a,b)=>b.path.length-a.path.length)[0]:undefined);
        if(this.worktrees.some(w=>w.status==='removing'&&within(w.path,worktreeCwd)))throw new AppError('WORKTREE_BUSY','삭제 중인 워크트리에서는 터미널을 열 수 없습니다.');
        this.requireClient(client);
        const info:TerminalInfo={id:randomUUID(),groupId:group.id,title:profile.name,profileId:profile.id,cwd:launch.cwd,generation:randomUUID(),status:'interrupted',cols:100,rows:30,...(associated?{worktreeId:associated.id}:{})};
        const previousLayout=group.layout,previousRevision=group.revision;
        if(associated)group.repositoryIds=[...new Set([...groupRepositoryIds(group),associated.repositoryId])];
        this.terminals.push(info);group.layout=p.tabTarget?appendTab(group.layout!,p.tabTarget,info.id):splitLeaf(group.layout,p.splitTarget,info.id,p.axis || 'horizontal');group.revision++;
        try{this.persist(true);}catch(error){this.terminals=this.terminals.filter(t=>t.id!==info.id);group.layout=previousLayout;group.revision=previousRevision;throw error;}
        try {await this.startTerminal(info,profile,launch);} finally {this.persist();this.broadcastState();}
        return structuredClone(info);
      }
      case 'terminals.rename': {
        const p=z.object({id:idSchema,title:nameSchema}).strict().parse(params);const info=this.terminal(p.id);info.title=p.title;this.persist(true);this.broadcastState();return structuredClone(info);
      }
      case 'terminals.move': {
        const p=terminalRef.extend({groupId:idSchema,splitTarget:idSchema.optional(),axis:z.enum(['horizontal','vertical']).optional()}).strict().parse(params);
        const info=this.target(p),source=this.group(info.groupId),destination=this.group(p.groupId);
        if(source.id===destination.id)throw new AppError('INVALID_TARGET','다른 그룹을 선택해 주세요.');
        if(this.terminals.filter(t=>t.groupId===destination.id).length>=16)throw new AppError('LIMIT_REACHED','대상 그룹의 터미널 한도에 도달했습니다.');
        if(p.splitTarget&&!leafIds(destination.layout).includes(p.splitTarget))throw new AppError('INVALID_TARGET','대상 그룹의 분할 위치를 찾을 수 없습니다.');
        source.layout=removeLeaf(source.layout,info.id);source.revision++;
        destination.layout=splitLeaf(destination.layout,p.splitTarget,info.id,p.axis || 'horizontal');destination.revision++;
        if(info.worktreeId)destination.repositoryIds=[...new Set([...groupRepositoryIds(destination),this.worktree(info.worktreeId).repositoryId])];
        info.groupId=destination.id;this.persist(true);this.broadcastState();return structuredClone(info);
      }
      case 'terminals.terminate': {
        const p=terminalRef.strict().parse(params);const info=this.target(p);await this.stopTerminal(info);this.persist();this.broadcastState();return structuredClone(info);
      }
      case 'terminals.remove': {
        const p=terminalRef.extend({terminate:z.boolean()}).strict().parse(params);const info=this.target(p);
        if (info.status==='running' && !p.terminate) throw new AppError('CONFIRM_REQUIRED','실행 중인 터미널의 종료를 확인해 주세요.');
        await this.removeTerminal(info);this.persist(true);this.broadcastState();return {removed:true};
      }
      case 'terminals.restart': {
        const p=terminalRef.extend({confirmed:z.boolean().optional()}).strict().parse(params);const info=this.target(p);
        if (info.status==='running' && !p.confirmed) throw new AppError('CONFIRM_REQUIRED','실행 중인 터미널을 종료하고 새 셸을 여는지 확인해 주세요.');
        if (info.status!=='running' && this.terminals.filter(t=>t.status==='running').length>=32) throw new AppError('LIMIT_REACHED','실행 가능한 터미널 수를 넘었습니다.');
        const profile=this.profile(info.profileId),launch=await resolveShellLaunch(profile,info.cwd);
        this.requireClient(client);
        await this.disposeRuntime(info.id);
        this.requireClient(client);
        this.agentSessions.delete(info.id);info.generation=randomUUID();info.notificationCount=0;info.exitCode=undefined;info.historyAvailable=false;info.status='interrupted';info.resumeOnBoot=false;delete info.restoreError;this.group(info.groupId).revision++;
        for(const connection of this.clients.values())connection.attached.delete(info.id);
        this.archivedSequences.delete(info.id);this.archivedFrames.delete(info.id);this.persist(true,[info.id]);
        try {await this.startTerminal(info,profile,launch);} finally {this.persist();this.broadcastState();}
        return structuredClone(info);
      }
      case 'terminals.attach': {
        const p=terminalRef.strict().parse(params);const info=this.target(p);
        client.attached.set(info.id,{lastSent:0,lastAck:0});
        const frame=await this.frame(info);client.attached.get(info.id)!.lastSent=frame.seq;return frame;
      }
      case 'terminals.detach': {
        const p=z.object({id:idSchema}).strict().parse(params);client.attached.delete(p.id);
        const runtime=this.runtimes.get(p.id);if(runtime?.lease?.connectionId===client.ctx.id){this.revoke(runtime);this.broadcastState();}return {detached:true};
      }
      case 'control.acquire': {
        const p=terminalRef.merge(dimensionSchema).extend({takeover:z.boolean().default(true)}).strict().parse(params);const info=this.target(p),runtime=this.running(info);
        // The mutation queue makes the check and lease replacement atomic.
        // A stale viewer must not resize, revoke or interrupt another controller.
        if(!p.takeover && runtime.lease && runtime.lease.connectionId!==client.ctx.id && runtime.lease.expires>Date.now())throw new AppError('CONTROL_BUSY','다른 기기에서 제어 중입니다. 가져오기를 눌러 제어권을 가져오세요.');
        this.revoke(runtime);this.broadcastState();
        runtime.epoch++;const lease:Lease={connectionId:client.ctx.id,deviceName:client.ctx.deviceName,epoch:runtime.epoch,expires:Date.now()+LEASE_MS,ready:false,syncSeq:Infinity,inputSeq:-1,dedupe:new Map()};runtime.lease=lease;
        this.updateController(runtime);
        if(!client.attached.has(info.id)) client.attached.set(info.id,{lastSent:0,lastAck:0});
        await this.resize(runtime,p.cols,p.rows);
        const frame=await this.frame(info);this.requireLease(runtime,client,lease.epoch,false);lease.syncSeq=frame.seq;client.attached.get(info.id)!.lastSent=frame.seq;client.attached.get(info.id)!.pending=undefined;
        this.broadcastFrame(frame,client.ctx.id);this.broadcastState();return {epoch:runtime.epoch,frame,connectionId:client.ctx.id};
      }
      case 'control.release': {
        const p=z.object({id:idSchema,epoch:z.number().int().positive()}).strict().parse(params);const runtime=this.running(this.terminal(p.id));this.requireLease(runtime,client,p.epoch,false);this.revoke(runtime);this.broadcastState();return {released:true};
      }
      case 'terminal.ack': {
        const p=terminalRef.extend({seq:z.number().int().nonnegative(),epoch:z.number().int().positive().optional()}).strict().parse(params);const info=this.target(p),attachment=client.attached.get(info.id);
        if(!attachment || p.seq>attachment.lastSent) throw new AppError('INVALID_ACK','적용한 화면 번호가 올바르지 않습니다.');
        attachment.lastAck=Math.max(attachment.lastAck,p.seq);
        const runtime=this.runtimes.get(info.id);
        if(p.epoch!==undefined){if(!runtime)throw new AppError('NOT_RUNNING','터미널이 종료되었습니다.');const lease=this.requireLease(runtime,client,p.epoch,false);if(p.seq>=lease.syncSeq && !lease.ready){lease.ready=true;this.updateController(runtime);this.broadcastState();}}
        this.flushAttachment(client,attachment);
        return {acknowledged:true};
      }
      case 'terminal.input': {
        const p=terminalRef.extend({epoch:z.number().int().positive(),inputId:z.string().min(1).max(100),clientInputSeq:z.number().int().nonnegative(),data:z.string().max(65536),encoding:z.enum(['utf8','binary']).optional()}).strict().parse(params);
        if(Buffer.byteLength(p.data)>65536)throw new AppError('INPUT_TOO_LARGE','한 번에 보낼 수 있는 입력 크기를 넘었습니다.');
        const runtime=this.running(this.target(p)),lease=this.requireLease(runtime,client,p.epoch,true);
        const hash=createHash('sha256').update(p.encoding || 'utf8').update(p.data).digest('hex'),prior=lease.dedupe.get(p.inputId);
        if(prior){if(prior.hash!==hash || prior.seq!==p.clientInputSeq)throw new AppError('INPUT_ID_REUSED','입력 식별자를 다른 입력에 사용할 수 없습니다.');return {accepted:true,inputId:p.inputId,clientInputSeq:p.clientInputSeq,duplicate:true};}
        if(p.clientInputSeq<=lease.inputSeq)throw new AppError('STALE_INPUT','이미 지난 입력 번호입니다. 입력을 자동으로 재전송하지 마세요.');
        const data=p.encoding==='binary'?Buffer.from(p.data,'latin1'):p.data;
        // Someone typed before the restored shell's first prompt: never append a resume line to their input.
        // Focus/mouse/device reports sent by an attaching view are not typing.
        if(runtime.pendingResume&&!isTerminalReportOnly(p.data))this.abandonResume(runtime);
        try {runtime.pty!.write(data);}catch{throw new AppError('WRITE_FAILED','터미널 입력을 전달하지 못했습니다.');}
        // Claude sends no hook after a cancel key or a rejected request, and keys that can move a dialog's
        // selection decide what its Enter means. Only that meaning, never the typed text nor a focus/device
        // report, queues behind already received output: the observer decides with the parsed status. A
        // request is visible only after its hook was parsed, so plain text counts only while one is shown.
        const agentSignal=isTerminalReportOnly(p.data,false)?undefined:agentInputSignal(p.data,runtime.info.agentStatus==='attention');
        if(agentSignal!==undefined)void runtime.engine.observeInput(agentSignal).then(changed=>{if(changed)this.scheduleFrame(runtime);}).catch(()=>{});
        lease.inputSeq=p.clientInputSeq;lease.dedupe.set(p.inputId,{seq:p.clientInputSeq,hash});if(lease.dedupe.size>2048)lease.dedupe.delete(lease.dedupe.keys().next().value!);
        return {accepted:true,inputId:p.inputId,clientInputSeq:p.clientInputSeq,duplicate:false};
      }
      case 'terminal.resize': {
        const p=terminalRef.merge(dimensionSchema).extend({epoch:z.number().int().positive()}).strict().parse(params);const runtime=this.running(this.target(p)),lease=this.requireLease(runtime,client,p.epoch,false);
        lease.ready=false;this.updateController(runtime);await this.resize(runtime,p.cols,p.rows);
        const frame=await this.frame(runtime.info);this.requireLease(runtime,client,lease.epoch,false);lease.syncSeq=frame.seq;client.attached.get(p.id)!.lastSent=frame.seq;client.attached.get(p.id)!.pending=undefined;
        this.broadcastFrame(frame,client.ctx.id);this.broadcastState();return {frame};
      }
      case 'settings.update': {
        if(!client.ctx.owner)throw new AppError('OWNER_REQUIRED','이 컴퓨터에서 설정을 변경해 주세요.');
        const p=z.object({name:nameSchema.optional(),recordHistory:z.boolean().optional()}).strict().parse(params);
        if(p.name!==undefined)this.settings.name=p.name;
        if(p.recordHistory!==undefined){this.settings.recordHistory=p.recordHistory;if(!p.recordHistory){for(const info of this.terminals)info.historyAvailable=false;}}
        this.persist(true,p.recordHistory===false?'all':undefined);this.broadcastState();return {...this.settings};
      }
      case 'settings.export': {
        if(!client.ctx.owner)throw new AppError('OWNER_REQUIRED','이 컴퓨터에서 설정을 내보내 주세요.');
        z.object({}).strict().parse(params);
        const config={version:1 as const,name:this.settings.name,recordHistory:this.settings.recordHistory,groups:this.groups.map(({name,cwd,profileId})=>({name,cwd,profileId}))};
        if(Buffer.byteLength(JSON.stringify(config))>96*1024)throw new AppError('EXPORT_TOO_LARGE','설정 파일이 크기 한도를 넘었습니다. 그룹의 긴 경로를 정리해 주세요.');
        return config;
      }
      case 'settings.import': {
        if(!client.ctx.owner)throw new AppError('OWNER_REQUIRED','이 컴퓨터에서 설정을 가져와 주세요.');
        const p=z.object({config:exportedSettingsSchema,confirmed:z.literal(true)}).strict().parse(params);
        if(Buffer.byteLength(JSON.stringify(p.config))>96*1024)throw new AppError('IMPORT_TOO_LARGE','설정 파일은 96KiB 이하여야 합니다.');
        if(this.groups.length+p.config.groups.length>100)throw new AppError('LIMIT_REACHED','기존 그룹과 가져올 그룹의 합계가 100개를 넘습니다.');
        const warnings=['현재 컴퓨터 이름과 기록 저장 설정은 그대로 유지했습니다. 가져온 그룹에는 실행 중인 터미널이 없습니다.'];
        const imported:Group[]=[];
        for(const source of p.config.groups){
          const profile=this.profiles.find(value=>value.id===source.profileId) || this.profiles[0];
          if(!profile)throw new AppError('PROFILE_NOT_FOUND','설치된 셸이 없어 그룹을 가져올 수 없습니다.');
          if(profile.id!==source.profileId)warnings.push(`${source.name}: 사용할 수 없는 셸을 ${profile.name}(으)로 바꿨습니다.`);
          let cwd:string;
          try{cwd=(await resolveShellLaunch(profile,source.cwd)).cwd;}catch(error){if(!(error instanceof AppError) || error.code!=='INVALID_CWD')throw error;cwd=(await resolveShellLaunch(profile,homedir())).cwd;warnings.push(`${source.name}: 작업 폴더가 없어 사용자 홈 폴더를 사용합니다.`);}
          imported.push({id:randomUUID(),name:source.name,cwd,profileId:profile.id,revision:0,layout:null});
        }
        this.requireClient(client);this.groups.push(...imported);this.persist(true);this.broadcastState();return {importedGroups:imported.length,warnings};
      }
      case 'history.clear': {
        const p=z.object({id:idSchema}).strict().parse(params);const info=this.terminal(p.id),runtime=this.runtimes.get(info.id);
        if(runtime){await runtime.engine.clearHistory();runtime.lastFrame=undefined;}
        this.archivedFrames.delete(info.id);
        this.store.clearSnapshot(info.id);info.historyAvailable=false;
        const frame=await this.frame(info);this.broadcastFrame(frame);this.persist();this.broadcastState();return {cleared:true};
      }
      default:throw new AppError('UNKNOWN_METHOD','지원하지 않는 요청입니다.');
    }
  }
  private async restoreTerminal(info:TerminalInfo):Promise<void> {
    const previous={...info};
    const previousRecord=this.agentSessions.get(info.id);
    try {
      if(info.worktreeId){const worktree=this.worktree(info.worktreeId);await validateWorktree(this.repository(worktree.repositoryId),worktree,this.options.dataDir);}
      if(this.terminals.filter(item=>item.status==='running').length>=32)throw new AppError('LIMIT_REACHED','실행 가능한 터미널 수를 넘어 새 셸을 열지 못했습니다.');
      const profile=this.profile(info.profileId);
      // Resume only the exact conversation recorded for this generation, in its own
      // folder. A missing folder or unsupported shell restores a plain shell only.
      const record=this.agentSessions.get(info.id);
      const resume=record&&record.generation===info.generation?record.session:undefined;
      const executable=resume?.cwd&&resume.provider==='claude'?await resolveAgentExecutable(resume.provider,safeShellEnvironment()):undefined;
      // Codex needs the session-local PowerShell wrapper, which exists only with a live lifecycle pipe.
      const codexWrapper=this.options.codexIntegration?.status==='installed'&&AGENT_PIPE_NAME.test(process.env.MONGLE_AGENT_PIPE||'');
      let command=resume?.cwd?agentResumeCommand(profile,resume,executable,{codexWrapper}):undefined;
      let launch:Awaited<ReturnType<typeof resolveShellLaunch>>|undefined;
      if(command&&resume?.cwd){try{launch=await resolveShellLaunch(profile,resume.cwd);}catch{command=undefined;}}
      else command=undefined;
      launch??=await resolveShellLaunch(profile,info.cwd);
      const snapshot=this.settings.recordHistory?this.store.getSnapshot(info.id,info.generation):undefined;
      info.generation=randomUUID();info.notificationCount=0;info.historyAvailable=false;delete info.restoreError;
      // Move the intent to the new generation before the shell starts. It is saved with
      // this restore, so a shutdown before the first prompt still resumes next boot;
      // a fast SessionStart from the resumed CLI simply overwrites it. Without a resume
      // line there is no intent. A failed restore puts the old record back.
      if(command&&resume)this.agentSessions.set(info.id,{generation:info.generation,session:resume});
      else this.agentSessions.delete(info.id);
      await this.startTerminal(info,profile,launch,snapshot,command);
      // Commit the replacement generation and its restored history together.
      // A second boot must never see metadata pointing at the old generation's frame.
      const runtime=this.runtimes.get(info.id)!;
      const restored=this.settings.recordHistory?await runtime.engine.snapshot():undefined;
      info.historyAvailable=Boolean(restored);info.resumeOnBoot=info.status==='running';
      this.store.save(this.persisted(),undefined,restored?[{terminalId:info.id,generation:info.generation,snapshot:restored}]:[]);
      runtime.checkpointAt=Date.now();
    } catch(error) {
      const runtime=this.runtimes.get(info.id);
      if(runtime){runtime.disposed=true;await this.disposeRuntime(info.id);}
      // Missing folders/profiles or a failed spawn keep the previous generation
      // and frame readable; no substitute shell or command is executed.
      Object.assign(info,previous,{status:'interrupted',resumeOnBoot:true,restoreError:error instanceof AppError?error.message:'새 셸을 복원하지 못했습니다. 이전 기록은 그대로 보관됩니다.'});
      delete info.pid;delete info.controller;
      if(previousRecord&&previousRecord.generation===info.generation)this.agentSessions.set(info.id,previousRecord);
    }
  }
  private async startTerminal(info:TerminalInfo,profile:ShellProfile,launch:{executable:string;args:string[];cwd:string},history?:PresentationSnapshot,resumeCommand?:string) {
    const runtime={} as Runtime;
    Object.assign(runtime,{info,seq:0,epoch:0,checkpointAt:0,disposed:false,pendingBytes:0});
    info.notificationCount=0;
    delete info.agentStatus; delete info.agentProvider; delete info.agentNotificationCount;
    // Every non-WSL shell gets a per-shell secret: its prompt marker authenticates
    // "back at the shell" for status and agent resume, independent of Claude setup.
    const agentToken = profile.kind !== 'wsl' ? randomBytes(32).toString('hex') : undefined;
    runtime.agentToken=agentToken;
    const current=()=>!runtime.disposed&&!runtime.stopping&&!this.closing&&!this.shutdownPrepared&&this.runtimes.get(info.id)===runtime;
    delete info.currentCwd;
    runtime.engine=new TerminalEngine({cols:info.cols,rows:info.rows,scrollback:this.settings.scrollback,
      notificationsEnabled:()=>!runtime.disposed&&!this.closing&&!this.shutdownPrepared&&this.runtimes.get(info.id)===runtime,
      onNotification:count=>{info.notificationCount=count;runtime.notificationChanged=true;},
      agentToken,
      onAgentStatus:(status,count)=>{info.agentStatus=status;info.agentProvider='claude';if(count!==undefined)info.agentNotificationCount=count;runtime.notificationChanged=true;},
      onAgentSession:session=>{if(current())this.recordAgentSession(info,session);},
      // The first prompt after a restore types the resume line and keeps the intent until
      // the CLI reports itself or exits; any other prompt means no agent is running.
      onShellPrompt:()=>{if(!current())return;if(!this.dispatchResume(runtime))this.recordAgentSession(info,null);},
      onDirectory:directory=>{if(!runtime.disposed&&info.currentCwd!==directory){info.currentCwd=directory;runtime.directoryChanged=true;}},onResponse:(data:string)=>{try{if(runtime.pty && info.status==='running')runtime.pty.write(data);}catch{/* exit can race an emulator reply */}}});
    this.runtimes.set(info.id,runtime);
    if(resumeCommand){const timer=setTimeout(()=>{if(!runtime.pendingResume||!current())return;this.abandonResume(runtime);this.notice('AGENT_RESUME_SKIPPED',`${info.title}: 셸 준비를 확인하지 못해 이전 대화를 자동으로 이어 가지 않았습니다. 필요하면 직접 다시 열어 주세요.`);},RESUME_PROMPT_TIMEOUT_MS);timer.unref?.();runtime.pendingResume={command:resumeCommand,timer};}
    try {
      if(history)await runtime.engine.restoreHistory(history);
      const environment=safeShellEnvironment();
      if(agentToken)environment.MONGLE_AGENT_TOKEN=agentToken;
      const integration=shellIntegration(profile,launch.args,environment);
      runtime.pty=pty.spawn(launch.executable,integration.args,{name:'xterm-256color',cols:info.cols,rows:info.rows,cwd:launch.cwd,env:integration.env,useConpty:true,useConptyDll:true});
      runtime.stopPty=installPtyLifecycle(runtime.pty);
    } catch {
      this.cancelResume(runtime);
      if(runtime.pty)try{if(runtime.stopPty)await runtime.stopPty();else runtime.pty.kill();}catch{}
      await runtime.engine.dispose();this.runtimes.delete(info.id);throw new AppError('SHELL_START_FAILED',`${profile.name}을 실행하지 못했습니다. 셸과 작업 폴더를 확인해 주세요.`);
    }
    info.status='running';info.pid=runtime.pty.pid;info.exitCode=undefined;
    runtime.pty.onData(data=>{
      if(runtime.disposed)return;
      const bytes=Buffer.byteLength(data);runtime.pendingBytes+=bytes;
      if(runtime.pendingBytes>1024*1024)try{runtime.pty?.pause();}catch{}
      void runtime.engine.write(data).then(()=>{runtime.pendingBytes-=bytes;if(runtime.pendingBytes<256*1024)try{runtime.pty?.resume();}catch{}this.scheduleFrame(runtime);}).catch(()=>this.notice('TERMINAL_RENDER_ERROR','터미널 출력을 처리하지 못했습니다.'));
    });
    runtime.pty.onExit(({exitCode})=>{
      if(runtime.disposed || this.runtimes.get(info.id)!==runtime)return;
      info.status='exited';info.exitCode=exitCode;delete info.pid;delete info.agentStatus;delete info.agentProvider;delete info.agentNotificationCount;runtime.pty=undefined;this.revoke(runtime);this.cancelResume(runtime);
      // A shell that ended by itself has no conversation to reopen. Shutdown keeps the saved one.
      if(!this.closing && !this.shutdownPrepared){info.resumeOnBoot=false;this.agentSessions.delete(info.id);}
      this.persist();this.broadcastState();
      // A completed process no longer needs a 5,000-line mutable VT engine.
      // Queue final-frame capture behind any accepted lifecycle operation.
      const archive=this.queue.then(()=>this.archiveExited(runtime));this.queue=archive.catch(()=>this.notice('HISTORY_FAILED','종료된 터미널 기록을 정리하지 못했습니다.'));
    });
  }
  private scheduleFrame(runtime:Runtime) {
    if(!this.initialized || runtime.disposed || this.closing)return;
    if(runtime.framePending){runtime.frameDirty=true;return;}
    if(runtime.timer)return;
    const hasViewer=[...this.clients.values()].some(c=>c.attached.has(runtime.info.id));
    runtime.timer=setTimeout(()=>{
      runtime.timer=undefined;runtime.framePending=true;runtime.frameDirty=false;
      void this.frame(runtime.info).then(frame=>{if(!runtime.disposed){this.broadcastFrame(frame);if(this.settings.recordHistory && Date.now()-runtime.checkpointAt>1000)this.checkpoint(runtime,frame);}})
        .catch(()=>{if(!runtime.disposed&&!this.closing)this.notice('SNAPSHOT_FAILED','터미널 화면을 동기화하지 못했습니다.');})
        .finally(()=>{runtime.framePending=false;if(runtime.frameDirty){runtime.frameDirty=false;this.scheduleFrame(runtime);}});
    },hasViewer?60:1000);
    runtime.timer.unref();
  }
  private async frame(info:TerminalInfo):Promise<SnapshotEvent> {
    const runtime=this.runtimes.get(info.id);
    let snapshot:PresentationSnapshot;
    if(runtime){snapshot=await runtime.engine.snapshot();if((runtime.directoryChanged||runtime.notificationChanged)&&!runtime.disposed&&!this.closing&&!this.shutdownPrepared){runtime.directoryChanged=false;runtime.notificationChanged=false;this.broadcastState();}}
    else snapshot=this.archivedFrames.get(info.id) || (this.settings.recordHistory ? this.store.getSnapshot(info.id,info.generation) || await this.blankSnapshot(info) : await this.blankSnapshot(info));
    const seq=runtime?++runtime.seq:(this.archivedSequences.get(info.id) || 0)+1;
    if(!runtime)this.archivedSequences.set(info.id,seq);
    const frame:SnapshotEvent={type:'snapshot',terminalId:info.id,generation:info.generation,bootId:this.bootId,seq,snapshot};
    // Reserve room for an RPC envelope when this frame is returned by attach.
    if(Buffer.byteLength(JSON.stringify(frame))>MAX_FRAME_BYTES-1024)throw new AppError('SNAPSHOT_TOO_LARGE','화면 기록이 연결 한도를 넘었습니다. 기록을 지운 뒤 다시 연결해 주세요.');
    if(runtime)runtime.lastFrame=frame;
    return frame;
  }
  private async blankSnapshot(info:TerminalInfo):Promise<PresentationSnapshot>{
    // A stopped generation may retain metadata without output history. Its
    // empty view still acknowledges that generation's notifications; this
    // temporary renderer is not a new live process with a reset counter.
    const notificationCount=info.notificationCount??0;
    const engine=new TerminalEngine({cols:info.cols,rows:info.rows,scrollback:0,onResponse:()=>{}});
    try{return {...await engine.snapshot(),notificationCount};}finally{await engine.dispose();}
  }
  private broadcastFrame(frame:SnapshotEvent,except?:string){for(const [id,client]of this.clients){const a=client.attached.get(frame.terminalId);if(a&&id!==except){a.pending=frame;this.flushAttachment(client,a);}}}
  private flushAttachment(client:Client,attachment:Attachment){if(attachment.pending && attachment.lastAck>=attachment.lastSent){const frame=attachment.pending;attachment.pending=undefined;if(frame.seq>attachment.lastSent){attachment.lastSent=frame.seq;this.send(client,frame);}}}
  private checkpoint(runtime:Runtime,frame:SnapshotEvent){
    if(!this.initialized || !this.settings.recordHistory)return;
    try{this.store.saveSnapshot(runtime.info.id,runtime.info.generation,frame.snapshot);runtime.checkpointAt=Date.now();runtime.info.historyAvailable=true;}catch{this.storageError='기록을 저장하지 못했습니다. 디스크 공간과 접근 권한을 확인해 주세요.';this.broadcastState();}
  }
  private async archiveExited(runtime:Runtime){
    if(!this.initialized || this.closing || runtime.disposed || runtime.info.status==='running' || this.runtimes.get(runtime.info.id)!==runtime)return;
    const frame=await this.frame(runtime.info);this.checkpoint(runtime,frame);this.broadcastFrame(frame);
    this.archivedFrames.set(runtime.info.id,frame.snapshot);this.archivedSequences.set(runtime.info.id,frame.seq);
    // Capped memory cache is independent of the disk-history setting and never
    // keeps live parser state. Persisted frames can be loaded again on demand.
    let bytes=[...this.archivedFrames.values()].reduce((total,item)=>total+Buffer.byteLength(JSON.stringify(item)),0);
    while(bytes>256*1024*1024 && this.archivedFrames.size>1){const first=this.archivedFrames.keys().next().value!;const old=this.archivedFrames.get(first)!;this.archivedFrames.delete(first);bytes-=Buffer.byteLength(JSON.stringify(old));if(!this.settings.recordHistory)this.notice('HISTORY_EVICTED','메모리 한도로 오래된 종료 화면을 정리했습니다. 기록 저장이 꺼져 있어 해당 화면은 다시 불러올 수 없습니다.');}
    if(runtime.timer)clearTimeout(runtime.timer);runtime.disposed=true;await runtime.engine.dispose();this.runtimes.delete(runtime.info.id);
    this.persist();this.broadcastState();
  }
  private async resize(runtime:Runtime,cols:number,rows:number){
    try{runtime.pty!.resize(cols,rows);await runtime.engine.resize(cols,rows);runtime.info.cols=cols;runtime.info.rows=rows;this.persist();}catch{throw new AppError('RESIZE_FAILED','터미널 크기를 변경하지 못했습니다.');}
  }
  private target(p:{id:string;hostId:string;bootId:string;generation:string}){if(p.hostId!==this.hostId || p.bootId!==this.bootId)throw new AppError('HOST_CHANGED','호스트가 바뀌었습니다. 다시 연결해 주세요.');const info=this.terminal(p.id);if(info.generation!==p.generation)throw new AppError('SESSION_CHANGED','새 터미널 세션입니다. 화면을 다시 연결해 주세요.');return info;}
  private requireClient(client:Client){if(this.clients.get(client.ctx.id)!==client)throw new AppError('NOT_CONNECTED','연결이 종료되었습니다. 다시 연결해 주세요.');}
  private requireLease(runtime:Runtime,client:Client,epoch:number,ready:boolean){const lease=runtime.lease;if(!lease || lease.connectionId!==client.ctx.id || lease.epoch!==epoch || lease.expires<=Date.now()){if(lease?.expires && lease.expires<=Date.now()){this.revoke(runtime);this.broadcastState();}throw new AppError('NOT_CONTROLLER','여기서 제어를 눌러 제어권을 가져오세요.');}if(ready&&!lease.ready)throw new AppError('CONTROL_SYNCING','화면 동기화가 끝난 뒤 입력할 수 있습니다.');return lease;}
  private revoke(runtime:Runtime){runtime.lease=undefined;delete runtime.info.controller;}
  /** Records (or clears) the exact conversation of the current generation. Persisted with metadata, never broadcast. */
  private recordAgentSession(info:TerminalInfo,session:AgentSessionIdentity|null){
    const before=this.agentSessions.get(info.id);
    if(!session){if(!before)return;this.agentSessions.delete(info.id);this.persist();return;}
    const valid=validAgentSession(session);if(!valid)return;
    if(before&&before.generation===info.generation&&before.session.provider===valid.provider&&before.session.sessionId===valid.sessionId&&before.session.cwd===valid.cwd)return;
    this.agentSessions.set(info.id,{generation:info.generation,session:valid});this.persist();
  }
  /** Types the single pending resume line once, right after the new shell's first authenticated prompt. */
  private dispatchResume(runtime:Runtime):boolean{
    const pending=runtime.pendingResume;if(!pending)return false;
    this.cancelResume(runtime);
    if(runtime.info.status!=='running'||!runtime.pty)return true;
    try{runtime.pty.write(pending.command);}catch{/* the shell exited; nothing is retried */}
    return true;
  }
  private cancelResume(runtime:Runtime){if(runtime.pendingResume){clearTimeout(runtime.pendingResume.timer);runtime.pendingResume=undefined;}}
  /** The user typed first or the shell never became ready: drop the line and its saved intent. Shutdown never calls this. */
  private abandonResume(runtime:Runtime){this.cancelResume(runtime);this.recordAgentSession(runtime.info,null);}
  private agentRuntime(token:string){
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||this.closing||this.shutdownPrepared)return;
    const expected=Buffer.from(token);
    const runtime=[...this.runtimes.values()].find(item=>item.agentToken!==undefined&&timingSafeEqual(Buffer.from(item.agentToken),expected));
    if(!runtime||runtime.disposed||runtime.stopping||runtime.info.status!=='running'||this.runtimes.get(runtime.info.id)!==runtime)return;
    return runtime;
  }
  /**
   * Out-of-band agent lifecycle report (e.g. a Codex hook through a local IPC).
   * token must be the per-shell MONGLE_AGENT_TOKEN of a running terminal of this boot.
   * session null clears the record. Returns false when rejected.
   */
  reportAgentSession(token:string,session:AgentSessionIdentity|null):boolean{
    const runtime=this.agentRuntime(token);if(!runtime)return false;
    if(session===null){this.recordAgentSession(runtime.info,null);return true;}
    const valid=validAgentSession(session);if(!valid)return false;
    this.recordAgentSession(runtime.info,valid);return true;
  }
  /**
   * Lifecycle end report (e.g. Codex SessionEnd). Clears the record only when it is
   * exactly this provider and UUID, so a late end of an older conversation cannot
   * erase the current one. Returns true only when a matching record was cleared.
   */
  endAgentSession(token:string,session:AgentSessionIdentity):boolean{
    const runtime=this.agentRuntime(token),valid=validAgentSession(session);if(!runtime||!valid)return false;
    const record=this.agentSessions.get(runtime.info.id);
    if(!record||record.generation!==runtime.info.generation||record.session.provider!==valid.provider||record.session.sessionId!==valid.sessionId)return false;
    this.recordAgentSession(runtime.info,null);return true;
  }
  private updateController(runtime:Runtime){const l=runtime.lease;runtime.info.controller=l?{connectionId:l.connectionId,deviceName:l.deviceName,epoch:l.epoch,ready:l.ready}:undefined;}
  private expireLeases(){let changed=false;for(const r of this.runtimes.values())if(r.lease&&r.lease.expires<=Date.now()){this.revoke(r);changed=true;}if(changed)this.broadcastState();}
  private profile(id:string){const value=this.profiles.find(p=>p.id===id);if(!value)throw new AppError('PROFILE_NOT_FOUND','설치된 셸 프로필을 찾을 수 없습니다.');return value;}
  private group(id:string){const value=this.groups.find(g=>g.id===id);if(!value)throw new AppError('GROUP_NOT_FOUND','그룹을 찾을 수 없습니다.');return value;}
  private terminal(id:string){const value=this.terminals.find(t=>t.id===id);if(!value)throw new AppError('TERMINAL_NOT_FOUND','터미널을 찾을 수 없습니다.');return value;}
  private running(info:TerminalInfo){const runtime=this.runtimes.get(info.id);if(!runtime?.pty || info.status!=='running')throw new AppError('NOT_RUNNING','터미널이 종료되었습니다. 새 셸을 열어 주세요.');return runtime;}
  private revision(group:Group,revision:number){if(group.revision!==revision)throw new AppError('REVISION_CONFLICT','다른 화면에서 배치가 변경되었습니다. 최신 상태에서 다시 시도해 주세요.');}
  private checkTreeSize(node:unknown){const queue=[node];let count=0;while(queue.length){const n=queue.pop();if(++count>31)throw new AppError('INVALID_LAYOUT','분할 구조가 너무 큽니다.');if(n&&typeof n==='object'&&(n as any).type==='split'){queue.push((n as any).first,(n as any).second);}}}
  private persisted():PersistedHost{
    const agentSessions:NonNullable<PersistedHost['agentSessions']>={};
    for(const info of this.terminals){const record=this.agentSessions.get(info.id);if(record&&record.generation===info.generation)agentSessions[info.id]={generation:record.generation,session:{...record.session}};}
    return {schemaVersion:2,hostId:this.hostId,settings:this.settings,groups:this.groups,terminals:this.terminals.map(({controller,pid,...info})=>info),repositories:this.repositories,worktrees:this.worktrees,worktreeOperations:this.worktreeOperations,agentSessions};
  }
  private async prepareShutdown():Promise<void>{
    if(this.projectTasks.size)throw new AppError('WORKTREE_BUSY','워크트리 작업이 끝난 뒤 정상 종료를 다시 시도해 주세요.');
    // This runs on the mutation queue. Earlier input/layout/settings requests
    // settle first; later requests cannot change the accepted checkpoint.
    const snapshots:PersistedSnapshot[]=[];
    try{
      if(this.settings.recordHistory){
        for(const info of this.terminals){
          const runtime=this.runtimes.get(info.id);
          const snapshot=runtime?await runtime.engine.snapshot():this.archivedFrames.get(info.id);
          if(snapshot)snapshots.push({terminalId:info.id,generation:info.generation,snapshot});
        }
      }
      const saved=this.persisted();
      for(const info of saved.terminals){
        if(info.status==='running')info.resumeOnBoot=true;
        if(!this.settings.recordHistory)info.historyAvailable=false;
        else if(snapshots.some(frame=>frame.terminalId===info.id))info.historyAvailable=true;
      }
      this.store.save(saved,this.settings.recordHistory?undefined:'all',snapshots);
      for(const info of this.terminals){const stored=saved.terminals.find(item=>item.id===info.id)!;info.historyAvailable=stored.historyAvailable;info.resumeOnBoot=stored.resumeOnBoot;}
      // Set only after the transaction succeeds. Failed preflight is entirely
      // non-destructive: the host, leases and live shells remain usable.
      this.shutdownPrepared=true;
      this.storageError=undefined;
    }catch{
      this.storageError='종료 전 상태를 저장하지 못했습니다. 디스크 공간과 접근 권한을 확인한 뒤 다시 시도해 주세요.';
      throw new AppError('STORAGE_ERROR',this.storageError);
    }
  }
  private persist(required=false,clearSnapshots?:'all'|string[]){if(!this.initialized && !required)return;try{this.store.save(this.persisted(),clearSnapshots);this.metadataVersion++;this.storageError=undefined;}catch{this.storageError='설정을 저장하지 못했습니다. 디스크 공간과 접근 권한을 확인해 주세요.';if(required)throw new AppError('STORAGE_ERROR',this.storageError);}}
  private send(client:Client,message:Parameters<Send>[0]){try{client.send(message);}catch{this.disconnect(client.ctx.id);}}
  private broadcastState(){const event={type:'state' as const,state:this.getState()};for(const client of this.clients.values())this.send(client,event);}
  private notice(code:string,message:string){for(const client of this.clients.values())this.send(client,{type:'notice',code,message});}
  private async stopTerminal(info:TerminalInfo,preserveForBoot=false){if(!preserveForBoot){info.resumeOnBoot=false;delete info.restoreError;this.agentSessions.delete(info.id);}const r=this.runtimes.get(info.id);if(r){r.stopping=true;this.cancelResume(r);}if(!r){if(!preserveForBoot)info.status='exited';return;}if(r.pty){await r.stopPty?.();r.pty=undefined;}info.status='exited';delete info.pid;this.revoke(r);const frame=await this.frame(info);this.checkpoint(r,frame);this.broadcastFrame(frame);}
  private async disposeRuntime(id:string){const r=this.runtimes.get(id);if(!r)return;r.stopping=true;if(r.timer)clearTimeout(r.timer);this.cancelResume(r);if(r.pty)await r.stopPty?.();r.disposed=true;await r.engine.dispose();this.runtimes.delete(id);}
  private async removeTerminal(info:TerminalInfo){this.agentSessions.delete(info.id);await this.disposeRuntime(info.id);for(const c of this.clients.values())c.attached.delete(info.id);const group=this.group(info.groupId);group.layout=removeLeaf(group.layout,info.id);group.revision++;this.terminals=this.terminals.filter(t=>t.id!==info.id);this.archivedFrames.delete(info.id);this.archivedSequences.delete(info.id);this.store.clearSnapshot(info.id);}
  async close():Promise<void>{
    if(this.closing)return;this.closing=true;if(this.leaseTimer)clearInterval(this.leaseTimer);await this.queue;await Promise.allSettled([...this.projectTasks.values()]);await this.queue;
    for(const info of this.terminals)if(info.status==='running')info.resumeOnBoot=true;
    this.persist();
    for(const info of this.terminals){const runtime=this.runtimes.get(info.id);if(runtime){try{await this.stopTerminal(info,true);}catch{}await this.disposeRuntime(info.id);}}
    this.persist();this.clients.clear();this.store.close();
  }
}

/** node-pty 1.1.0's bundled ConPTY path only disposes its output worker after a
 * final data event. Idle shells may exit without that event. Pin and validate
 * this tiny adapter, and always retain its normal one-second output drain. */
function installPtyLifecycle(child:pty.IPty):()=>Promise<void>{
  let exited=false,finish!:()=>void;
  const done=new Promise<void>(resolve=>{finish=resolve;});
  child.onExit(()=>{exited=true;finish();});
  const agent=(child as any)._agent;
  if(process.platform==='win32'){
    if(!agent || agent._useConptyDll!==true || typeof agent._$onProcessExit!=='function' || typeof agent._conoutSocketWorker?.dispose!=='function'){
      try{child.kill();}catch{}throw new Error('Unsupported node-pty Windows lifecycle adapter.');
    }
    const onNativeExit=agent._$onProcessExit.bind(agent);
    agent._$onProcessExit=(code:number)=>{onNativeExit(code);agent._conoutSocketWorker.dispose();};
  }
  let stopping:Promise<void>|undefined;
  return ()=>{
    if(stopping)return stopping;
    stopping=(async()=>{
      if(exited)return;
      if(process.platform==='win32' && !(child as any)._isReady){
        // Shutdown cancels any resize/input deferred before the first PTY byte.
        // Otherwise node-pty runs those callbacks against the closed ConPTY.
        (child as any)._deferreds=[];agent.kill();
      }else child.kill();
      await done;
    })();return stopping;
  };
}
