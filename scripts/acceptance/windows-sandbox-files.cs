// Fixed disposable mapping probe. An unexpected open is a failure; private contents are never read.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
internal static class FileBoundaryProbe {
    const string Protocol = "super-pi-wsb-files-v1", Input = @"C:\SuperPiFiles\Input", Output = @"C:\SuperPiFiles\Output";
    const string HostRoot = @"D:\RMProjects\Pi\.artifacts\windows-sandbox-acceptance-owner";
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr handle);
    internal sealed class OpenResult {
        public string name;
        public bool opened;
        public int? openError, closeError;
    }
    static void OpenOnly(OpenResult result, string file, uint access) {
        IntPtr handle = CreateFileW(file, access, 7, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
        int error = Marshal.GetLastWin32Error(); // Capture the open operation's error before any other native call.
        if (handle == new IntPtr(-1)) { result.openError = error; return; }
        result.opened = true; // Sticky before close; never read or write using an unexpected handle.
        bool closed = CloseHandle(handle); int closeError = Marshal.GetLastWin32Error();
        if (!closed) result.closeError = closeError;
    }
    static bool SameFile(string file, byte[] expected) {
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (stream.Length != expected.Length) return false;
            byte[] actual = new byte[expected.Length]; int offset = 0;
            while (offset < actual.Length) { int n = stream.Read(actual, offset, actual.Length - offset); if (n == 0) return false; offset += n; }
            for (int i = 0; i < actual.Length; i++) if (actual[i] != expected[i]) return false;
            return stream.Length == expected.Length;
        }
    }
    internal sealed class Report {
        public string protocol = Protocol, taskId, error;
        public int pid, sessionId;
        public bool system, inputReadMatched, outputMatched, complete;
        public OpenResult ro;
        public List<OpenResult> denied = new List<OpenResult>();
    }
    static void Probe(Report report) {
        byte[] inputBytes = Encoding.UTF8.GetBytes("super-pi-read-control:" + report.taskId);
        report.inputReadMatched = SameFile(Input + @"\control.bin", inputBytes);
        if (!report.inputReadMatched) return;
        report.ro = new OpenResult { name = "ro-append" };
        OpenOnly(report.ro, Input + @"\control.bin", 4); // FILE_APPEND_DATA, OPEN_EXISTING.
        if (report.ro.opened || report.ro.openError != 5) return;
        byte[] outputBytes = Encoding.UTF8.GetBytes("super-pi-write-control:" + report.taskId);
        using (var stream = new FileStream(Output + @"\allowed.bin", FileMode.CreateNew, FileAccess.Write, FileShare.None)) stream.Write(outputBytes, 0, outputBytes.Length);
        report.outputMatched = SameFile(Output + @"\allowed.bin", outputBytes);
        if (!report.outputMatched) return;
        string[] names = { "host-private", "parent-neighbor", "host-git", "parent-git", "host-sp", "parent-sp" };
        string[] files = { HostRoot + @"\private\sentinel.bin", Input + @"\..\neighbor\sentinel.bin", HostRoot + @"\.git\sentinel.bin",
            Input + @"\..\.git\sentinel.bin", HostRoot + @"\.sp\sentinel.bin", Input + @"\..\.sp\sentinel.bin" };
        for (int i = 0; i < names.Length; i++) {
            var result = new OpenResult { name = names[i] }; report.denied.Add(result);
            OpenOnly(result, files[i], 0x80000000);
            if (result.opened || result.openError != 2 && result.openError != 3 && result.openError != 5) return;
        }
        report.complete = true;
    }
    static int Main(string[] args) {
        if (args.Length != 0) return 125;
        var report = new Report();
        using (Process process = Process.GetCurrentProcess()) {
            if (!process.MainModule.FileName.Equals(Input + @"\probe.exe", StringComparison.OrdinalIgnoreCase) || !Environment.CurrentDirectory.Equals(Input, StringComparison.OrdinalIgnoreCase)) return 125;
            report.pid = process.Id; report.sessionId = process.SessionId;
        }
        using (WindowsIdentity user = WindowsIdentity.GetCurrent()) report.system = user.IsSystem;
        if (!report.system || report.sessionId != 0) return 125;
        try {
            string file = Input + @"\request.json"; if (new FileInfo(file).Length > 1024) return 125;
            var serializer = new JavaScriptSerializer(); var request = serializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(file)); Guid task;
            if (request.Count != 2 || request["protocol"] != Protocol || !Guid.TryParseExact(request["taskId"], "D", out task) || task.ToString("D") != request["taskId"]) return 125;
            report.taskId = request["taskId"];
            try { Probe(report); } catch (Exception error) { report.error = error.GetType().Name; }
            byte[] result = Encoding.UTF8.GetBytes(serializer.Serialize(report)); if (result.Length > 4096) return 126;
            using (var stream = new FileStream(Output + @"\result.json", FileMode.CreateNew, FileAccess.Write, FileShare.None)) stream.Write(result, 0, result.Length);
            return 0; // Transport only; the host judges observations after instance exit.
        } catch (Exception error) { Console.WriteLine(error.GetType().Name); return 125; }
    }
}
