import type { AgentStatus } from '../protocol/index.js';

/** State comes only from our per-shell authenticated Claude lifecycle hook, never titles/output heuristics. */
export class ClaudeTaskState {
  private session = '';
  private status: AgentStatus = 'idle';
  private waiting = new Set<string>();
  private activeTools = new Map<string,number>();
  private clearTools(){this.waiting.clear();this.activeTools.clear();}
  private finishTool(tool:string){
    const remaining=Math.max(0,(this.activeTools.get(tool)||1)-1);
    if(remaining)this.activeTools.set(tool,remaining);
    else {this.activeTools.delete(tool);this.waiting.delete(tool);}
  }
  constructor(private token: string) {}
  /** A delivered cancel key invalidates our observation; it does not assert the CLI stopped. */
  cancelInput(data: string): {status: AgentStatus; notify: boolean} | undefined {
    if(data !== '\x03' && data !== '\x1b' && data !== '\x1b[27u' && data !== '\x1b[99;5u')return;
    if(this.status !== 'working' && this.status !== 'attention')return;
    this.session='';this.clearTools();this.status='idle';return {status:'idle',notify:false};
  }
  accept(data: string): {status: AgentStatus; notify: boolean} | undefined {
    if (!this.token) return;
    if (data === `mongle-shell;${this.token}`) {
      this.session = '';
      this.clearTools();
      if (this.status === 'idle') return;
      this.status = 'idle'; return {status:'idle', notify:false};
    }
    const prefix = `mongle-agent;${this.token};`;
    if (!data.startsWith(prefix) || data.length > 2048) return;
    let value: any;
    try { value = JSON.parse(Buffer.from(data.slice(prefix.length), 'base64').toString('utf8')); } catch { return; }
    if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.session)) return;
    if (value.event === 'SessionStart' || value.event === 'UserPromptSubmit') {this.session = value.session;this.clearTools();}
    if (!this.session || value.session !== this.session) return;
    let next: AgentStatus;
    const tool = typeof value.tool === 'string' && /^[a-f0-9]{64}$/.test(value.tool) ? value.tool : '';
    switch (value.event) {
      case 'SessionStart': next = 'idle'; break;
      case 'UserPromptSubmit': next = 'working'; break;
      case 'PostToolUse':
        if(tool)this.finishTool(tool);
        next = this.waiting.size ? 'attention' : 'working'; break;
      case 'PreToolUse':
        if(tool)this.activeTools.set(tool,(this.activeTools.get(tool)||0)+1);
        if(value.question === true && tool)this.waiting.add(tool);
        next = value.question === true || this.waiting.size ? 'attention' : 'working'; break;
      case 'PostToolUseFailure':
        if(tool)this.finishTool(tool);
        if(value.interrupted === true){this.clearTools();next='idle';}
        else next=this.waiting.size?'attention':'working';
        break;
      case 'PermissionRequest': if(tool)this.waiting.add(tool); next = 'attention'; break;
      case 'Notification':
        if (value.notification === 'idle_prompt') { if(this.status !== 'working') return; next = 'attention'; }
        else if (value.notification === 'permission_prompt' || value.notification === 'elicitation_dialog') next = 'attention';
        else return;
        break;
      case 'Stop': this.clearTools(); next = value.interrupted === true ? 'idle' : 'completed'; break;
      case 'StopFailure': this.clearTools(); next = 'error'; break;
      case 'SessionEnd': this.clearTools(); next = 'idle'; this.session = ''; break;
      default: return;
    }
    if (next === this.status) return;
    this.status = next;
    return {status:next, notify:next === 'completed' || next === 'attention' || next === 'error'};
  }
}
