// PowerShell 7 task profile. All guest reports remain untrusted host data.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class TaskWorker {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DefineDosDeviceW(uint flags, string name, string target);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint QueryDosDeviceW(string name, StringBuilder target, int length);
    static void ToolchainDrives(string value) {
        if (value.Length == 0) return;
        foreach (string drive in value.Split(';')) {
            Need(drive.Length == 1 && drive[0] >= 'A' && drive[0] <= 'Z' && drive[0] != 'C', "Guest toolchain drive");
            string name = drive + ":", target = @"C:\SuperPiToolchains\" + drive;
            Need(Directory.Exists(target), "Guest toolchain drive directory");
            var current = new StringBuilder(1024);
            uint length = QueryDosDeviceW(name, current, current.Capacity);
            if (length > 0) Need(current.ToString() == @"\??\" + target, "Guest drive already in use");
            else Need(Marshal.GetLastWin32Error() == 2 && DefineDosDeviceW(8, name, target), "Guest toolchain drive creation");
        }
    }
    internal const string VersionGuard = "if($PSVersionTable.PSEdition -cne 'Core' -or $PSVersionTable.PSVersion.Major -ne 7){throw 'Sandbox requires PowerShell 7'}; $PSStyle.OutputRendering='PlainText'; $ErrorView='NormalView'; ";
    internal static ProcessStartInfo CommandInfo(string bootstrap, string cwd, string encodedEnvironment, string temporary) {
        Need(encodedEnvironment.Length <= 24000, "Toolchain environment capacity");
        string[] lines = Utf8.GetString(Convert.FromBase64String(encodedEnvironment)).Split('\n');
        Need(lines.Length >= 3 && lines.Length <= 32 && lines[0].StartsWith(@"C:\", StringComparison.OrdinalIgnoreCase)
            && lines[0].EndsWith(@"\pwsh.exe", StringComparison.OrdinalIgnoreCase) && File.Exists(lines[0]), "Mapped PowerShell 7 required");
        Directory.CreateDirectory(temporary);
        string settings = Path.Combine(temporary, "powershell.config.json");
        File.WriteAllText(settings, "{\"DisableImplicitWinCompat\":true}", new UTF8Encoding(false));
        var info = new ProcessStartInfo(lines[0], "-NoLogo -NoProfile -NonInteractive -SettingsFile \"" + settings + "\" -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand " + Convert.ToBase64String(Utf16.GetBytes(bootstrap))) {
            WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        // Only guest OS values and explicitly translated tool roots enter the command.
        info.EnvironmentVariables.Clear();
        info.EnvironmentVariables["SystemRoot"] = @"C:\Windows"; info.EnvironmentVariables["WINDIR"] = @"C:\Windows";
        info.EnvironmentVariables["COMSPEC"] = @"C:\Windows\System32\cmd.exe";
        info.EnvironmentVariables["PATHEXT"] = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
        info.EnvironmentVariables["TEMP"] = temporary; info.EnvironmentVariables["TMP"] = temporary; info.EnvironmentVariables["TMPDIR"] = temporary;
        string home = Path.Combine(temporary, "home"); Directory.CreateDirectory(home);
        info.EnvironmentVariables["USERPROFILE"] = home; info.EnvironmentVariables["HOME"] = home;
        info.EnvironmentVariables["APPDATA"] = home; info.EnvironmentVariables["LOCALAPPDATA"] = home;
        info.EnvironmentVariables["DOTNET_CLI_HOME"] = home; info.EnvironmentVariables["DOTNET_SKIP_FIRST_TIME_EXPERIENCE"] = "1";
        info.EnvironmentVariables["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        info.EnvironmentVariables["npm_config_cache"] = Path.Combine(temporary, "npm-cache");
        info.EnvironmentVariables["CARGO_HOME"] = Path.Combine(temporary, "cargo");
        for (int i = 1; i < lines.Length; i++) {
            int at = lines[i].IndexOf('='); Need(at > 0, "Guest environment record");
            string name = lines[i].Substring(0, at), value = lines[i].Substring(at + 1);
            if (name == "SUPERPI_TOOLCHAIN_DRIVES") { ToolchainDrives(value); continue; }
            Need(name == "PATH" || name == "PSModulePath" || name == "JAVA_HOME" || name == "JDK_HOME" || name == "GOROOT" || name == "DOTNET_ROOT"
                || name == "RUSTUP_HOME" || name == "ANDROID_HOME" || name == "ANDROID_SDK_ROOT" || name == "GRADLE_HOME" || name == "CUDA_PATH" || name == "SUPERPI_BASH", "Unexpected guest variable");
            Need(value.IndexOf('\r') < 0 && value.IndexOf('\0') < 0, "Guest environment value");
            info.EnvironmentVariables[name] = value;
        }
        Need(info.EnvironmentVariables.ContainsKey("PATH") && info.EnvironmentVariables.ContainsKey("PSModulePath"), "Guest search paths required");
        return info;
    }
    const string Root = @"C:\SuperPiVolume", Workspace = Root + @"\workspace", Tools = Root + @"\tools";
    const int StreamLimit = 32768, PackageLimit = 49168;
    static readonly Encoding Utf8 = new UTF8Encoding(false, true), Utf16 = new UnicodeEncoding(false, false, true);
    static readonly Regex Uuid = new Regex(@"\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z");
    static readonly Regex Component = new Regex(@"\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z");
    static readonly Regex Protected = new Regex(@"\A(con|prn|aux|nul|com[1-9]|lpt[1-9]|credentials?|secrets?|id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)|\.(pem|key|pfx|p12)$", RegexOptions.IgnoreCase);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, byte[] data, uint size, IntPtr needed);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    static void Need(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
    static void Clear(byte[] bytes) { if (bytes != null) Array.Clear(bytes, 0, bytes.Length); }
    static uint U32(byte[] b, int at) { return (uint)(b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24); }
    static void Put32(byte[] b, int at, uint value) { for (int i = 0; i < 4; i++) b[at + i] = (byte)(value >> (i * 8)); }
    static void Put64(byte[] b, int at, ulong value) { for (int i = 0; i < 8; i++) b[at + i] = (byte)(value >> (i * 8)); }
    static string Ascii(byte[] b, int at, int count) {
        Need(at >= 0 && count >= 0 && at <= b.Length - count, "ASCII bound");
        for (int i = at; i < at + count; i++) Need(b[i] < 128 && b[i] != 0, "Canonical ASCII");
        return Encoding.ASCII.GetString(b, at, count);
    }
    static string Relative(string value) {
        Need(value.Length > 0 && value.Length <= 120, "Path length");
        string[] parts = value.Split('/'); Need(parts.Length <= 4, "Path depth");
        foreach (string part in parts) Need(Component.IsMatch(part) && !part.EndsWith(".") && !Protected.IsMatch(part), "Path component");
        return value;
    }
    sealed class Input { internal string Path; internal int Size, Offset; internal byte[] Hash; }
    sealed class Target { internal string Path; internal byte Operation; }
    sealed class Package {
        internal string Task, Snapshot, Cwd;
        internal int Timeout;
        internal byte[] Command;
        internal Input[] Inputs;
        internal Target[] Writes;
        internal void Clear() {
            TaskWorker.Clear(Command); Command = null;
            if (Inputs != null) foreach (Input input in Inputs) if (input != null) { TaskWorker.Clear(input.Hash); input.Hash = null; input.Path = null; }
            Inputs = null; Writes = null; Task = null; Snapshot = null; Cwd = null;
        }
    }
    sealed class Cursor {
        internal byte[] Bytes; internal int At, End;
        internal void Bound(int count) { Need(count >= 0 && At >= 0 && At <= End - count, "Metadata boundary"); }
        internal byte Byte() { Bound(1); return Bytes[At++]; }
        internal uint UInt() { Bound(4); uint value = U32(Bytes, At); At += 4; return value; }
        internal string Text(int count) { Bound(count); string value = Ascii(Bytes, At, count); At += count; return value; }
        internal byte[] Hash() { Bound(32); byte[] value = new byte[32]; Buffer.BlockCopy(Bytes, At, value, 0, 32); At += 32; return value; }
    }
    static void AddPath(List<string> paths, string value) {
        string key = value.ToLowerInvariant(); Need(paths.Count < 16, "Combined path limit");
        foreach (string old in paths) Need(key != old && !key.StartsWith(old + "/", StringComparison.Ordinal) && !old.StartsWith(key + "/", StringComparison.Ordinal), "Path conflict");
        paths.Add(key);
    }
    static Package Parse(byte[] bytes, string task, string snapshot) {
        Package p = new Package();
        try {
            Need(bytes != null && bytes.Length >= 100 && bytes.Length <= PackageLimit && Uuid.IsMatch(task) && Uuid.IsMatch(snapshot), "Package bound/identity");
            uint metadata = U32(bytes, 12);
            Need(Ascii(bytes, 0, 8) == "SPTASK01" && U32(bytes, 8) == bytes.Length && metadata >= 84 && metadata <= 32768 && metadata <= bytes.Length - 16, "Package header");
            Cursor c = new Cursor { Bytes = bytes, At = 16, End = 16 + (int)metadata };
            p.Task = c.Text(36); p.Snapshot = c.Text(36); Need(p.Task == task && p.Snapshot == snapshot, "Package association");
            uint timeout = c.UInt(), commandSize = c.UInt();
            Need(timeout > 0 && timeout <= 30000 && commandSize > 0 && commandSize <= 21848 && commandSize % 4 == 0, "Command bound");
            p.Timeout = (int)timeout;
            int cwdSize = c.Byte(), inputCount = c.Byte(), writeCount = c.Byte();
            Need(c.Byte() == 0 && cwdSize > 0 && cwdSize <= 120 && inputCount <= 16 && writeCount <= 16, "Package fields");
            p.Cwd = c.Text(cwdSize); if (p.Cwd != ".") Relative(p.Cwd);
            string encoded = c.Text((int)commandSize);
            p.Command = Convert.FromBase64String(encoded);
            Need(Convert.ToBase64String(p.Command) == encoded && p.Command.Length > 0 && p.Command.Length % 2 == 0, "Canonical command encoding");
            string command = Utf16.GetString(p.Command);
            Need(command.IndexOf('\0') < 0 && Utf8.GetByteCount(command) <= 8192, "Command text");
            p.Inputs = new Input[inputCount]; p.Writes = new Target[writeCount];
            var paths = new List<string>(16); var inputs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            int total = 0;
            for (int i = 0; i < inputCount; i++) {
                Input input = p.Inputs[i] = new Input(); input.Path = Relative(c.Text(c.Byte()));
                AddPath(paths, input.Path); inputs.Add(input.Path, input.Path);
                uint size = c.UInt(); Need(size <= 4096, "Input size"); input.Size = (int)size; total += input.Size;
                Need(total <= 16384, "Combined input bytes"); input.Hash = c.Hash();
            }
            var targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < writeCount; i++) {
                Target write = p.Writes[i] = new Target { Path = Relative(c.Text(c.Byte())), Operation = c.Byte() };
                Need(targets.Add(write.Path), "Repeated write");
                if (write.Operation == 1) AddPath(paths, write.Path);
                else { string original; Need(write.Operation == 2 && inputs.TryGetValue(write.Path, out original) && original == write.Path, "Write input association"); }
            }
            Need(c.At == c.End && bytes.Length - c.End == total, "Exact metadata/payload consumption");
            if (p.Cwd != ".") foreach (string name in paths) {
                string directory = p.Cwd.ToLowerInvariant(); Need(directory != name && !directory.StartsWith(name + "/", StringComparison.Ordinal), "Cwd file conflict");
            }
            int offset = c.End;
            using (SHA256 sha = SHA256.Create()) foreach (Input input in p.Inputs) {
                input.Offset = offset; byte[] digest = sha.ComputeHash(bytes, offset, input.Size);
                try { for (int j = 0; j < 32; j++) Need(digest[j] == input.Hash[j], "Input hash"); }
                finally { Clear(digest); }
                offset += input.Size;
            }
            Need(offset == bytes.Length, "Payload end"); return p;
        } catch { p.Clear(); throw; }
    }
    static byte[] ReadBounded(string path, int maximum) {
        byte[] bytes = null;
        try {
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                Need(file.Length >= 0 && file.Length <= maximum, "File byte bound"); bytes = new byte[(int)file.Length];
                int at = 0; while (at < bytes.Length) { int n = file.Read(bytes, at, bytes.Length - at); Need(n > 0, "Short file"); at += n; }
                Need(file.Length == bytes.Length, "Resized file");
            }
            return bytes;
        } catch { Clear(bytes); throw; }
    }
    static void WriteNew(string path, byte[] bytes, int offset, int count) {
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.Write(bytes, offset, count); file.Flush(true); }
    }
    // Each pump owns one 32 KiB prefix and one 4 KiB scratch. The production read
    // loop never allocates application objects/strings and keeps draining at cap.
    sealed class Pump {
        internal byte[] Retained = new byte[StreamLimit], Scratch = new byte[4096];
        internal Stream Stream; internal IDisposable Reader; internal Thread Thread;
        internal int Kept, Reads, Cleared; internal long Seen;
        internal bool Started, Finished, CloseAttempted, Closed;
        internal Exception Failure, CloseFailure;
        internal Pump(StreamReader reader) { Reader = reader; Stream = reader.BaseStream; }
        internal Pump(Stream stream) { Reader = stream; Stream = stream; }
        internal void Start() { Thread = new Thread(Run); Thread.IsBackground = true; Thread.Start(); Started = true; }
        internal void Run() {
            try {
                while (true) {
                    int count = Stream.Read(Scratch, 0, Scratch.Length); Reads++;
                    if (count == 0) break;
                    if (Seen > 9007199254740991L - count) throw new InvalidOperationException("Output counter overflow");
                    Seen += count; int copy = Math.Min(count, StreamLimit - Kept);
                    if (copy > 0) { Buffer.BlockCopy(Scratch, 0, Retained, Kept, copy); Kept += copy; }
                }
            } catch (Exception error) { Failure = error; }
            finally { Close(); Clear(Scratch); Cleared += Scratch.Length; Scratch = null; Finished = true; }
        }
        internal void Close() {
            if (CloseAttempted) return; CloseAttempted = true;
            try { Reader.Dispose(); Closed = true; Stream = null; Reader = null; }
            catch (Exception error) { CloseFailure = error; }
        }
        internal bool Join(int timeout) { return !Started || Thread.Join(timeout); }
        internal void Release() {
            Need(!Started || Finished && !Thread.IsAlive, "Pump still live");
            if (!Started) { Close(); if (Scratch != null) { Clear(Scratch); Cleared += Scratch.Length; Scratch = null; } }
            Clear(Retained); Cleared += Retained.Length; Retained = null; Thread = null;
            Need(Closed && Failure == null && CloseFailure == null, "Pump unresolved");
        }
    }
    sealed class Job {
        internal IntPtr Handle; internal bool CloseAttempted, Closed, Assigned, Settled;
        internal readonly byte[] Accounting = new byte[48];
        internal int Queries;
        internal void Open() {
            Need(IntPtr.Size == 8, "x64 profile"); Handle = CreateJobObjectW(IntPtr.Zero, null); // Non-inheritable.
            if (Handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] limits = new byte[144]; Put32(limits, 16, 0x2000); // KILL_ON_JOB_CLOSE.
            try { if (!SetInformationJobObject(Handle, 9, limits, (uint)limits.Length)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
            finally { Clear(limits); }
        }
        internal void Assign(Process process) {
            if (!AssignProcessToJobObject(Handle, process.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error()); Assigned = true;
        }
        internal void Settle(Stopwatch clock, long deadline) {
            Need(Handle != IntPtr.Zero && !CloseAttempted, "Job unavailable");
            // Termination is required even after a normal root exit: descendants
            // may have detached from redirected streams and still be running.
            if (!TerminateJobObject(Handle, 1460)) throw new Win32Exception(Marshal.GetLastWin32Error());
            do {
                Queries++;
                if (!QueryInformationJobObject(Handle, 1, Accounting, (uint)Accounting.Length, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (U32(Accounting, 40) == 0) { Settled = true; return; }
                if (clock.ElapsedMilliseconds >= deadline) break; Thread.Sleep(10);
            } while (true);
            throw new TimeoutException("Job descendants unsettled");
        }
        internal void Close() {
            if (Handle == IntPtr.Zero || CloseAttempted) return; CloseAttempted = true;
            if (!CloseHandle(Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
            Handle = IntPtr.Zero; Closed = true; Clear(Accounting);
        }
    }
    static int Remaining(Stopwatch clock, long deadline) { return (int)Math.Max(0, Math.Min(Int32.MaxValue, deadline - clock.ElapsedMilliseconds)); }
    // Framework Process may emit an encoding preamble while creating its stdin
    // writer. Decode that byte stream explicitly, including BOM detection; do
    // not set Console.InputEncoding (the System runner has no console).
    internal const string GateBootstrap = "$gateReader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.Encoding]::UTF8,$true); "
        + "try { if ($gateReader.ReadLine() -cne 'SUPERPI_GO') { exit 125 } } finally { $gateReader.Dispose() }; $gateReader=$null; ";
    static void PublishCandidates(Package p) {
        string payload = Root + @"\payload"; Need(!Directory.Exists(payload), "Payload exists"); Directory.CreateDirectory(payload);
        var json = new StringBuilder(4096); json.Append("{\"protocol\":\"super-pi-offline-candidates-v1\",\"taskId\":\"").Append(p.Task)
            .Append("\",\"snapshotId\":\"").Append(p.Snapshot).Append("\",\"candidates\":[");
        int total = 0;
        for (int i = 0; i < p.Writes.Length; i++) {
            Target write = p.Writes[i]; byte[] bytes = ReadBounded(Path.Combine(Workspace, write.Path.Replace('/', '\\')), 4096);
            try {
                total += bytes.Length; Need(total <= 16384, "Candidate total");
                string destination = Path.Combine(payload, write.Path.Replace('/', '\\')); Directory.CreateDirectory(Path.GetDirectoryName(destination));
                WriteNew(destination, bytes, 0, bytes.Length);
            } finally { Clear(bytes); }
            if (i != 0) json.Append(','); json.Append("{\"path\":\"").Append(write.Path).Append("\",\"operation\":\"")
                .Append(write.Operation == 1 ? "add" : "modify").Append("\"}");
        }
        json.Append("],\"report\":{\"exitCode\":0}}"); byte[] manifest = Utf8.GetBytes(json.ToString());
        try { Need(manifest.Length <= 4096, "Candidate manifest size"); WriteNew(Root + @"\candidates.json", manifest, 0, manifest.Length); }
        finally { Clear(manifest); }
    }
    static void PublishResult(Package p, Pump stdout, Pump stderr, int exit, bool timedOut, long elapsed) {
        byte[] bytes = new byte[128 + stdout.Kept + stderr.Kept];
        try {
            Encoding.ASCII.GetBytes("SPRES001", 0, 8, bytes, 0); Put32(bytes, 8, (uint)bytes.Length); Put32(bytes, 12, 128);
            Encoding.ASCII.GetBytes(p.Task, 0, 36, bytes, 16); Encoding.ASCII.GetBytes(p.Snapshot, 0, 36, bytes, 52);
            Put32(bytes, 88, unchecked((uint)exit));
            Put32(bytes, 92, (uint)(995 | (timedOut ? 4 : 0) | (stdout.Seen > StreamLimit ? 8 : 0) | (stderr.Seen > StreamLimit ? 16 : 0)));
            Put32(bytes, 96, (uint)stdout.Kept); Put32(bytes, 100, (uint)stderr.Kept);
            Put64(bytes, 104, (ulong)stdout.Seen); Put64(bytes, 112, (ulong)stderr.Seen); Put32(bytes, 120, (uint)elapsed);
            Buffer.BlockCopy(stdout.Retained, 0, bytes, 128, stdout.Kept); Buffer.BlockCopy(stderr.Retained, 0, bytes, 128 + stdout.Kept, stderr.Kept);
            WriteNew(Root + @"\task-result.bin", bytes, 0, bytes.Length);
        } finally { Clear(bytes); }
    }
    static int Execute(Package p, byte[] package, string environment) {
        Process process = null; Pump stdout = null, stderr = null; Job job = new Job();
        bool started = false, stdinClosed = false, stdinCloseAttempted = false, processDisposeAttempted = false;
        bool gate = false, timedOut = false, finished = false, settlementAttempted = false;
        var failures = new List<Exception>(); Stopwatch clock = Stopwatch.StartNew();
        long settleDeadline = p.Timeout + 8000L;
        try {
            Directory.CreateDirectory(Root + @"\temp");
            foreach (Input input in p.Inputs) {
                string file = Path.Combine(Workspace, input.Path.Replace('/', '\\')); Directory.CreateDirectory(Path.GetDirectoryName(file));
                WriteNew(file, package, input.Offset, input.Size);
            }
            string cwd = p.Cwd == "." ? Workspace : Path.Combine(Workspace, p.Cwd.Replace('/', '\\')); Directory.CreateDirectory(cwd);
            WriteNew(Tools + @"\task-command.bin", p.Command, 0, p.Command.Length);
            // Only this fixed bootstrap is in argv. The original command is never
            // quoted/reinterpreted by a host shell and cannot run before Job assignment.
            const string bootstrap = GateBootstrap + VersionGuard
                + "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; "
                + "$b=[IO.File]::ReadAllBytes('C:\\SuperPiVolume\\tools\\task-command.bin'); "
                + "$s=[Text.Encoding]::Unicode.GetString($b); [Array]::Clear($b,0,$b.Length); $b=$null; & ([ScriptBlock]::Create($s))";
            var info = CommandInfo(bootstrap, cwd, environment, Root + @"\temp");
            job.Open(); process = new Process { StartInfo = info }; Need(process.Start(), "PowerShell start"); started = true;
            stdout = new Pump(process.StandardOutput); stderr = new Pump(process.StandardError);
            job.Assign(process); stdout.Start(); stderr.Start();
            process.StandardInput.WriteLine("SUPERPI_GO"); process.StandardInput.Flush(); gate = true;
            stdinCloseAttempted = true; process.StandardInput.Close(); stdinClosed = true;
            timedOut = !process.WaitForExit(Remaining(clock, p.Timeout));
            settlementAttempted = true; job.Settle(clock, settleDeadline);
            Need(process.WaitForExit(Remaining(clock, settleDeadline)), "Root unsettled");
            Need(stdout.Join(Remaining(clock, settleDeadline)) && stderr.Join(Remaining(clock, settleDeadline)), "Pumps unsettled");
            Need(stdout.Closed && stderr.Closed && stdout.Failure == null && stderr.Failure == null && stdout.CloseFailure == null && stderr.CloseFailure == null, "Pipe failure");
            int exit = process.ExitCode; job.Close(); Need(job.Closed && job.Settled && job.Assigned && gate && stdinClosed, "Job settlement");
            processDisposeAttempted = true; process.Dispose(); process = null;
            Need(clock.ElapsedMilliseconds <= p.Timeout + 10000L, "Result deadline");
            PublishResult(p, stdout, stderr, exit, timedOut, clock.ElapsedMilliseconds);
            if (!timedOut && exit == 0) PublishCandidates(p);
            finished = true;
        } catch (Exception error) { failures.Add(error); }
        finally {
            // Preserve the first failure and all cleanup failures. No successful
            // wrapper exit can hide an unknown Job, pipe, root, or pump state.
            if (job.Handle != IntPtr.Zero && !job.CloseAttempted) {
                try { if (!settlementAttempted) { settlementAttempted = true; job.Settle(clock, settleDeadline); } } catch (Exception error) { failures.Add(error); }
                try { job.Close(); } catch (Exception error) { failures.Add(error); }
            }
            if (process != null) {
                if (started && !stdinCloseAttempted) try { stdinCloseAttempted = true; process.StandardInput.Close(); stdinClosed = true; } catch (Exception error) { failures.Add(error); }
                try {
                    if (started && !process.HasExited && !job.Assigned) process.Kill(); // Only the exact gated root we started.
                    if (started) Need(process.WaitForExit(Remaining(clock, settleDeadline)), "Cleanup root unsettled");
                    if (!processDisposeAttempted) { processDisposeAttempted = true; process.Dispose(); process = null; }
                } catch (Exception error) { failures.Add(error); }
            }
            foreach (Pump pump in new Pump[] { stdout, stderr }) if (pump != null) {
                try { Need(pump.Join(Remaining(clock, settleDeadline)), "Cleanup pump unsettled"); pump.Release(); }
                catch (Exception error) { failures.Add(error); }
            }
        }
        if (failures.Count != 0) throw new AggregateException("Task execution/cleanup failed", failures);
        Need(finished, "Task incomplete"); return 0;
    }
    // Bounded host-side allocation/lifecycle evidence for the exact production
    // pump. This branch performs no OS process launch, file access, or Job calls.
    [MethodImpl(MethodImplOptions.NoInlining)]
    static WeakReference[] PumpCheck() {
        byte[] input = new byte[131073]; for (int i = 0; i < input.Length; i++) input[i] = (byte)i;
        Pump pump = new Pump(new MemoryStream(input, false)); WeakReference retained = new WeakReference(pump.Retained), scratch = new WeakReference(pump.Scratch);
        pump.Run(); Need(pump.Seen == input.Length && pump.Kept == StreamLimit && pump.Reads == 34 && pump.Closed && pump.Failure == null, "Pump counters");
        for (int i = 0; i < StreamLimit; i++) Need(pump.Retained[i] == input[i], "Retained prefix");
        pump.Release(); Need(pump.Cleared == 36864 && pump.Retained == null && pump.Scratch == null && pump.Reader == null && pump.Stream == null && pump.Thread == null, "Pump reference release");
        Clear(input); return new WeakReference[] { retained, scratch };
    }
    static int PackageCheck() {
        string id = "00000000-0000-0000-0000-000000000000"; byte[] bytes = new byte[105]; int refused = 0;
        try {
            Encoding.ASCII.GetBytes("SPTASK01", 0, 8, bytes, 0); Put32(bytes, 8, 105); Put32(bytes, 12, 89);
            Encoding.ASCII.GetBytes(id, 0, 36, bytes, 16); Encoding.ASCII.GetBytes(id, 0, 36, bytes, 52);
            Put32(bytes, 88, 10000); Put32(bytes, 92, 4); bytes[96] = 1;
            Encoding.ASCII.GetBytes(".eAA=", 0, 5, bytes, 100);
            Package valid = Parse(bytes, id, id);
            try { Need(valid.Inputs.Length == 0 && valid.Writes.Length == 0 && valid.Cwd == "." && Utf16.GetString(valid.Command) == "x", "Empty package contract"); }
            finally { valid.Clear(); }
            for (int variant = 0; variant < 9; variant++) {
                byte[] altered = (byte[])bytes.Clone(); Package unexpected = null;
                try {
                    switch (variant) {
                        case 0: altered[0] |= 128; break;
                        case 1: Put32(altered, 8, 104); break;
                        case 2: Put32(altered, 12, 84); break;
                        case 3: altered[16] = (byte)'x'; break;
                        case 4: Put32(altered, 88, 0); break;
                        case 5: Put32(altered, 92, UInt32.MaxValue); break;
                        case 6: altered[97] = 17; break;
                        case 7: altered[99] = 1; break;
                        case 8: altered[101] = 0; break;
                    }
                    try { unexpected = Parse(altered, id, id); } catch (Exception) { refused++; }
                    Need(unexpected == null, "Malformed package accepted");
                } finally { if (unexpected != null) unexpected.Clear(); Clear(altered); }
            }
            Need(refused == 9, "Package refusal count"); return refused;
        } finally { Clear(bytes); }
    }
    static int ContractCheck() {
        int refused = PackageCheck(); WeakReference[] weak = PumpCheck();
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        Need(!weak[0].IsAlive && !weak[1].IsAlive, "Pump buffers retained");
        Console.WriteLine("{\"protocol\":\"super-pi-task-pump-contract-v1\",\"seen\":131073,\"retained\":32768,\"reads\":34,\"allocated\":36864,\"cleared\":36864,\"liveBuffers\":0,\"nativeCalls\":0,\"packageRefusals\":" + refused + "}"); return 0;
    }
    // The persistent workspace backend shares the exact gated Job/Pump owners.
    // This entry is guest-only and never accepts a host executable or shell.
    static int WorkspaceCommand(string[] args) {
        Need(args.Length == 6 && args[0] == @"C:\SuperPiExchange"
            && (args[1] == @"C:\SuperPiInput" || args[1] == @"C:\SuperPiWorkspace")
            && String.Equals(Path.GetFullPath(typeof(TaskWorker).Assembly.Location), @"C:\SuperPiTools\command.exe", StringComparison.OrdinalIgnoreCase), "Guest workspace runner location");
        int timeout; Need(Int32.TryParse(args[2], out timeout) && timeout > 0 && timeout <= 120000, "Command deadline");
        string cwd = args[3];
        Need(cwd.Length > 3 && cwd.Length < 4096 && Char.ToUpperInvariant(cwd[0]) >= 'A' && Char.ToUpperInvariant(cwd[0]) <= 'Z'
            && cwd[1] == ':' && cwd[2] == '\\' && Path.GetFullPath(cwd) == cwd, "Command workspace path");
        if (Char.ToUpperInvariant(cwd[0]) != 'C') ToolchainDrives(Char.ToUpperInvariant(cwd[0]).ToString());
        Need(args[5].Length <= 49, "Workspace drive capacity");
        ToolchainDrives(args[5]);
        Need(Directory.Exists(cwd), "Command workspace unavailable");
        string commandFile = args[0] + @"\command.txt";
        Need(new FileInfo(commandFile).Length <= 131072, "Command capacity");
        Need(args[4] == "powershell" || args[4] == "bash", "Unknown workspace shell");
        string bootstrap = GateBootstrap + VersionGuard + "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; "
            + (args[4] == "bash" ? "if(!$env:SUPERPI_BASH){throw 'Mapped Bash installation unavailable; inspect C:\\SuperPiTools\\toolchains.json'}; & $env:SUPERPI_BASH --noprofile --norc /c/SuperPiExchange/command.txt; exit $LASTEXITCODE"
                : "& ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\\SuperPiExchange\\command.txt',[Text.Encoding]::UTF8)))");
        const string environmentFile = @"C:\SuperPiTools\environment.txt";
        Need(new FileInfo(environmentFile).Length <= 24000, "Toolchain environment capacity");
        var info = CommandInfo(bootstrap, cwd, File.ReadAllText(environmentFile, Utf8), @"C:\SuperPiCommand");
        Process process = null; Pump stdout = null, stderr = null; Job job = new Job(); Stopwatch clock = Stopwatch.StartNew();
        long deadline = timeout + 8000L; bool started = false;
        try {
            job.Open(); process = new Process { StartInfo = info }; Need(process.Start(), "Start gated command"); started = true;
            stdout = new Pump(process.StandardOutput); stderr = new Pump(process.StandardError);
            job.Assign(process); stdout.Start(); stderr.Start();
            process.StandardInput.WriteLine("SUPERPI_GO"); process.StandardInput.Flush(); process.StandardInput.Close();
            bool timedOut = !process.WaitForExit(Remaining(clock, timeout));
            job.Settle(clock, deadline);
            Need(process.WaitForExit(Remaining(clock, deadline)) && stdout.Join(Remaining(clock, deadline)) && stderr.Join(Remaining(clock, deadline)), "Command family unsettled");
            Need(stdout.Closed && stderr.Closed && stdout.Failure == null && stderr.Failure == null && stdout.CloseFailure == null && stderr.CloseFailure == null, "Pipe failure");
            int exit = process.ExitCode; job.Close(); Need(job.Closed && job.Settled, "Job remains owned");
            string result = "{\"closed\":true,\"exitCode\":" + exit + ",\"timedOut\":" + (timedOut ? "true" : "false")
                + ",\"truncated\":" + (stdout.Seen > StreamLimit || stderr.Seen > StreamLimit ? "true" : "false")
                + ",\"stdoutBase64\":\"" + Convert.ToBase64String(stdout.Retained, 0, stdout.Kept)
                + "\",\"stderrBase64\":\"" + Convert.ToBase64String(stderr.Retained, 0, stderr.Kept) + "\"}";
            File.WriteAllText(args[0] + @"\command-result.json", result, new UTF8Encoding(false)); return 0;
        } finally {
            try { if (job.Handle != IntPtr.Zero && !job.Closed) { job.Settle(clock, deadline); job.Close(); } }
            finally {
                if (process != null) {
                    if (started && !job.Assigned && !process.HasExited) process.Kill();
                    if (started) Need(process.WaitForExit(Remaining(clock, deadline)), "Command root retained"); process.Dispose();
                }
                foreach (Pump pump in new Pump[] { stdout, stderr }) if (pump != null) { Need(pump.Join(Remaining(clock, deadline)), "Command pump retained"); pump.Release(); }
            }
        }
    }
    static int Main(string[] args) {
        byte[] bytes = null; Package package = null;
        try {
            if (args.Length == 1 && args[0] == "--contract-check") return ContractCheck();
            if (args.Length == 6 && args[0] == @"C:\SuperPiExchange") return WorkspaceCommand(args);
            Need(args.Length == 4 && Uuid.IsMatch(args[0]) && Uuid.IsMatch(args[1]) && args[2] == "--toolchain", "Task arguments");
            Need(String.Equals(Environment.CurrentDirectory, Workspace, StringComparison.OrdinalIgnoreCase)
                && String.Equals(Path.GetFullPath(typeof(TaskWorker).Assembly.Location), Tools + @"\task-runner.exe", StringComparison.OrdinalIgnoreCase), "Isolated runner location");
            bytes = ReadBounded(Tools + @"\task-package.bin", PackageLimit); package = Parse(bytes, args[0], args[1]);
            return Execute(package, bytes, args[3]);
        } catch (Exception error) { Console.Error.WriteLine(error.GetType().Name); return 125; }
        finally { if (package != null) package.Clear(); Clear(bytes); }
    }
}
