param([ValidateSet('watch','exit','environment','discover','diagnose')] [string]$Mode, [string]$Config)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable GitHub-hosted runner required' }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
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
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] struct NotifyIdentifier { public uint size;public IntPtr window;public uint id;public Guid guid; }
 [DllImport("shell32.dll")] static extern int Shell_NotifyIconGetRect(ref NotifyIdentifier icon,out Rect rect);
 public static int RegisteredTrayRect(IntPtr window,uint id,out Rect rect){var icon=new NotifyIdentifier {size=(uint)Marshal.SizeOf(typeof(NotifyIdentifier)),window=window,id=id,guid=Guid.Empty};return Shell_NotifyIconGetRect(ref icon,out rect);}
 public static List<IntPtr> NotifyHosts(uint pid){var result=new List<IntPtr>();EnumWindows((h,l)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid && Class(h)=="Electron_NotifyIconHostWindow")result.Add(h);return true;},IntPtr.Zero);return result;}
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 public static bool RightClickTray(IntPtr root,uint shellPid,int x,int y){
   var point=new Point {X=x,Y=y};var hit=WindowFromPoint(point);uint actual;GetWindowThreadProcessId(hit,out actual);
   if(actual!=shellPid || GetAncestor(hit,2)!=root)return false;
   if(!SetCursorPos(x,y))return false;
   hit=WindowFromPoint(point);GetWindowThreadProcessId(hit,out actual);
   if(actual!=shellPid || GetAncestor(hit,2)!=root)return false;
   mouse_event(8,0,0,0,UIntPtr.Zero);mouse_event(16,0,0,0,UIntPtr.Zero);return true;
 }
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
 # Bounded raw-view traversal also exposes Chromium Views controls which are
 # Buttons or Custom controls rather than UIA MenuItems. Never inspect other apps.
 function Get-UpgradeUiaSnapshot($element) {
   $walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
   $queue=[System.Collections.Queue]::new();$queue.Enqueue(@{element=$element;depth=0})
   $result=@();$visited=0
   while($queue.Count -gt 0 -and $visited -lt 64) {
     $next=$queue.Dequeue();$visited++;$current=$next.element
     if($current.Current.ProcessId -ne $c.pid){continue}
     $name=[string]$current.Current.Name
     $result+=@{name=$name.Substring(0,[Math]::Min(128,$name.Length));type=$current.Current.ControlType.ProgrammaticName;offscreen=$current.Current.IsOffscreen;depth=$next.depth}
     if($next.depth -ge 5){continue}
     $child=$walker.GetFirstChild($current)
     while($null -ne $child -and $queue.Count -lt 64){$queue.Enqueue(@{element=$child;depth=($next.depth+1)});$child=$walker.GetNextSibling($child)}
   }
   return $result
 }
 # Electron v44.4.5 RootView::SetMenu omits the menu bar for titleBarStyle:hidden.
 # Use the production tray menu, not Alt or an injected application accelerator.
 $probes=@{}; $uiaErrors=@(); $trayOpened=$false; $trayAttempts=0; $overflowOpened=$false; $trayProbes=@{}; $trayCallback=$null; $callbackAttempted=$false
 $deadline=[DateTime]::UtcNow.AddSeconds(45)
 while ([DateTime]::UtcNow -lt $deadline) {
   if(-not $sent -and -not $trayOpened -and $trayAttempts -lt 3) {
     try {
       if((Get-Process -Id $c.pid -ErrorAction Stop).Path -ine $c.exe){throw 'Desktop path changed before tray activation'}
       $icons=@();$chevrons=@()
       foreach($trayWindow in [UpgradeWindow]::Windows()) {
         $trayClass=[UpgradeWindow]::Class($trayWindow)
         if($trayClass -notin @('Shell_TrayWnd','NotifyIconOverflowWindow')){continue}
         $shellPid=[uint32]0;[void][UpgradeWindow]::GetWindowThreadProcessId($trayWindow,[ref]$shellPid)
         if((Get-Process -Id $shellPid -ErrorAction Stop).Path -ine (Join-Path $env:SystemRoot 'explorer.exe')){continue}
         $trayRoot=[System.Windows.Automation.AutomationElement]::FromHandle($trayWindow)
         $buttons=$trayRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
         $trayProbes[$trayClass]=@($buttons | Select-Object -First 24 | ForEach-Object {$n=[string]$_.Current.Name;$a=[string]$_.Current.AutomationId;@{name=$n.Substring(0,[Math]::Min(128,$n.Length));automationId=$a.Substring(0,[Math]::Min(128,$a.Length));offscreen=$_.Current.IsOffscreen}})
         foreach($button in $buttons) {
           if($button.Current.ProcessId -ne $shellPid -or $button.Current.IsOffscreen -or -not $button.Current.IsEnabled){continue}
           $name=$button.Current.Name
           if($name -in @('몽글터미널','몽글터미널 · 업데이트 준비 완료')){$icons+=@{element=$button;root=$trayWindow;pid=$shellPid}}
           if($trayClass -eq 'Shell_TrayWnd' -and $name -in @('Notification Chevron','Show hidden icons','숨겨진 아이콘 표시')){$chevrons+=$button}
         }
       }
       if($icons.Count -gt 1){throw 'Ambiguous Mongle tray icons; refusing to click'}
       if($icons.Count -eq 1) {
         $icon=$icons[0];$point=$icon.element.GetClickablePoint();$trayAttempts++
         $trayOpened=[UpgradeWindow]::RightClickTray($icon.root,$icon.pid,[int]$point.X,[int]$point.Y)
       } elseif(-not $overflowOpened -and $chevrons.Count -eq 1) {
         $chevrons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();$overflowOpened=$true
       }
       if(-not $trayOpened -and $icons.Count -eq 0 -and $chevrons.Count -eq 0 -and -not $callbackAttempted) {
         # Hosted Explorer may expose no accessible notification buttons. This
         # sends the shell's RIGHT-CLICK callback only; selecting the real menu
         # item and confirming the real dialog remain independently required.
         # Contract: Electron v44.4.5 notify_icon_host.{h,cc}: next ID 1 + base 2,
         # WM_APP+1, Electron_NotifyIconHostWindow; notify_icon.cc handles the menu.
         # https://github.com/electron/electron/blob/v44.4.5/shell/browser/ui/win/notify_icon_host.h#L46
         # https://github.com/electron/electron/blob/v44.4.5/shell/browser/ui/win/notify_icon_host.cc#L25
         # https://github.com/electron/electron/blob/v44.4.5/shell/browser/ui/win/notify_icon.cc#L65
         if($c.electronVersion -ne '44.4.5'){throw 'Unverified Electron tray callback contract'}
         $callbackAttempted=$true
         $hosts=@([UpgradeWindow]::NotifyHosts([uint32]$c.pid))
         $trayCallback=@{hostCount=$hosts.Count;electronVersion=$c.electronVersion;iconId=3;message=0x8001;event=0x204;posted=$false}
         if($hosts.Count -ne 1){throw 'Expected exactly one tray host belonging to the validated desktop PID'}
         if((Get-Process -Id $c.pid -ErrorAction Stop).Path -ine $c.exe){throw 'Desktop path changed before tray callback'}
         $bounds=[UpgradeWindow+Rect]::new()
         $registration=[UpgradeWindow]::RegisteredTrayRect($hosts[0],3,[ref]$bounds)
         $trayCallback.registrationHResult=$registration;$trayCallback.bounds=$bounds;$trayCallback.host=$hosts[0].ToInt64()
         if($registration -ne 0 -or $bounds.Right -le $bounds.Left -or $bounds.Bottom -le $bounds.Top){throw 'Tray icon registration was not verified; refusing callback'}
         foreach($targetWindow in [UpgradeWindow]::Windows()) {
           $targetPid=[uint32]0;[void][UpgradeWindow]::GetWindowThreadProcessId($targetWindow,[ref]$targetPid)
           if($targetPid -eq $c.pid -and [UpgradeWindow]::Class($targetWindow) -eq 'Chrome_WidgetWin_1'){[void][UpgradeWindow]::SetForegroundWindow($targetWindow);break}
         }
         $trayCallback.posted=[UpgradeWindow]::PostMessage($hosts[0],0x8001,[IntPtr]3,[IntPtr]0x204)
         $trayOpened=$trayCallback.posted
       }
     } catch {if($uiaErrors.Count -lt 8){$uiaErrors+=($_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length)))}}
   }
   foreach($h in [UpgradeWindow]::Windows()) {
     $windowPid=[uint32]0; [void][UpgradeWindow]::GetWindowThreadProcessId($h,[ref]$windowPid)
     if($windowPid -ne $c.pid) { continue }
     $menu=[UpgradeWindow]::GetMenu($h)
     $probeKey=([UpgradeWindow]::Class($h))+'|'+([UpgradeWindow]::Text($h))+'|'+$sent+'|'+$trayOpened
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
           if($probes.ContainsKey($probeKey) -and -not $probes[$probeKey].ContainsKey('uiaControls')){$probes[$probeKey].uiaControls=@(Get-UpgradeUiaSnapshot $element)}
           $menuCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::MenuItem)
           if($trayOpened){$menuCondition=[System.Windows.Automation.OrCondition]::new($menuCondition,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))}
           $items=$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,$menuCondition)
           $names=@($items | Select-Object -First 16 | ForEach-Object {$_.Current.Name})
           if($probes.ContainsKey($probeKey)){$probes[$probeKey].menuItems=$names}
           foreach($item in $items) {
             if($item.Current.ProcessId -ne $c.pid){continue}
             if($item.Current.IsOffscreen -or -not $item.Current.IsEnabled){continue}
             if($item.Current.Name.Replace('&','') -eq '완전 종료…') {
               $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();$sent=$true;break
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
   if($confirmed) { @{menuInvoked=$sent;confirmationClicked=$true;trayOpened=$trayOpened;trayCallback=$trayCallback;trayProbes=$trayProbes;probes=@($probes.Values);uiaErrors=$uiaErrors} | ConvertTo-Json -Depth 6 -Compress; exit 0 }
   Start-Sleep -Milliseconds 100
 }
 $diagnostic=@{menuInvoked=$sent;confirmationClicked=$confirmed;trayOpened=$trayOpened;trayCallback=$trayCallback;trayAttempts=$trayAttempts;overflowOpened=$overflowOpened;trayProbes=$trayProbes;probes=@($probes.Values);uiaErrors=$uiaErrors} | ConvertTo-Json -Depth 6 -Compress
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
