// Manual P3 feasibility probe only. No production/default execution path uses this helper.
// Fixed Win32 AppContainer + suspended launch + Job Object; no command classification.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class SuperPiAppContainerSpike : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup {
        public int cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public ushort show, reservedBytes; public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int size; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct Capabilities { public IntPtr sid, capabilities; public uint count, reserved; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong r, w, o, rb, wb, ob; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public BasicLimits basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, byte[] data, uint size, IntPtr needed);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string path, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int needed);

    readonly string name;
    IntPtr sid, job, process;
    bool assigned, profileCreated, disposed;
    public int OpenHandles { get; private set; }
    public uint ProcessId { get; private set; }
    public string ProfileName { get { return name; } }
    public bool ProfileReleased { get { return !profileCreated; } }
    public bool Drained { get; private set; }
    public string Sid { get { return new System.Security.Principal.SecurityIdentifier(sid).Value; } }
    static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    public SuperPiAppContainerSpike() {
        if (RuntimeInformation.ProcessArchitecture != Architecture.X64) throw new PlatformNotSupportedException("The spike is pinned to Windows x64.");
        name = "SuperPi.Spike." + Guid.NewGuid().ToString("N");
        int result = CreateAppContainerProfile(name, name, "Temporary Super Pi execution boundary probe", IntPtr.Zero, 0, out sid);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        profileCreated = true;
    }
    static string Quote(string value) {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') text.Append('\\', slashes * 2 + 1); else text.Append('\\', slashes);
            text.Append(c); slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    public void Start(string executable, string[] arguments, string cwd, string environment) {
        if (disposed || job != IntPtr.Zero) throw new InvalidOperationException("One launch per spike owner.");
        IntPtr list = IntPtr.Zero, caps = IntPtr.Zero, env = IntPtr.Zero, thread = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, handles = IntPtr.Zero;
        bool initialized = false;
        try {
            job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject"); OpenHandles++;
            var limits = new Limits(); limits.basic.flags = 0x2000 | 0x8 | 0x100;
            limits.basic.active = 16; limits.processMemory = new UIntPtr(256 * 1024 * 1024);
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Limits>()), "SetInformationJobObject");
            UIntPtr bytes = UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
            list = Marshal.AllocHGlobal(checked((int)bytes.ToUInt64()));
            Check(InitializeProcThreadAttributeList(list, 2, 0, ref bytes), "InitializeProcThreadAttributeList"); initialized = true;
            var capabilities = new Capabilities { sid = sid };
            caps = Marshal.AllocHGlobal(Marshal.SizeOf<Capabilities>()); Marshal.StructureToPtr(capabilities, caps, false);
            Check(UpdateProcThreadAttribute(list, 0, new UIntPtr(0x20009), caps, new UIntPtr((uint)Marshal.SizeOf<Capabilities>()), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute");
            // Only these two private diagnostic handles cross the process boundary.
            var security = new SecurityAttributes { size = Marshal.SizeOf<SecurityAttributes>(), inherit = 1 };
            input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
            Check(input != new IntPtr(-1), "CreateFile(stdin)"); OpenHandles++;
            output = CreateFileW(System.IO.Path.Combine(cwd, "probe.log"), 0x40000000, 3, ref security, 2, 0x80, IntPtr.Zero);
            Check(output != new IntPtr(-1), "CreateFile(probe.log)"); OpenHandles++;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(handles, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output);
            Check(UpdateProcThreadAttribute(list, 0, new UIntPtr(0x20002), handles, new UIntPtr((uint)(IntPtr.Size * 2)), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(handles)");
            var startup = new StartupEx(); startup.startup.cb = Marshal.SizeOf<StartupEx>(); startup.attributes = list;
            startup.startup.flags = 0x100; startup.startup.stdin = input; startup.startup.stdout = output; startup.startup.stderr = output;
            var command = new StringBuilder(Quote(executable)); foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            env = Marshal.StringToHGlobalUni(environment);
            ProcessInfo info;
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x4 | 0x400 | 0x08000000, env, cwd, ref startup, out info), "CreateProcess(AppContainer)");
            process = info.process; thread = info.thread; ProcessId = info.pid; OpenHandles += 2;
            Check(AssignProcessToJobObject(job, process), "AssignProcessToJobObject"); assigned = true;
            Check(ResumeThread(thread) != 0xffffffff, "ResumeThread");
        } finally {
            Exception cleanup = null;
            if (thread != IntPtr.Zero) { if (CloseHandle(thread)) OpenHandles--; else cleanup = new Win32Exception(Marshal.GetLastWin32Error()); }
            if (input != IntPtr.Zero && input != new IntPtr(-1)) { if (CloseHandle(input)) OpenHandles--; else cleanup = new Win32Exception(Marshal.GetLastWin32Error()); }
            if (output != IntPtr.Zero && output != new IntPtr(-1)) { if (CloseHandle(output)) OpenHandles--; else cleanup = new Win32Exception(Marshal.GetLastWin32Error()); }
            if (initialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (caps != IntPtr.Zero) Marshal.FreeHGlobal(caps);
            if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (cleanup != null) throw cleanup;
        }
    }
    public bool IsAppContainer() {
        IntPtr token; Check(OpenProcessToken(process, 8, out token), "OpenProcessToken"); OpenHandles++;
        try { int value, needed; Check(GetTokenInformation(token, 29, out value, 4, out needed), "TokenIsAppContainer"); return value != 0; }
        finally { Check(CloseHandle(token), "CloseHandle(token)"); OpenHandles--; }
    }
    public uint Wait(uint milliseconds) {
        uint wait = WaitForSingleObject(process, milliseconds);
        if (wait == 258) throw new TimeoutException("AppContainer probe deadline exceeded.");
        Check(wait == 0, "WaitForSingleObject"); uint code; Check(GetExitCodeProcess(process, out code), "GetExitCodeProcess"); return code;
    }
    public uint ActiveProcesses() {
        var accounting = new byte[48]; Check(QueryInformationJobObject(job, 1, accounting, 48, IntPtr.Zero), "QueryInformationJobObject");
        return BitConverter.ToUInt32(accounting, 40);
    }
    public void Dispose() {
        if (disposed) return; disposed = true;
        Exception failure = null;
        try {
            if (process != IntPtr.Zero && !assigned) {
                Check(TerminateProcess(process, 1), "TerminateProcess(unassigned)");
                Check(WaitForSingleObject(process, 5000) == 0, "WaitForSingleObject(unassigned cleanup)");
            }
            if (job != IntPtr.Zero) {
                Check(TerminateJobObject(job, 1), "TerminateJobObject");
                var deadline = Environment.TickCount64 + 5000;
                while (ActiveProcesses() != 0) { if (Environment.TickCount64 >= deadline) throw new TimeoutException("Job still owns live processes"); Thread.Sleep(10); }
            }
            Drained = true;
        } catch (Exception e) { failure = e; }
        finally {
            if (process != IntPtr.Zero) { if (CloseHandle(process)) OpenHandles--; else failure = new Win32Exception(Marshal.GetLastWin32Error()); process = IntPtr.Zero; }
            if (job != IntPtr.Zero) { if (CloseHandle(job)) OpenHandles--; else failure = new Win32Exception(Marshal.GetLastWin32Error()); job = IntPtr.Zero; }
            if (sid != IntPtr.Zero) { FreeSid(sid); sid = IntPtr.Zero; }
            if (profileCreated) { int result = DeleteAppContainerProfile(name); if (result != 0) failure = Marshal.GetExceptionForHR(result); else profileCreated = false; }
        }
        if (failure != null) throw failure;
    }
}
