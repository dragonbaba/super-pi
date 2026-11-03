// Fixed capacity acceptance algorithm. No filesystem, P/Invoke, process entry or production integration.
using System;

namespace SuperPiCapacity {
    public enum StopReason { None, DiskFull, WriteError, ShortWrite, AttemptLimit, Deadline, InvalidObservation, Exception }
    public struct IoResult {
        public bool Attempted, Success;
        public uint Error, Requested, Transferred;
        public static IoResult Result(bool success, uint error, uint requested, uint transferred) {
            return new IoResult { Attempted=true, Success=success, Error=error, Requested=requested, Transferred=transferred };
        }
    }
    public interface IFillIo {
        long ElapsedMilliseconds { get; }
        IoResult Write(byte[] buffer);
        IoResult Flush();
        IoResult Close();
    }
    public sealed class FillResult {
        public StopReason Stop;
        public uint Attempts, SuccessfulCalls, RequestedBytes, SuccessfulBytes;
        public IoResult LastWrite, Flush, Close;
        public Exception OperationException, FlushException, CloseException;
        public long LastLoopCheckMilliseconds;
        public int PayloadBuffers, AllocatedBytes;
        // This is candidate write evidence, never host acceptance, result-channel delivery or VM closure.
        public bool HasDiskFullWriteEvidence {
            get {
                return Stop==StopReason.DiskFull && Attempts>1 && SuccessfulCalls>0 && SuccessfulBytes>0
                    && LastWrite.Attempted && !LastWrite.Success && (LastWrite.Error==112 || LastWrite.Error==39)
                    && OperationException==null && FlushException==null && CloseException==null
                    && Flush.Attempted && Flush.Success && Flush.Error==0 && Close.Attempted && Close.Success && Close.Error==0;
            }
        }
    }
    public static class FillCore {
        public const int BlockBytes=1048576, MaximumCalls=144, LogicalDeadlineMs=20000;
        public static FillResult Run(IFillIo io) {
            if(io==null) throw new ArgumentNullException("io");
            var result=new FillResult();
            byte[] block=null;
            try {
                block=new byte[BlockBytes]; result.PayloadBuffers=1; result.AllocatedBytes=block.Length;
                for(int i=0;i<block.Length;i++) block[i]=0x5A;
                while(result.Attempts<MaximumCalls) {
                    long elapsed=io.ElapsedMilliseconds;
                    if(elapsed<0) { result.Stop=StopReason.InvalidObservation; break; }
                    result.LastLoopCheckMilliseconds=elapsed;
                    if(elapsed>=LogicalDeadlineMs) { result.Stop=StopReason.Deadline; break; }
                    result.Attempts++; result.RequestedBytes+=BlockBytes;
                    IoResult call=io.Write(block); result.LastWrite=call;
                    if(!call.Attempted || call.Requested!=BlockBytes || call.Transferred>BlockBytes || call.Success && call.Error!=0) {
                        result.Stop=StopReason.InvalidObservation; break;
                    }
                    if(!call.Success) {
                        result.Stop=call.Error==112 || call.Error==39 ? StopReason.DiskFull : StopReason.WriteError; break;
                    }
                    if(call.Transferred!=BlockBytes) { result.Stop=StopReason.ShortWrite; break; }
                    result.SuccessfulCalls++; result.SuccessfulBytes+=call.Transferred;
                }
                if(result.Stop==StopReason.None) result.Stop=StopReason.AttemptLimit;
            } catch(Exception error) { result.Stop=StopReason.Exception; result.OperationException=error; }
            finally {
                try { result.Flush=io.Flush(); } catch(Exception error) { result.FlushException=error; }
                try { result.Close=io.Close(); } catch(Exception error) { result.CloseException=error; }
                if(block!=null) Array.Clear(block,0,block.Length); // Result retains no payload buffer; real I/O must not retain this argument.
            }
            return result; // A deadline only stops the next call; it cannot settle a blocked synchronous operation.
        }
    }
}
