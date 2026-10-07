param([ValidateSet('watch','exit','environment','discover','diagnose')] [string]$Mode, [string]$Config)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable GitHub-hosted runner required' }
$c = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($Mode -eq 'discover') {
 # Failure cleanup only: exact installed executable, automatic launch flag and
 # creation after this installation began; never select an unrelated desktop.
 $matches = @(Get-CimInstance Win32_Process -Filter "Name='MongleTerminal.exe'" | Where-Object {
   $_.ExecutablePath -ieq $c.exe -and $_.CommandLine -match '(?:^|\s)--updated(?:\s|$)' -and
   $_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)' -and $_.CreationDate.ToUniversalTime() -ge [DateTime]::Parse($c.since).ToUniversalTime()
 } | ForEach-Object {
   @{kind='desktop';pid=[int]$_.ProcessId;path=$_.ExecutablePath;visible=$false;progress=$false;commandLine=$_.CommandLine;time=$_.CreationDate.ToUniversalTime().ToString('o')}
 })
 ConvertTo-Json -InputObject $matches -Compress
 exit 0
}
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class UpgradeWindow {
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h,EnumProc f,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr h,int i);
 [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr h,int i);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr h,uint i,StringBuilder s,int n,uint flags);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,string l,uint flags,uint ms,out IntPtr result);
 public static string Text(IntPtr h){var s=new StringBuilder(512);GetWindowText(h,s,s.Capacity);return s.ToString();}
 public static string Class(IntPtr h){var s=new StringBuilder(128);GetClassName(h,s,s.Capacity);return s.ToString();}
 public static List<IntPtr> Windows(){var a=new List<IntPtr>();EnumWindows((h,l)=>{if(IsWindowVisible(h))a.Add(h);return true;},IntPtr.Zero);return a;}
 public static List<IntPtr> Children(IntPtr h){var a=new List<IntPtr>();EnumChildWindows(h,(x,l)=>{if(IsWindowVisible(x))a.Add(x);return true;},IntPtr.Zero);return a;}
 public static int FullExit(IntPtr menu){for(int i=0;i<GetMenuItemCount(menu);i++){var s=new StringBuilder(256);GetMenuString(menu,(uint)i,s,s.Capacity,0x400);if(s.ToString().Replace("&","")=="완전 종료…")return (int)GetMenuItemID(menu,i);var sub=GetSubMenu(menu,i);if(sub!=IntPtr.Zero){int id=FullExit(sub);if(id>=0)return id;}}return -1;}
}
'@
if ($Mode -eq 'diagnose') {
 # Hosted-VM diagnostics only. Never feed this broader list into exit/discover.
 $processes=@(Get-CimInstance Win32_Process -Filter "Name='MongleTerminal.exe'" | Select-Object -First 16 | ForEach-Object {
   @{pid=[int]$_.ProcessId;path=$_.ExecutablePath;commandLine=([string]$_.CommandLine).Substring(0,[Math]::Min(4096,([string]$_.CommandLine).Length));sessionId=$_.SessionId;parentPid=$_.ParentProcessId;created=$_.CreationDate}
 })
 $windows=@(foreach($h in [UpgradeWindow]::Windows()) {
   $windowPid=[uint32]0; [void][UpgradeWindow]::GetWindowThreadProcessId($h,[ref]$windowPid)
   try {$file=(Get-Process -Id $windowPid -ErrorAction Stop).Path} catch {continue}
   if($file -ine $c.installer -and $file -ine $c.exe){continue}
   @{pid=$windowPid;path=$file;title=[UpgradeWindow]::Text($h);class=[UpgradeWindow]::Class($h);children=@([UpgradeWindow]::Children($h) | Select-Object -First 16 | ForEach-Object {@{text=[UpgradeWindow]::Text($_);class=[UpgradeWindow]::Class($_)}})}
 })
 $windows=@($windows | Select-Object -First 8)
 @{observerSessionId=(Get-Process -Id $PID).SessionId;processes=$processes;windows=$windows;explorerSessions=@(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 8 | ForEach-Object {@{pid=$_.Id;sessionId=$_.SessionId}})} | ConvertTo-Json -Depth 6 -Compress
 exit 0
}
if ($Mode -eq 'environment') {
 foreach ($entry in $c.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value, 'User') }
 $result=[IntPtr]::Zero
 [void][UpgradeWindow]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,5000,[ref]$result)
 exit 0
}
if ($Mode -eq 'exit') {
 $p=Get-Process -Id $c.pid
 if ($p.Path -ine $c.exe) { throw 'Desktop path mismatch' }
 $sent=$false; $confirmed=$false
 Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
 $probes=@{}; $uiaErrors=@(); $expanded=$false
 $deadline=[DateTime]::UtcNow.AddSeconds(45)
 while ([DateTime]::UtcNow -lt $deadline) {
   foreach($h in [UpgradeWindow]::Windows()) {
     $windowPid=[uint32]0; [void][UpgradeWindow]::GetWindowThreadProcessId($h,[ref]$windowPid)
     if($windowPid -ne $c.pid) { continue }
     $menu=[UpgradeWindow]::GetMenu($h)
     $probeKey=([UpgradeWindow]::Class($h))+'|'+([UpgradeWindow]::Text($h))+'|'+$sent
     if($probes.Count -lt 16 -and -not $probes.ContainsKey($probeKey)) {
       $probes[$probeKey]=@{title=[UpgradeWindow]::Text($h);class=[UpgradeWindow]::Class($h);nativeMenu=($menu -ne [IntPtr]::Zero);children=@([UpgradeWindow]::Children($h) | Select-Object -First 12 | ForEach-Object {@{text=[UpgradeWindow]::Text($_);class=[UpgradeWindow]::Class($_)}})}
     }
     if(-not $sent) {
       if($menu -ne [IntPtr]::Zero) {
         $id=[UpgradeWindow]::FullExit($menu)
         if($id -ge 0) { [void][UpgradeWindow]::PostMessage($h,0x111,[IntPtr]$id,[IntPtr]::Zero); $sent=$true }
       }
       if(-not $sent) {
         try {
           $element=[System.Windows.Automation.AutomationElement]::FromHandle($h)
           $items=$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::MenuItem))
           $names=@($items | Select-Object -First 16 | ForEach-Object {$_.Current.Name})
           if($probes.ContainsKey($probeKey)){$probes[$probeKey].menuItems=$names}
           foreach($item in $items) {
             if($item.Current.ProcessId -ne $c.pid){continue}
             if($item.Current.Name.Replace('&','') -eq '완전 종료…') {
               $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();$sent=$true;break
             }
           }
           if(-not $sent -and -not $expanded) {
             foreach($item in $items) {
               if($item.Current.ProcessId -eq $c.pid -and $item.Current.Name.Replace('&','') -eq '몽글터미널') {
                 $expand=$null
                 if($item.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$expand)){$expand.Expand()}
                 else {$item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()}
                 $expanded=$true;break
               }
             }
           }
         } catch {if($uiaErrors.Count -lt 8){$uiaErrors+=($_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length)))}}
       }
     } elseif ([UpgradeWindow]::Text($h) -eq '몽글터미널 완전 종료') {
       foreach($button in [UpgradeWindow]::Children($h)) {
         if([UpgradeWindow]::Class($button) -eq 'Button' -and [UpgradeWindow]::Text($button).Replace('&','') -eq '완전 종료') {
           [void][UpgradeWindow]::PostMessage($button,0xf5,[IntPtr]::Zero,[IntPtr]::Zero); $confirmed=$true
         }
       }
     }
     if($sent -and -not $confirmed) {
       try {
         $dialog=[System.Windows.Automation.AutomationElement]::FromHandle($h)
         $message=$dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'현재 컴퓨터의 몽글터미널을 완전히 종료할까요?'))
         $buttons=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
         if($probes.ContainsKey($probeKey)){$probes[$probeKey].buttons=@($buttons | Select-Object -First 12 | ForEach-Object {$_.Current.Name})}
         if([UpgradeWindow]::Text($h) -eq '몽글터미널 완전 종료' -or $null -ne $message) {
           foreach($button in $buttons) {
             if($button.Current.ProcessId -eq $c.pid -and $button.Current.Name.Replace('&','') -eq '완전 종료') {
               $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();$confirmed=$true;break
             }
           }
         }
       } catch {if($uiaErrors.Count -lt 8){$uiaErrors+=($_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length)))}}
     }
   }
   if($confirmed) { @{menuInvoked=$sent;confirmationClicked=$true;probes=@($probes.Values);uiaErrors=$uiaErrors} | ConvertTo-Json -Depth 6 -Compress; exit 0 }
   Start-Sleep -Milliseconds 100
 }
 $diagnostic=@{menuInvoked=$sent;confirmationClicked=$confirmed;probes=@($probes.Values);uiaErrors=$uiaErrors} | ConvertTo-Json -Depth 6 -Compress
 throw "Could not invoke and confirm the real full-exit menu: $diagnostic"
}
# Observer is ready before the installer is launched. Only records visible windows
# belonging to the exact candidate installer or exact installed desktop executable.
$seen=@{}; $deadline=[DateTime]::UtcNow.AddSeconds(210)
Set-Content -LiteralPath $c.ready -Value 'ready'
while(-not (Test-Path -LiteralPath $c.stop) -and [DateTime]::UtcNow -lt $deadline) {
 foreach($h in [UpgradeWindow]::Windows()) {
   $windowPid=[uint32]0; [void][UpgradeWindow]::GetWindowThreadProcessId($h,[ref]$windowPid)
   try { $proc=Get-Process -Id $windowPid -ErrorAction Stop; $file=$proc.Path } catch {continue}
   $kind=if($file -ieq $c.installer){'installer'} elseif($file -ieq $c.exe){'desktop'} else {continue}
   $progress=@([UpgradeWindow]::Children($h) | Where-Object { [UpgradeWindow]::Class($_) -eq 'msctls_progress32' }).Count -gt 0
   $key="$kind-$windowPid-$progress"
   if($seen.ContainsKey($key)){continue}; $seen[$key]=$true
   $command=if($kind -eq 'desktop'){(Get-CimInstance Win32_Process -Filter "ProcessId=$windowPid").CommandLine}else{''}
   @{kind=$kind;pid=$windowPid;path=$file;visible=$true;progress=$progress;class=[UpgradeWindow]::Class($h);commandLine=$command;time=[DateTime]::UtcNow.ToString('o')} |
     ConvertTo-Json -Compress | Add-Content -LiteralPath $c.events
 }
 Start-Sleep -Milliseconds 30
}
