// Optional same-manager batch capture; no helper command or runtime read lease.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace SuperPiVolume {
    internal sealed class BatchRequest {
        readonly string[] paths;
        public int Count { get { return paths.Length; } }
        public string this[int index] { get { return paths[index]; } }
        BatchRequest(string[] paths) { this.paths=paths; }
        internal static void Need(bool value,string message) { if(!value) throw new InvalidOperationException(message); }
        internal static void Path(string path) {
            Need(path!=null && path.Length>0 && path.Length<=120,"Batch path length");
            string[] parts=path.Split('/'); Need(parts.Length<=4,"Batch path depth");
            foreach(string part in parts) Need(Regex.IsMatch(part,@"\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z")
                && !part.EndsWith(".") && !Regex.IsMatch(part,@"\A(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\z)",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant),"Batch path component");
        }
        public static BatchRequest Parse(byte[] bytes,string task,string manifestSha) {
            Need(bytes!=null && bytes.Length>0 && bytes.Length<=4096,"Batch request bytes");
            Need(task!=null && Regex.IsMatch(task,@"\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z")
                && manifestSha!=null && Regex.IsMatch(manifestSha,@"\A[0-9a-f]{64}\z"),"Batch expected request binding");
            string text=new UTF8Encoding(false,true).GetString(bytes);
            string prefix="{\"protocol\":\"super-pi-candidate-read-request-v1\",\"taskId\":\""+task+"\",\"manifestSha256\":\""+manifestSha+"\",\"paths\":[";
            Need(text.StartsWith(prefix,StringComparison.Ordinal) && text.EndsWith("]}",StringComparison.Ordinal),"Batch canonical request fields/binding");
            int cursor=prefix.Length,end=text.Length-2,count=0; var selected=new string[16];
            while(cursor<end) {
                Need(count<16 && text[cursor]=='"',"Batch request entries");
                int quote=text.IndexOf('"',cursor+1); Need(quote>cursor+1 && quote<end && quote-cursor-1<=120,"Batch request path token");
                string path=text.Substring(cursor+1,quote-cursor-1); Path(path);
                for(int i=0;i<count;i++) Need(!String.Equals(path,selected[i],StringComparison.OrdinalIgnoreCase)
                    && !path.StartsWith(selected[i]+"/",StringComparison.OrdinalIgnoreCase)
                    && !selected[i].StartsWith(path+"/",StringComparison.OrdinalIgnoreCase),"Batch duplicate/ancestor target");
                selected[count++]=path; cursor=quote+1;
                if(cursor<end) { Need(text[cursor]==',' && cursor+1<end,"Batch request separator"); cursor++; }
            }
            Need(cursor==end,"Batch request trailing data");
            var exact=new string[count]; Array.Copy(selected,exact,count); return new BatchRequest(exact);
        }
    }
    internal sealed class BatchBinding {
        public readonly ManifestBinding Manifest;
        public readonly string TaskId,ManifestSha,ManifestSourceId,ManifestCarrierId,Request,Carrier,Payload;
        public BatchBinding(Guid task,ManifestCapture captured,string root,string rootId,string volume,string exchangeId) {
            BatchRequest.Need(task!=Guid.Empty && captured!=null && captured.Captured && !captured.Handles.Unknown,"Completed manifest capture required");
            Manifest=captured.Binding;
            ManifestCapture.Identity(Manifest.Root==root && Manifest.RootId==rootId && Manifest.Volume==volume && Manifest.ExchangeId==exchangeId,"Batch must use captured manifest binding");
            TaskId=task.ToString("D"); ManifestSha=captured.Sha256; ManifestSourceId=captured.SourceId; ManifestCarrierId=captured.CarrierId;
            Request=root+@"\candidate-request.json"; Carrier=root+@"\candidate-payload.bin"; Payload=Manifest.Exchange+@"\payload";
        }
    }
    internal struct BatchOpen {
        public ManifestOpen File;
        public bool Guid,Directory;
    }
    internal interface IBatchOps {
        void VerifyBinding();
        IntPtr Open(BatchOpen specification);
        ManifestMeta Inspect(IntPtr handle,bool guid,bool directory);
        ManifestIo Read(IntPtr handle,byte[] bytes);
        ManifestIo Write(IntPtr handle,byte[] bytes);
        ManifestIo Flush(IntPtr handle);
        int? Close(IntPtr handle);
    }
    internal sealed class BatchHandles {
        readonly IntPtr[] handles=new IntPtr[7]; readonly bool[] attempted=new bool[7]; readonly int?[] errors=new int?[7];
        Func<IntPtr,int?> close;
        public int Opened { get; private set; } public int Closed { get; private set; } public int Peak { get; private set; }
        public bool Unknown { get; private set; } public bool RetainsClose { get { return close!=null; } }
        public BatchHandles(Func<IntPtr,int?> close) { if(close==null) throw new ArgumentNullException("close"); this.close=close; }
        public IntPtr this[int slot] { get { return handles[slot]; } }
        public void CanOpen(int slot) {
            if(slot<0 || slot>=7 || handles[slot]!=IntPtr.Zero || Unknown || close==null || Opened>=98)
                throw new InvalidOperationException("Batch handle admission");
        }
        public void Adopt(int slot,IntPtr handle) {
            CanOpen(slot); if(handle==IntPtr.Zero || handle==new IntPtr(-1)) throw new ArgumentException("Batch valid handle required");
            handles[slot]=handle; attempted[slot]=false; errors[slot]=null; Opened++; Peak=Math.Max(Peak,Opened-Closed);
        }
        public void CloseOnce(int slot) {
            if(handles[slot]==IntPtr.Zero || attempted[slot]) return; attempted[slot]=true;
            try {
                int? error=close(handles[slot]);
                if(error.HasValue) { errors[slot]=error; throw new Win32Exception(error.Value,"Batch handle close unknown"); }
                handles[slot]=IntPtr.Zero; Closed++;
            } catch { Unknown=true; throw; }
        }
        public Exception CloseRange(int first,int last) {
            Exception failure=null;
            for(int i=last;i>=first;i--) try { CloseOnce(i); } catch(Exception error) { if(failure==null) failure=error; }
            return failure;
        }
        public void ReleaseCallback() {
            if(Unknown || Opened!=Closed) throw new InvalidOperationException("Batch unresolved handles"); close=null;
        }
        public int?[] Errors { get { return (int?[])errors.Clone(); } }
        public string[] Retained { get { var copy=new string[7]; for(int i=0;i<7;i++) if(handles[i]!=IntPtr.Zero) copy[i]=handles[i].ToInt64().ToString("X"); return copy; } }
    }
    public struct CandidateBatchItem {
        public readonly string SourceId,Sha256; public readonly int Bytes;
        public CandidateBatchItem(string id,int bytes,string sha) { SourceId=id; Bytes=bytes; Sha256=sha; }
    }
    public struct CandidateBatchIo {
        public readonly int Index,RequestedBytes; public readonly ManifestIo? Read,Write;
        public CandidateBatchIo(int index,int requested,ManifestIo? read,ManifestIo? write) { Index=index; RequestedBytes=requested; Read=read; Write=write; }
    }
    internal sealed class BatchCapture {
        readonly BatchBinding binding; IBatchOps ops; CandidateBatchItem[] items; readonly CandidateBatchIo[] facts=new CandidateBatchIo[16];
        public readonly BatchHandles Handles;
        public bool Attempted { get; private set; } public bool Captured { get; private set; }
        public string RequestId { get; private set; } public string CarrierId { get; private set; }
        public string RequestSha256 { get; private set; } public string Sha256 { get; private set; }
        public int Bytes { get; private set; } public int FactCount { get; private set; }
        public int AllocatedBytes { get; private set; } public int ClearedBytes { get; private set; } public int RetainedBufferBytes { get; private set; }
        public ManifestIo? RequestRead { get; private set; } public ManifestIo? FlushResult { get; private set; }
        public Exception OperationException { get; private set; } public Exception CloseException { get; private set; }
        public bool RetainsOperations { get { return ops!=null || Handles.RetainsClose; } }
        public CandidateBatchItem[] Items { get { BatchRequest.Need(Captured,"No partial batch success"); return (CandidateBatchItem[])items.Clone(); } }
        public CandidateBatchIo[] Facts { get { var copy=new CandidateBatchIo[FactCount]; Array.Copy(facts,copy,FactCount); return copy; } }
        public BatchCapture(BatchBinding binding,IBatchOps ops) {
            if(binding==null || ops==null) throw new ArgumentNullException("batch capture");
            this.binding=binding; this.ops=ops; Handles=new BatchHandles(ops.Close);
        }
        static string Hash(byte[] bytes) { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
        static void CheckIo(ManifestIo value,string operation) {
            if(!value.Success) { if(value.Error.HasValue) throw new Win32Exception(value.Error.Value,operation); throw new InvalidOperationException(operation+" failed without native error"); }
            BatchRequest.Need(!value.Error.HasValue,operation+" contradictory native error");
        }
        byte[] Allocate(int length) { var bytes=new byte[length]; AllocatedBytes+=length; RetainedBufferBytes+=length; return bytes; }
        void Clear(ref byte[] bytes) { if(bytes==null) return; Array.Clear(bytes,0,bytes.Length); ClearedBytes+=bytes.Length; RetainedBufferBytes-=bytes.Length; bytes=null; }
        void Close(int first,int last) { Exception error=Handles.CloseRange(first,last); if(CloseException==null) CloseException=error; }
        void Fail(Exception error) { if(OperationException==null && !Object.ReferenceEquals(error,CloseException)) OperationException=error; }
        BatchOpen Specification(string path,bool guid,bool directory,bool writer) {
            return new BatchOpen { Guid=guid,Directory=directory,File=new ManifestOpen { Path=path,Access=writer ? 0x40000080u : 0x80000000u,
                Share=directory ? 1u : 0u,Creation=writer ? 1u : 3u,Flags=writer ? 0x80200000u : directory ? 0x02200000u : 0x00200000u } };
        }
        void Open(int slot,BatchOpen specification) { Handles.CanOpen(slot); IntPtr handle=ops.Open(specification); Handles.Adopt(slot,handle); }
        internal static void Shape(ManifestMeta value,string expected,string domain,bool directory,int maximum,string expectedId) {
            ManifestCapture.Identity(value.Consistent && (value.Attributes&0x4E00)==0 && ((value.Attributes&0x10)!=0)==directory
                && value.Directory==directory && !value.DeletePending,"Batch ordinary type/metadata");
            ManifestCapture.Identity(String.Equals(value.Path,expected,StringComparison.OrdinalIgnoreCase) && ManifestCapture.FileId(value.Id)
                && value.Id.Substring(0,9)==domain.Substring(0,9),"Batch final path/volume identity");
            if(expectedId!=null) ManifestCapture.Identity(value.Id==expectedId,"Batch bound identity changed");
            if(!directory) ManifestCapture.Identity(value.Links==1 && value.Id!=domain && value.Length>=0 && value.Length<=maximum && value.Allocation>=0,"Batch link/length");
        }
        ManifestMeta Inspect(int slot,BatchOpen spec,int maximum,string expectedId) {
            var value=ops.Inspect(Handles[slot],spec.Guid,spec.Directory);
            Shape(value,spec.Guid ? spec.File.Path : @"\\?\"+spec.File.Path,spec.Guid ? binding.Manifest.ExchangeId : binding.Manifest.RootId,spec.Directory,maximum,expectedId);
            return value;
        }
        BatchRequest ReadRequest() {
            byte[] bytes=null; BatchRequest result=null;
            try {
                ops.VerifyBinding(); var spec=Specification(binding.Request,false,false,false); Open(0,spec);
                ManifestMeta before=Inspect(0,spec,4096,null); RequestId=before.Id;
                ManifestCapture.Identity(RequestId!=binding.ManifestCarrierId,"Request aliases captured manifest carrier");
                BatchRequest.Need(before.Length>0,"Empty batch request"); bytes=Allocate((int)before.Length);
                RequestRead=ops.Read(Handles[0],bytes); CheckIo(RequestRead.Value,"Batch request read");
                BatchRequest.Need(RequestRead.Value.Count==(uint)bytes.Length,"Short batch request read");
                var after=Inspect(0,spec,4096,RequestId); ManifestCapture.StableSource(before,after);
                result=BatchRequest.Parse(bytes,binding.TaskId,binding.ManifestSha); RequestSha256=Hash(bytes);
            } catch(Exception error) { Fail(error); }
            finally { Close(0,0); Clear(ref bytes); }
            ManifestCapture.ThrowFirst(OperationException,CloseException); return result;
        }
        void ReadItem(int index,string relative,SHA256 totalHash) {
            byte[] bytes=null; string[] parts=relative.Split('/'); int last=parts.Length+2;
            var specifications=new BatchOpen[last]; var before=new ManifestMeta[last]; int length=0; ManifestIo? read=null,write=null;
            try {
                ops.VerifyBinding();
                string current=binding.Manifest.Exchange;
                for(int slot=1;slot<=last;slot++) {
                    if(slot==2) current=binding.Payload; else if(slot>2) current+=@"\"+parts[slot-3];
                    bool directory=slot<last; var spec=Specification(current,true,directory,false); specifications[slot-1]=spec; Open(slot,spec);
                    before[slot-1]=Inspect(slot,spec,4096,slot==1 ? binding.Manifest.ExchangeId : null);
                    for(int prior=0;prior<slot-1;prior++) ManifestCapture.Identity(before[slot-1].Id!=before[prior].Id,"Batch component identity repeated");
                }
                ManifestMeta source=before[last-1];
                ManifestCapture.Identity(source.Id!=binding.ManifestSourceId,"Candidate aliases captured manifest source");
                for(int previous=0;previous<index;previous++) ManifestCapture.Identity(source.Id!=items[previous].SourceId,"Batch source identity repeated");
                length=(int)source.Length; BatchRequest.Need(Bytes+length<=16384,"Batch total byte budget");
                facts[index]=new CandidateBatchIo(index,length,null,null); FactCount=index+1; bytes=Allocate(length);
                if(length>0) {
                    read=ops.Read(Handles[last],bytes); facts[index]=new CandidateBatchIo(index,length,read,null); CheckIo(read.Value,"Batch source read");
                    BatchRequest.Need(read.Value.Count==(uint)length,"Short batch source read");
                }
                for(int slot=last;slot>=1;slot--) {
                    var after=Inspect(slot,specifications[slot-1],4096,before[slot-1].Id); ManifestCapture.StableSource(before[slot-1],after);
                }
                string sha=Hash(bytes);
                if(length>0) {
                    write=ops.Write(Handles[0],bytes); facts[index]=new CandidateBatchIo(index,length,read,write); CheckIo(write.Value,"Batch carrier write");
                    BatchRequest.Need(write.Value.Count==(uint)length,"Short batch carrier write");
                    totalHash.TransformBlock(bytes,0,length,bytes,0);
                }
                Bytes+=length; items[index]=new CandidateBatchItem(source.Id,length,sha);
            } catch(Exception error) { Fail(error); }
            finally { Close(1,6); Clear(ref bytes); }
            ManifestCapture.ThrowFirst(OperationException,CloseException);
        }
        public void Run() {
            BatchRequest.Need(!Attempted,"No batch capture retry"); Attempted=true;
            try {
                var request=ReadRequest(); items=new CandidateBatchItem[request.Count]; ops.VerifyBinding();
                var spec=Specification(binding.Carrier,false,false,true); Open(0,spec);
                var initial=Inspect(0,spec,16384,null); CarrierId=initial.Id;
                ManifestCapture.Identity(initial.Length==0 && CarrierId!=RequestId && CarrierId!=binding.ManifestCarrierId,"New batch carrier identity/length");
                using(var hash=SHA256.Create()) {
                    for(int index=0;index<request.Count;index++) ReadItem(index,request[index],hash);
                    hash.TransformFinalBlock(new byte[0],0,0); Sha256=BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();
                }
                FlushResult=ops.Flush(Handles[0]); CheckIo(FlushResult.Value,"Batch carrier flush");
                var final=Inspect(0,spec,16384,CarrierId); ManifestCapture.Identity(final.Length==Bytes,"Batch carrier final length");
            } catch(Exception error) { Fail(error); }
            finally { Close(0,6); }
            try {
                ManifestCapture.ThrowFirst(OperationException,CloseException); ops.VerifyBinding();
                BatchRequest.Need(!Handles.Unknown && Handles.Opened==Handles.Closed && Handles.Peak<=7 && RetainedBufferBytes==0,"Batch capture not closed");
                Captured=true;
            } catch(Exception error) { Fail(error); throw; }
            finally { if(!Captured) items=null; if(!Handles.Unknown && Handles.Opened==Handles.Closed) { Handles.ReleaseCallback(); ops=null; } }
        }
    }
    public sealed partial class NativeDisk {
        BatchCapture candidateBatch; bool candidateBatchAttempted; static int candidateBatchNativeOperations;
        public static int CandidateBatchNativeOperations { get { return candidateBatchNativeOperations; } }
        public bool CandidateBatchCaptured { get { return candidateBatch!=null && candidateBatch.Captured; } }
        public string CandidateBatchRequestId { get { return candidateBatch==null ? null : candidateBatch.RequestId; } }
        public string CandidateBatchCarrierId { get { return candidateBatch==null ? null : candidateBatch.CarrierId; } }
        public string CandidateBatchRequestSha256 { get { return candidateBatch==null ? null : candidateBatch.RequestSha256; } }
        public string CandidateBatchSha256 { get { return candidateBatch==null ? null : candidateBatch.Sha256; } }
        public int CandidateBatchBytes { get { return candidateBatch==null ? 0 : candidateBatch.Bytes; } }
        public int CandidateBatchOpened { get { return candidateBatch==null ? 0 : candidateBatch.Handles.Opened; } }
        public int CandidateBatchClosed { get { return candidateBatch==null ? 0 : candidateBatch.Handles.Closed; } }
        public int CandidateBatchPeak { get { return candidateBatch==null ? 0 : candidateBatch.Handles.Peak; } }
        public int?[] CandidateBatchCloseErrors { get { return candidateBatch==null ? new int?[7] : candidateBatch.Handles.Errors; } }
        public string[] CandidateBatchRetainedHandles { get { return candidateBatch==null ? new string[7] : candidateBatch.Handles.Retained; } }
        public CandidateBatchItem[] CandidateBatchItems { get { BatchRequest.Need(candidateBatch!=null,"Batch not attempted"); return candidateBatch.Items; } }
        public CandidateBatchIo[] CandidateBatchIoFacts { get { return candidateBatch==null ? new CandidateBatchIo[0] : candidateBatch.Facts; } }
        public ManifestIo? CandidateBatchRequestRead { get { return candidateBatch==null ? null : candidateBatch.RequestRead; } }
        public ManifestIo? CandidateBatchFlushResult { get { return candidateBatch==null ? null : candidateBatch.FlushResult; } }
        public Exception CandidateBatchOperationException { get { return candidateBatch==null ? null : candidateBatch.OperationException; } }
        public Exception CandidateBatchCloseException { get { return candidateBatch==null ? null : candidateBatch.CloseException; } }
        public int CandidateBatchAllocatedBytes { get { return candidateBatch==null ? 0 : candidateBatch.AllocatedBytes; } }
        public int CandidateBatchClearedBytes { get { return candidateBatch==null ? 0 : candidateBatch.ClearedBytes; } }
        public bool CandidateBatchRetainsOperations { get { return candidateBatch!=null && candidateBatch.RetainsOperations; } }
        sealed class NativeBatchOps : IBatchOps {
            readonly NativeDisk owner; readonly BatchBinding binding;
            public NativeBatchOps(NativeDisk owner,BatchBinding binding) { this.owner=owner; this.binding=binding; }
            public void VerifyBinding() {
                candidateBatchNativeOperations++; owner.ProbeVolumeIdentity(binding.Manifest.Volume,binding.Manifest.ExchangeId);
                ProbeInvariant(owner.Fingerprint(owner.Root,true)==owner.RootId && !owner.CloseUnknown,"Batch private root changed");
            }
            public IntPtr Open(BatchOpen spec) {
                candidateBatchNativeOperations++; var value=spec.File;
                IntPtr handle=CreateFile(value.Path,value.Access,value.Share,IntPtr.Zero,value.Creation,value.Flags,IntPtr.Zero);
                if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); return handle;
            }
            public ManifestMeta Inspect(IntPtr handle,bool guid,bool directory) { candidateBatchNativeOperations++; return CaptureMetadata(handle,guid,directory); }
            public ManifestIo Read(IntPtr handle,byte[] bytes) {
                candidateBatchNativeOperations++; uint count; bool ok=ReadFile(handle,bytes,(uint)bytes.Length,out count,IntPtr.Zero);
                int? error=ok ? (int?)null : Marshal.GetLastWin32Error(); return new ManifestIo(ok,error,count);
            }
            public ManifestIo Write(IntPtr handle,byte[] bytes) {
                candidateBatchNativeOperations++; uint count; bool ok=WriteFile(handle,bytes,(uint)bytes.Length,out count,IntPtr.Zero);
                int? error=ok ? (int?)null : Marshal.GetLastWin32Error(); return new ManifestIo(ok,error,count);
            }
            public ManifestIo Flush(IntPtr handle) {
                candidateBatchNativeOperations++; bool ok=FlushFileBuffers(handle); int? error=ok ? (int?)null : Marshal.GetLastWin32Error();
                return new ManifestIo(ok,error,0);
            }
            public int? Close(IntPtr handle) { candidateBatchNativeOperations++; if(CloseHandle(handle)) return null; return Marshal.GetLastWin32Error(); }
        }
        public void CaptureCandidateBatch(string volume,string exchangeId) {
            Need(!candidateBatchAttempted && !CloseUnknown,"No batch retry or prior close unknown"); candidateBatchAttempted=true;
            var binding=new BatchBinding(Id,candidateManifest,Root,RootId,volume,exchangeId);
            candidateBatch=new BatchCapture(binding,new NativeBatchOps(this,binding));
            try { candidateBatch.Run(); } finally { if(candidateBatch.Handles.Unknown) CloseUnknown=true; }
        }
    }
}

