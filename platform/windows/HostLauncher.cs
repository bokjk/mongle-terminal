using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

// A tiny launcher with no shell expansion. Detached host survives window/GUI exit.
// Breakaway is requested when a parent Job permits it; WMI is a documented fallback
// for launchers which place Electron in a kill-on-close job that forbids breakaway.
public static class HostLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string arg) { var b=new StringBuilder("\""); int slashes=0; foreach(char c in arg) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); slashes=0; continue; } b.Append('\\',slashes); slashes=0; b.Append(c); } b.Append('\\',slashes*2); b.Append('"'); return b.ToString(); }
  public static int Main(string[] args) {
    try {
      if(args.Length<3) throw new ArgumentException("Expected node.exe, host entry and data directory");
      string node=Path.GetFullPath(args[0]),entry=Path.GetFullPath(args[1]),data=Path.GetFullPath(args[2]);
      if(!File.Exists(node)||!File.Exists(entry)) throw new FileNotFoundException("Bundled host runtime is missing");
      string cwd=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(entry),"..",".."));
      string command=Quote(node)+" "+Quote(entry)+" --data-dir "+Quote(data);
      for(int i=3;i<args.Length;i++) command+=" "+Quote(args[i]);
      bool inJob; if(!IsProcessInJob(Process.GetCurrentProcess().Handle,IntPtr.Zero,out inJob)) throw new Win32Exception();
      var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); si.dwFlags=1; si.wShowWindow=0;
      PROCESS_INFORMATION pi;
      uint flags=0x00000008u|0x00000200u|(inJob?0x01000000u:0u);
      if(CreateProcess(node,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,flags,IntPtr.Zero,cwd,ref si,out pi)) {
        Console.WriteLine(pi.dwProcessId); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); return 0;
      }
      int error=Marshal.GetLastWin32Error(); if(!inJob) throw new Win32Exception(error);
      using(var processClass=new ManagementClass("Win32_Process")) {
        using(var start=new ManagementClass("Win32_ProcessStartup")) {
          using(var startup=start.CreateInstance()) {
            startup["ShowWindow"]=(ushort)0;
            startup["CreateFlags"]=(uint)(0x01000000u|0x00000200u|0x00000008u);
            using(var input=processClass.GetMethodParameters("Create")) {
              input["CommandLine"]=command; input["CurrentDirectory"]=cwd; input["ProcessStartupInformation"]=startup;
              using(var output=processClass.InvokeMethod("Create",input,null)) {
                if(Convert.ToUInt32(output["ReturnValue"])!=0) throw new InvalidOperationException("Independent host start failed; WMI code "+output["ReturnValue"]);
                Console.WriteLine(output["ProcessId"]); return 0;
              }
            }
          }
        }
      }
    } catch(Exception e) { Console.Error.WriteLine("HOST_START_FAILED: "+e.Message); return 1; }
  }
}
