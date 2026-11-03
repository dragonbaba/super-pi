// Acceptance-only host observer. No EmptyClipboard/SetClipboardData or content output.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

internal static class ClipboardHostObserver {
    [DllImport("user32.dll", SetLastError=true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError=true)] static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError=true)] static extern uint EnumClipboardFormats(uint previous);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern int GetClipboardFormatNameW(uint format, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, IntPtr data, uint size, out uint needed);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);

    static void Need(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
    internal static string StorageKind(uint id, string name) {
        if ((id == 1 || id == 7 || id == 13) && name == null) return "standard-text";
        if (id == 16 && name == null) return "standard-locale";
        Need(id >= 0xC000 && id <= 0xFFFF, "unsupported-format-" + id);
        CheckedName(name, name == null ? 0 : name.Length);
        return "registered-hglobal-opaque";
    }
    internal static string CheckedName(string name, int count) {
        Need(count > 0 && count < 255 && name != null && name.Length == count && name.IndexOf('\0') < 0, "registered-name-failed-or-truncated");
        return name;
    }
    static string[] FormatNames(uint[] ids) {
        Need(ids.Length > 0 && ids.Length <= 64, "format-count-bound");
        var names = new string[ids.Length]; var buffer = new StringBuilder(256);
        for (int i = 0; i < ids.Length; i++) {
            if (ids[i] >= 0xC000 && ids[i] <= 0xFFFF) {
                buffer.Clear();
                int count = GetClipboardFormatNameW(ids[i], buffer, buffer.Capacity);
                names[i] = CheckedName(buffer.ToString(), count);
            }
            StorageKind(ids[i], names[i]);
        }
        return names;
    }
    internal static void CheckUnlock(bool result, int error) {
        if (!result && error != 0) throw new Win32Exception(error, "global-unlock-failed-" + error);
    }
    internal static Exception CleanupFailure(Exception prior, Exception cleanup) {
        return prior == null ? cleanup : new AggregateException("read-and-cleanup-failed", prior, cleanup);
    }
    internal sealed class Storage {
        public uint id;
        public string name, storageKind, storageSha256;
        public long allocationBytes;
        public int? logicalBytes;
    }
    // Also exercised with process-owned HGLOBAL memory; never owns/frees the input handle.
    internal static Storage ReadStorage(uint id, string name, IntPtr handle, byte[] scratch, ref long total) {
        string kind = StorageKind(id, name); bool opaque = kind == "registered-hglobal-opaque";
        Need(scratch != null && scratch.Length == 65536, "scratch-size");
        Need(handle != IntPtr.Zero, "format-read-failed-" + id);
        SetLastError(0); ulong size = GlobalSize(handle).ToUInt64(); int sizeError = Marshal.GetLastWin32Error();
        Need(size > 0, "global-size-failed-" + id + "-" + sizeError);
        Need(size <= 8 * 1024 * 1024, "allocation-size-bound-" + id);
        total += (long)size; Need(total <= 16 * 1024 * 1024, "total-size-bound");
        if (id == 13) Need(size % 2 == 0, "unicode-allocation-odd");
        if (id == 16) Need(size >= 4, "locale-allocation-short");
        SetLastError(0); IntPtr pointer = GlobalLock(handle); int lockError = Marshal.GetLastWin32Error();
        Need(pointer != IntPtr.Zero, "global-lock-failed-" + id + "-" + lockError);
        int logical = id == 16 ? 4 : 0; string digest; Exception readError = null;
        try {
            using (SHA256 hash = SHA256.Create()) {
                for (int offset = 0; offset < (int)size;) {
                    int count = Math.Min(scratch.Length, (int)size - offset);
                    Marshal.Copy(IntPtr.Add(pointer, offset), scratch, 0, count);
                    if (!opaque && logical == 0) {
                        int stride = id == 13 ? 2 : 1;
                        for (int i = 0; i < count; i += stride) {
                            if (scratch[i] == 0 && (stride == 1 || scratch[i + 1] == 0)) { logical = offset + i + stride; break; }
                        }
                    }
                    hash.TransformBlock(scratch, 0, count, scratch, 0); offset += count;
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                digest = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
            }
            Need(opaque || logical > 0, "unterminated-text");
        } catch (Exception error) { readError = error; throw; }
        finally {
            try {
                SetLastError(0); bool result = GlobalUnlock(handle); int error = Marshal.GetLastWin32Error();
                CheckUnlock(result, error); // Exactly one release per successful lock; never drain others' locks.
            } catch (Exception error) { throw CleanupFailure(readError, error); }
            finally { Array.Clear(scratch, 0, scratch.Length); }
        }
        return new Storage { id = id, name = name, storageKind = kind, allocationBytes = (long)size,
            logicalBytes = opaque ? (int?)null : logical, storageSha256 = digest };
    }
    static string UiName(IntPtr handle) {
        IntPtr buffer = Marshal.AllocHGlobal(1024);
        try { uint needed; Need(GetUserObjectInformationW(handle, 2, buffer, 1024, out needed), "host-ui-name"); return Marshal.PtrToStringUni(buffer); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static object Context() {
        int sessionId; using (Process process = Process.GetCurrentProcess()) sessionId = process.SessionId;
        IntPtr stationHandle = GetProcessWindowStation(); string station = UiName(stationHandle), desktop = UiName(GetThreadDesktop(GetCurrentThreadId()));
        bool visible; IntPtr flags = Marshal.AllocHGlobal(12);
        try { uint needed; Need(GetUserObjectInformationW(stationHandle, 1, flags, 12, out needed), "host-ui-flags"); visible = (Marshal.ReadInt32(flags, 8) & 1) != 0; }
        finally { Marshal.FreeHGlobal(flags); }
        IntPtr input = OpenInputDesktop(0, false, 1); Need(input != IntPtr.Zero, "host-input-desktop-unavailable");
        string inputDesktop; try { inputDesktop = UiName(input); } finally { Need(CloseDesktop(input), "host-input-desktop-close"); }
        bool system; string userSidSha256;
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
            system = identity.IsSystem;
            using (SHA256 hash = SHA256.Create()) userSidSha256 = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity.User.Value))).Replace("-", "").ToLowerInvariant();
        }
        Need(sessionId > 0 && !system && visible && station == "WinSta0" && desktop == "Default" && inputDesktop == desktop, "wrong-host-interactive-context");
        return new { sessionId, system, visible, station, desktop, inputDesktop, userSidSha256 };
    }
    static uint[] Formats() {
        var formats = new List<uint>(64); uint current = 0;
        for (;;) {
            SetLastError(0); current = EnumClipboardFormats(current);
            if (current == 0) { Need(Marshal.GetLastWin32Error() == 0, "format-enumeration-failed"); break; }
            Need(formats.Count < 64 && !formats.Contains(current), "format-count-or-cycle");
            formats.Add(current);
        }
        return formats.ToArray();
    }
    static object Snapshot() {
        object context = Context();
        uint initial = GetClipboardSequenceNumber(); Need(initial != 0, "sequence-unavailable");
        var formats = new List<Storage>(64); byte[] scratch = new byte[65536];
        string owner = null; uint sequence = 0; long total = 0; bool nonempty = false;
        Exception snapshotError = null;
        Need(OpenClipboard(IntPtr.Zero), "clipboard-busy");
        try {
            sequence = GetClipboardSequenceNumber(); Need(sequence == initial, "changed-before-lock");
            owner = GetClipboardOwner().ToInt64().ToString();
            uint[] ids = Formats(); string[] names = FormatNames(ids);
            // All enumerated formats must be supported, including synthesized ones.
            for (int i = 0; i < ids.Length; i++) {
                Storage item = ReadStorage(ids[i], names[i], GetClipboardData(ids[i]), scratch, ref total);
                if (item.storageKind == "standard-text" && item.logicalBytes > (item.id == 13 ? 2 : 1)) nonempty = true;
                formats.Add(item);
            }
            uint[] after = Formats(); Need(after.Length == ids.Length, "format-set-changed");
            string[] afterNames = FormatNames(after);
            for (int i = 0; i < ids.Length; i++) Need(ids[i] == after[i] && names[i] == afterNames[i], "format-identity-or-order-changed");
            Need(nonempty, "no-nonempty-text");
            Need(GetClipboardSequenceNumber() == sequence && GetClipboardOwner().ToInt64().ToString() == owner, "changed-during-read");
        } catch (Exception error) { snapshotError = error; throw; }
        finally {
            Array.Clear(scratch, 0, scratch.Length);
            if (!CloseClipboard()) throw CleanupFailure(snapshotError, new Win32Exception(Marshal.GetLastWin32Error(), "clipboard-close-failed"));
        }
        Need(GetClipboardSequenceNumber() == sequence && GetClipboardOwner().ToInt64().ToString() == owner, "changed-after-close");
        Need(new JavaScriptSerializer().Serialize(context) == new JavaScriptSerializer().Serialize(Context()), "host-context-changed-during-snapshot");
        return new { protocol = "super-pi-wsb-clipboard-host-v3", context, sequence, owner, totalAllocationBytes = total, formats };
    }
    static object Window(string[] args) {
        Need(args.Length == 4, "window-arguments");
        long handle = 0, ticks = 0; int pid = 0;
        Need(long.TryParse(args[1], out handle) && handle > 0 && int.TryParse(args[2], out pid) && pid > 0
            && long.TryParse(args[3], out ticks) && ticks > 0, "invalid-window-identity");
        uint actualPid; bool exists = IsWindow(new IntPtr(handle)); GetWindowThreadProcessId(new IntPtr(handle), out actualPid);
        bool processMatches = false;
        try { using (Process p = Process.GetProcessById(pid)) processMatches = p.StartTime.ToUniversalTime().Ticks == ticks; }
        catch (ArgumentException) { }
        return new { protocol = "super-pi-wsb-window-v1", windowMatches = exists && actualPid == (uint)pid && processMatches, processMatches };
    }
    internal static string SerializeReceipt(object result) {
        string json = new JavaScriptSerializer().Serialize(result);
        Need(Encoding.UTF8.GetByteCount(json) + 2 <= 16 * 1024, "host-receipt-output-bound");
        return json; // Complete result plus Windows newline must fit the existing capture buffer.
    }
    [STAThread] static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            object result = args.Length == 0 ? Snapshot() : Window(args);
            Console.WriteLine(SerializeReceipt(result)); return 0;
        } catch (Exception error) {
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { error = error.Message })); return 2;
        }
    }
}
