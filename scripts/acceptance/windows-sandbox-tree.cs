// One fixed parent -> child -> grandchild tree, no shell or arbitrary arguments.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
internal static class TreeProbe {
    const string Input = @"C:\SuperPiCancel\Input", Output = @"C:\SuperPiCancel\Output", Executable = Input + @"\probe.exe";
    const string Protocol = "super-pi-wsb-tree-v1", ReadyProtocol = "super-pi-wsb-cancel-v1";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal sealed class Identity { public string role, creationTicks, path; public int pid, sessionId; public bool system, alive; }
    internal sealed class Edge { public int parentPid, childPid; public string childCreationTicks; }
    internal sealed class Coordination { public string protocol, taskId; public Identity node, descendant; public Edge edge; }
    static string Created(Process process) { return process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture); }
    static Identity Self(Process process, string role) {
        bool system; using (WindowsIdentity user = WindowsIdentity.GetCurrent()) system = user.IsSystem;
        if (!system || process.SessionId != 0 || !process.MainModule.FileName.Equals(Executable, StringComparison.OrdinalIgnoreCase)
            || !Environment.CurrentDirectory.Equals(Input, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("context");
        return new Identity { role = role, pid = process.Id, creationTicks = Created(process), path = Executable, sessionId = 0, system = true, alive = true };
    }
    static void Publish(string name, object value, int maximum) {
        byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(value)); if (bytes.Length > maximum) throw new InvalidOperationException("bound");
        using (var file = new FileStream(Output + "\\" + name + ".json", FileMode.CreateNew, FileAccess.Write, FileShare.None)) file.Write(bytes, 0, bytes.Length);
        using (var marker = new FileStream(Output + "\\" + name + ".complete", FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
    }
    static string Read(string file, int maximum) {
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            long length = stream.Length; if (length < 1 || length > maximum) throw new InvalidOperationException("bound");
            byte[] bytes = new byte[(int)length]; int offset = 0;
            while (offset < bytes.Length) { int n = stream.Read(bytes, offset, bytes.Length - offset); if (n == 0) throw new IOException("short"); offset += n; }
            if (stream.Length != length) throw new IOException("resized"); return Encoding.UTF8.GetString(bytes);
        }
    }
    static Process Start(string role) {
        return Process.Start(new ProcessStartInfo(Executable, role) { WorkingDirectory = Input, UseShellExecute = false, CreateNoWindow = true });
    }
    static Edge Started(int parentPid, Process child) { return new Edge { parentPid = parentPid, childPid = child.Id, childCreationTicks = Created(child) }; }
    static void Match(Process process, Identity identity, string role) {
        process.Refresh();
        if (identity == null || identity.role != role || !identity.alive || !identity.system || identity.sessionId != 0 || identity.path != Executable
            || identity.pid != process.Id || identity.creationTicks != Created(process) || process.SessionId != 0
            || !process.MainModule.FileName.Equals(Executable, StringComparison.OrdinalIgnoreCase) || process.HasExited) throw new InvalidOperationException("identity-or-exit");
    }
    static Coordination Await(string role, Process child, string taskId) {
        var clock = Stopwatch.StartNew();
        while (!File.Exists(Output + "\\" + role + ".complete")) {
            if (child.HasExited || clock.ElapsedMilliseconds >= 5000) throw new InvalidOperationException("not-ready"); Thread.Sleep(25);
        }
        var value = Json.Deserialize<Coordination>(Read(Output + "\\" + role + ".json", 4096));
        if (value.protocol != Protocol || value.taskId != taskId) throw new InvalidOperationException("task"); Match(child, value.node, role); return value;
    }
    static int Main(string[] args) {
        string role = args.Length == 0 ? "parent" : args.Length == 1 ? args[0] : "";
        if (role != "parent" && role != "child" && role != "grandchild" || role == "parent" && args.Length != 0) return 125;
        try {
            using (Process self = Process.GetCurrentProcess()) {
                Identity own = Self(self, role);
                var request = Json.Deserialize<Dictionary<string, string>>(Read(Input + @"\request.json", 1024)); Guid task;
                if (request.Count != 2 || request["protocol"] != Protocol || !Guid.TryParseExact(request["taskId"], "D", out task) || task.ToString("D") != request["taskId"]) return 125;
                string taskId = request["taskId"];
                if (role == "grandchild") Publish(role, new Coordination { protocol = Protocol, taskId = taskId, node = own }, 4096);
                else using (Process child = Start(role == "parent" ? "child" : "grandchild")) {
                    Edge edge = Started(own.pid, child); Coordination next = Await(role == "parent" ? "child" : "grandchild", child, taskId);
                    if (role == "child") {
                        if (next.descendant != null || next.edge != null) throw new InvalidOperationException("leaf");
                        Publish(role, new Coordination { protocol = Protocol, taskId = taskId, node = own, descendant = next.node, edge = edge }, 4096);
                    } else {
                        if (next.descendant == null || next.edge == null || next.edge.parentPid != next.node.pid
                            || next.edge.childPid != next.descendant.pid || next.edge.childCreationTicks != next.descendant.creationTicks
                            || own.pid == next.node.pid || own.pid == next.descendant.pid || next.node.pid == next.descendant.pid) throw new InvalidOperationException("tree");
                        // Open only the PID recorded by the child's actual Process.Start; creation time prevents PID reuse.
                        using (Process grandchild = Process.GetProcessById(next.descendant.pid)) {
                            Match(grandchild, next.descendant, "grandchild"); Match(child, next.node, "child"); Match(self, own, "parent");
                            Publish("tree", new { protocol = Protocol, taskId, complete = true, nodes = new[] { own, next.node, next.descendant }, edges = new[] { edge, next.edge } }, 4096);
                            Publish("ready", new { protocol = ReadyProtocol, taskId, pid = own.pid, sessionId = 0, system = true, lifetimeMs = 60000 }, 1024);
                        }
                    }
                }
                Thread.Sleep(60000); return 73; // Every role waits after its readiness publication; no natural completion in the host's <30s window.
            }
        } catch (Exception error) { Console.WriteLine(error.GetType().Name); return 125; }
    }
}
