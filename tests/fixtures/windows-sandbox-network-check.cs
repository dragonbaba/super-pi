// Pure parsing, address and teardown-order checks. Never calls Main, Probe, DNS, interfaces or sockets.
using System;
using System.Text;
using System.Web.Script.Serialization;
internal static class NetworkProbeChecks {
    static int count;
    static void Check(bool value) { count++; if (!value) throw new Exception("check-" + count); }
    static bool Http(string value, bool eof) { byte[] bytes = Encoding.ASCII.GetBytes(value); return SandboxNetworkProbe.ExpectedHttp(bytes, bytes.Length, eof); }
    static int Main() {
        try {
            foreach (string ip in new string[] { "1.1.1.1", "23.1.2.3", "223.1.2.3" }) Check(SandboxNetworkProbe.PublicIPv4(ip));
            foreach (string ip in new string[] { "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.1.1", "169.254.1.1", "198.18.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "1.1.1.01", "www.msftconnecttest.com", "1.1.1.256" }) Check(!SandboxNetworkProbe.PublicIPv4(ip));
            const string good = "HTTP/1.1 200 OK\r\nContent-Length: 22\r\nConnection: close\r\n\r\nMicrosoft Connect Test";
            Check(Http(good, true)); Check(Http(good.Replace("HTTP/1.1", "HTTP/1.0"), true));
            Check(!Http(good, false)); Check(!Http(good + "x", true)); Check(!Http(good.Substring(0, good.Length - 1), true));
            Check(!Http(good.Replace("200 OK", "302 Found"), true));
            Check(!Http(good.Replace("Content-Length: 22", "Transfer-Encoding: chunked"), true));
            Check(!Http(good.Replace("Content-Length: 22", "Content-Length: 22\r\nContent-Length: 22"), true));
            Check(!Http(good.Replace("Content-Length: 22", "Content-Length: 21"), true));
            Check(!Http(good.Replace("Content-Length: 22", "Content-Encoding: gzip\r\nContent-Length: 22"), true));
            Check(!Http(good.Replace("Connection: close", "X: " + new string('a', 2049)), true));
            Check(!Http(good + new string('a', 4097), true));
            Check(!Http("garbage Microsoft Connect Test", true));
            bool ended = false, completed = false; string order = ""; var late = new SandboxNetworkProbe.Report { outcome = "connect-timeout" };
            Check(!completed); completed = true; // Models completion just after the initial wait timed out.
            SandboxNetworkProbe.ObserveThenClose(late, ref ended, () => completed, () => { order += "end;"; }, () => { order += "close;"; });
            Check(order == "end;close;" && ended && late.connected && late.connectSettled && late.socketClosed);
            bool secondEnd = false;
            SandboxNetworkProbe.ObserveThenClose(late, ref ended, () => true, () => { secondEnd = true; }, () => { });
            Check(!secondEnd); // EndConnect responsibility is consumed exactly once.
            ended = false; var closingError = new SandboxNetworkProbe.Report();
            try { SandboxNetworkProbe.ObserveThenClose(closingError, ref ended, () => true, () => { }, () => { throw new InvalidOperationException(); }); }
            catch (InvalidOperationException) { }
            Check(closingError.connected && closingError.connectSettled && !closingError.socketClosed);
            ended = false; bool closed = false; var endError = new SandboxNetworkProbe.Report();
            try { SandboxNetworkProbe.ObserveThenClose(endError, ref ended, () => true, () => { throw new InvalidOperationException(); }, () => { closed = true; }); }
            catch (InvalidOperationException) { }
            Check(ended && closed && !endError.connected);
            ended = false; var unresolved = new SandboxNetworkProbe.Report();
            SandboxNetworkProbe.ObserveThenClose(unresolved, ref ended, () => false, () => { throw new Exception("must-not-end"); }, () => { });
            Check(!ended && !unresolved.connected && !unresolved.connectSettled && unresolved.socketClosed);
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = true, checks = count })); return 0;
        } catch (Exception error) { Console.WriteLine(error.Message); return 1; }
    }
}
