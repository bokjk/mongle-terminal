import { randomUUID, createHash } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { z } from 'zod';
import { APP_VERSION, PROTOCOL_VERSION, AppError, dimensionSchema, idSchema, leafIds, removeLeaf, splitLeaf } from '../protocol/index.js';
import type { ConnectionContext, Group, HostSettings, HostState, LayoutNode, PresentationSnapshot, Send, ShellProfile, SnapshotEvent, TerminalInfo } from '../protocol/index.js';
import { HostStore, type PersistedHost, type PersistedSnapshot } from '../storage/index.js';
import { detectShellProfiles, resolveShellLaunch, safeShellEnvironment } from '../shell-profiles/index.js';
import { TerminalEngine } from '../terminal/engine.js';

const nameSchema = z.string().trim().min(1).max(100);
const cwdSchema = z.string().min(1).max(4096);
const exportedSettingsSchema=z.object({version:z.literal(1),name:nameSchema,recordHistory:z.boolean(),groups:z.array(z.object({name:nameSchema,cwd:cwdSchema,profileId:z.string().max(300)}).strict()).max(100)}).strict();
const terminalRef = z.object({ id: idSchema, hostId: idSchema, bootId: idSchema, generation: idSchema });
const layoutSchema: z.ZodType<LayoutNode> = z.lazy(() => z.union([
  z.object({type: z.literal('leaf'), terminalId: idSchema}).strict(),
  z.object({type: z.literal('split'), axis: z.enum(['horizontal','vertical']), ratio: z.number().min(0.05).max(0.95), first: layoutSchema, second: layoutSchema}).strict(),
]));
const LEASE_MS = 15_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
type Attachment = { lastSent: number; lastAck: number; pending?: SnapshotEvent };
type Client = { ctx: ConnectionContext; send: Send; attached: Map<string, Attachment> };
type Lease = { connectionId: string; deviceName: string; epoch: number; expires: number; ready: boolean; syncSeq: number; inputSeq: number; dedupe: Map<string, {seq:number; hash:string}> };
type Runtime = { info: TerminalInfo; engine: TerminalEngine; pty?: pty.IPty; stopPty?:()=>Promise<void>; seq: number; epoch: number; lease?: Lease; timer?: ReturnType<typeof setTimeout>; checkpointAt: number; lastFrame?: SnapshotEvent; disposed: boolean; pendingBytes: number };

/** Owns the shells, independent of every GUI/browser attachment. */
export class HostCore {
  private store!: HostStore;
  private hostId = '';
  private readonly bootId = randomUUID();
  private settings: HostSettings;
  private profiles: ShellProfile[] = [];
  private groups: Group[] = [];
  private terminals: TerminalInfo[] = [];
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

  constructor(private options: { dataDir: string; name?: string }) {
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
      this.terminals = saved.terminals.map(({controller, pid, ...info}) => ({...info, status: info.status === 'running' ? 'interrupted' : info.status, resumeOnBoot: info.status === 'running' || info.resumeOnBoot === true || legacyResume.has(info.id), historyAvailable: Boolean(this.settings.recordHistory && this.store.getSnapshot(info.id, info.generation))}));
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
    return structuredClone({ hostId:this.hostId, bootId:this.bootId, name:this.settings.name, version:APP_VERSION, protocolVersion:PROTOCOL_VERSION, groups:this.groups, terminals:this.terminals, profiles:this.profiles, settings:this.settings, ...(this.storageError ? {storageError:this.storageError} : {}) });
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
    let changed = false;
    for (const runtime of this.runtimes.values()) if (runtime.lease?.connectionId === id) {this.revoke(runtime); changed = true;}
    if (changed) this.broadcastState();
  }
  async handle(method: string, params: unknown, ctx: ConnectionContext): Promise<any> {
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
          this.terminals=before.terminals.map(old=>{const current=this.terminals.find(t=>t.id===old.id)||old;Object.assign(current,{title:old.title,groupId:old.groupId,profileId:old.profileId,cwd:old.cwd});if(method==='settings.update')current.historyAvailable=old.historyAvailable;return current;});
        }
        if(error instanceof AppError && error.code==='STORAGE_ERROR')this.broadcastState();
        throw error;
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
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
        const terminals=this.terminals.filter(t=>t.groupId===p.id);
        if (!p.terminate && terminals.some(t=>t.status==='running')) throw new AppError('CONFIRM_REQUIRED','실행 중인 터미널을 종료하려면 확인이 필요합니다.');
        for (const info of terminals) await this.removeTerminal(info);
        this.groups=this.groups.filter(g=>g.id!==p.id);this.persist(true);this.broadcastState();return {removed:true};
      }
      case 'terminals.create': {
        const p=z.object({groupId:idSchema,profileId:z.string().max(300).optional(),cwd:cwdSchema.optional(),splitTarget:idSchema.optional(),axis:z.enum(['horizontal','vertical']).optional()}).strict().parse(params);
        const group=this.group(p.groupId);
        if (this.terminals.filter(t=>t.groupId===group.id).length>=16 || this.terminals.filter(t=>t.status==='running').length>=32 || this.terminals.length>=128) throw new AppError('LIMIT_REACHED','터미널 한도에 도달했습니다. 사용하지 않는 터미널을 정리해 주세요.');
        if (p.splitTarget && !leafIds(group.layout).includes(p.splitTarget)) throw new AppError('INVALID_TARGET','분할할 터미널을 찾을 수 없습니다.');
        const source=p.splitTarget ? this.terminal(p.splitTarget) : undefined;
        const profile=this.profile(p.profileId || source?.profileId || group.profileId);
        const launch=await resolveShellLaunch(profile,p.cwd || source?.cwd || group.cwd);
        this.requireClient(client);
        const info:TerminalInfo={id:randomUUID(),groupId:group.id,title:profile.name,profileId:profile.id,cwd:launch.cwd,generation:randomUUID(),status:'interrupted',cols:100,rows:30};
        this.terminals.push(info);group.layout=splitLeaf(group.layout,p.splitTarget,info.id,p.axis || 'horizontal');group.revision++;
        this.persist(true);
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
        info.generation=randomUUID();info.exitCode=undefined;info.historyAvailable=false;info.status='interrupted';info.resumeOnBoot=false;delete info.restoreError;this.group(info.groupId).revision++;
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
        const p=terminalRef.merge(dimensionSchema).strict().parse(params);const info=this.target(p),runtime=this.running(info);
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
        try {runtime.pty!.write(data);}catch{throw new AppError('WRITE_FAILED','터미널 입력을 전달하지 못했습니다.');}
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
    try {
      if(this.terminals.filter(item=>item.status==='running').length>=32)throw new AppError('LIMIT_REACHED','실행 가능한 터미널 수를 넘어 새 셸을 열지 못했습니다.');
      const profile=this.profile(info.profileId),launch=await resolveShellLaunch(profile,info.cwd);
      const snapshot=this.settings.recordHistory?this.store.getSnapshot(info.id,info.generation):undefined;
      info.generation=randomUUID();info.historyAvailable=false;delete info.restoreError;
      await this.startTerminal(info,profile,launch,snapshot);
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
    }
  }
  private async startTerminal(info:TerminalInfo,profile:ShellProfile,launch:{executable:string;args:string[];cwd:string},history?:PresentationSnapshot) {
    const runtime={} as Runtime;
    Object.assign(runtime,{info,seq:0,epoch:0,checkpointAt:0,disposed:false,pendingBytes:0});
    runtime.engine=new TerminalEngine({cols:info.cols,rows:info.rows,scrollback:this.settings.scrollback,onResponse:(data:string)=>{try{if(runtime.pty && info.status==='running')runtime.pty.write(data);}catch{/* exit can race an emulator reply */}}});
    this.runtimes.set(info.id,runtime);
    try {
      if(history)await runtime.engine.restoreHistory(history);
      runtime.pty=pty.spawn(launch.executable,launch.args,{name:'xterm-256color',cols:info.cols,rows:info.rows,cwd:launch.cwd,env:safeShellEnvironment(),useConpty:true,useConptyDll:true});
      runtime.stopPty=installPtyLifecycle(runtime.pty);
    } catch {
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
      info.status='exited';info.exitCode=exitCode;delete info.pid;runtime.pty=undefined;this.revoke(runtime);
      if(!this.closing && !this.shutdownPrepared)info.resumeOnBoot=false;
      this.persist();this.broadcastState();
      // A completed process no longer needs a 5,000-line mutable VT engine.
      // Queue final-frame capture behind any accepted lifecycle operation.
      const archive=this.queue.then(()=>this.archiveExited(runtime));this.queue=archive.catch(()=>this.notice('HISTORY_FAILED','종료된 터미널 기록을 정리하지 못했습니다.'));
    });
  }
  private scheduleFrame(runtime:Runtime) {
    if(!this.initialized || runtime.disposed || this.closing || runtime.timer)return;
    const hasViewer=[...this.clients.values()].some(c=>c.attached.has(runtime.info.id));
    runtime.timer=setTimeout(()=>{runtime.timer=undefined;void this.frame(runtime.info).then(frame=>{if(!runtime.disposed){this.broadcastFrame(frame);if(this.settings.recordHistory && Date.now()-runtime.checkpointAt>1000)this.checkpoint(runtime,frame);}}).catch(()=>this.notice('SNAPSHOT_FAILED','터미널 화면을 동기화하지 못했습니다.'));},hasViewer?60:1000);
    runtime.timer.unref();
  }
  private async frame(info:TerminalInfo):Promise<SnapshotEvent> {
    const runtime=this.runtimes.get(info.id);
    let snapshot:PresentationSnapshot;
    if(runtime){snapshot=await runtime.engine.snapshot();}
    else snapshot=this.archivedFrames.get(info.id) || (this.settings.recordHistory ? this.store.getSnapshot(info.id,info.generation) || await this.blankSnapshot(info) : await this.blankSnapshot(info));
    const seq=runtime?++runtime.seq:(this.archivedSequences.get(info.id) || 0)+1;
    if(!runtime)this.archivedSequences.set(info.id,seq);
    const frame:SnapshotEvent={type:'snapshot',terminalId:info.id,generation:info.generation,bootId:this.bootId,seq,snapshot};
    // Reserve room for an RPC envelope when this frame is returned by attach.
    if(Buffer.byteLength(JSON.stringify(frame))>MAX_FRAME_BYTES-1024)throw new AppError('SNAPSHOT_TOO_LARGE','화면 기록이 연결 한도를 넘었습니다. 기록을 지운 뒤 다시 연결해 주세요.');
    if(runtime)runtime.lastFrame=frame;
    return frame;
  }
  private async blankSnapshot(info:TerminalInfo):Promise<PresentationSnapshot>{const engine=new TerminalEngine({cols:info.cols,rows:info.rows,scrollback:0,onResponse:()=>{}});try{return await engine.snapshot();}finally{await engine.dispose();}}
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
  private updateController(runtime:Runtime){const l=runtime.lease;runtime.info.controller=l?{connectionId:l.connectionId,deviceName:l.deviceName,epoch:l.epoch,ready:l.ready}:undefined;}
  private expireLeases(){let changed=false;for(const r of this.runtimes.values())if(r.lease&&r.lease.expires<=Date.now()){this.revoke(r);changed=true;}if(changed)this.broadcastState();}
  private profile(id:string){const value=this.profiles.find(p=>p.id===id);if(!value)throw new AppError('PROFILE_NOT_FOUND','설치된 셸 프로필을 찾을 수 없습니다.');return value;}
  private group(id:string){const value=this.groups.find(g=>g.id===id);if(!value)throw new AppError('GROUP_NOT_FOUND','그룹을 찾을 수 없습니다.');return value;}
  private terminal(id:string){const value=this.terminals.find(t=>t.id===id);if(!value)throw new AppError('TERMINAL_NOT_FOUND','터미널을 찾을 수 없습니다.');return value;}
  private running(info:TerminalInfo){const runtime=this.runtimes.get(info.id);if(!runtime?.pty || info.status!=='running')throw new AppError('NOT_RUNNING','터미널이 종료되었습니다. 새 셸을 열어 주세요.');return runtime;}
  private revision(group:Group,revision:number){if(group.revision!==revision)throw new AppError('REVISION_CONFLICT','다른 화면에서 배치가 변경되었습니다. 최신 상태에서 다시 시도해 주세요.');}
  private checkTreeSize(node:unknown){const queue=[node];let count=0;while(queue.length){const n=queue.pop();if(++count>31)throw new AppError('INVALID_LAYOUT','분할 구조가 너무 큽니다.');if(n&&typeof n==='object'&&(n as any).type==='split'){queue.push((n as any).first,(n as any).second);}}}
  private persisted():PersistedHost{return {schemaVersion:1,hostId:this.hostId,settings:this.settings,groups:this.groups,terminals:this.terminals.map(({controller,pid,...info})=>info)};}
  private async prepareShutdown():Promise<void>{
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
  private persist(required=false,clearSnapshots?:'all'|string[]){if(!this.initialized && !required)return;try{this.store.save(this.persisted(),clearSnapshots);}catch{this.storageError='설정을 저장하지 못했습니다. 디스크 공간과 접근 권한을 확인해 주세요.';if(required)throw new AppError('STORAGE_ERROR',this.storageError);}}
  private send(client:Client,message:Parameters<Send>[0]){try{client.send(message);}catch{this.disconnect(client.ctx.id);}}
  private broadcastState(){const event={type:'state' as const,state:this.getState()};for(const client of this.clients.values())this.send(client,event);}
  private notice(code:string,message:string){for(const client of this.clients.values())this.send(client,{type:'notice',code,message});}
  private async stopTerminal(info:TerminalInfo,preserveForBoot=false){if(!preserveForBoot){info.resumeOnBoot=false;delete info.restoreError;}const r=this.runtimes.get(info.id);if(!r){if(!preserveForBoot)info.status='exited';return;}if(r.pty){await r.stopPty?.();r.pty=undefined;}info.status='exited';delete info.pid;this.revoke(r);const frame=await this.frame(info);this.checkpoint(r,frame);this.broadcastFrame(frame);}
  private async disposeRuntime(id:string){const r=this.runtimes.get(id);if(!r)return;if(r.timer)clearTimeout(r.timer);if(r.pty)await r.stopPty?.();r.disposed=true;await r.engine.dispose();this.runtimes.delete(id);}
  private async removeTerminal(info:TerminalInfo){await this.disposeRuntime(info.id);for(const c of this.clients.values())c.attached.delete(info.id);const group=this.group(info.groupId);group.layout=removeLeaf(group.layout,info.id);group.revision++;this.terminals=this.terminals.filter(t=>t.id!==info.id);this.archivedFrames.delete(info.id);this.archivedSequences.delete(info.id);this.store.clearSnapshot(info.id);}
  async close():Promise<void>{
    if(this.closing)return;this.closing=true;if(this.leaseTimer)clearInterval(this.leaseTimer);await this.queue;
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
