using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class JobHarness {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string a,b,c; public int x,y,sx,sy,cx,cy,fill,flags; public short show,reserved; public IntPtr reserved2,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref EXTENDED info,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr a,IntPtr b,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value) { var b=new StringBuilder("\""); int n=0; foreach(char c in value) { if(c=='\\') { n++; continue; } if(c=='"') { b.Append('\\',2*n+1); b.Append(c); n=0; continue; } b.Append('\\',n); n=0; b.Append(c); } b.Append('\\',2*n); return b.Append('"').ToString(); }
  public static int Main(string[] args) {
    try {
      var job=CreateJobObject(IntPtr.Zero,null); var info=new EXTENDED(); info.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(info))) throw new Win32Exception();
      var command=new StringBuilder(); foreach(var arg in args) command.Append(Quote(arg)).Append(' ');
      var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); PROCESS_INFORMATION pi;
      if(!CreateProcess(args[0],command,IntPtr.Zero,IntPtr.Zero,false,0x4,IntPtr.Zero,null,ref si,out pi)) throw new Win32Exception();
      if(!AssignProcessToJobObject(job,pi.process)) throw new Win32Exception();
      ResumeThread(pi.thread); var status=WaitForSingleObject(pi.process,20000); uint exitCode; GetExitCodeProcess(pi.process,out exitCode); CloseHandle(pi.thread); CloseHandle(pi.process); CloseHandle(job);
      if(status!=0) throw new Exception("Launcher did not finish");
      if(exitCode!=0) throw new Exception("Launcher exited with "+exitCode);
      return 0;
    } catch(Exception error) { Console.Error.WriteLine(error); return 1; }
  }
}
