// New one-package profile. Reuses NativeDisk's original seven once-only slots.
using System;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.RegularExpressions;

namespace SuperPiVolume {
    public sealed partial class NativeDisk {
        bool taskInputsInstalled,taskResultAttempted;
        ManifestCapture taskResult;
        public static int TaskResultNativeOperations { get { return taskResultNativeOperations; } }
        public bool TaskResultCaptured { get { return taskResult!=null && taskResult.Captured; } }
        public string TaskResultSourceId { get { return taskResult==null ? null : taskResult.SourceId; } }
        public string TaskResultCarrierId { get { return taskResult==null ? null : taskResult.CarrierId; } }
        public string TaskResultSha256 { get { return taskResult==null ? null : taskResult.Sha256; } }
        public int TaskResultBytes { get { return taskResult==null ? 0 : taskResult.Bytes; } }
        public int TaskResultOpened { get { return taskResult==null ? 0 : taskResult.Handles.Opened; } }
        public int TaskResultClosed { get { return taskResult==null ? 0 : taskResult.Handles.Closed; } }
        public int TaskResultPeak { get { return taskResult==null ? 0 : taskResult.Handles.Peak; } }
        public int?[] TaskResultCloseErrors { get { return taskResult==null ? new int?[3] : taskResult.Handles.Errors; } }
        public string[] TaskResultRetainedHandles { get { return taskResult==null ? new string[3] : taskResult.Handles.Retained; } }
        public Exception TaskResultOperationException { get { return taskResult==null ? null : taskResult.OperationException; } }
        public Exception TaskResultCloseException { get { return taskResult==null ? null : taskResult.CloseException; } }
        public ManifestIo? TaskResultReadResult { get { return taskResult==null ? null : taskResult.ReadResult; } }
        public ManifestIo? TaskResultWriteResult { get { return taskResult==null ? null : taskResult.WriteResult; } }
        public ManifestIo? TaskResultFlushResult { get { return taskResult==null ? null : taskResult.FlushResult; } }
        public int TaskResultAllocatedBytes { get { return taskResult==null ? 0 : taskResult.AllocatedBytes; } }
        public int TaskResultClearedBytes { get { return taskResult==null ? 0 : taskResult.ClearedBytes; } }
        public bool TaskResultRetainsOperations { get { return taskResult!=null && taskResult.RetainsOperations; } }
        public void CaptureTaskResult(string volume,string exchangeId) {
            Need(taskInputsInstalled && !taskResultAttempted && !CloseUnknown,"One installed task result capture required");
            taskResultAttempted=true;
            var binding=new ManifestBinding(Root,RootId,volume,exchangeId,true);
            taskResult=new ManifestCapture(binding,new NativeManifestOps(this,binding));
            try { taskResult.Run(); }
            finally { if(taskResult.Handles.Unknown) CloseUnknown=true; }
        }
        public void InstallTaskInputs(string volume,string exchangeId,string packageSha256,string runnerSha256,
            string taskId,string snapshotId) {
            Need(!inputAttempted && !CloseUnknown
                && Regex.IsMatch(packageSha256??"", @"\A[0-9a-f]{64}\z")
                && Regex.IsMatch(runnerSha256??"", @"\A[0-9a-f]{64}\z")
                && Regex.IsMatch(taskId??"", @"\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z")
                && Regex.IsMatch(snapshotId??"", @"\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z"),
                "One original task installation required");
            // Shared with InstallInputs. No switch or retry after either attempt.
            inputAttempted=true;
            byte[] package=null,runner=null;
            Exception operation=null,close=null;
            string exchange=volume+"exchange",workspace=exchange+@"\workspace",tools=exchange+@"\tools";
            try {
                ProbeVolumeIdentity(volume,exchangeId);
                ProbeInvariant(Fingerprint(Root,true)==RootId,"Task carrier root changed");
                InputSourceCarrierId=ReadInput(0,"task-package.bin",49168,packageSha256,ref package);
                Need(package.Length>=100 && Encoding.ASCII.GetString(package,0,8)=="SPTASK01"
                    && BitConverter.IsLittleEndian && BitConverter.ToUInt32(package,8)==package.Length
                    && BitConverter.ToUInt32(package,12)>=84 && BitConverter.ToUInt32(package,12)<=32768
                    && 16L+BitConverter.ToUInt32(package,12)<=package.Length
                    && Encoding.ASCII.GetString(package,16,36)==taskId
                    && Encoding.ASCII.GetString(package,52,36)==snapshotId,"Task package association/layout");
                InputToolCarrierId=ReadInput(1,"task-runner.exe",65536,runnerSha256,ref runner);
                OpenInput(2,exchange,0x80000000,1,3,0x02200000); long length;
                ProbeInvariant(InspectInput(2,exchange,exchangeId,true,0,1,out length)==exchangeId,"Task exchange changed");
                InputWorkspaceId=CreateInputDirectory(3,workspace,exchangeId);
                InputToolsId=CreateInputDirectory(4,tools,exchangeId);
                InputSourceId=WriteInput(5,tools+@"\task-package.bin",InputToolsId,package);
                InputToolId=WriteInput(6,tools+@"\task-runner.exe",InputToolsId,runner);
                ProbeInvariant(InspectInput(4,tools,exchangeId,true,0,1,out length)==InputToolsId
                    && InspectInput(3,workspace,exchangeId,true,0,1,out length)==InputWorkspaceId
                    && InspectInput(2,exchange,exchangeId,true,0,1,out length)==exchangeId,"Task directories changed");
                ProbeVolumeIdentity(volume,exchangeId);
            } catch(Exception error) { operation=error; InputOperationException=error; }
            finally {
                for(int slot=6;slot>=0;slot--) try { CloseInput(slot); } catch(Exception error) { if(close==null) close=error; }
                if(InputCloseException==null) InputCloseException=close;
                if(package!=null) { Array.Clear(package,0,package.Length); InputCleared+=package.Length; }
                if(runner!=null) { Array.Clear(runner,0,runner.Length); InputCleared+=runner.Length; }
            }
            if(operation!=null) ExceptionDispatchInfo.Capture(operation).Throw();
            if(close!=null) ExceptionDispatchInfo.Capture(close).Throw();
            InputsInstalled=true; taskInputsInstalled=true;
        }
    }
}
