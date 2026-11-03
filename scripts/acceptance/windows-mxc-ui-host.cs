// Manual fixture only. Default mode uses an invisible private window station.
// Explicit interactive mode uses the current clipboard and foreground; the caller
// must obtain user approval for those effects before selecting that mode.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class MxcUiHost {
    static bool interactiveMode;
    static bool childExitUnconfirmed;
    static bool assistedForeground;
    static bool clipboardMode;
    static bool writeReadbackConfirmed;
    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int kind, IntPtr data, uint size, out uint needed);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetUserObjectSecurity(IntPtr handle, ref uint information, IntPtr data, uint size, out uint needed);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y,
        int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] static extern bool DestroyWindow(IntPtr window);
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int size; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int size; public string reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedSize; public IntPtr reservedData, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint sharing, ref SecurityAttributes security, uint creation, uint attributes, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation information);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);

    static void Require(bool condition, string message) {
        if (!condition) throw new InvalidOperationException(message + " (Win32 " + Marshal.GetLastWin32Error() + ")");
    }
    static IntPtr CopyUiDescriptor(IntPtr handle) {
        uint information = 4, needed;
        GetUserObjectSecurity(handle, ref information, IntPtr.Zero, 0, out needed);
        Require(needed > 0 && needed <= 65536, "UI fixture descriptor size unavailable");
        IntPtr data = Marshal.AllocHGlobal((int)needed);
        try {
            Require(GetUserObjectSecurity(handle, ref information, data, needed, out needed), "UI fixture descriptor read failed");
            return data;
        } catch { Marshal.FreeHGlobal(data); throw; }
    }
    static string StationName() {
        return ObjectName(GetProcessWindowStation());
    }
    static string ObjectName(IntPtr handle) {
        uint needed;
        IntPtr data = Marshal.AllocHGlobal(1024);
        try {
            Require(GetUserObjectInformationW(handle, 2, data, 1024, out needed), "UI object name unavailable");
            return Marshal.PtrToStringUni(data);
        } finally { Marshal.FreeHGlobal(data); }
    }
    static void RequirePrivateStation(string expected) {
        Require(expected.StartsWith("SuperPiMxcUi-", StringComparison.Ordinal), "Invalid fixture identity");
        Require(StationName() == expected, "Refusing probe outside its private window station");
        IntPtr flags = Marshal.AllocHGlobal(12);
        uint needed;
        try {
            Require(GetUserObjectInformationW(GetProcessWindowStation(), 1, flags, 12, out needed), "Station flags unavailable");
            Require((Marshal.ReadInt32(flags, 8) & 1) == 0, "Refusing a visible window station");
        } finally { Marshal.FreeHGlobal(flags); }
    }
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static IntPtr InheritOutput(int kind) {
        IntPtr source = GetStdHandle(kind), duplicate;
        Require(source != IntPtr.Zero && source != new IntPtr(-1), "Fixture output pipe unavailable");
        IntPtr process = GetCurrentProcess();
        Require(DuplicateHandle(process, source, process, out duplicate, 0, true, 2), "Output pipe duplication failed");
        return duplicate;
    }
    static string[] PrepareClipboardRead(string tag, string[] args, IntPtr owner) {
        if (!clipboardMode || tag != "READCLIPBOARD") return args;
        // Eagerly publish only synthetic text and retain its owner until the child exits.
        byte[] text = Encoding.Unicode.GetBytes("MXC_UI_PROBE_READ_SEED\0");
        IntPtr memory = IntPtr.Zero;
        bool transferred = false;
        uint sequence = 0;
        Require(OpenClipboard(owner), "Host clipboard seed open failed");
        try {
            memory = GlobalAlloc(2, new UIntPtr((uint)text.Length));
            Require(memory != IntPtr.Zero, "Seed allocation failed");
            IntPtr buffer = GlobalLock(memory);
            Require(buffer != IntPtr.Zero, "Seed memory lock failed");
            try { Marshal.Copy(text, 0, buffer, text.Length); }
            finally { GlobalUnlock(memory); }
            Require(EmptyClipboard(), "Host clipboard seed empty failed");
            Require(SetClipboardData(13, memory) != IntPtr.Zero, "Host clipboard seed publication failed");
            transferred = true;
        } finally {
            bool released = memory == IntPtr.Zero || transferred || GlobalFree(memory) == IntPtr.Zero;
            bool closed = CloseClipboard();
            Require(released && closed, "Host seed cleanup failed");
        }
        // Closing the publication can synthesize formats and change the sequence.
        // Reopen and verify our exact allocation before taking a stable read snapshot.
        Require(OpenClipboard(owner), "Host seed snapshot open failed");
        try {
            Require(GetClipboardOwner() == owner, "Host clipboard identity changed");
            Require(GetClipboardData(13) == memory, "Host clipboard seed handle changed");
            IntPtr buffer = GlobalLock(memory);
            Require(buffer != IntPtr.Zero, "Seed readback lock failed");
            try {
                for (int i = 0; i < text.Length; i++) Require(Marshal.ReadByte(buffer, i) == text[i], "Seed readback mismatch");
            } finally { GlobalUnlock(memory); }
            sequence = GetClipboardSequenceNumber();
            Require(sequence != 0, "Missing seed sequence");
        } finally { Require(CloseClipboard(), "Host seed snapshot close failed"); }
        Console.WriteLine("HOST_CLIPBOARD_AFTER_CLOSE expected_owner=" + owner.ToInt64() + " actual_owner=" + GetClipboardOwner().ToInt64() + " expected_sequence=" + sequence + " actual_sequence=" + GetClipboardSequenceNumber());
        Console.WriteLine("HOST_CLIPBOARD_SEED=CONFIRMED");
        string[] result = new string[args.Length + 2];
        Array.Copy(args, result, args.Length);
        result[args.Length] = "--superpi-seed-owner=" + owner.ToInt64();
        result[args.Length + 1] = "--superpi-seed-sequence=" + sequence;
        return result;
    }
    static string[] PrepareClipboardWrite(string tag, string[] args, string policy) {
        if (!clipboardMode || tag != "WRITECLIPBOARD") return args;
        string prefix = Path.Combine(Path.GetDirectoryName(policy), "workspace", "write-" + Guid.NewGuid().ToString("N"));
        string[] result = new string[args.Length + 2];
        Array.Copy(args, result, args.Length);
        result[args.Length] = "--superpi-write-ready=" + prefix + ".ready";
        result[args.Length + 1] = "--superpi-write-release=" + prefix + ".release";
        return result;
    }
    static void ConfirmClipboardWrite(string ready, string release) {
        Require(new FileInfo(ready).Length <= 128, "Write identity exceeds bound");
        string[] identity = File.ReadAllText(ready).Split(' ');
        Require(identity.Length == 2, "Invalid write identity");
        IntPtr owner = new IntPtr(long.Parse(identity[0]));
        uint sequence = uint.Parse(identity[1]);
        Require(owner != IntPtr.Zero && sequence != 0, "Missing write identity");
        Require(OpenClipboard(IntPtr.Zero), "Host write verification open failed");
        try {
            IntPtr actualOwner = GetClipboardOwner();
            uint actualSequence = GetClipboardSequenceNumber();
            Require(actualOwner == owner && actualSequence == sequence, "Write identity changed before host read: expected_owner=" + owner.ToInt64() + " actual_owner=" + actualOwner.ToInt64() + " expected_sequence=" + sequence + " actual_sequence=" + actualSequence);
            IntPtr memory = GetClipboardData(13);
            byte[] expected = Encoding.Unicode.GetBytes("MXC_UI_PROBE_WRITE\0");
            Require(memory != IntPtr.Zero && GlobalSize(memory).ToUInt64() >= (ulong)expected.Length, "Written text unavailable");
            IntPtr buffer = GlobalLock(memory);
            Require(buffer != IntPtr.Zero, "Written text lock failed");
            try {
                for (int i = 0; i < expected.Length; i++) Require(Marshal.ReadByte(buffer, i) == expected[i], "Host write readback mismatch");
            } finally { GlobalUnlock(memory); }
        } finally { Require(CloseClipboard(), "Host write verification close failed"); }
        File.WriteAllText(release + ".tmp", "verified");
        File.Move(release + ".tmp", release);
        writeReadbackConfirmed = true;
    }
    static void Run(string executable, string[] args) {
        writeReadbackConfirmed = false;
        string ready = null, release = null;
        foreach (string arg in args) {
            if (arg.StartsWith("--superpi-write-ready=", StringComparison.Ordinal)) ready = arg.Substring("--superpi-write-ready=".Length);
            if (arg.StartsWith("--superpi-write-release=", StringComparison.Ordinal)) release = arg.Substring("--superpi-write-release=".Length);
        }
        string stationName = StationName();
        if (interactiveMode) Require(stationName == "WinSta0", "Interactive station changed");
        else RequirePrivateStation(stationName);
        StringBuilder command = new StringBuilder(Quote(executable));
        foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        SecurityAttributes sa = new SecurityAttributes { size = Marshal.SizeOf(typeof(SecurityAttributes)), inherit = 1 };
        IntPtr output = IntPtr.Zero, errors = IntPtr.Zero, input = IntPtr.Zero;
        ProcessInformation child = new ProcessInformation();
        try {
            // Forward native pipes to the existing Node owner. Its combined
            // 64 KiB cap stops the whole job; no output is spooled to disk.
            Console.Out.Flush(); Console.Error.Flush();
            output = InheritOutput(-11); errors = InheritOutput(-12);
            input = CreateFileW("NUL", 0x80000000, 3, ref sa, 3, 128, IntPtr.Zero);
            Require(input != new IntPtr(-1), "Input handle creation failed");
            StartupInfo startup = new StartupInfo {
                size = Marshal.SizeOf(typeof(StartupInfo)), desktop = stationName + "\\" + (interactiveMode ? ObjectName(GetThreadDesktop(GetCurrentThreadId())) : "ProbeDesktop"),
                flags = 0x100, input = input, output = output, error = errors
            };
            Require(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000000,
                IntPtr.Zero, null, ref startup, out child), "Private-desktop process creation failed");
            childExitUnconfirmed = true;
            if (ready == null) {
                Require(WaitForSingleObject(child.process, assistedForeground ? 25000u : 10000u) == 0, "UI child timed out; outer owner must drain the job");
            } else {
                Require(release != null, "Missing write release identity");
                Stopwatch deadline = Stopwatch.StartNew();
                while (true) {
                    uint wait = WaitForSingleObject(child.process, 25);
                    if (wait == 0) break;
                    Require(wait == 258 && deadline.ElapsedMilliseconds < 25000, "UI write child wait failed; outer owner must drain the job");
                    if (!writeReadbackConfirmed && File.Exists(ready + ".complete")) ConfirmClipboardWrite(ready, release);
                }
            }
            childExitUnconfirmed = false;
            uint code; Require(GetExitCodeProcess(child.process, out code), "Probe exit code unavailable");
            Require(code == 0, "UI probe failed: exit=" + code);
        } finally {
            bool closed = true;
            if (child.thread != IntPtr.Zero) closed &= CloseHandle(child.thread);
            if (child.process != IntPtr.Zero) closed &= CloseHandle(child.process);
            if (input != IntPtr.Zero && input != new IntPtr(-1)) closed &= CloseHandle(input);
            if (output != IntPtr.Zero) closed &= CloseHandle(output);
            if (errors != IntPtr.Zero) closed &= CloseHandle(errors);
            Require(closed, "UI child handle cleanup not confirmed");
        }
    }

    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
        // A CLR/COM startup thread can already own USER objects. SetThreadDesktop
        // must run on a fresh thread before it creates any window or hook.
        int result = 1;
        Thread worker = new Thread(delegate() { result = RunFixture(args); });
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start(); worker.Join();
        return result;
    }
    static int RunFixture(string[] args) {
        try {
            Require(args.Length == 5 && (args[0] == "host" || args[0] == "interactive" || args[0] == "injection" || args[0] == "clipboard"), "Expected mode executor policy probe clipboard-control-policy");
            clipboardMode = args[0] == "clipboard";
            assistedForeground = args[0] == "injection" || clipboardMode;
            bool interactive = args[0] == "interactive" || assistedForeground;
            interactiveMode = interactive;
            string executor = args[1], policy = args[2], probe = args[3], clipboardControl = args[4];
            string stationName = interactive ? "WinSta0" : "SuperPiMxcUi-" + Guid.NewGuid().ToString("N");
            IntPtr originalStation = GetProcessWindowStation();
            IntPtr originalDesktop = GetThreadDesktop(GetCurrentThreadId());
            IntPtr station = IntPtr.Zero, desktop = IntPtr.Zero, window = IntPtr.Zero;
            IntPtr stationDescriptor = IntPtr.Zero, desktopDescriptor = IntPtr.Zero;
            bool cleanupOk = true;
            try {
                if (!interactive) {
                // Mirror the existing station/desktop DACL only onto newly created
                // private objects. Never change the original desktop permissions.
                stationDescriptor = CopyUiDescriptor(originalStation);
                desktopDescriptor = CopyUiDescriptor(originalDesktop);
                SecurityAttributes stationSecurity = new SecurityAttributes { size = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = stationDescriptor };
                SecurityAttributes desktopSecurity = new SecurityAttributes { size = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = desktopDescriptor };
                station = CreateWindowStationW(stationName, 0, 0x37f, ref stationSecurity);
                Require(station != IntPtr.Zero, "Private station creation failed");
                Require(SetProcessWindowStation(station), "Private station attachment failed");
                desktop = CreateDesktopW("ProbeDesktop", IntPtr.Zero, IntPtr.Zero, 0, 0x1ff, ref desktopSecurity);
                Require(desktop != IntPtr.Zero, "Private desktop creation failed");
                Require(SetThreadDesktop(desktop), "Private desktop attachment failed");
                RequirePrivateStation(stationName);
                } else Require(StationName() == "WinSta0", "Interactive mode requires WinSta0");
                window = CreateWindowExW(0, "STATIC", "Super Pi UI fixture", 0, 0, 0, 1, 1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                Require(window != IntPtr.Zero, "Hidden fixture window creation failed");
                Console.WriteLine((interactive ? "INTERACTIVE_STATION=" : "PRIVATE_STATION=") + stationName);
                foreach (string tag in clipboardMode ? new string[] { "READCLIPBOARD", "WRITECLIPBOARD" } : assistedForeground ? new string[] { "INJECTION" } : new string[] { "READCLIPBOARD", "WRITECLIPBOARD", "HANDLES", "INJECTION" }) {
                    string[] guarded = tag == "HANDLES"
                        ? new string[] { "--superpi-station=" + stationName, tag, "--handle-hwnd=" + window.ToInt64(), "--handle-pid=" + Process.GetCurrentProcess().Id }
                        : new string[] { "--superpi-station=" + stationName, tag };
                    if (interactive) {
                        string[] expanded = new string[guarded.Length + 1];
                        Array.Copy(guarded, expanded, guarded.Length); expanded[guarded.Length] = "--superpi-interactive=true";
                        guarded = expanded;
                    }
                    if (assistedForeground) {
                        string[] expanded = new string[guarded.Length + (clipboardMode ? 2 : 1)];
                        Array.Copy(guarded, expanded, guarded.Length); expanded[guarded.Length] = "--superpi-await-foreground=true";
                        if (clipboardMode) expanded[guarded.Length + 1] = "--superpi-foreground-clipboard=true";
                        guarded = expanded;
                    }
                    string[] controlGuarded = PrepareClipboardWrite(tag, PrepareClipboardRead(tag, guarded, window), policy);
                    Console.WriteLine("BEGIN_CONTROL=" + tag);
                    if (tag == "READCLIPBOARD" || tag == "WRITECLIPBOARD") {
                        string[] control = new string[controlGuarded.Length + 3];
                        control[0] = clipboardControl; control[1] = "--"; control[2] = probe;
                        Array.Copy(controlGuarded, 0, control, 3, controlGuarded.Length);
                        Run(executor, control);
                    } else Run(probe, controlGuarded);
                    if (writeReadbackConfirmed) Console.WriteLine("HOST_CLIPBOARD_WRITE=CONFIRMED");
                    Console.WriteLine("END_CONTROL=" + tag);
                    string[] containedGuarded = PrepareClipboardWrite(tag, PrepareClipboardRead(tag, guarded, window), policy);
                    string[] contained = new string[containedGuarded.Length + 3];
                    contained[0] = policy; contained[1] = "--"; contained[2] = probe;
                    Array.Copy(containedGuarded, 0, contained, 3, containedGuarded.Length);
                    Console.WriteLine("BEGIN_CONTAINED=" + tag);
                    Run(executor, contained);
                    if (writeReadbackConfirmed) Console.WriteLine("HOST_CLIPBOARD_WRITE=CONFIRMED");
                    Console.WriteLine("END_CONTAINED=" + tag);
                }
            } finally {
                if (window != IntPtr.Zero) cleanupOk &= DestroyWindow(window);
                cleanupOk &= SetThreadDesktop(originalDesktop);
                cleanupOk &= SetProcessWindowStation(originalStation);
                if (desktop != IntPtr.Zero) cleanupOk &= CloseDesktop(desktop);
                if (station != IntPtr.Zero) cleanupOk &= CloseWindowStation(station);
                if (stationDescriptor != IntPtr.Zero) Marshal.FreeHGlobal(stationDescriptor);
                if (desktopDescriptor != IntPtr.Zero) Marshal.FreeHGlobal(desktopDescriptor);
                // Only the outer Job owner can confirm all descendants drained.
                Console.WriteLine("UI_HOST_HANDLES=" + (cleanupOk ? "RELEASED" : "UNCONFIRMED"));
                Console.WriteLine("UI_CHILD_EXIT=" + (childExitUnconfirmed ? "UNCONFIRMED" : "CONFIRMED"));
            }
            Require(cleanupOk, "UI resource cleanup not confirmed");
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
