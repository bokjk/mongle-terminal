// .NET Framework helper. Keep authentication material out of JavaScript and renderers.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class OwnerPipe
{
    private const int MaxServerFrame = 16 * 1024 * 1024;
    private const int MaxClientFrame = 128 * 1024;
    private const int MaxLine = 23 * 1024 * 1024;
    private const int MaxQueuedBytes = 24 * 1024 * 1024;
    private const int MaxOutputBytes = 64 * 1024 * 1024;
    private const int MaxClients = 16;
    private const int HandshakeTimeout = 5000;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly object JsonLock = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxLine, RecursionLimit = 8 };
    private static readonly SecurityIdentifier UserSid = WindowsIdentity.GetCurrent().User;
    private static readonly string ImagePath = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
    private static readonly int OwnPid = Process.GetCurrentProcess().Id;
    private static readonly ConcurrentDictionary<string, Peer> Peers = new ConcurrentDictionary<string, Peer>();
    private static readonly BlockingCollection<string> Output = new BlockingCollection<string>(128);
    private static int OutputBytes;
    private static int Connections;
    private static volatile bool Stopping;
    private static NamedPipeServerStream WaitingPipe;
    private static bool FirstPipeCreated;
    private static string PipeName;
    private static byte[] Secret;
    private static FileStream HostLock;
    private static IntPtr HostParent;
    private static IntPtr ParentLockHandle;
    private static int ParentPid;
    private static bool ServerReady;
    private static bool ParentRequestedStop;

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool WaitNamedPipe(string name, uint timeout);
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outputSize, uint inputSize, uint defaultTimeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
    [StructLayout(LayoutKind.Sequential)] private struct ProcessBasicInformation { public IntPtr Reserved1; public IntPtr Peb; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr ProcessId; public IntPtr ParentProcessId; }
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, ref ProcessBasicInformation information, int length, out int returnLength);

    private sealed class OwnerException : Exception
    {
        public readonly string Code;
        public OwnerException(string code, string message) : base(message) { Code = code; }
    }

    public static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        new Thread(WriteOutput) { IsBackground = true, Name = "owner-output" }.Start();
        try
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || args.Length < 2 || (args[0] != "server" && args[0] != "client" && args[0] != "prepare") || (args[0] == "server" ? args.Length != 3 : args.Length != 2))
                throw new InvalidOperationException("Windows owner IPC requires server/client/prepare and a data directory.");
            if (args[0] == "server" && (!Int32.TryParse(args[2], out ParentPid) || ParentPid <= 0)) throw new SecurityException("Owner host parent identity is required.");
            string dataDir = Path.GetFullPath(args[1]).TrimEnd(Path.DirectorySeparatorChar);
            if (dataDir.Length < 4) throw new SecurityException("A dedicated data directory is required.");
            RejectReparsePoints(dataDir);
            if (args[0] == "prepare")
            {
                // Electron must prepare the parent before Chromium creates its
                // profile with an elevated token's default Administrators owner.
                // This path never reads secrets, takes a host lock or starts IPC.
                ProtectDirectory(dataDir);
                Console.WriteLine("{\"kind\":\"prepared\"}");
                Console.Out.Flush();
                return 0;
            }
            if (args[0] == "client" && (!Directory.Exists(dataDir) || !File.Exists(Path.Combine(dataDir, "owner.secret"))))
                throw new OwnerException("NO_HOST", "No local owner host has been initialized.");
            if (args[0] == "server") ProtectDirectory(dataDir);
            else VerifyDirectory(dataDir);
            Secret = ReadSecret(dataDir, args[0] == "server");
            using (SHA256 hash = SHA256.Create())
                PipeName = "mongle-owner-" + Hex(hash.ComputeHash(Utf8.GetBytes(UserSid.Value + "\n" + dataDir.ToUpperInvariant()))).Substring(0, 40);
            if (args[0] == "server") { AcquireHostLock(dataDir); RunServer(); } else RunClient();
            return 0;
        }
        catch (Exception error)
        {
            // Error types are enough for diagnostics. Never print authentication bytes or payloads.
            OwnerException known = error as OwnerException;
            string code = known != null ? known.Code : error is SecurityException || error is UnauthorizedAccessException ? "AUTH_FAILED" : "IPC_ERROR";
            Console.Error.WriteLine("OWNER_IPC_ERROR:" + code + ":" + error.Message);
            return 1;
        }
        finally
        {
            Stop();
            // After readiness, EOF/error may leave a live Node host using this store.
            // Only an explicit stop command may release its duplicate before Node exits.
            ReleaseHostLock(ParentRequestedStop || !ServerReady);
            if (Secret != null) Array.Clear(Secret, 0, Secret.Length);
        }
    }

    private static void RejectReparsePoints(string path)
    {
        string cursor = path;
        while (!String.IsNullOrEmpty(cursor))
        {
            if ((Directory.Exists(cursor) || File.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                throw new SecurityException("Reparse points are not allowed in owner IPC storage.");
            cursor = Path.GetDirectoryName(cursor);
        }
    }

    private static DirectorySecurity DirectoryAcl()
    {
        DirectorySecurity security = new DirectorySecurity();
        security.SetOwner(UserSid);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(UserSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    private static void ProtectDirectory(string path)
    {
        if (Directory.Exists(path))
        {
            DirectorySecurity existing = Directory.GetAccessControl(path, AccessControlSections.Owner);
            if (!UserSid.Equals(existing.GetOwner(typeof(SecurityIdentifier))))
                throw new SecurityException("Owner IPC data directory is owned by another account.");
            Directory.SetAccessControl(path, DirectoryAcl());
        }
        else Directory.CreateDirectory(path, DirectoryAcl()); // ACL is supplied to CreateDirectory, not applied after creation.
        VerifyDirectory(path);
    }

    private static void VerifyDirectory(string path)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException("Owner IPC data directory does not exist.");
        CheckAcl(Directory.GetAccessControl(path, AccessControlSections.Access | AccessControlSections.Owner));
    }

    private static void CheckAcl(FileSystemSecurity security)
    {
        if (!security.AreAccessRulesProtected || !UserSid.Equals(security.GetOwner(typeof(SecurityIdentifier))))
            throw new SecurityException("Owner IPC storage must have a protected, current-user ACL.");
        bool own = false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            if (!UserSid.Equals(rule.IdentityReference)) throw new SecurityException("Owner IPC storage grants access to another account.");
            if ((rule.FileSystemRights & FileSystemRights.ReadData) != 0) own = true;
        }
        if (!own) throw new SecurityException("Owner IPC storage is not readable by its owner.");
    }

    private static byte[] ReadSecret(string directory, bool create)
    {
        string path = Path.Combine(directory, "owner.secret");
        RejectReparsePoints(path);
        if (create && !File.Exists(path))
        {
            FileSecurity security = new FileSecurity();
            security.SetOwner(UserSid);
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(UserSid, FileSystemRights.FullControl, AccessControlType.Allow));
            byte[] generated = RandomBytes();
            try
            {
                using (FileStream file = new FileStream(path, FileMode.CreateNew, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, security))
                {
                    file.Write(generated, 0, generated.Length);
                    file.Flush(true);
                }
            }
            catch (IOException) { if (!File.Exists(path)) throw; }
            finally { Array.Clear(generated, 0, generated.Length); }
        }
        CheckAcl(File.GetAccessControl(path, AccessControlSections.Access | AccessControlSections.Owner));
        using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (file.Length != 32) throw new SecurityException("Invalid owner IPC secret length.");
            byte[] bytes = new byte[32];
            int read = file.Read(bytes, 0, 32);
            if (read != 32) throw new SecurityException("Cannot read owner IPC secret.");
            return bytes;
        }
    }

    private static NamedPipeServerStream MakePipe()
    {
        PipeSecurity security = new PipeSecurity();
        security.SetOwner(UserSid);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(UserSid, PipeAccessRights.FullControl, AccessControlType.Allow));
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
        try
        {
            Marshal.Copy(descriptor, 0, memory, descriptor.Length);
            SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = memory, Inherit = false };
            // PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, and FIRST_PIPE_INSTANCE on initial creation.
            uint openMode = 0x00000003 | 0x40000000;
            if (!FirstPipeCreated) openMode |= 0x00080000;
            // PIPE_REJECT_REMOTE_CLIENTS forbids SMB access even for an otherwise valid user.
            SafePipeHandle handle = CreateNamedPipe("\\\\.\\pipe\\" + PipeName, openMode, 0x00000008, MaxClients, 65536, 65536, 5000, ref attributes);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            FirstPipeCreated = true;
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    private static void AcquireHostLock(string directory)
    {
        ProcessBasicInformation info = new ProcessBasicInformation();
        int returned;
        if (NtQueryInformationProcess(new IntPtr(-1), 0, ref info, Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned) != 0 || info.ParentProcessId.ToInt64() != ParentPid)
            throw new SecurityException("Owner host PID is not the helper's actual parent.");
        HostParent = OpenProcess(0x1000 | 0x0040, false, (uint)ParentPid); // QUERY_LIMITED_INFORMATION | DUP_HANDLE
        if (HostParent == IntPtr.Zero) throw new SecurityException("Cannot retain the owner host instance guard.");
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(HostParent, 0x0008, out token)) throw new SecurityException("Cannot verify owner host account.");
            using (WindowsIdentity identity = new WindowsIdentity(token))
                if (!UserSid.Equals(identity.User)) throw new SecurityException("Owner host belongs to another account.");
        }
        finally { if (token != IntPtr.Zero) CloseHandle(token); }

        string path = Path.Combine(directory, "owner-host.lock");
        RejectReparsePoints(path);
        if (File.Exists(path)) CheckAcl(File.GetAccessControl(path, AccessControlSections.Access | AccessControlSections.Owner));
        FileSecurity security = new FileSecurity();
        security.SetOwner(UserSid);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(UserSid, FileSystemRights.FullControl, AccessControlType.Allow));
        try { HostLock = new FileStream(path, FileMode.OpenOrCreate, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.None, security); }
        catch (IOException) { throw new OwnerException("HOST_ALREADY_RUNNING", "A local owner host still holds this data directory."); }
        CheckAcl(HostLock.GetAccessControl());
        if (!DuplicateHandle(new IntPtr(-1), HostLock.SafeFileHandle.DangerousGetHandle(), HostParent, out ParentLockHandle, 0, false, 2))
            throw new SecurityException("Cannot transfer the owner host instance guard.");
    }

    private static void ReleaseHostLock(bool releaseParentDuplicate)
    {
        if (releaseParentDuplicate && ParentLockHandle != IntPtr.Zero && HostParent != IntPtr.Zero)
        {
            IntPtr copy;
            // CLOSE_SOURCE removes the parent's duplicate on graceful helper shutdown.
            if (DuplicateHandle(HostParent, ParentLockHandle, new IntPtr(-1), out copy, 0, false, 3)) CloseHandle(copy);
        }
        ParentLockHandle = IntPtr.Zero;
        if (HostLock != null) { HostLock.Dispose(); HostLock = null; }
        if (HostParent != IntPtr.Zero) { CloseHandle(HostParent); HostParent = IntPtr.Zero; }
    }

    private static void RunServer()
    {
        // A per-user named mutex prevents two servers from intentionally sharing a pipe name.
        MutexSecurity acl = new MutexSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new MutexAccessRule(UserSid, MutexRights.FullControl, AccessControlType.Allow));
        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\" + PipeName + "-singleton", out created, acl))
        {
            if (!created) throw new IOException("An owner IPC server is already running for this directory.");
            WaitingPipe = MakePipe();
            ServerReady = true;
            Emit(new { kind = "ready", pipeName = PipeName, pid = OwnPid });
            new Thread(AcceptClients) { IsBackground = true, Name = "owner-accept" }.Start();
            ReadParentCommands(true, null);
            mutex.ReleaseMutex();
        }
    }

    private static void AcceptClients()
    {
        while (!Stopping)
        {
            NamedPipeServerStream pipe = WaitingPipe;
            try
            {
                pipe.WaitForConnection();
                if (Interlocked.Increment(ref Connections) > MaxClients - 1)
                {
                    Interlocked.Decrement(ref Connections);
                    pipe.Dispose();
                }
                else new Thread(delegate() { ServeClient(pipe); }) { IsBackground = true, Name = "owner-peer" }.Start();
                WaitingPipe = MakePipe();
            }
            catch (Exception)
            {
                if (!Stopping) { Emit(new { kind = "fatal", message = "Owner IPC listener stopped." }); Stop(); }
                return;
            }
        }
    }

    private static int VerifyPeer(PipeStream stream, bool server)
    {
        uint pid;
        if (!(server ? GetNamedPipeClientProcessId(stream.SafePipeHandle, out pid) : GetNamedPipeServerProcessId(stream.SafePipeHandle, out pid)))
            throw new SecurityException("Cannot establish owner IPC peer identity.");
        IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) throw new SecurityException("Cannot inspect owner IPC peer.");
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process, 0x0008, out token)) throw new SecurityException("Cannot inspect owner IPC peer account.");
            using (WindowsIdentity identity = new WindowsIdentity(token))
                if (!UserSid.Equals(identity.User)) throw new SecurityException("Owner IPC peer has another account.");
            uint length = 32768;
            StringBuilder image = new StringBuilder((int)length);
            if (!QueryFullProcessImageName(process, 0, image, ref length) || !String.Equals(Path.GetFullPath(image.ToString()), ImagePath, StringComparison.OrdinalIgnoreCase))
                throw new SecurityException("Owner IPC peer is not the installed owner helper.");
            return checked((int)pid);
        }
        finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
    }

    private static void ServeClient(NamedPipeServerStream pipe)
    {
        Peer peer = null;
        try
        {
            int clientPid = VerifyPeer(pipe, true);
            string[] hello = ReadText(pipe, 1024, HandshakeTimeout).Split(' ');
            if (hello.Length != 2 || hello[0] != "HELLO") throw new SecurityException("Invalid owner IPC handshake.");
            ValidateNonce(hello[1]);
            string serverNonce = Convert.ToBase64String(RandomBytes());
            string transcript = Transcript(OwnPid, clientPid, hello[1], serverNonce);
            WriteText(pipe, "CHALLENGE " + serverNonce + " " + Proof("server", transcript));
            string[] auth = ReadText(pipe, 1024, HandshakeTimeout).Split(' ');
            if (auth.Length != 2 || auth[0] != "AUTH" || !Equal(auth[1], Proof("client", transcript)))
                throw new SecurityException("Owner IPC authentication failed.");
            string id = Guid.NewGuid().ToString();
            WriteText(pipe, "OK " + id + " " + Proof("complete", transcript + "\n" + id));
            peer = new Peer(id, pipe, MaxClientFrame);
            if (!Peers.TryAdd(id, peer)) throw new IOException("Owner IPC connection collision.");
            Emit(new { kind = "connected", id = id, sid = UserSid.Value, pid = clientPid });
            peer.Run();
        }
        catch (Exception) { /* Unauthenticated peers never reach the owner RPC dispatcher. */ }
        finally
        {
            if (peer != null) RemovePeer(peer.Id); else pipe.Dispose();
            Interlocked.Decrement(ref Connections);
        }
    }

    private static void RunClient()
    {
        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None))
        {
            if (!WaitNamedPipe("\\\\.\\pipe\\" + PipeName, 1))
            {
                int probeError = Marshal.GetLastWin32Error();
                if (probeError == 2 || probeError == 3) throw new OwnerException("NO_HOST", "No local owner host is listening.");
            }
            try { pipe.Connect(5000); }
            catch (TimeoutException)
            {
                WaitNamedPipe("\\\\.\\pipe\\" + PipeName, 1);
                int error = Marshal.GetLastWin32Error();
                if (error == 2 || error == 3) throw new OwnerException("NO_HOST", "No local owner host is listening.");
                throw new OwnerException("HOST_BUSY", "Local owner host is not accepting connections.");
            }
            int serverPid = VerifyPeer(pipe, false);
            string clientNonce = Convert.ToBase64String(RandomBytes());
            WriteText(pipe, "HELLO " + clientNonce);
            string[] challenge = ReadText(pipe, 1024, HandshakeTimeout).Split(' ');
            if (challenge.Length != 3 || challenge[0] != "CHALLENGE") throw new SecurityException("Invalid owner IPC challenge.");
            ValidateNonce(challenge[1]);
            string transcript = Transcript(serverPid, OwnPid, clientNonce, challenge[1]);
            if (!Equal(challenge[2], Proof("server", transcript))) throw new SecurityException("Owner IPC server authentication failed.");
            WriteText(pipe, "AUTH " + Proof("client", transcript));
            string[] ok = ReadText(pipe, 1024, HandshakeTimeout).Split(' ');
            Guid id;
            if (ok.Length != 3 || ok[0] != "OK" || !Guid.TryParse(ok[1], out id) || !Equal(ok[2], Proof("complete", transcript + "\n" + ok[1])))
                throw new SecurityException("Owner IPC mutual authentication failed.");
            Peer peer = new Peer(ok[1], pipe, MaxServerFrame);
            Peers.TryAdd(peer.Id, peer);
            Emit(new { kind = "ready", id = peer.Id, pipeName = PipeName, pid = OwnPid });
            new Thread(delegate()
            {
                try { peer.Run(); } catch (Exception) { }
                finally { RemovePeer(peer.Id); Environment.Exit(0); }
            }) { IsBackground = true, Name = "owner-client-reader" }.Start();
            ReadParentCommands(false, peer);
        }
    }

    private static string Transcript(int serverPid, int clientPid, string clientNonce, string serverNonce)
    {
        return "mongle-owner-v1\n" + PipeName + "\n" + serverPid + "\n" + clientPid + "\n" + clientNonce + "\n" + serverNonce;
    }

    private static void ValidateNonce(string nonce)
    {
        if (nonce.Length != 44 || Convert.FromBase64String(nonce).Length != 32) throw new SecurityException("Invalid owner IPC nonce.");
    }

    private static string Proof(string role, string transcript)
    {
        using (HMACSHA256 mac = new HMACSHA256(Secret)) return Convert.ToBase64String(mac.ComputeHash(Utf8.GetBytes(role + "\n" + transcript)));
    }

    private static bool Equal(string a, string b)
    {
        if (a.Length != b.Length) return false;
        int difference = 0;
        for (int i = 0; i < a.Length; i++) difference |= a[i] ^ b[i];
        return difference == 0;
    }

    private static byte[] RandomBytes()
    {
        byte[] bytes = new byte[32];
        using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
        return bytes;
    }

    private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }

    private static void ReadParentCommands(bool server, Peer client)
    {
        string line;
        while (!Stopping && (line = ReadLineLimited(Console.In, MaxLine)) != null)
        {
            Dictionary<string, object> command;
            lock (JsonLock) command = Json.Deserialize<Dictionary<string, object>>(line);
            string kind = command.ContainsKey("kind") ? command["kind"] as string : null;
            if (kind == "stop") { ParentRequestedStop = true; return; }
            Peer peer = client;
            if (server && (!command.ContainsKey("id") || !Peers.TryGetValue(command["id"] as string, out peer))) continue;
            if (peer == null) continue;
            if (kind == "close") { RemovePeer(peer.Id); continue; }
            if (kind != "send" || !command.ContainsKey("data")) throw new IOException("Invalid owner bridge command.");
            byte[] payload = Convert.FromBase64String(command["data"] as string);
            if (payload.Length == 0 || payload.Length > (server ? MaxServerFrame : MaxClientFrame)) throw new IOException("Owner IPC frame is too large.");
            peer.Enqueue(payload);
        }
    }

    private static string ReadLineLimited(TextReader reader, int limit)
    {
        StringBuilder line = new StringBuilder();
        int value;
        while ((value = reader.Read()) != -1)
        {
            if (value == 10) return line.ToString().TrimEnd('\r');
            if (line.Length >= limit) throw new IOException("Owner bridge line is too large.");
            line.Append((char)value);
        }
        return line.Length == 0 ? null : line.ToString();
    }

    private static string ReadText(PipeStream stream, int limit, int timeout) { return Utf8.GetString(ReadFrame(stream, limit, timeout)); }
    private static void WriteText(PipeStream stream, string text) { WriteFrame(stream, Utf8.GetBytes(text)); }

    private static byte[] ReadFrame(PipeStream stream, int limit, int timeout)
    {
        byte[] length = ReadExact(stream, 4, timeout);
        int size = BitConverter.ToInt32(length, 0);
        if (size <= 0 || size > limit) throw new IOException("Invalid owner IPC frame length.");
        return ReadExact(stream, size, timeout);
    }

    private static byte[] ReadExact(PipeStream stream, int count, int timeout)
    {
        byte[] bytes = new byte[count];
        int offset = 0;
        Stopwatch watch = Stopwatch.StartNew();
        while (offset < count)
        {
            int read;
            if (timeout == Timeout.Infinite) read = stream.Read(bytes, offset, count - offset);
            else
            {
                IAsyncResult operation = stream.BeginRead(bytes, offset, count - offset, null, null);
                int remaining = Math.Max(0, timeout - (int)watch.ElapsedMilliseconds);
                if (!operation.AsyncWaitHandle.WaitOne(remaining)) { stream.Dispose(); throw new TimeoutException("Owner IPC handshake timed out."); }
                read = stream.EndRead(operation);
                operation.AsyncWaitHandle.Close();
            }
            if (read == 0) throw new EndOfStreamException("Owner IPC peer disconnected.");
            offset += read;
        }
        return bytes;
    }

    private static void WriteFrame(PipeStream stream, byte[] bytes)
    {
        byte[] size = BitConverter.GetBytes(bytes.Length);
        stream.Write(size, 0, size.Length);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    private static void Emit(object value)
    {
        string line;
        lock (JsonLock) line = Json.Serialize(value);
        if (Interlocked.Add(ref OutputBytes, line.Length * 2) > MaxOutputBytes || !Output.TryAdd(line))
            Environment.Exit(70); // A stalled Node parent cannot grow a helper without bound.
    }

    private static void WriteOutput()
    {
        try
        {
            foreach (string line in Output.GetConsumingEnumerable())
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
                Interlocked.Add(ref OutputBytes, -line.Length * 2);
            }
        }
        catch (Exception) { Environment.Exit(71); }
    }

    private static void RemovePeer(string id)
    {
        Peer peer;
        if (Peers.TryRemove(id, out peer)) { peer.Close(); Emit(new { kind = "disconnected", id = id }); }
    }

    private static void Stop()
    {
        Stopping = true;
        if (WaitingPipe != null) WaitingPipe.Dispose();
        foreach (KeyValuePair<string, Peer> entry in Peers) entry.Value.Close();
    }

    private sealed class Peer
    {
        public readonly string Id;
        private readonly PipeStream Stream;
        private readonly int IncomingLimit;
        private readonly BlockingCollection<byte[]> Queue = new BlockingCollection<byte[]>(64);
        private int QueueBytes;
        private int Closed;

        public Peer(string id, PipeStream stream, int incomingLimit) { Id = id; Stream = stream; IncomingLimit = incomingLimit; }
        public void Enqueue(byte[] bytes)
        {
            if (Interlocked.CompareExchange(ref Closed, 0, 0) != 0) return;
            if (Interlocked.Add(ref QueueBytes, bytes.Length) > MaxQueuedBytes) { RemovePeer(Id); return; }
            // Close can complete this queue between the Closed check and TryAdd.
            // That is a peer disconnect, never a reason to fail the shared helper.
            try { if (!Queue.TryAdd(bytes)) RemovePeer(Id); }
            catch (InvalidOperationException) { RemovePeer(Id); }
        }
        public void Run()
        {
            new Thread(delegate()
            {
                try
                {
                    foreach (byte[] bytes in Queue.GetConsumingEnumerable())
                    {
                        WriteFrame(Stream, bytes);
                        Interlocked.Add(ref QueueBytes, -bytes.Length);
                    }
                }
                catch (Exception) { RemovePeer(Id); }
            }) { IsBackground = true, Name = "owner-peer-writer" }.Start();
            while (Interlocked.CompareExchange(ref Closed, 0, 0) == 0)
            {
                byte[] bytes = ReadFrame(Stream, IncomingLimit, Timeout.Infinite);
                Emit(new { kind = "message", id = Id, data = Convert.ToBase64String(bytes) });
            }
        }
        public void Close()
        {
            if (Interlocked.Exchange(ref Closed, 1) == 0) { Queue.CompleteAdding(); Stream.Dispose(); }
        }
    }
}
