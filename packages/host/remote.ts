import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { access, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../protocol';
const exec = promisify(execFile);
type ManagedEndpoint = { origin:string; dnsName:string; httpsPort:number; proxy:string };
const validPort = (port:unknown):port is number => Number.isInteger(port) && Number(port)>0 && Number(port)<65536;
const validDns = (name:unknown):name is string => typeof name==='string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/i.test(name);
const originFor = (dnsName:string, port:number) => `https://${dnsName}${port===443?'':`:${port}`}`;
async function tailscaleExecutable() { const executable=path.join(process.env.ProgramFiles ?? 'C:\\Program Files','Tailscale','tailscale.exe'); try {await access(executable);return executable;}catch{throw new AppError('TAILSCALE_MISSING','Tailscale을 설치한 뒤 네트워크에 연결해 주세요.');} }
/** Run the installed Tailscale CLI and turn its failures into messages a user can act on. */
export async function runTailscale(args:string[], timeout=20_000) {
  try {const {stdout}=await exec(await tailscaleExecutable(),args,{windowsHide:true,timeout,maxBuffer:2*1024*1024});return stdout;}
  catch(error) {
    if(error instanceof AppError)throw error;
    const detail=error as {stdout?:string;stderr?:string};
    const output=`${detail.stdout??''}\n${detail.stderr??''}`;
    if(/login\.tailscale\.com\/f\/serve|serve is not enabled|enable.*https|https.*not enabled/i.test(output))throw new AppError('TAILSCALE_SETUP_REQUIRED','Tailscale 네트워크의 HTTPS·Serve 사용 승인이 필요합니다. Tailscale 관리 화면에서 활성화한 뒤 다시 시도해 주세요.');
    if(/access is denied|permission denied/i.test(output))throw new AppError('TAILSCALE_PERMISSION','현재 Windows 사용자로 Tailscale에 접근할 수 없습니다. Tailscale 앱의 연결 및 사용자 권한을 확인해 주세요.');
    throw new AppError('TAILSCALE_COMMAND','Tailscale에서 작업을 완료하지 못했습니다. Tailscale 연결과 HTTPS 사용 설정을 확인해 주세요.');
  }
}
export class RemoteSetup {
  private pending:Promise<unknown> = Promise.resolve();
  constructor(private dataDir:string, private port:number, private configure:(origin:string|null)=>Promise<unknown>) {}
  private get file() { return path.join(this.dataDir,'remote-serve.json'); }
  private get proxy() { return `http://127.0.0.1:${this.port}`; }
  private serialize<T>(action:()=>Promise<T>):Promise<T> {
    const pending=this.pending.then(action,action);
    this.pending=pending.catch(()=>{});
    return pending;
  }
  private run(args:string[]) { return runTailscale(args); }
  private async managed():Promise<ManagedEndpoint|null> {
    let source:string;
    try { source=await readFile(this.file,'utf8'); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw new AppError('SERVE_RECORD_READ','저장된 원격 연결 설정을 읽지 못했습니다. 사용자 데이터 폴더의 접근 권한을 확인해 주세요.');
    }
    try {
      const value=JSON.parse(source);
      if(!value || !validDns(value.dnsName) || !validPort(value.httpsPort) || value.origin!==originFor(value.dnsName,value.httpsPort) || typeof value.proxy!=='string')return null;
      const proxy=/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(value.proxy);
      return proxy && validPort(Number(proxy[1])) ? value : null;
    }catch{return null;}
  }
  private async config() {return JSON.parse(await this.run(['serve','status','--json']));}
  private owned(config:any, endpoint:ManagedEndpoint) {
    const key=`${endpoint.dnsName}:${endpoint.httpsPort}`, entry=config.Web?.[key], tcp=config.TCP?.[String(endpoint.httpsPort)];
    return tcp?.HTTPS===true && Object.keys(tcp).length===1 && entry?.Handlers?.['/']?.Proxy===endpoint.proxy && Object.keys(entry.Handlers).length===1 && Object.keys(entry.Handlers['/']).length===1 && config.AllowFunnel?.[key]!==true;
  }
  private scopes(config:any):any[] {
    return [config,...Object.values(config.Foreground??{}).flatMap(value=>this.scopes(value)),...Object.values(config.Services??{}).flatMap(value=>this.scopes(value))];
  }
  private foregroundScopes(config:any):any[] {
    return Object.values(config.Foreground??{}).flatMap(value=>[value,...this.foregroundScopes(value)]);
  }
  private exclusiveDns(config:any, dnsName:string, endpoint?:ManagedEndpoint) {
    const sameDns=(key:string)=>key.toLowerCase().startsWith(`${dnsName.toLowerCase()}:`);
    const keys=Object.keys(config.Web??{}).filter(sameDns);
    const scopes=this.scopes(config);
    return keys.every(key=>endpoint && key===`${dnsName}:${endpoint.httpsPort}`)
      && !scopes.slice(1).some(scope=>Object.keys(scope.Web??{}).some(sameDns))
      && !scopes.some(scope=>Object.keys(scope.AllowFunnel??{}).some(key=>sameDns(key) && scope.AllowFunnel[key]===true))
      && !scopes.some(scope=>Object.values(scope.TCP??{}).some((tcp:any)=>typeof tcp.TerminateTLS==='string' && tcp.TerminateTLS.replace(/\.$/,'').toLowerCase()===dnsName.toLowerCase()));
  }
  // The CLI removes HTTPS by port, including routes for other DNS names.
  private exclusivePort(config:any, endpoint:ManagedEndpoint) {
    const key=`${endpoint.dnsName}:${endpoint.httpsPort}`, suffix=`:${endpoint.httpsPort}`;
    return Object.keys(config.Web??{}).every(item=>!item.endsWith(suffix)||item===key) && !Object.keys(config.AllowFunnel??{}).some(item=>item.endsWith(suffix)&&config.AllowFunnel[item]===true)
      && this.foregroundScopes(config).every(scope=>!scope.TCP?.[String(endpoint.httpsPort)] && !Object.keys(scope.Web??{}).some(item=>item.endsWith(suffix)));
  }
  private availablePort(config:any, port:number) {
    return [config,...this.foregroundScopes(config)].every(scope=>!scope.TCP?.[String(port)] && !Object.keys(scope.Web??{}).some(key=>key.endsWith(`:${port}`)) && !Object.keys(scope.AllowFunnel??{}).some(key=>key.endsWith(`:${port}`)));
  }
  private async unchanged(config:any) {
    if(!isDeepStrictEqual(config,await this.config()))throw new AppError('SERVE_CHANGED','Tailscale Serve 설정이 작업 중 변경되었습니다. 기존 설정은 덮어쓰지 않았습니다. 연결을 확인한 뒤 다시 시도해 주세요.');
  }
  async diagnose() {try {const status=JSON.parse(await this.run(['status','--json']));const config=await this.config();const endpoint=await this.managed();const dnsName=String(status.Self?.DNSName??'').replace(/\.$/,'');return {installed:true,connected:status.BackendState==='Running',dnsName,origin:endpoint?.origin,serveEnabled:!!endpoint&&endpoint.dnsName===dnsName&&endpoint.proxy===this.proxy&&this.owned(config,endpoint)&&this.exclusiveDns(config,dnsName,endpoint),message:status.BackendState==='Running'?'Tailscale 연결됨':'Tailscale에서 로그인하고 연결해 주세요.'};}catch(error){return {installed:!(error instanceof AppError&&error.code==='TAILSCALE_MISSING'),connected:false,message:error instanceof Error?error.message:'Tailscale 상태 확인 실패'};}}
  enable() { return this.serialize(()=>this.enableExclusive()); }
  private async enableExclusive() {
    const status=JSON.parse(await this.run(['status','--json']));
    if(status.BackendState!=='Running')throw new AppError('TAILSCALE_OFFLINE','Tailscale에서 로그인하고 네트워크에 연결해 주세요.');
    const dnsName=String(status.Self?.DNSName??'').replace(/\.$/,'');
    if(!validDns(dnsName))throw new AppError('TAILSCALE_DNS','Tailscale의 기기 이름과 MagicDNS 설정을 확인해 주세요.');
    const config=await this.config(), previous=await this.managed();
    let existing=previous?.dnsName===dnsName && this.owned(config,previous) ? previous : undefined;
    if(!existing) {
      // Only the current gateway's exact target proves ownership without a
      // saved record. An unknown old/dead loopback port must remain untouched.
      const keys=Object.keys(config.Web??{}).filter(key=>key.startsWith(`${dnsName}:`));
      if(keys.length===1) {
        const httpsPort=Number(keys[0].slice(dnsName.length+1));
        const candidate={dnsName,httpsPort,origin:originFor(dnsName,httpsPort),proxy:this.proxy};
        if(validPort(httpsPort)&&keys[0]===`${dnsName}:${httpsPort}`&&this.owned(config,candidate))existing=candidate;
      }
    }
    // Browser cookies are scoped to host names, not ports. Do not put shell
    // credentials on a name that already serves an unrelated web application.
    // Recheck this for a known route too: another port may have been added later.
    if(!this.exclusiveDns(config,dnsName,existing))throw new AppError('SERVE_SHARED_HOST','이 Tailscale 주소의 기존 HTTPS 연결을 몽글터미널 전용 연결로 확인하지 못했습니다. 다른 서비스와 인증 쿠키가 공유되지 않도록 원격 접속을 켜지 않았습니다. 기존 서비스는 변경하지 않았습니다.');
    const candidates=[443,8443,10000];
    const httpsPort=existing?.httpsPort??candidates.find(port=>this.availablePort(config,port));
    if(!httpsPort)throw new AppError('SERVE_CONFLICT','Tailscale Serve 포트가 사용 중입니다. 기존 서비스를 확인한 뒤 전용 HTTPS 주소를 설정해 주세요.');
    const endpoint:ManagedEndpoint={dnsName,httpsPort,origin:originFor(dnsName,httpsPort),proxy:this.proxy};
    if(existing&&existing.proxy!==this.proxy&&!this.exclusivePort(config,existing))throw new AppError('SERVE_CONFLICT','기존 HTTPS 포트를 다른 연결도 사용하고 있어 변경하지 않았습니다. Tailscale Serve 설정을 확인해 주세요.');
    await this.unchanged(config);
    // Never reset Serve or enable Funnel. The endpoint is only reachable inside the tailnet.
    if(!existing||existing.proxy!==endpoint.proxy) {
      await this.run(['serve','--bg',`--https=${httpsPort}`,'--yes',endpoint.proxy]);
      const updated=await this.config();
      if(!this.owned(updated,endpoint)||!this.exclusiveDns(updated,dnsName,endpoint))throw new AppError('SERVE_VERIFY','원격 접속 주소를 확인하지 못했습니다. Tailscale Serve 상태를 확인해 주세요.');
    }
    await writeFile(this.file,JSON.stringify(endpoint));
    await this.configure(endpoint.origin);
    return endpoint;
  }
  disable() { return this.serialize(()=>this.disableExclusive()); }
  private async disableExclusive() {
    // Revoke application access even if the VPN daemon is unavailable or its
    // configuration was independently edited. Never delete somebody else's route.
    await this.configure(null);
    const endpoint=await this.managed();
    if(!endpoint)return {ok:true,serveRemoved:false};
    try {
      const config=await this.config();
      if(!this.owned(config,endpoint)||!this.exclusivePort(config,endpoint))return {ok:true,serveRemoved:false,warning:'몽글 원격 접속은 차단했습니다. 변경되거나 다른 연결과 공유하는 Tailscale Serve 설정은 보존했습니다.'};
      await this.unchanged(config);
      await this.run(['serve',`--https=${endpoint.httpsPort}`,'off']);
      await unlink(this.file).catch(()=>{});
      return {ok:true,serveRemoved:true};
    } catch {return {ok:true,serveRemoved:false,warning:'몽글 원격 접속은 차단했습니다. Tailscale 연결과 남아 있는 Serve 설정을 확인해 주세요.'};}
  }
}
