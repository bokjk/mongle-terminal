// This fixture exercises packaged hooks with fabricated exact IDs; it cannot validate vendor CLI trust.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const provider=process.argv[2],args=process.argv.slice(3),config=JSON.parse(fs.readFileSync(path.join(__dirname,'fixture.json'),'utf8'));
if(args.includes('--version')){console.log(provider==='claude'?'2.1.292':'codex-cli 0.160.0');process.exit(0);}
const resume=provider==='claude'?'--resume':'resume';
const resumed=args.includes(resume),index=args.indexOf(resumed?resume:'--fixture-session');
const id=args.slice(index+1).find(x=>/^[0-9a-f-]{36}$/.test(x));
if(index<0||!id||!config.sessions.some(s=>s.provider===provider&&s.sessionId===id))throw Error('Unexpected fixture identity/command');
if(provider==='codex'&&(!args.includes('--no-daemon')||!process.env.MONGLE_CODEX_RUN))throw Error('Missing Codex lifecycle wrapper');
const hook=path.join(provider==='claude'?config.claudeHome:config.codexHome,provider==='claude'?'mongle-terminal-hook.cjs':'mongle-terminal-codex-hook.cjs');
const result=spawnSync(process.execPath,[hook],{encoding:'utf8',input:JSON.stringify({session_id:id,cwd:process.cwd(),hook_event_name:'SessionStart',source:resumed?'resume':'startup'}),timeout:5000});
if(result.status!==0||result.error)throw Error('Managed hook fixture failed');
if(provider==='claude')process.stdout.write(JSON.parse(result.stdout).terminalSequence);
else if(result.stdout||result.stderr)throw Error('Codex hook must not write model context');
fs.appendFileSync(config.log,JSON.stringify({provider,sessionId:id,resumed,cwd:process.cwd(),pid:process.pid,args})+'\n');
process.stdin.resume();setInterval(()=>{},1000);
