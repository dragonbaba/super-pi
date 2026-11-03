using System;
using SuperPiCapacity;

public static class CapacityCoreChecks {
    sealed class Fake : IFillIo {
        public int Writes, Flushes, Closes; public byte[] Seen;
        public string Mode; public uint Error=112;
        public readonly Exception WriteException=new Exception("write-primary"), FlushException=new Exception("flush-secondary"), CloseException=new Exception("close-third");
        public long ElapsedMilliseconds { get { return Mode=="deadline" && Writes==1 ? 20000 : Mode=="negative-clock" ? -1 : 0; } }
        public IoResult Write(byte[] buffer) {
            Need(buffer.Length==FillCore.BlockBytes && buffer[0]==0x5A && buffer[buffer.Length-1]==0x5A,"fixed nonzero block");
            Need(Seen==null || Object.ReferenceEquals(Seen,buffer),"block reused"); Seen=buffer; Writes++;
            if(Mode=="triple-exception") throw WriteException;
            if(Mode=="invalid") return IoResult.Result(true,0,1,1);
            if(Mode=="short") return IoResult.Result(true,0,FillCore.BlockBytes,7);
            if(Mode=="limit" || Mode=="deadline" || Writes<3 && Mode!="first-failure") return IoResult.Result(true,0,FillCore.BlockBytes,FillCore.BlockBytes);
            return IoResult.Result(false,Error,FillCore.BlockBytes,Mode=="partial-failure" ? 17u : 0u);
        }
        public IoResult Flush() { Flushes++; if(Mode=="triple-exception") throw FlushException; return IoResult.Result(Mode!="dual-failure",Mode=="dual-failure" ? 5u : 0u,0,0); }
        public IoResult Close() { Closes++; if(Mode=="triple-exception") throw CloseException; return IoResult.Result(Mode!="dual-failure",Mode=="dual-failure" ? 6u : 0u,0,0); }
    }
    static void Need(bool value,string message) { if(!value) throw new Exception(message); }
    static FillResult Check(Fake io,StopReason stop,bool full) {
        FillResult result=FillCore.Run(io);
        Need(result.Stop==stop && result.HasDiskFullWriteEvidence==full,"classification: "+io.Mode+"/"+io.Error);
        Need(io.Flushes==1 && io.Closes==1,"independent cleanup attempts");
        Need(result.Attempts<=144 && result.RequestedBytes==result.Attempts*1048576u && result.RequestedBytes<=150994944,"request ceiling");
        Need(result.PayloadBuffers==1 && result.AllocatedBytes==1048576,"allocation counters");
        if(io.Seen!=null) for(int i=0;i<io.Seen.Length;i++) Need(io.Seen[i]==0,"payload cleared");
        return result;
    }
    public static string Run() {
        int cases=0;
        foreach(uint code in new uint[]{112,39}) { var io=new Fake{Error=code}; var r=Check(io,StopReason.DiskFull,true);
            Need(r.Attempts==3 && r.SuccessfulCalls==2 && r.SuccessfulBytes==2097152 && r.LastWrite.Error==code,"disk full raw facts"); cases++; }
        foreach(uint code in new uint[]{2,3,5,1816,0}) { var r=Check(new Fake{Error=code},StopReason.WriteError,false); Need(r.LastWrite.Error==code,"other raw error retained"); cases++; }
        var first=Check(new Fake{Mode="first-failure"},StopReason.DiskFull,false); Need(first.SuccessfulBytes==0,"no initial writable evidence"); cases++;
        var partial=Check(new Fake{Mode="partial-failure"},StopReason.DiskFull,true); Need(partial.LastWrite.Transferred==17 && partial.SuccessfulBytes==2097152,"partial failure not added to successful bytes"); cases++;
        var shortWrite=Check(new Fake{Mode="short"},StopReason.ShortWrite,false); Need(shortWrite.Attempts==1 && shortWrite.LastWrite.Success && shortWrite.LastWrite.Transferred==7,"short write stops"); cases++;
        var limit=Check(new Fake{Mode="limit"},StopReason.AttemptLimit,false); Need(limit.Attempts==144 && limit.SuccessfulBytes==150994944,"no 145th call"); cases++;
        var deadline=Check(new Fake{Mode="deadline"},StopReason.Deadline,false); Need(deadline.Attempts==1,"deadline stops next call"); cases++;
        Check(new Fake{Mode="negative-clock"},StopReason.InvalidObservation,false); cases++;
        Check(new Fake{Mode="invalid"},StopReason.InvalidObservation,false); cases++;
        var dual=Check(new Fake{Mode="dual-failure"},StopReason.DiskFull,false); Need(dual.LastWrite.Error==112 && dual.Flush.Error==5 && dual.Close.Error==6,"separate raw errors"); cases++;
        var tripleIo=new Fake{Mode="triple-exception"}; var triple=Check(tripleIo,StopReason.Exception,false);
        Need(Object.ReferenceEquals(triple.OperationException,tripleIo.WriteException) && Object.ReferenceEquals(triple.FlushException,tripleIo.FlushException)
            && Object.ReferenceEquals(triple.CloseException,tripleIo.CloseException),"exception identities retained independently"); cases++;
        foreach(var field in typeof(FillResult).GetFields()) Need(field.FieldType!=typeof(byte[]),"no result payload reference");
        return "{\"cases\":"+cases+",\"realStorageOperations\":0,\"payloadBuffersPerRun\":1,\"payloadBytesPerRun\":1048576,\"maximumRequests\":144,\"maximumRequestedBytes\":150994944,\"buffersCleared\":true}";
    }
}
