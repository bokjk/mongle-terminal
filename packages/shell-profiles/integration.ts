import type { ShellProfile } from '../protocol/index.js';

const AGENT_PIPE = /^\\\\\.\\pipe\\mongle-agent-[a-f0-9]{32}$/;

/**
 * Session-local `codex` function for PowerShell. It never replaces an existing
 * user function or alias and never edits profiles. Interactive launches (and
 * `resume`/`fork`) get `--no-daemon` so lifecycle hooks run in this shell's
 * Codex process with this shell's token, plus a one-run nonce the managed hook
 * requires. Other subcommands and explicit --remote/--no-daemon pass through
 * unchanged. Calling codex.exe by full path bypasses this and is not captured.
 */
export const CODEX_POWERSHELL_WRAPPER = String.raw`
if ($env:MONGLE_AGENT_PIPE) {
  # Internal entry point; also used by the host's automatic resume line, so a
  # resumed conversation is launched and captured exactly like a typed one.
  function global:__MongleCodex {
    # Same lookup order PowerShell uses per directory, absolute PATH entries only.
    $cli = $null
    foreach ($dir in ($env:Path -split ';')) {
      $d = $dir.Trim().Trim('"')
      if ($d -notmatch '^[A-Za-z]:\\') { continue }
      foreach ($n in 'codex.ps1','codex.exe','codex.cmd') {
        $f = Join-Path $d $n
        if (Test-Path -LiteralPath $f -PathType Leaf) { $cli = $f; break }
      }
      if ($cli) { break }
    }
    if (-not $cli) { Write-Error 'codex: Codex CLI was not found in PATH.'; return }
    $a = @($args)
    $sub = 'exec','e','review','login','logout','mcp','plugin','app-server','remote-control','app','completion','update','doctor','sandbox','debug','apply','a','queue','archive','delete','migrate-rollouts','unarchive','cloud','exec-server','features','help','agents'
    $values = '-c','--config','--enable','--disable','--remote-auth-token-env','-i','--image','-m','--model','--local-provider','-p','--profile','-s','--sandbox','-C','--cd','--add-dir','-a','--ask-for-approval'
    # Every option before '--' is checked, wherever it appears (e.g. after 'resume').
    $at = -1; $first = $null; $skip = $false; $noDaemon = $false
    for ($i = 0; $i -lt $a.Count; $i++) {
      $t = [string]$a[$i]
      if ($t -eq '--') { break }
      if ($t -in '--remote','-h','--help','-V','--version' -or $t -like '--remote=*') { $skip = $true }
      if ($t -ceq '--no-daemon') { $noDaemon = $true }
      if ($values -ccontains $t) { $i++; continue }
      if ($t.StartsWith('-') -or $at -ge 0) { continue }
      $first = $t; $at = $i
    }
    # A Codex started from inside a Codex turn (CODEX_THREAD_ID) is never captured.
    if ($env:CODEX_THREAD_ID) { $skip = $true }
    $final = $a; $wrapped = $false
    if (-not $skip) {
      if ($first -ceq 'resume' -or $first -ceq 'fork') { $wrapped = $true; if (-not $noDaemon) { $final = @($a[0..$at]) + '--no-daemon' + @(if ($at + 1 -lt $a.Count) { $a[($at + 1)..($a.Count - 1)] }) } }
      elseif (-not ($first -and $sub -ccontains $first)) { $wrapped = $true; if (-not $noDaemon) { $final = @('--no-daemon') + $a } }
    }
    $previous = $env:MONGLE_CODEX_RUN
    if ($wrapped) { $env:MONGLE_CODEX_RUN = [guid]::NewGuid().ToString('N') } else { Remove-Item Env:MONGLE_CODEX_RUN -ErrorAction SilentlyContinue }
    try { & $cli @final } finally { if ($null -eq $previous) { Remove-Item Env:MONGLE_CODEX_RUN -ErrorAction SilentlyContinue } else { $env:MONGLE_CODEX_RUN = $previous } }
  }
  if (-not (Get-Command codex -CommandType Function,Alias -ErrorAction SilentlyContinue)) {
    function global:codex { __MongleCodex @args }
  }
}`;

/** Process-local prompt hooks; never edit the user's shell profile files. */
export function shellIntegration(profile: ShellProfile, args: string[], environment: Record<string, string>, options: {agentPipe?: string} = {}) {
  const env = { ...environment };
  const integratedArgs = [...args];
  const agentToken = /^[a-f0-9]{64}$/.test(env.MONGLE_AGENT_TOKEN || '') ? env.MONGLE_AGENT_TOKEN : '';
  const agentPipe = options.agentPipe ?? process.env.MONGLE_AGENT_PIPE ?? '';
  delete env.MONGLE_AGENT_PIPE; delete env.MONGLE_CODEX_RUN;
  // Only PowerShell has the wrapper that marks a capturable Codex run.
  if (profile.kind === 'powershell' && agentToken && AGENT_PIPE.test(agentPipe)) env.MONGLE_AGENT_PIPE = agentPipe;
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
}` + (env.MONGLE_AGENT_PIPE ? CODEX_POWERSHELL_WRAPPER : '');
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
