// Fixed 512-byte guest report and finite delivery states. No I/O in the codec.
using System;
using System.ComponentModel;
using System.Text;

namespace SuperPiCapacity {
    public enum DataPhase { CreateFailed=1, PrepareFailed=2, FillInvoked=3 }
    public interface IResultSlot {
        bool CloseAttempted { get; }
        void Prepare(Guid task);
        IoResult Write(byte[] bytes);
        IoResult Flush();
        IoResult Close();
    }
    public sealed class DeliveryResult {
        public IoResult Write, Flush, Close;
        public Exception WriteException, FlushException, CloseException;
        public int Mask;
        public int ExitCode { get { return Mask==0 ? 0 : 64|Mask; } }
    }
    public static class CapacityProtocol {
        public const int Bytes=512, SetupFailed=96, SetupCloseFailed=97, InvalidInvocation=98, InternalFailure=99;
        static void U32(byte[] bytes,int offset,uint value) { for(int i=0;i<4;i++) bytes[offset+i]=(byte)(value>>(i*8)); }
        static void U64(byte[] bytes,int offset,ulong value) { for(int i=0;i<8;i++) bytes[offset+i]=(byte)(value>>(i*8)); }
        static void Header(byte[] bytes,string magic,Guid task) {
            if(task==Guid.Empty) throw new ArgumentException("Nonempty task required");
            Encoding.ASCII.GetBytes(magic,0,8,bytes,0); string id=task.ToString("N"); Encoding.ASCII.GetBytes(id,0,32,bytes,8);
        }
        public static byte[] Initial(Guid task) { var bytes=new byte[Bytes]; Header(bytes,"SPCI0001",task); return bytes; }
        public static void CheckInitial(byte[] actual,Guid task) {
            if(actual==null || actual.Length!=Bytes) throw new ArgumentException("Fixed initial slot length");
            byte[] expected=Initial(task);
            try { for(int i=0;i<Bytes;i++) if(actual[i]!=expected[i]) throw new ArgumentException("Initial slot changed"); }
            finally { Array.Clear(expected,0,expected.Length); }
        }
        static void Call(byte[] bytes,int offset,IoResult call) {
            U32(bytes,offset,call.Attempted ? 1u : 0u); U32(bytes,offset+4,call.Success ? 1u : 0u);
            U32(bytes,offset+8,call.Error); U32(bytes,offset+12,call.Requested); U32(bytes,offset+16,call.Transferred);
        }
        static void Failure(byte[] bytes,int offset,Exception error) {
            if(error==null) return;
            U32(bytes,offset,1); U32(bytes,offset+4,unchecked((uint)error.HResult));
            var native=error as Win32Exception;
            if(native!=null) { U32(bytes,offset+8,1); U32(bytes,offset+12,unchecked((uint)native.NativeErrorCode)); }
        }
        public static byte[] Final(Guid task,DataPhase phase,FillResult result) {
            if(result==null || (uint)phase<1 || (uint)phase>3 || result.LastLoopCheckMilliseconds<0) throw new ArgumentException("Fixed report required");
            var bytes=new byte[Bytes]; Header(bytes,"SPCF0001",task);
            U32(bytes,40,(uint)phase); U32(bytes,44,(uint)result.Stop); U32(bytes,48,result.Attempts); U32(bytes,52,result.SuccessfulCalls);
            U32(bytes,56,result.RequestedBytes); U32(bytes,60,result.SuccessfulBytes); U64(bytes,64,(ulong)result.LastLoopCheckMilliseconds);
            Call(bytes,72,result.LastWrite); Call(bytes,92,result.Flush); Call(bytes,112,result.Close);
            Failure(bytes,132,result.OperationException); Failure(bytes,148,result.FlushException); Failure(bytes,164,result.CloseException);
            U32(bytes,180,FillCore.BlockBytes); U32(bytes,184,FillCore.MaximumCalls); U32(bytes,188,FillCore.LogicalDeadlineMs);
            U32(bytes,192,1); U32(bytes,196,phase==DataPhase.CreateFailed ? 0u : 1u);
            return bytes; // Bytes 200..511 reserved zero. No promise of this slot's future final write/flush/close.
        }
        static bool EmptySuccess(IoResult call) { return call.Attempted && call.Success && call.Error==0 && call.Requested==0 && call.Transferred==0; }
        public static DeliveryResult Deliver(IResultSlot slot,byte[] bytes) {
            if(slot==null || bytes==null || bytes.Length!=Bytes || slot.CloseAttempted) throw new ArgumentException("Fixed open result slot required");
            var result=new DeliveryResult();
            try {
                result.Write=slot.Write(bytes); var write=result.Write;
                if(!write.Attempted || !write.Success || write.Error!=0 || write.Requested!=Bytes || write.Transferred>Bytes) result.Mask|=1;
                else if(write.Transferred!=Bytes) result.Mask|=2;
            } catch(Exception error) { result.WriteException=error; result.Mask|=1; }
            try { result.Flush=slot.Flush(); if(!EmptySuccess(result.Flush)) result.Mask|=4; }
            catch(Exception error) { result.FlushException=error; result.Mask|=4; }
            try { result.Close=slot.Close(); if(!EmptySuccess(result.Close)) result.Mask|=8; }
            catch(Exception error) { result.CloseException=error; result.Mask|=8; }
            return result; // All three outcomes retained independently. Unknown raw errors are not invented in the host decoder.
        }
    }
}
