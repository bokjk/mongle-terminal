import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

/** Probe access only. Never read, empty, or write the user's clipboard. */
export async function probeClipboardAccess(): Promise<{ available: boolean; error: number }> {
  if (process.platform !== 'win32') throw new Error('The native clipboard probe requires Windows.');
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MongleClipboardAccess {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();
}
'@
$available = [MongleClipboardAccess]::OpenClipboard([IntPtr]::Zero)
$errorCode = if ($available) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
if ($available) {
  if (-not [MongleClipboardAccess]::CloseClipboard()) { throw 'The clipboard probe could not release its access.' }
}
@{ available = $available; error = $errorCode } | ConvertTo-Json -Compress
`;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024,
  });
  const result = JSON.parse(stdout.trim()) as { available: unknown; error: unknown };
  if (typeof result.available !== 'boolean' || !Number.isInteger(result.error) || Number(result.error) < 0) {
    throw new Error('The native clipboard access probe returned an invalid result.');
  }
  return result as { available: boolean; error: number };
}
