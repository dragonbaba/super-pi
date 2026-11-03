// Compiled with the real observer but /main:ClipboardHostChecks. Never calls its Main,
// Snapshot, Context, or any clipboard API. Only this process's GlobalAlloc is exercised.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class ClipboardHostChecks {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern uint GlobalFlags(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    static int checks;
    static void Check(bool value) { checks++; if (!value) throw new Exception("check-" + checks); }
    static void Reject(Action action) {
        bool rejected = false; try { action(); } catch (InvalidOperationException) { rejected = true; }
        Check(rejected);
    }
    static void Cleared(byte[] bytes) { foreach (byte value in bytes) if (value != 0) throw new Exception("scratch-not-cleared"); checks++; }
    static string Digest(byte[] bytes) { using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static int Main() {
        IntPtr owned = IntPtr.Zero; bool locked = false;
        try {
            Check(ClipboardHostObserver.StorageKind(0xC010, "DataObject") == "registered-hglobal-opaque");
            Check(ClipboardHostObserver.StorageKind(0xFFFF, "DataObject") == "registered-hglobal-opaque");
            foreach (uint id in new uint[] { 1, 7, 13 }) Check(ClipboardHostObserver.StorageKind(id, null) == "standard-text");
            Check(ClipboardHostObserver.StorageKind(16, null) == "standard-locale");
            Check(ClipboardHostObserver.StorageKind(0xC000, "Unknown") == "registered-hglobal-opaque");
            Check(ClipboardHostObserver.StorageKind(49356, "EnterpriseDataProtectionId") == "registered-hglobal-opaque");
            Check(ClipboardHostObserver.StorageKind(49171, "Ole Private Data") == "registered-hglobal-opaque");
            foreach (uint id in new uint[] { 2, 0x200, 0x300 }) Reject(() => ClipboardHostObserver.StorageKind(id, "Unknown"));
            Reject(() => ClipboardHostObserver.StorageKind(0xBFFF, "DataObject"));
            Reject(() => ClipboardHostObserver.StorageKind(0x10000, "DataObject"));
            Reject(() => ClipboardHostObserver.StorageKind(13, "DataObject"));
            Check(ClipboardHostObserver.CheckedName("DataObject", 10) == "DataObject");
            Reject(() => ClipboardHostObserver.CheckedName("", 0));
            Reject(() => ClipboardHostObserver.CheckedName("DataObject", 9));
            Reject(() => ClipboardHostObserver.CheckedName(new string('x', 255), 255));
            Reject(() => ClipboardHostObserver.CheckedName("A\0B", 3));
            Reject(() => ClipboardHostObserver.StorageKind(0xC010, null));
            Check(ClipboardHostObserver.CheckedName(new string('x', 254), 254).Length == 254);
            Check(Encoding.UTF8.GetByteCount(ClipboardHostObserver.SerializeReceipt(new string('x', 16380))) + 2 == 16384);
            Reject(() => ClipboardHostObserver.SerializeReceipt(new string('x', 16381)));
            Check(Encoding.UTF8.GetByteCount(ClipboardHostObserver.SerializeReceipt(new string('\u754c', 5460))) + 2 == 16384);
            Reject(() => ClipboardHostObserver.SerializeReceipt(new string('\u754c', 5461)));
            ClipboardHostObserver.CheckUnlock(false, 0); checks++;
            ClipboardHostObserver.CheckUnlock(true, 0); checks++;
            ClipboardHostObserver.CheckUnlock(true, 158); checks++; // Nonzero means the one decrement succeeded.
            foreach (int code in new int[] { 6, 158 }) {
                bool rejected = false;
                try { ClipboardHostObserver.CheckUnlock(false, code); }
                catch (Win32Exception error) { rejected = error.NativeErrorCode == code && error.Message.Contains(code.ToString()); }
                Check(rejected);
            }
            var prior = new Exception("read-failed"); var cleanup = new Win32Exception(158, "unlock-failed");
            var combined = ClipboardHostObserver.CleanupFailure(prior, cleanup) as AggregateException;
            Check(combined != null && combined.InnerExceptions[0] == prior && combined.InnerExceptions[1] == cleanup);
            Check(ClipboardHostObserver.CleanupFailure(null, cleanup) == cleanup);
            owned = GlobalAlloc(0x0042, new UIntPtr(65544)); Check(owned != IntPtr.Zero);
            int size = checked((int)GlobalSize(owned).ToUInt64()); Check(size >= 65544);
            IntPtr pointer = GlobalLock(owned); Check(pointer != IntPtr.Zero); locked = true;
            var bytes = new byte[size]; for (int i = 0; i < size; i++) bytes[i] = (byte)(i % 254 + 1);
            bytes[0] = 0; bytes[size - 1] = 93; Marshal.Copy(bytes, 0, pointer, size);
            var scratch = new byte[65536]; long total = 0;
            var first = ClipboardHostObserver.ReadStorage(49356, "EnterpriseDataProtectionId", owned, scratch, ref total);
            Check(first.logicalBytes == null && first.allocationBytes == size && total == size && first.storageSha256 == Digest(bytes));
            Check((GlobalFlags(owned) & 0xFF) == 1); Cleared(scratch); // Observer released only its own extra lock.
            bytes[size - 1] ^= 1; Marshal.Copy(bytes, 0, pointer, size); total = 0;
            var second = ClipboardHostObserver.ReadStorage(49171, "Ole Private Data", owned, scratch, ref total);
            Check(second.storageSha256 != first.storageSha256 && second.storageSha256 == Digest(bytes)); Cleared(scratch);
            for (int i = 0; i < size; i++) bytes[i] = 65;
            Marshal.Copy(bytes, 0, pointer, size); total = 0;
            Reject(() => ClipboardHostObserver.ReadStorage(1, null, owned, scratch, ref total));
            Check((GlobalFlags(owned) & 0xFF) == 1); Cleared(scratch);
            bytes[65536] = 0; bytes[65537] = 0; Marshal.Copy(bytes, 0, pointer, size); total = 0;
            var text = ClipboardHostObserver.ReadStorage(13, null, owned, scratch, ref total);
            Check(text.logicalBytes == 65538 && text.storageSha256 == Digest(bytes)); Cleared(scratch);
            total = 16 * 1024 * 1024; Reject(() => ClipboardHostObserver.ReadStorage(0xC010, "DataObject", owned, scratch, ref total));
            Check((GlobalFlags(owned) & 0xFF) == 1);
            total = 0; Reject(() => ClipboardHostObserver.ReadStorage(0xC010, "DataObject", IntPtr.Zero, scratch, ref total));
            SetLastError(0); bool released = GlobalUnlock(owned); int releaseError = Marshal.GetLastWin32Error();
            ClipboardHostObserver.CheckUnlock(released, releaseError); locked = false;
            Check((GlobalFlags(owned) & 0xFF) == 0);
            total = 0;
            var unlocked = ClipboardHostObserver.ReadStorage(0xC010, "DataObject", owned, scratch, ref total);
            Check(unlocked.storageSha256 == Digest(bytes));
            Check((GlobalFlags(owned) & 0xFF) == 0); Cleared(scratch); // Native observer release now returns false + NO_ERROR.
            Check(GlobalFree(owned) == IntPtr.Zero); owned = IntPtr.Zero;
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = true, checks, allocations = 1, freed = 1, scratchBytes = 65536 }));
            return 0;
        } catch (Exception error) { Console.WriteLine(error.ToString()); return 1; }
        finally {
            if (owned != IntPtr.Zero) {
                if (locked) GlobalUnlock(owned);
                GlobalFree(owned);
            }
        }
    }
}
