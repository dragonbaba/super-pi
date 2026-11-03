// Fixed acceptance probe: one literal IPv4 TCP connection; no HTTP client, proxy, redirect or retry layer.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class SandboxNetworkProbe {
    internal const string Host = "www.msftconnecttest.com";
    internal const string Protocol = "super-pi-wsb-network-v1";
    const string Input = @"C:\SuperPiNetwork\Input";
    const string Output = @"C:\SuperPiNetwork\Output";
    static readonly byte[] RequestBytes = Encoding.ASCII.GetBytes("GET /connecttest.txt HTTP/1.1\r\nHost: www.msftconnecttest.com\r\nConnection: close\r\nAccept-Encoding: identity\r\n\r\n");
    internal static void Need(bool value, string error) { if (!value) throw new InvalidOperationException(error); }
    internal static bool PublicIPv4(string value) {
        IPAddress ip; if (!IPAddress.TryParse(value, out ip) || ip.AddressFamily != AddressFamily.InterNetwork || ip.ToString() != value) return false;
        byte[] b = ip.GetAddressBytes();
        return b[0] > 0 && b[0] < 224 && b[0] != 10 && b[0] != 127
            && !(b[0] == 100 && b[1] >= 64 && b[1] <= 127) && !(b[0] == 169 && b[1] == 254)
            && !(b[0] == 172 && b[1] >= 16 && b[1] <= 31) && !(b[0] == 192 && (b[1] == 168 || b[1] == 0))
            && !(b[0] == 198 && (b[1] == 18 || b[1] == 19 || b[1] == 51 && b[2] == 100))
            && !(b[0] == 203 && b[1] == 0 && b[2] == 113);
    }
    internal static bool ExpectedHttp(byte[] bytes, int count, bool eof) {
        if (!eof || count < 1 || count > 4096) return false;
        string text = Encoding.ASCII.GetString(bytes, 0, count); int boundary = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        if (boundary < 0 || boundary > 2048 || text.Substring(boundary + 4) != "Microsoft Connect Test") return false;
        string[] lines = text.Substring(0, boundary).Split(new string[] { "\r\n" }, StringSplitOptions.None);
        if (lines[0] != "HTTP/1.1 200 OK" && lines[0] != "HTTP/1.0 200 OK") return false;
        bool length = false;
        for (int i = 1; i < lines.Length; i++) {
            int colon = lines[i].IndexOf(':'); if (colon <= 0) return false;
            string name = lines[i].Substring(0, colon), value = lines[i].Substring(colon + 1).Trim();
            if (name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) return false;
            if (name.Equals("Content-Encoding", StringComparison.OrdinalIgnoreCase) && !value.Equals("identity", StringComparison.OrdinalIgnoreCase)) return false;
            if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) { if (length || value != "22") return false; length = true; }
        }
        return length;
    }
    internal sealed class Adapter {
        public string id;
        public int type, status, ipv4, ipv6, gateways4, gateways6;
    }
    internal sealed class InterfaceTrace {
        public string stage = "enumerate", reason;
        public int? count, index, type, status, unicastCount, gatewayCount;
        public int completedCount;
        public bool complete;
    }
    static void InterfaceNeed(bool value, string reason, InterfaceTrace trace) {
        if (!value && trace != null) trace.reason = reason;
        Need(value, reason);
    }
    internal static Adapter[] Interfaces(InterfaceTrace trace = null) {
        if (trace != null) trace.stage = "enumerate";
        return CollectInterfaces(NetworkInterface.GetAllNetworkInterfaces(), trace);
    }
    internal static void CountAddress(Adapter entry, AddressFamily family, bool gateway, InterfaceTrace trace) {
        if (family == AddressFamily.InterNetwork) { if (gateway) entry.gateways4++; else entry.ipv4++; }
        else if (family == AddressFamily.InterNetworkV6) { if (gateway) entry.gateways6++; else entry.ipv6++; }
        else InterfaceNeed(false, gateway ? "unknown-gateway-family" : "unknown-address-family", trace);
    }
    // Shared by the real collector and pure fixtures; no policy or limit is relaxed for diagnostics.
    internal static Adapter[] CollectInterfaces(NetworkInterface[] all, InterfaceTrace trace = null) {
        if (trace != null) { trace.stage = "count"; trace.count = all.Length; }
        InterfaceNeed(all.Length <= 32, "interface-count-bound", trace);
        var result = new Adapter[all.Length]; var ids = new HashSet<string>();
        for (int i = 0; i < all.Length; i++) {
            NetworkInterface nic = all[i];
            if (trace != null) { trace.index = i; trace.stage = "identity"; trace.type = trace.status = trace.unicastCount = trace.gatewayCount = null; }
            string id = nic.Id;
            InterfaceNeed(id.Length > 0 && id.Length <= 128 && ids.Add(id), "interface-identity", trace);
            if (trace != null) trace.stage = "type";
            NetworkInterfaceType type = nic.NetworkInterfaceType;
            if (trace != null) trace.type = (int)type;
            // Windows SDK ipifcons.h: IF_TYPE_PROP_VIRTUAL=53; .NET omits its name.
            // Keep it in the full inventory and apply the same non-loopback status checks.
            InterfaceNeed((int)type == 53 || Enum.IsDefined(typeof(NetworkInterfaceType), type) && type != NetworkInterfaceType.Unknown, "unknown-interface-kind-or-state", trace);
            if (trace != null) trace.stage = "status";
            OperationalStatus status = nic.OperationalStatus;
            if (trace != null) trace.status = (int)status;
            InterfaceNeed(Enum.IsDefined(typeof(OperationalStatus), status) && status != OperationalStatus.Unknown, "unknown-interface-kind-or-state", trace);
            var entry = new Adapter { id = id, type = (int)type, status = (int)status };
            if (trace != null) trace.stage = "properties";
            IPInterfaceProperties properties = nic.GetIPProperties();
            if (trace != null) trace.stage = "unicast-count";
            int unicastCount = properties.UnicastAddresses.Count;
            if (trace != null) trace.unicastCount = unicastCount;
            InterfaceNeed(unicastCount <= 32, "interface-address-count-bound", trace);
            if (trace != null) trace.stage = "gateway-count";
            int gatewayCount = properties.GatewayAddresses.Count;
            if (trace != null) trace.gatewayCount = gatewayCount;
            InterfaceNeed(gatewayCount <= 32, "interface-address-count-bound", trace);
            if (trace != null) trace.stage = "unicast";
            foreach (UnicastIPAddressInformation address in properties.UnicastAddresses) {
                CountAddress(entry, address.Address.AddressFamily, false, trace);
            }
            if (trace != null) trace.stage = "gateway";
            foreach (GatewayIPAddressInformation gateway in properties.GatewayAddresses) {
                CountAddress(entry, gateway.Address.AddressFamily, true, trace);
            }
            result[i] = entry;
            if (trace != null) trace.completedCount++;
        }
        if (trace != null) { trace.stage = "complete"; trace.complete = true; }
        return result;
    }
    internal sealed class Report {
        public string protocol = Protocol, taskId, phase, address, outcome = "not-started";
        public int port = 80, pid, sessionId, responseBytes, sentBytes, connectAttempts, receiveCalls;
        public bool system, connected, connectSettled, socketClosed, eof, matched, interfacesComplete;
        public int? socketError;
        public Adapter[] before, after;
        public string error, cleanupError;
        public long elapsedMs;
    }
    // One teardown boundary. Observe an already completed operation before invalidating its client.
    // The callbacks exist only once per probe; pure fixtures verify the late-completion ordering.
    internal static void ObserveThenClose(Report report, ref bool endCalled, Func<bool> completed, Action end, Action close) {
        try {
            if (!endCalled && completed()) {
                endCalled = true; report.connectSettled = true;
                end(); report.connected = true; // Keep this fact even if close subsequently fails.
            }
        } finally { close(); report.socketClosed = true; }
    }
    static Report Probe(Dictionary<string, string> request) {
        var report = new Report { taskId = request["taskId"], phase = request["phase"], address = request["address"] };
        using (Process process = Process.GetCurrentProcess()) { report.pid = process.Id; report.sessionId = process.SessionId; }
        using (WindowsIdentity user = WindowsIdentity.GetCurrent()) report.system = user.IsSystem;
        TcpClient client = null; IAsyncResult pending = null; WaitHandle wait = null; bool endCalled = false;
        var timer = Stopwatch.StartNew(); var bytes = new byte[4097];
        try {
            report.before = Interfaces();
            client = new TcpClient(AddressFamily.InterNetwork); report.connectAttempts = 1;
            pending = client.BeginConnect(IPAddress.Parse(report.address), 80, null, null); wait = pending.AsyncWaitHandle;
            if (!wait.WaitOne(3000)) { report.outcome = "connect-timeout"; return report; }
            report.connectSettled = true; endCalled = true; client.EndConnect(pending); report.connected = true;
            report.outcome = "connected";
            using (NetworkStream stream = client.GetStream()) {
                stream.WriteTimeout = 3000; stream.Write(RequestBytes, 0, RequestBytes.Length); report.sentBytes = RequestBytes.Length;
                while (report.responseBytes < bytes.Length) {
                    int remaining = 6000 - (int)timer.ElapsedMilliseconds; Need(remaining > 0, "probe-deadline");
                    stream.ReadTimeout = remaining; report.receiveCalls++;
                    int count = stream.Read(bytes, report.responseBytes, bytes.Length - report.responseBytes);
                    if (count == 0) { report.eof = true; break; }
                    report.responseBytes += count;
                }
            }
            report.matched = ExpectedHttp(bytes, report.responseBytes, report.eof);
            report.outcome = report.matched ? "expected-response" : "unexpected-response";
        } catch (Exception error) {
            SocketException socket = error as SocketException ?? error.InnerException as SocketException;
            if (socket != null) report.socketError = (int)socket.SocketErrorCode;
            report.error = error.GetType().Name;
            report.outcome = report.connected ? "connected-io-error" : socket != null ? "connect-error" : "probe-error";
        } finally {
            try {
                if (client != null) ObserveThenClose(report, ref endCalled, () => pending != null && pending.IsCompleted,
                    () => client.EndConnect(pending), () => client.Close());
                else report.socketClosed = true;
                if (pending == null) report.connectSettled = true;
                else if (!endCalled && wait != null && wait.WaitOne(1000)) {
                    // It was unresolved at close. Drain the paired EndConnect, but timeout stays inconclusive.
                    report.connectSettled = true;
                    try { endCalled = true; client.EndConnect(pending); report.connected = true; } catch (SocketException) { } catch (ObjectDisposedException) { }
                }
            } catch (Exception error) { report.cleanupError = error.GetType().Name; }
            finally { if (wait != null) wait.Dispose(); Array.Clear(bytes, 0, bytes.Length); }
            try { report.after = Interfaces(); report.interfacesComplete = report.before != null; }
            catch (Exception error) { report.error = report.error ?? error.GetType().Name; }
            report.elapsedMs = timer.ElapsedMilliseconds;
        }
        return report;
    }
    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        bool guest = args.Length == 0; string file;
        using (Process process = Process.GetCurrentProcess()) {
            string executable = process.MainModule.FileName;
            if (guest) { if (!executable.Equals(Input + @"\probe.exe", StringComparison.OrdinalIgnoreCase)) return 125; file = Input + @"\request.json"; }
            else {
                if (args.Length != 1 || !executable.Equals(Path.Combine(Environment.CurrentDirectory, "network-probe.exe"), StringComparison.OrdinalIgnoreCase)) return 125;
                file = Path.Combine(Environment.CurrentDirectory, args[0] + ".json");
            }
        }
        try {
            if (!guest && args[0] == "resolve") {
                IPAddress[] addresses = Dns.GetHostAddresses(Host); Need(addresses.Length <= 32, "dns-count-bound");
                var ipv4 = new List<string>(); foreach (IPAddress ip in addresses) if (ip.AddressFamily == AddressFamily.InterNetwork && PublicIPv4(ip.ToString()) && !ipv4.Contains(ip.ToString())) ipv4.Add(ip.ToString());
                Need(ipv4.Count > 0, "no-public-ipv4");
                Console.WriteLine(new JavaScriptSerializer().Serialize(new { host = Host, addresses = ipv4 })); return 0;
            }
            Need(guest || args[0] == "health-before" || args[0] == "health-middle" || args[0] == "health-after", "host-phase");
            Need(new FileInfo(file).Length <= 1024, "request-size-bound");
            var request = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(File.ReadAllText(file)); Guid task;
            Need(request.Count == 4 && request["protocol"] == Protocol && Guid.TryParseExact(request["taskId"], "D", out task)
                && task.ToString("D") == request["taskId"] && PublicIPv4(request["address"]), "request-identity");
            Need(guest ? request["phase"] == "enabled" || request["phase"] == "disabled" : request["phase"] == args[0], "request-phase");
            Report result = Probe(request); string json = new JavaScriptSerializer().Serialize(result);
            if (Encoding.UTF8.GetByteCount(json) + 2 > 8192) {
                // Preserve any successful TCP connection even when detailed evidence exceeds its budget.
                result.before = result.after = null; result.interfacesComplete = false; result.error = result.error ?? "receipt-output-bound";
                json = new JavaScriptSerializer().Serialize(result);
            }
            Need(Encoding.UTF8.GetByteCount(json) + 2 <= 8192, "receipt-output-bound");
            if (guest) { using (var stream = new FileStream(Output + @"\result.json", FileMode.CreateNew)) { byte[] encoded = Encoding.UTF8.GetBytes(json); stream.Write(encoded, 0, encoded.Length); } }
            else Console.WriteLine(json);
            return 0; // Transport succeeded; the host separately evaluates network evidence.
        } catch (Exception error) { Console.WriteLine(new JavaScriptSerializer().Serialize(new { error = error.GetType().Name + ":" + error.Message })); return 2; }
    }
}
