import type { ShellProfile } from '../protocol/index.js';

/** Process-local prompt hooks; never edit the user's shell profile files. */
export function shellIntegration(profile: ShellProfile, args: string[], environment: Record<string, string>) {
  const env = { ...environment };
  const integratedArgs = [...args];
  const agentToken = /^[a-f0-9]{64}$/.test(env.MONGLE_AGENT_TOKEN || '') ? env.MONGLE_AGENT_TOKEN : '';
  if (profile.kind === 'powershell') {
    // The PowerShell host writes Unicode console text. Console.Write instead
    // encodes through OutputEncoding and can replace Hangul with '?' on US PCs.
    const script = String.raw`
$global:__MongleOriginalPrompt = $function:prompt
function global:prompt {
  $result = & $global:__MongleOriginalPrompt
  if ($env:MONGLE_AGENT_TOKEN) { Write-Host -NoNewline ([char]27 + ']777;mongle-shell;' + $env:MONGLE_AGENT_TOKEN + [char]7) }
  if ($PWD.Provider.Name -eq 'FileSystem') {
    Write-Host -NoNewline ([char]27 + ']9;9;' + $PWD.ProviderPath + [char]27 + '\')
  }
  $result
}`;
    integratedArgs.push('-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'));
  } else if (profile.kind === 'cmd') {
    const promptKey = Object.keys(env).find(key => key.toUpperCase() === 'PROMPT');
    const prompt = promptKey ? env[promptKey] : '$P$G';
    if (promptKey) delete env[promptKey];
    env.PROMPT = `${prompt}$E]9;9;$P$E\\${agentToken ? `$E]777;mongle-shell;${agentToken}$E\\` : ''}`;
  } else if (profile.kind === 'bash') {
    // Existing prompt commands still run first. Login files may replace this;
    // shells that already emit OSC 7 work without this hook as well.
    // Git Bash's /c and /tmp mounts are not Windows filesystem paths. Its pwd
    // builtin resolves every mount (including custom installs) with -W; ordinary
    // Unix Bash falls back to pwd. Never guess mount roots from a drive letter.
    env.PROMPT_COMMAND = `${env.PROMPT_COMMAND ? env.PROMPT_COMMAND + '\n' : ''}printf '\\033]9;9;%s\\033\\\\' "$(pwd -W 2>/dev/null || pwd)"`;
    if(agentToken) env.PROMPT_COMMAND += `; printf '\\033]777;mongle-shell;%s\\007' "$MONGLE_AGENT_TOKEN"`;
  }
  return { args: integratedArgs, env };
}

/** Directory reports are display metadata, never commands or launch arguments. */
export function reportedDirectory(data: string, osc: 7 | 9): string | undefined {
  let directory: string;
  try {
    if (osc === 7) {
      const uri = new URL(data);
      if (uri.protocol !== 'file:' || uri.search || uri.hash || uri.username || uri.password) return;
      directory = decodeURIComponent(uri.pathname);
      if (/^\/[a-z]:\//i.test(directory)) directory = directory.slice(1).replaceAll('/', '\\');
    } else {
      if (!data.startsWith('9;')) return;
      directory = data.slice(2);
      if (directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1);
    }
  } catch { return; }
  if (!directory || directory.length > 4096 || /[\x00-\x1f\x7f]/.test(directory)) return;
  if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(directory)) return;
  return directory;
}
