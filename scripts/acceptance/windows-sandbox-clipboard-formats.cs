// One metadata enumeration only. No clipboard content, OLE, memory-handle, or write APIs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

internal static class ClipboardFormatsOnly {
    [DllImport("user32.dll", SetLastError=true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError=true)] static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError=true)] static extern uint EnumClipboardFormats(uint previous);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern int GetClipboardFormatNameW(uint format, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, IntPtr data, uint size, out uint needed);
    sealed class Format {
        public uint id;
        public string registeredName;
        public string nameStatus = "not-registered";
        public int nameError;
    }
    sealed class Report {
        public string protocol = "super-pi-wsb-clipboard-formats-v1";
        public string status = "preparing", countClass = "unknown", error, cleanupError;
        public int? count;
        public int enumerationLimit = 64, acceptanceCountLimit = 5;
        public bool enumerationComplete, namesComplete, metadataStable, opened, closed;
        public uint sequenceBefore, sequenceAfter;
        public string ownerBefore, ownerAfter;
        public int sessionId;
        public List<Format> formats = new List<Format>(64);
    }
    static void Need(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
    static string UiName(IntPtr handle) {
        IntPtr buffer = Marshal.AllocHGlobal(1024);
        try { uint needed; Need(GetUserObjectInformationW(handle, 2, buffer, 1024, out needed), "ui-name-failed"); return Marshal.PtrToStringUni(buffer); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static int Context() {
        int session; using (Process process = Process.GetCurrentProcess()) session = process.SessionId;
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) Need(session > 0 && !identity.IsSystem, "wrong-host-session");
        IntPtr station = GetProcessWindowStation();
        Need(UiName(station) == "WinSta0" && UiName(GetThreadDesktop(GetCurrentThreadId())) == "Default", "wrong-host-desktop");
        IntPtr flags = Marshal.AllocHGlobal(12);
        try { uint needed; Need(GetUserObjectInformationW(station, 1, flags, 12, out needed) && (Marshal.ReadInt32(flags, 8) & 1) != 0, "host-station-not-visible"); }
        finally { Marshal.FreeHGlobal(flags); }
        IntPtr input = OpenInputDesktop(0, false, 1); Need(input != IntPtr.Zero, "input-desktop-unavailable");
        try { Need(UiName(input) == "Default", "wrong-input-desktop"); }
        finally { Need(CloseDesktop(input), "input-desktop-close-failed"); }
        return session;
    }
    static Report Query() {
        var report = new Report();
        try {
            report.sessionId = Context();
            report.sequenceBefore = GetClipboardSequenceNumber(); report.ownerBefore = GetClipboardOwner().ToInt64().ToString();
            report.opened = OpenClipboard(IntPtr.Zero);
            if (!report.opened) { report.status = "open-failed"; report.error = "OpenClipboard:" + Marshal.GetLastWin32Error(); return report; }
            try {
                report.status = "enumerating"; uint previous = 0;
                var seen = new HashSet<uint>();
                for (;;) {
                    SetLastError(0); uint id = EnumClipboardFormats(previous); int error = Marshal.GetLastWin32Error();
                    if (id == 0) {
                        if (error != 0) { report.status = "enumeration-failed"; report.error = "EnumClipboardFormats:" + error; }
                        else { report.enumerationComplete = true; report.count = report.formats.Count; }
                        break;
                    }
                    if (!seen.Add(id)) { report.status = "enumeration-cycle"; break; }
                    if (report.formats.Count == 64) { report.status = "enumeration-limit"; break; }
                    report.formats.Add(new Format { id = id, nameStatus = id >= 0xC000 && id <= 0xFFFF ? "not-queried" : "not-registered" }); previous = id;
                }
                // Even an incomplete enumeration retains its observed IDs; count stays null.
                bool namesComplete = true; var name = new StringBuilder(256);
                foreach (Format format in report.formats) {
                    if (format.id < 0xC000 || format.id > 0xFFFF) continue;
                    name.Clear(); SetLastError(0);
                    int count = GetClipboardFormatNameW(format.id, name, name.Capacity); int error = Marshal.GetLastWin32Error();
                    if (count <= 0 || count != name.Length) { format.nameStatus = "failed"; format.nameError = error; namesComplete = false; }
                    else if (count >= 255) { format.nameStatus = "at-buffer-limit"; namesComplete = false; }
                    else { format.registeredName = name.ToString(); format.nameStatus = "resolved"; }
                }
                report.namesComplete = namesComplete && report.enumerationComplete;
                if (report.enumerationComplete) {
                    report.countClass = report.count == 0 ? "empty" : report.count > 5 ? "over-acceptance-count" : "within-acceptance-count";
                    report.status = namesComplete ? "complete" : "name-unavailable";
                }
            } finally {
                report.closed = CloseClipboard(); int error = Marshal.GetLastWin32Error();
                if (!report.closed) {
                    report.cleanupError = "CloseClipboard:" + error;
                    if (report.status == "complete") report.status = "close-failed";
                }
            }
            report.sequenceAfter = GetClipboardSequenceNumber(); report.ownerAfter = GetClipboardOwner().ToInt64().ToString();
            report.metadataStable = report.sequenceBefore != 0 && report.sequenceBefore == report.sequenceAfter && report.ownerBefore == report.ownerAfter;
            Need(Context() == report.sessionId, "host-context-changed");
            if (!report.metadataStable && report.status == "complete") report.status = "metadata-changed-or-unavailable";
        } catch (Exception error) { report.status = "query-failed"; report.error = error.Message; }
        return report;
    }
    [STAThread] static int Main(string[] args) {
        if (args.Length != 0) return 125;
        Console.OutputEncoding = new UTF8Encoding(false);
        Report report = Query(); var serializer = new JavaScriptSerializer();
        string json = serializer.Serialize(report);
        // Keep the shared 16 KiB capture bound unchanged. Never claim omitted names are complete.
        if (Encoding.UTF8.GetByteCount(json) > 12 * 1024) {
            report.status = "output-limit"; report.namesComplete = false;
            foreach (Format format in report.formats) {
                format.registeredName = null;
                if (format.id >= 0xC000 && format.id <= 0xFFFF) format.nameStatus = "omitted-output-limit";
            }
            json = serializer.Serialize(report);
        }
        Console.WriteLine(json);
        return report.status == "complete" && report.closed && report.cleanupError == null ? 0 : 2;
    }
}
