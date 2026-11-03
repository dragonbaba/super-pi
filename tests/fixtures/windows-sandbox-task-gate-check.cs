using System;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;

internal static class TaskGateCheck {
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    static int Main() {
        // Exercise the production startup helper under both locale-independent
        // UTF-8 preamble modes, plus a non-UTF-8 console code page.
        Encoding original = Console.InputEncoding;
        int started = 0, closed = 0;
        try {
            foreach (Encoding encoding in new Encoding[] { new UTF8Encoding(true), new UTF8Encoding(false), Encoding.GetEncoding(936), null }) {
                if (encoding != null) Console.InputEncoding = encoding;
                else { Console.InputEncoding = original; FreeConsole(); }
                string bootstrap = TaskWorker.GateBootstrap + "[Console]::Write('gate-passed')";
                var info = new ProcessStartInfo(@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                    "-NoLogo -NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(bootstrap))) {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                    RedirectStandardOutput = true, RedirectStandardError = true
                };
                using (var process = new Process { StartInfo = info }) {
                    bool running = false;
                    try {
                        if (!process.Start()) throw new Exception("Start failed");
                        running = true; started++;
                        if (process.WaitForExit(100)) throw new Exception("Child passed gate before release");
                        process.StandardInput.WriteLine("SUPERPI_GO"); process.StandardInput.Flush(); process.StandardInput.Close();
                        if (!process.WaitForExit(5000)) throw new Exception("Gate timeout");
                        string output = process.StandardOutput.ReadToEnd(), error = process.StandardError.ReadToEnd();
                        if (process.ExitCode != 0 || output != "gate-passed" || error != "")
                            throw new Exception("Gate mismatch: case=" + started + ";exit=" + process.ExitCode + ";out=" + output + ";err=" + error);
                    } finally {
                        if (running) { if (!process.HasExited) process.Kill(); process.WaitForExit(); closed++; }
                    }
                }
            }
            Console.WriteLine("{\"cases\":4,\"started\":" + started + ",\"closed\":" + closed + ",\"headless\":true}");
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
