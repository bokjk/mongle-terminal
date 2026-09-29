import { spawn } from 'node:child_process';
import path from 'node:path';
import electron from 'electron';
const build = spawn(process.execPath,['--import','tsx','scripts/build.ts'],{stdio:'inherit',windowsHide:true});
const code = await new Promise<number|null>(resolve=>build.on('exit',resolve));
if (code !== 0) process.exit(code ?? 1);
const gui = spawn(electron as unknown as string,[path.resolve('.')],{stdio:'inherit',env:{...process.env,MONGLE_NODE_PATH:process.execPath},windowsHide:true});
gui.on('exit',code=>process.exit(code??0));
