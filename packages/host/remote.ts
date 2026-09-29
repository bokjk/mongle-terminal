import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../protocol';
const exec = promisify(execFile);
type ManagedEndpoint = { origin:string; dnsName:string; httpsPort:number; proxy:string };
export class RemoteSetup {
  constructor(private dataDir:string, private port:number, private configure:(origin:string|null)=>Promise<unknown>) {}
  private get file() { return path.join(this.dataDir,'remote-serve.json'); }
  private async executable() { const executable=path.join(process.env.ProgramFiles ?? 'C:\\Program Files','Tailscale','tailscale.exe'); try {await access(executable);return executable;}catch{throw new AppError('TAILSCALE_MISSING','Tailscale을 설치한 뒤 네트워크에 연결해 주세요.');} }
  private async run(args:string[]) {
    try {const {stdout}=await exec(await this.executable(),args,{windowsHide:true,timeout:20_000,maxBuffer:2*1024*1024});return stdout;}
    catch(error) {
      if(error instanceof AppError)throw error;
      const detail=error as {stdout?:string;stderr?:string};
      const output=`${detail.stdout??''}\n${detail.stderr??''}`;
      if(/login\.tailscale\.com\/f\/serve|serve is not enabled|enable.*https|https.*not enabled/i.test(output))throw new AppError('TAILSCALE_SETUP_REQUIRED','Tailscale 네트워크의 HTTPS·Serve 사용 승인이 필요합니다. Tailscale 관리 화면에서 활성화한 뒤 다시 시도해 주세요.');
      if(/access is denied|permission denied/i.test(output))throw new AppError('TAILSCALE_PERMISSION','현재 Windows 사용자로 Tailscale에 접근할 수 없습니다. Tailscale 앱의 연결 및 사용자 권한을 확인해 주세요.');
      throw new AppError('TAILSCALE_COMMAND','Tailscale에서 작업을 완료하지 못했습니다. Tailscale 연결과 HTTPS 사용 설정을 확인해 주세요.');
    }
  }
  private async managed():Promise<ManagedEndpoint|null> {try{return JSON.parse(await readFile(this.file,'utf8'));}catch{return null;}}
  private async config() {return JSON.parse(await this.run(['serve','status','--json']));}
  private owned(config:any, endpoint:ManagedEndpoint) {const entry=config.Web?.[`${endpoint.dnsName}:${endpoint.httpsPort}`];return entry?.Handlers?.['/']?.Proxy===endpoint.proxy && Object.keys(entry.Handlers).length===1 && config.AllowFunnel?.[`${endpoint.dnsName}:${endpoint.httpsPort}`] !== true;}
  async diagnose() {try {const status=JSON.parse(await this.run(['status','--json']));const config=await this.config();const endpoint=await this.managed();return {installed:true,connected:status.BackendState==='Running',dnsName:String(status.Self?.DNSName??'').replace(/\.$/,''),origin:endpoint?.origin,serveEnabled:!!endpoint&&this.owned(config,endpoint),message:status.BackendState==='Running'?'Tailscale 연결됨':'Tailscale에서 로그인하고 연결해 주세요.'};}catch(error){return {installed:!(error instanceof AppError&&error.code==='TAILSCALE_MISSING'),connected:false,message:error instanceof Error?error.message:'Tailscale 상태 확인 실패'};}}
  async enable() {
    const status=JSON.parse(await this.run(['status','--json']));
    if(status.BackendState!=='Running')throw new AppError('TAILSCALE_OFFLINE','Tailscale에서 로그인하고 네트워크에 연결해 주세요.');
    const dnsName=String(status.Self?.DNSName??'').replace(/\.$/,'');
    if(!/^[a-z0-9.-]+\.ts\.net$/i.test(dnsName))throw new AppError('TAILSCALE_DNS','Tailscale의 기기 이름과 MagicDNS 설정을 확인해 주세요.');
    const config=await this.config(), previous=await this.managed();
    if(previous&&this.owned(config,previous)&&previous.proxy===`http://127.0.0.1:${this.port}`){await this.configure(previous.origin);return previous;}
    // Browser cookies are scoped to host names, not ports. Do not put shell
    // credentials on a name that already serves an unrelated web application.
    if(Object.keys(config.Web??{}).some(key=>key.startsWith(`${dnsName}:`)))throw new AppError('SERVE_SHARED_HOST','이 Tailscale 이름에서 다른 웹 서비스가 실행 중입니다. 기기 인증 쿠키를 보호하려면 몽글터미널 전용 HTTPS 호스트를 사용해 주세요. 기존 서비스는 변경하지 않았습니다.');
    const candidates=[443,8443,10000];
    const httpsPort=candidates.find(port=>!config.TCP?.[String(port)]&&!config.Web?.[`${dnsName}:${port}`]&&!config.AllowFunnel?.[`${dnsName}:${port}`]);
    if(!httpsPort)throw new AppError('SERVE_CONFLICT','Tailscale Serve 포트가 사용 중입니다. 기존 서비스를 확인한 뒤 전용 HTTPS 주소를 설정해 주세요.');
    const endpoint:ManagedEndpoint={dnsName,httpsPort,origin:`https://${dnsName}${httpsPort===443?'':`:${httpsPort}`}`,proxy:`http://127.0.0.1:${this.port}`};
    // Never reset Serve or enable Funnel. The endpoint is only reachable inside the tailnet.
    await this.run(['serve','--bg',`--https=${httpsPort}`,'--yes',endpoint.proxy]);
    if(!this.owned(await this.config(),endpoint))throw new AppError('SERVE_VERIFY','원격 접속 주소를 확인하지 못했습니다. Tailscale Serve 상태를 확인해 주세요.');
    await writeFile(this.file,JSON.stringify(endpoint));
    await this.configure(endpoint.origin);
    return endpoint;
  }
  async disable() {
    // Revoke application access even if the VPN daemon is unavailable or its
    // configuration was independently edited. Never delete somebody else's route.
    await this.configure(null);
    const endpoint=await this.managed();
    if(!endpoint)return {ok:true,serveRemoved:false};
    try {
      const config=await this.config();
      if(!this.owned(config,endpoint))return {ok:true,serveRemoved:false,warning:'몽글 원격 접속은 차단했습니다. 변경된 Tailscale Serve 설정은 보존했습니다.'};
      await this.run(['serve',`--https=${endpoint.httpsPort}`,'off']);
      await unlink(this.file).catch(()=>{});
      return {ok:true,serveRemoved:true};
    } catch {return {ok:true,serveRemoved:false,warning:'몽글 원격 접속은 차단했습니다. Tailscale 연결이 복구되면 남아 있는 Serve 주소를 정리해 주세요.'};}
  }
}
