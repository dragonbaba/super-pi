// Guest-only fixed probe. It cannot run from the host build/output path.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;

internal static class ClipboardGuestProbe {
    const string Input = @"C:\SuperPiClipboard\Input";
    const string Output = @"C:\SuperPiClipboard\Output";
    const string Protocol = "super-pi-wsb-clipboard-guest-v1";
    [DllImport("user32.dll", SetLastError=true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError=true)] static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError=true)] static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, IntPtr data, uint size, out uint needed);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr data);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr data);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr data);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr data);
    static void Need(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
    static string Name(IntPtr handle) {
        IntPtr buffer = Marshal.AllocHGlobal(1024);
        try { uint needed; Need(GetUserObjectInformationW(handle, 2, buffer, 1024, out needed), "ui-name"); return Marshal.PtrToStringUni(buffer); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static bool Visible(IntPtr station) {
        IntPtr buffer = Marshal.AllocHGlobal(12);
        try { uint needed; Need(GetUserObjectInformationW(station, 1, buffer, 12, out needed), "ui-flags"); return (Marshal.ReadInt32(buffer, 8) & 1) != 0; }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static void Publish(string name, object value) {
        byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value)); Need(bytes.Length <= 4096, "receipt-bound");
        using (var stream = new FileStream(Path.Combine(Output, name + ".json"), FileMode.CreateNew)) stream.Write(bytes, 0, bytes.Length);
        using (File.Create(Path.Combine(Output, name + ".complete"))) { }
    }
    static void Ack(string name, string taskId) {
        var timer = Stopwatch.StartNew(); string file = Path.Combine(Output, name + ".ack");
        while (!File.Exists(file)) { Need(timer.ElapsedMilliseconds < 30000, "ack-timeout"); Thread.Sleep(50); }
        Need(new FileInfo(file).Length == 36 && File.ReadAllText(file) == taskId, "ack-identity");
    }
    [STAThread] static int Main(string[] args) {
        // Guard before any clipboard operation, output publication or HWND creation.
        if (args.Length != 0 || !string.Equals(Process.GetCurrentProcess().MainModule.FileName, Input + @"\probe.exe", StringComparison.OrdinalIgnoreCase)) return 125;
        string taskId = null; IntPtr window = IntPtr.Zero, memory = IntPtr.Zero; bool transferred = false, destroyed = false;
        bool opened = false, emptied = false, set = false, closed = false, reopened = false, readback = false, readClosed = false;
        try {
            string requestPath = Input + @"\request.json"; Need(new FileInfo(requestPath).Length <= 1024, "request-bound");
            var request = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(File.ReadAllText(requestPath));
            Need(request.Count == 2 && request["protocol"] == Protocol, "request-schema"); taskId = request["taskId"];
            Guid parsed; Need(Guid.TryParseExact(taskId, "D", out parsed) && parsed.ToString("D") == taskId, "request-id");
            int sessionId = Process.GetCurrentProcess().SessionId;
            string station = Name(GetProcessWindowStation()), desktop = Name(GetThreadDesktop(GetCurrentThreadId()));
            bool visible = Visible(GetProcessWindowStation());
            string user, sid; bool system;
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) { user = identity.Name; sid = identity.User.Value; system = identity.IsSystem; }
            Need(sessionId > 0 && !system && visible && station == "WinSta0" && desktop == "Default", "not-interactive-login");
            var context = new { sessionId, user, sid, system, visible, station, desktop };
            Publish("ready", new { protocol = Protocol, taskId, phase = "ready", context });
            Ack("ready", taskId);
            window = CreateWindowExW(0, "STATIC", "SuperPi fixed clipboard owner", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            Need(window != IntPtr.Zero, "owner-window");
            byte[] expected = Encoding.Unicode.GetBytes("SUPER_PI_WSB_GUEST_" + taskId + "\0");
            memory = GlobalAlloc(0x42, (UIntPtr)expected.Length); Need(memory != IntPtr.Zero, "allocate");
            IntPtr pointer = GlobalLock(memory); Need(pointer != IntPtr.Zero, "lock-owned-data");
            try { Marshal.Copy(expected, 0, pointer, expected.Length); } finally { GlobalUnlock(memory); }
            opened = OpenClipboard(window); Need(opened, "open");
            try { emptied = EmptyClipboard(); Need(emptied, "empty"); set = SetClipboardData(13, memory) == memory; transferred = set; Need(set, "set"); }
            finally { closed = CloseClipboard(); Need(closed, "close"); }
            reopened = OpenClipboard(window); Need(reopened, "reopen");
            uint sequence;
            try {
                Need(GetClipboardOwner() == window && GetClipboardData(13) == memory && GlobalSize(memory).ToUInt64() >= (ulong)expected.Length, "readback-identity");
                pointer = GlobalLock(memory); Need(pointer != IntPtr.Zero, "readback-lock");
                try { byte[] actual = new byte[expected.Length]; Marshal.Copy(pointer, actual, 0, actual.Length); readback = true; for (int i = 0; i < actual.Length; i++) if (actual[i] != expected[i]) readback = false; }
                finally { GlobalUnlock(memory); }
                Need(readback, "readback-content"); sequence = GetClipboardSequenceNumber(); Need(sequence != 0, "sequence");
            } finally { readClosed = CloseClipboard(); Need(readClosed, "read-close"); }
            Publish("written", new { protocol = Protocol, taskId, phase = "written", sequence });
            Ack("written", taskId);
            destroyed = DestroyWindow(window); Need(destroyed, "destroy-window"); window = IntPtr.Zero;
            Publish("result", new { protocol = Protocol, taskId, context, opened, emptied, set, closed, reopened, readback, readClosed, destroyed });
            return 0;
        } catch (Exception error) {
            if (taskId != null) { try { Publish("failure", new { protocol = Protocol, taskId, error = error.Message, opened, emptied, set, closed, reopened, readback, readClosed }); } catch { } }
            return 1;
        } finally {
            if (window != IntPtr.Zero) DestroyWindow(window);
            if (memory != IntPtr.Zero && !transferred) GlobalFree(memory);
        }
    }
}
