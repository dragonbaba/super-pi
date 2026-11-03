// Optional manifest-capture partial. No static I/O and no helper/CLI entry.
using System;
using System.ComponentModel;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace SuperPiVolume {
    internal struct ManifestMeta {
        public string Id, Path;
        public uint Attributes, Links;
        public long Length, Allocation;
        public ulong Creation, WriteTime;
        public bool Directory, DeletePending, Consistent;
    }
    public struct ManifestIo {
        public readonly bool Success;
        public readonly int? Error;
        public readonly uint Count;
        public ManifestIo(bool success, int? error, uint count) { Success=success; Error=error; Count=count; }
    }
    internal struct ManifestOpen {
        public string Path;
        public uint Access, Share, Creation, Flags;
    }
    internal sealed class ManifestBinding {
        public readonly string Root, RootId, Volume, ExchangeId, Exchange, Source, Carrier, FinalCarrier;
        public readonly int Maximum;
        public readonly bool TaskResult;
        public ManifestBinding(string root,string rootId,string volume,string exchangeId,bool taskResult=false) {
            ManifestCapture.Identity(root!=null && root.Length<=180 && Regex.IsMatch(root,@"\A[A-Za-z]:\\")
                && !root.EndsWith(@"\") && root.IndexOfAny(new char[]{'\0','\r','\n','%','[',']'})<0,"Manifest private root syntax");
            ManifestCapture.Identity(ManifestCapture.FileId(rootId) && ManifestCapture.FileId(exchangeId),"Manifest root identities");
            ManifestCapture.Identity(volume!=null && Regex.IsMatch(volume,@"\A\\\\\?\\Volume\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}\\\z"),"Manifest GUID volume");
            Root=root; RootId=rootId; Volume=volume; ExchangeId=exchangeId;
            TaskResult=taskResult; Maximum=taskResult ? 65664 : ManifestCapture.Maximum;
            Exchange=volume+"exchange";
            Source=Exchange+(taskResult ? @"\task-result.bin" : @"\candidates.json");
            Carrier=root+(taskResult ? @"\task-result.bin" : @"\candidate-manifest.bin"); FinalCarrier=@"\\?\"+Carrier;
        }
        public ManifestOpen Open(int slot) {
            if(slot==0) return new ManifestOpen { Path=Exchange,Access=0x80000000,Share=1,Creation=3,Flags=0x02200000 };
            if(slot==1) return new ManifestOpen { Path=Source,Access=0x80000000,Share=0,Creation=3,Flags=0x00200000 };
            if(slot==2) return new ManifestOpen { Path=Carrier,Access=0x40000080,Share=0,Creation=1,Flags=0x80200000 };
            throw new ArgumentOutOfRangeException("slot");
        }
    }
    internal interface IManifestOps {
        void VerifyBinding();
        IntPtr Open(int slot,ManifestOpen specification);
        ManifestMeta Inspect(int slot,IntPtr handle);
        ManifestIo Read(IntPtr handle,byte[] bytes);
        ManifestIo Write(IntPtr handle,byte[] bytes);
        ManifestIo Flush(IntPtr handle);
        int? Close(IntPtr handle);
    }
    internal sealed class ManifestHandles {
        readonly IntPtr[] handles=new IntPtr[3];
        readonly bool[] used=new bool[3],attempted=new bool[3];
        readonly int?[] errors=new int?[3];
        Func<IntPtr,int?> close;
        public int Opened { get; private set; } public int Closed { get; private set; } public int Peak { get; private set; }
        public bool Unknown { get; private set; }
        public bool RetainsClose { get { return close!=null; } }
        public ManifestHandles(Func<IntPtr,int?> close) { if(close==null) throw new ArgumentNullException("close"); this.close=close; }
        public IntPtr this[int slot] { get { return handles[slot]; } }
        public void CanOpen(int slot) {
            if(slot<0 || slot>=3 || used[slot] || Unknown || close==null) throw new InvalidOperationException("Manifest handle admission");
        }
        public void Adopt(int slot,IntPtr handle) {
            CanOpen(slot); if(handle==IntPtr.Zero || handle==new IntPtr(-1)) throw new ArgumentException("Manifest valid handle required");
            handles[slot]=handle; used[slot]=true; Opened++; Peak=Math.Max(Peak,Opened-Closed);
        }
        public void CloseOnce(int slot) {
            if(handles[slot]==IntPtr.Zero || attempted[slot]) return;
            attempted[slot]=true;
            try {
                int? error=close(handles[slot]);
                if(error.HasValue) { errors[slot]=error; throw new Win32Exception(error.Value,"Manifest handle close unknown"); }
                handles[slot]=IntPtr.Zero; Closed++;
            } catch { Unknown=true; throw; }
        }
        public Exception CloseRange(int first,int last) {
            Exception firstFailure=null;
            for(int slot=last;slot>=first;slot--) try { CloseOnce(slot); } catch(Exception error) { if(firstFailure==null) firstFailure=error; }
            return firstFailure;
        }
        public void ReleaseCallback() {
            if(Unknown || Opened!=Closed) throw new InvalidOperationException("Manifest unresolved handles");
            close=null;
        }
        public int?[] Errors { get { return (int?[])errors.Clone(); } }
        public string[] Retained {
            get { var result=new string[3]; for(int i=0;i<3;i++) if(handles[i]!=IntPtr.Zero) result[i]=handles[i].ToInt64().ToString("X"); return result; }
        }
    }
    internal sealed class ManifestCapture {
        internal const int Maximum=4096;
        readonly ManifestBinding binding;
        internal ManifestBinding Binding { get { return binding; } }
        IManifestOps ops;
        public readonly ManifestHandles Handles;
        public bool Attempted { get; private set; } public bool Captured { get; private set; }
        public string SourceId { get; private set; } public string CarrierId { get; private set; } public string Sha256 { get; private set; }
        public int Bytes { get; private set; } public int AllocatedBytes { get; private set; } public int ClearedBytes { get; private set; }
        public ManifestIo? ReadResult { get; private set; } public ManifestIo? WriteResult { get; private set; } public ManifestIo? FlushResult { get; private set; }
        public Exception OperationException { get; private set; } public Exception CloseException { get; private set; }
        public bool RetainsOperations { get { return ops!=null || Handles.RetainsClose; } }
        public ManifestCapture(ManifestBinding binding,IManifestOps ops) {
            if(binding==null || ops==null) throw new ArgumentNullException("manifest capture");
            this.binding=binding; this.ops=ops; Handles=new ManifestHandles(ops.Close);
        }
        internal static bool FileId(string value) { return value!=null && Regex.IsMatch(value,@"\A[0-9A-F]{8}:[0-9A-F]{16}\z"); }
        internal static void Identity(bool value,string message) { if(!value) throw new StorageIdentityException(message); }
        static void Need(bool value,string message) { if(!value) throw new InvalidOperationException(message); }
        internal static void Shape(ManifestMeta value,int slot,ManifestBinding binding,long expectedLength) {
            bool parent=slot==0;
            string expected=parent ? binding.Exchange : slot==1 ? binding.Source : binding.FinalCarrier;
            string domain=slot==2 ? binding.RootId : binding.ExchangeId;
            Identity(value.Consistent && (value.Attributes&0x4E00)==0 && ((value.Attributes&0x10)!=0)==parent
                && value.Directory==parent && !value.DeletePending,"Manifest ordinary type/metadata");
            Identity(String.Equals(value.Path,expected,StringComparison.OrdinalIgnoreCase) && FileId(value.Id),"Manifest final path/identity");
            Identity(parent ? value.Id==binding.ExchangeId : value.Links==1 && value.Id!=domain && value.Id.Substring(0,9)==domain.Substring(0,9)
                && value.Length>=0 && value.Length<=binding.Maximum && value.Allocation>=0,"Manifest link/volume/length");
            if(!parent && expectedLength>=0) Identity(value.Length==expectedLength,"Manifest length changed");
        }
        internal static void StableSource(ManifestMeta before,ManifestMeta after) {
            Identity(before.Id==after.Id && before.Length==after.Length && before.Creation==after.Creation
                && before.WriteTime==after.WriteTime && before.Attributes==after.Attributes && before.Links==after.Links,"Manifest source changed");
        }
        void Open(int slot) { Handles.CanOpen(slot); IntPtr handle=ops.Open(slot,binding.Open(slot)); Handles.Adopt(slot,handle); }
        static void CheckIo(ManifestIo result,string name) {
            if(!result.Success) {
                if(result.Error.HasValue) throw new Win32Exception(result.Error.Value,name);
                throw new InvalidOperationException(name+" failed without returned native error");
            }
            Need(!result.Error.HasValue,name+" contradictory native error");
        }
        internal static void ThrowFirst(Exception operation,Exception close) {
            if(operation!=null) ExceptionDispatchInfo.Capture(operation).Throw();
            if(close!=null) ExceptionDispatchInfo.Capture(close).Throw();
        }
        public void Run() {
            Need(!Attempted,"No manifest capture retry"); Attempted=true;
            byte[] bytes=null;
            try {
                ops.VerifyBinding();
                try {
                    Open(0); Shape(ops.Inspect(0,Handles[0]),0,binding,-1);
                    Open(1); ManifestMeta before=ops.Inspect(1,Handles[1]); Shape(before,1,binding,-1);
                    SourceId=before.Id; Bytes=(int)before.Length;
                    Need(Bytes>0,"Empty candidate manifest"); // Invalid data, not an identity or unknown-close assertion.
                    bytes=new byte[Bytes]; AllocatedBytes=bytes.Length;
                    ReadResult=ops.Read(Handles[1],bytes); CheckIo(ReadResult.Value,"Manifest read");
                    Need(ReadResult.Value.Count==(uint)bytes.Length,"Short manifest read");
                    ManifestMeta after=ops.Inspect(1,Handles[1]); Shape(after,1,binding,Bytes); StableSource(before,after);
                    Shape(ops.Inspect(0,Handles[0]),0,binding,-1);
                    using(var sha=SHA256.Create()) Sha256=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
                } catch(Exception error) { OperationException=error; }
                finally { CloseException=Handles.CloseRange(0,1); }
                ThrowFirst(OperationException,CloseException);
                ops.VerifyBinding();
                Open(2); ManifestMeta initial=ops.Inspect(2,Handles[2]); Shape(initial,2,binding,0); CarrierId=initial.Id;
                WriteResult=ops.Write(Handles[2],bytes); CheckIo(WriteResult.Value,"Manifest carrier write");
                Need(WriteResult.Value.Count==(uint)bytes.Length,"Short manifest carrier write");
                FlushResult=ops.Flush(Handles[2]); CheckIo(FlushResult.Value,"Manifest carrier flush");
                ManifestMeta final=ops.Inspect(2,Handles[2]); Shape(final,2,binding,Bytes);
                Identity(final.Id==CarrierId,"Manifest carrier identity changed");
            } catch(Exception error) { if(OperationException==null && !Object.ReferenceEquals(error,CloseException)) OperationException=error; }
            finally {
                Exception last=Handles.CloseRange(0,2); if(CloseException==null) CloseException=last;
                if(bytes!=null) { Array.Clear(bytes,0,bytes.Length); ClearedBytes=bytes.Length; bytes=null; }
            }
            try {
                ThrowFirst(OperationException,CloseException);
                ops.VerifyBinding();
                Need(!Handles.Unknown && Handles.Opened==3 && Handles.Closed==3 && Handles.Peak==2,"Manifest capture not closed");
                Captured=true;
            } catch(Exception error) { if(OperationException==null && !Object.ReferenceEquals(error,CloseException)) OperationException=error; throw; }
            finally { if(!Handles.Unknown && Handles.Opened==Handles.Closed) { Handles.ReleaseCallback(); ops=null; } }
        }
    }
    public sealed partial class NativeDisk {
        ManifestCapture candidateManifest;
        bool candidateManifestAttempted;
        static int candidateManifestNativeOperations;
        static int taskResultNativeOperations;
        public static int CandidateManifestNativeOperations { get { return candidateManifestNativeOperations; } }
        public bool CandidateManifestCaptured { get { return candidateManifest!=null && candidateManifest.Captured; } }
        public string CandidateManifestSourceId { get { return candidateManifest==null ? null : candidateManifest.SourceId; } }
        public string CandidateManifestCarrierId { get { return candidateManifest==null ? null : candidateManifest.CarrierId; } }
        public string CandidateManifestSha256 { get { return candidateManifest==null ? null : candidateManifest.Sha256; } }
        public int CandidateManifestBytes { get { return candidateManifest==null ? 0 : candidateManifest.Bytes; } }
        public int CandidateManifestOpened { get { return candidateManifest==null ? 0 : candidateManifest.Handles.Opened; } }
        public int CandidateManifestClosed { get { return candidateManifest==null ? 0 : candidateManifest.Handles.Closed; } }
        public int CandidateManifestPeak { get { return candidateManifest==null ? 0 : candidateManifest.Handles.Peak; } }
        public int?[] CandidateManifestCloseErrors { get { return candidateManifest==null ? new int?[3] : candidateManifest.Handles.Errors; } }
        public string[] CandidateManifestRetainedHandles { get { return candidateManifest==null ? new string[3] : candidateManifest.Handles.Retained; } }
        public Exception CandidateManifestOperationException { get { return candidateManifest==null ? null : candidateManifest.OperationException; } }
        public Exception CandidateManifestCloseException { get { return candidateManifest==null ? null : candidateManifest.CloseException; } }
        public ManifestIo? CandidateManifestReadResult { get { return candidateManifest==null ? null : candidateManifest.ReadResult; } }
        public ManifestIo? CandidateManifestWriteResult { get { return candidateManifest==null ? null : candidateManifest.WriteResult; } }
        public ManifestIo? CandidateManifestFlushResult { get { return candidateManifest==null ? null : candidateManifest.FlushResult; } }
        public int CandidateManifestAllocatedBytes { get { return candidateManifest==null ? 0 : candidateManifest.AllocatedBytes; } }
        public int CandidateManifestClearedBytes { get { return candidateManifest==null ? 0 : candidateManifest.ClearedBytes; } }
        public bool CandidateManifestRetainsOperations { get { return candidateManifest!=null && candidateManifest.RetainsOperations; } }
        static ManifestMeta CaptureMetadata(IntPtr handle,bool guid,bool parent) {
            try {
                FileInfo file; StandardInfo standard;
                Win(GetFileInformationByHandle(handle,out file)); Win(GetFileInformationByHandleEx(handle,1,out standard,(uint)Marshal.SizeOf(typeof(StandardInfo))));
                var path=new StringBuilder(512); uint count=GetFinalPathNameByHandle(handle,path,512,guid ? 1u : 0u);
                Win(count>0); ProbeInvariant(count<512,"Capture final path bound");
                ulong length=((ulong)file.SizeHigh<<32)|file.SizeLow;
                return new ManifestMeta { Id=file.Serial.ToString("X8")+":"+file.IndexHigh.ToString("X8")+file.IndexLow.ToString("X8"),
                    Path=path.ToString(),Attributes=file.Attributes,Links=file.Links,Length=standard.EndOfFile,Allocation=standard.AllocationSize,
                    Creation=((ulong)file.CreationHigh<<32)|file.CreationLow,WriteTime=((ulong)file.WriteHigh<<32)|file.WriteLow,
                    Directory=standard.Directory,DeletePending=standard.DeletePending,
                    Consistent=parent || standard.EndOfFile>=0 && (ulong)standard.EndOfFile==length && standard.Links==file.Links };
            } catch(StorageIdentityException) { throw; }
            catch(Exception error) { throw new StorageIdentityException("Capture handle identity unavailable",error); }
        }
        sealed class NativeManifestOps : IManifestOps {
            readonly NativeDisk owner; readonly ManifestBinding binding;
            public NativeManifestOps(NativeDisk owner,ManifestBinding binding) { this.owner=owner; this.binding=binding; }
            void Count() { if(binding.TaskResult) taskResultNativeOperations++; else candidateManifestNativeOperations++; }
            public void VerifyBinding() {
                Count();
                owner.ProbeVolumeIdentity(binding.Volume,binding.ExchangeId);
                ProbeInvariant(owner.Fingerprint(owner.Root,true)==owner.RootId && !owner.CloseUnknown,"Manifest private root changed");
            }
            public IntPtr Open(int slot,ManifestOpen value) {
                Count();
                IntPtr handle=CreateFile(value.Path,value.Access,value.Share,IntPtr.Zero,value.Creation,value.Flags,IntPtr.Zero);
                if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); return handle;
            }
            public ManifestMeta Inspect(int slot,IntPtr handle) {
                Count();
                return CaptureMetadata(handle,slot!=2,slot==0);
            }
            public ManifestIo Read(IntPtr handle,byte[] bytes) {
                Count(); uint count; bool ok=ReadFile(handle,bytes,(uint)bytes.Length,out count,IntPtr.Zero);
                int? error=ok ? (int?)null : Marshal.GetLastWin32Error(); return new ManifestIo(ok,error,count);
            }
            public ManifestIo Write(IntPtr handle,byte[] bytes) {
                Count(); uint count; bool ok=WriteFile(handle,bytes,(uint)bytes.Length,out count,IntPtr.Zero);
                int? error=ok ? (int?)null : Marshal.GetLastWin32Error(); return new ManifestIo(ok,error,count);
            }
            public ManifestIo Flush(IntPtr handle) {
                Count(); bool ok=FlushFileBuffers(handle); int? error=ok ? (int?)null : Marshal.GetLastWin32Error();
                return new ManifestIo(ok,error,0);
            }
            public int? Close(IntPtr handle) {
                Count(); if(CloseHandle(handle)) return null; return Marshal.GetLastWin32Error();
            }
        }
        public void CaptureCandidateManifest(string volume,string exchangeId) {
            Need(!candidateManifestAttempted && !CloseUnknown,"No manifest retry or prior close unknown"); candidateManifestAttempted=true;
            var binding=new ManifestBinding(Root,RootId,volume,exchangeId);
            candidateManifest=new ManifestCapture(binding,new NativeManifestOps(this,binding));
            try { candidateManifest.Run(); }
            finally { if(candidateManifest.Handles.Unknown) CloseUnknown=true; }
        }
    }
}
