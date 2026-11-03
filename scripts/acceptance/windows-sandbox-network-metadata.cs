// Independent entry: one shared interface collection, no DNS, TCP, health probe or VM path.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

internal static class NetworkMetadataEntry {
    internal sealed class Receipt {
        public string protocol = "super-pi-wsb-network-metadata-v1", taskId, errorType;
        public int pid;
        public int? hresult, nativeErrorCode;
        public SandboxNetworkProbe.InterfaceTrace trace = new SandboxNetworkProbe.InterfaceTrace();
    }
    internal static Receipt Capture(string taskId, Action<SandboxNetworkProbe.InterfaceTrace> collect) {
        var receipt = new Receipt { taskId = taskId };
        using (Process process = Process.GetCurrentProcess()) receipt.pid = process.Id;
        try { collect(receipt.trace); }
        catch (Exception error) {
            receipt.errorType = error.GetType().Name; receipt.hresult = error.HResult;
            Win32Exception native = error as Win32Exception;
            if (native != null) receipt.nativeErrorCode = native.NativeErrorCode;
        }
        return receipt;
    }
    static int Main(string[] args) {
        Guid task;
        if (args.Length != 1 || !Guid.TryParseExact(args[0], "D", out task) || task.ToString("D") != args[0]) return 125;
        using (Process process = Process.GetCurrentProcess()) {
            if (!process.MainModule.FileName.Equals(Path.Combine(Environment.CurrentDirectory, "network-metadata.exe"), StringComparison.OrdinalIgnoreCase)) return 125;
        }
        Console.OutputEncoding = new UTF8Encoding(false);
        Receipt receipt = Capture(args[0], trace => SandboxNetworkProbe.Interfaces(trace));
        string json = new JavaScriptSerializer().Serialize(receipt);
        if (Encoding.UTF8.GetByteCount(json) + 2 > 8192) return 126;
        Console.WriteLine(json);
        return 0; // A complete diagnostic receipt is not a passing network acceptance result.
    }
}
