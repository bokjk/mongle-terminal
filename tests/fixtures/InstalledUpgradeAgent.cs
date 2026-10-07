// Isolated CLI test double, not Claude or Codex. No authentication or model calls.
using System;
using System.IO;
using System.Diagnostics;
using System.Text;
public class InstalledUpgradeAgent {
 static string Quote(string value) {
   var s=new StringBuilder("\"");int n=0;
   foreach(char c in value){if(c=='\\'){n++;continue;}if(c=='"'){s.Append('\\',n*2+1);s.Append(c);}else{s.Append('\\',n);s.Append(c);}n=0;}
   s.Append('\\',n*2);s.Append('"');return s.ToString();
 }
 public static int Main(string[] args) {
   string dir=Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
   string provider=Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName);
   string fixtureRoot=Path.Combine(dir,"mongle-installed-upgrade-fixture.path");
   if(File.Exists(fixtureRoot))dir=File.ReadAllText(fixtureRoot).Trim();
   var command=new StringBuilder(Quote(Path.Combine(dir,"agent.cjs"))+" "+provider);
   foreach(string arg in args)command.Append(" "+Quote(arg));
   var start=new ProcessStartInfo(File.ReadAllText(Path.Combine(dir,"node.path")).Trim(),command.ToString());
   start.UseShellExecute=false;
   using(var child=Process.Start(start)){child.WaitForExit();return child.ExitCode;}
 }
}
