// Controlled single-process wait. No descendants, arbitrary commands, network or clipboard operations.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
internal static class CancellationProbe {
    const string Input = @"C:\SuperPiCancel\Input", Output = @"C:\SuperPiCancel\Output";
    const string Protocol = "super-pi-wsb-cancel-v1";
    static int Main(string[] args) {
        if (args.Length != 0) return 125;
        try {
            int pid, sessionId; bool system;
            using (Process process = Process.GetCurrentProcess()) {
                if (!process.MainModule.FileName.Equals(Input + @"\probe.exe", StringComparison.OrdinalIgnoreCase)
                    || !Environment.CurrentDirectory.Equals(Input, StringComparison.OrdinalIgnoreCase)) return 125;
                pid = process.Id; sessionId = process.SessionId;
            }
            using (WindowsIdentity user = WindowsIdentity.GetCurrent()) system = user.IsSystem;
            if (!system || sessionId != 0) return 125;
            string file = Input + @"\request.json";
            if (new FileInfo(file).Length > 1024) return 125;
            var serializer = new JavaScriptSerializer();
            var request = serializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(file)); Guid task;
            if (request.Count != 2 || request["protocol"] != Protocol || !Guid.TryParseExact(request["taskId"], "D", out task) || task.ToString("D") != request["taskId"]) return 125;
            byte[] ready = Encoding.UTF8.GetBytes(serializer.Serialize(new { protocol = Protocol, taskId = request["taskId"], pid, sessionId, system, lifetimeMs = 60000 }));
            if (ready.Length > 1024) return 126;
            using (var stream = new FileStream(Output + @"\ready.json", FileMode.CreateNew, FileAccess.Write, FileShare.None)) stream.Write(ready, 0, ready.Length);
            using (var marker = new FileStream(Output + @"\ready.complete", FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
            Thread.Sleep(60000); // Natural completion cannot occur before the host dispatch time + 60 seconds.
            return 73; // A natural exit is never an active-cancellation pass.
        } catch (Exception error) { Console.WriteLine(error.GetType().Name); return 125; }
    }
}
