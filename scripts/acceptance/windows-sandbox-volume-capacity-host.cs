// Optional partial compiled only into the capacity acceptance manager. No automatic entry or disk discovery.
using System;
using System.ComponentModel;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using SuperPiCapacity;

namespace SuperPiVolume {
    // Fixed nine handle identities for one install/read pair; the callback is host-private, never guest supplied.
    sealed class CapacityHandles {
        readonly IntPtr[] handles=new IntPtr[9]; readonly bool[] attempted=new bool[9]; readonly int?[] errors=new int?[9];
        readonly Func<IntPtr,int?> close;
        public int Opened { get; private set; } public int Closed { get; private set; } public int Peak { get; private set; }
        public bool Unknown { get; private set; }
        public CapacityHandles(Func<IntPtr,int?> close) { if(close==null) throw new ArgumentNullException("close"); this.close=close; }
        public IntPtr this[int slot] { get { return handles[slot]; } }
        public void CanOpen(int slot) { if(slot<0 || slot>=9 || handles[slot]!=IntPtr.Zero || attempted[slot] || Unknown) throw new InvalidOperationException("Capacity handle slot already used/unknown"); }
        public void Adopt(int slot,IntPtr handle) {
            CanOpen(slot); if(handle==IntPtr.Zero || handle==new IntPtr(-1)) throw new ArgumentException("Valid capacity handle required");
            handles[slot]=handle; Opened++; Peak=Math.Max(Peak,Opened-Closed);
        }
        public void CloseOnce(int slot) {
            if(handles[slot]==IntPtr.Zero || attempted[slot]) return;
            attempted[slot]=true;
            try {
                int? error=close(handles[slot]);
                if(error.HasValue) { errors[slot]=error; throw new Win32Exception(error.Value,"Capacity handle close unknown"); }
                handles[slot]=IntPtr.Zero; Closed++;
            } catch { Unknown=true; throw; }
        }
        public Exception CloseRange(int first,int last) {
            Exception failure=null;
            for(int i=last;i>=first;i--) try { CloseOnce(i); } catch(Exception error) { if(failure==null) failure=error; }
            return failure;
        }
        public int?[] Errors { get { return (int?[])errors.Clone(); } }
        public string[] Retained {
            get { var result=new string[9]; for(int i=0;i<9;i++) if(handles[i]!=IntPtr.Zero) result[i]=handles[i].ToInt64().ToString("X"); return result; }
        }
    }
    public sealed partial class NativeDisk {
        // Each operation has its own slot. A failed close retains the exact handle and is never retried.
        readonly CapacityHandles capacityHandles=new CapacityHandles(CapacityNativeClose);
        bool capacityInstallAttempted,capacityReadAttempted;
        public int CapacityOpened { get { return capacityHandles.Opened; } }
        public int CapacityClosed { get { return capacityHandles.Closed; } }
        public int CapacityPeak { get { return capacityHandles.Peak; } }
        public bool CapacityInstalled { get; private set; }
        public bool CapacityReadCompleted { get; private set; }
        public string CapacityProbeId { get; private set; }
        public string CapacitySlotId { get; private set; }
        public string CapacitySentinelId { get; private set; }
        public string CapacityFillId { get; private set; }
        public long CapacityFillLength { get; private set; }
        public long CapacityFillAllocation { get; private set; }
        public string CapacityResultBase64 { get; private set; }
        public bool CapacitySentinelMatched { get; private set; }
        public int?[] CapacityCloseErrors { get { return capacityHandles.Errors; } }
        public string[] CapacityRetainedHandles { get { return capacityHandles.Retained; } }
        public Exception CapacityOperationException { get; private set; }
        static void CapacityShape(uint attributes,uint links,long length,long allocation,bool directory,bool deleting,string actualPath,string expectedPath,
            string identity,string parentId,bool parent,long maximum) {
            ProbeInvariant((attributes&0x4E00)==0 && ((attributes&0x10)!=0)==parent && directory==parent && !deleting,"Capacity ordinary file/directory required");
            ProbeInvariant(String.Equals(actualPath,expectedPath,StringComparison.OrdinalIgnoreCase),"Capacity final path changed");
            ProbeInvariant(Regex.IsMatch(identity,@"\A[0-9A-F]{8}:[0-9A-F]{16}\z") && Regex.IsMatch(parentId,@"\A[0-9A-F]{8}:[0-9A-F]{16}\z"),"Capacity identity shape");
            ProbeInvariant(parent ? identity==parentId : links==1 && identity.Substring(0,9)==parentId.Substring(0,9)
                && length>=0 && length<=maximum && allocation>=0 && allocation<=Capacity,"Capacity volume/link/size boundary");
        }
        string CapacityIdentity(int slot,string expectedPath,string parentId,bool parent,long maximum,uint pathFlags,out long length,out long allocation) {
            try {
                FileInfo file; StandardInfo standard; IntPtr handle=capacityHandles[slot];
                Win(GetFileInformationByHandle(handle,out file)); Win(GetFileInformationByHandleEx(handle,1,out standard,(uint)Marshal.SizeOf(typeof(StandardInfo))));
                var path=new StringBuilder(512); uint count=GetFinalPathNameByHandle(handle,path,512,pathFlags);
                Win(count>0); ProbeInvariant(count<512,"Capacity path exceeds fixed bound");
                string identity=file.Serial.ToString("X8")+":"+file.IndexHigh.ToString("X8")+file.IndexLow.ToString("X8");
                long fileLength=((long)file.SizeHigh<<32)|file.SizeLow;
                ProbeInvariant(parent || fileLength==standard.EndOfFile && standard.Links==file.Links,"Capacity metadata disagreement");
                CapacityShape(file.Attributes,file.Links,standard.EndOfFile,standard.AllocationSize,standard.Directory,standard.DeletePending,
                    path.ToString(),expectedPath,identity,parentId,parent,maximum);
                length=standard.EndOfFile; allocation=standard.AllocationSize; return identity;
            } catch(StorageIdentityException) { throw; }
            catch(Exception error) { throw new StorageIdentityException("Capacity handle identity unavailable",error); }
        }
        void OpenCapacity(int slot,string path,uint access,uint share,uint creation,uint flags) {
            capacityHandles.CanOpen(slot); Need(!CloseUnknown,"Capacity prior close unknown");
            IntPtr handle=CreateFile(path,access,share,IntPtr.Zero,creation,flags,IntPtr.Zero);
            if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            capacityHandles.Adopt(slot,handle);
        }
        static int? CapacityNativeClose(IntPtr handle) { if(CloseHandle(handle)) return null; return Marshal.GetLastWin32Error(); }
        void CloseCapacity(int slot) {
            try { capacityHandles.CloseOnce(slot); }
            finally { if(capacityHandles.Unknown) CloseUnknown=true; }
        }
        Exception CloseCapacityRange(int first,int last) {
            try { return capacityHandles.CloseRange(first,last); }
            finally { if(capacityHandles.Unknown) CloseUnknown=true; }
        }
        static void CapacityThrow(Exception operation,Exception close) {
            if(operation!=null) ExceptionDispatchInfo.Capture(operation).Throw();
            if(close!=null) ExceptionDispatchInfo.Capture(close).Throw();
        }
        void CapacityBinding(string volume,string exchangeId) {
            ProbeInvariant(volume!=null && volume.Length==49 && Regex.IsMatch(volume,@"\A\\\\\?\\Volume\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}\\\z"),"Capacity GUID volume required");
            ProbeVolumeIdentity(volume,exchangeId);
        }
        void CapacityReadExactly(int slot,byte[] bytes) {
            uint read; bool ok=ReadFile(capacityHandles[slot],bytes,(uint)bytes.Length,out read,IntPtr.Zero);
            int error=ok ? 0 : Marshal.GetLastWin32Error(); if(!ok) throw new Win32Exception(error); Need(read==bytes.Length,"Short capacity host read");
        }
        string CapacityWriteNew(int slot,string file,byte[] bytes,string parentId,uint pathFlags) {
            OpenCapacity(slot,file,0x40000080,0,1,0x80200000); long length,allocation;
            string id=CapacityIdentity(slot,file.StartsWith(@"\\?\") ? file : @"\\?\"+file,parentId,false,bytes.Length,pathFlags,out length,out allocation);
            Need(length==0,"New capacity output not empty"); uint written;
            bool ok=WriteFile(capacityHandles[slot],bytes,(uint)bytes.Length,out written,IntPtr.Zero); int error=ok ? 0 : Marshal.GetLastWin32Error();
            if(!ok) throw new Win32Exception(error); Need(written==bytes.Length,"Short capacity host write"); Win(FlushFileBuffers(capacityHandles[slot]));
            ProbeInvariant(CapacityIdentity(slot,file.StartsWith(@"\\?\") ? file : @"\\?\"+file,parentId,false,bytes.Length,pathFlags,out length,out allocation)==id
                && length==bytes.Length,"Capacity write identity/length changed");
            CloseCapacity(slot); return id;
        }
        public void InstallCapacity(string volume,string exchangeId,string probeSha256) {
            Need(!capacityInstallAttempted && !CloseUnknown && Regex.IsMatch(probeSha256??"",@"\A[0-9a-f]{64}\z"),"One fixed capacity installation required");
            capacityInstallAttempted=true; CapacityBinding(volume,exchangeId);
            byte[] probe=null,initial=null,sentinel=null; Exception operation=null,close=null;
            string exchange=volume+"exchange", source=Root+"\\capacity-probe.exe";
            try {
                OpenCapacity(0,source,0x80000000,1,3,0x00200000); long length,allocation;
                string sourceId=CapacityIdentity(0,@"\\?\"+source,RootId,false,65536,0,out length,out allocation);
                Need(length>0,"Empty capacity probe"); probe=new byte[(int)length]; CapacityReadExactly(0,probe);
                using(var hash=SHA256.Create()) Need(BitConverter.ToString(hash.ComputeHash(probe)).Replace("-","").ToLowerInvariant()==probeSha256,"Capacity probe digest changed");
                ProbeInvariant(CapacityIdentity(0,@"\\?\"+source,RootId,false,65536,0,out length,out allocation)==sourceId && length==probe.Length,"Probe source changed");
                OpenCapacity(1,exchange,0x80000000,1,3,0x02200000); CapacityIdentity(1,exchange,exchangeId,true,0,1,out length,out allocation);
                CapacityProbeId=CapacityWriteNew(2,exchange+"\\capacity-probe.exe",probe,exchangeId,1);
                initial=CapacityProtocol.Initial(Id); CapacitySlotId=CapacityWriteNew(3,exchange+"\\capacity-result.bin",initial,exchangeId,1);
                sentinel=Encoding.ASCII.GetBytes(Id.ToString("N")); CapacitySentinelId=CapacityWriteNew(4,Root+"\\capacity-host-sentinel.bin",sentinel,RootId,0);
                CapacityIdentity(1,exchange,exchangeId,true,0,1,out length,out allocation); CapacityBinding(volume,exchangeId);
            } catch(Exception error) { operation=error; CapacityOperationException=error; }
            finally {
                close=CloseCapacityRange(0,4);
                if(probe!=null) Array.Clear(probe,0,probe.Length); if(initial!=null) Array.Clear(initial,0,initial.Length); if(sentinel!=null) Array.Clear(sentinel,0,sentinel.Length);
            }
            CapacityThrow(operation,close); CapacityInstalled=true;
        }
        public void ReadCapacity(string volume,string exchangeId) {
            Need(CapacityInstalled && !capacityReadAttempted && !CloseUnknown,"One post-VM capacity read required");
            capacityReadAttempted=true; CapacityBinding(volume,exchangeId);
            byte[] result=new byte[512],sentinel=new byte[32],expected=Encoding.ASCII.GetBytes(Id.ToString("N"));
            Exception operation=null,close=null;
            string exchange=volume+"exchange", resultFile=exchange+"\\capacity-result.bin", fillFile=exchange+"\\capacity-fill.bin", sentinelFile=Root+"\\capacity-host-sentinel.bin";
            try {
                long length,allocation;
                OpenCapacity(5,exchange,0x80000000,1,3,0x02200000); CapacityIdentity(5,exchange,exchangeId,true,0,1,out length,out allocation);
                OpenCapacity(6,resultFile,0x80000000,0,3,0x00200000);
                ProbeInvariant(CapacityIdentity(6,resultFile,exchangeId,false,512,1,out length,out allocation)==CapacitySlotId && length==512,"Capacity result identity/length changed");
                CapacityReadExactly(6,result);
                ProbeInvariant(CapacityIdentity(6,resultFile,exchangeId,false,512,1,out length,out allocation)==CapacitySlotId && length==512,"Capacity result changed after read");
                CapacityResultBase64=Convert.ToBase64String(result); CloseCapacity(6); // Preserve diagnostic bytes even if later metadata/close fails.
                OpenCapacity(7,fillFile,0x80,0,3,0x00200000);
                CapacityFillId=CapacityIdentity(7,fillFile,exchangeId,false,Capacity,1,out length,out allocation);
                Need(length>=1048576 && allocation>=length,"Capacity fill lacks allocated ordinary data");
                CapacityFillLength=length; CapacityFillAllocation=allocation; CloseCapacity(7);
                OpenCapacity(8,sentinelFile,0x80000000,0,3,0x00200000);
                ProbeInvariant(CapacityIdentity(8,@"\\?\"+sentinelFile,RootId,false,32,0,out length,out allocation)==CapacitySentinelId && length==32,"Capacity sentinel identity changed");
                CapacityReadExactly(8,sentinel); for(int i=0;i<32;i++) ProbeInvariant(sentinel[i]==expected[i],"Capacity sentinel changed");
                ProbeInvariant(CapacityIdentity(8,@"\\?\"+sentinelFile,RootId,false,32,0,out length,out allocation)==CapacitySentinelId && length==32,"Capacity sentinel changed after read");
                CapacitySentinelMatched=true; CloseCapacity(8);
                CapacityIdentity(5,exchange,exchangeId,true,0,1,out length,out allocation); CapacityBinding(volume,exchangeId);
            } catch(Exception error) { operation=error; CapacityOperationException=error; }
            finally { close=CloseCapacityRange(5,8); Array.Clear(result,0,result.Length); Array.Clear(sentinel,0,sentinel.Length); Array.Clear(expected,0,expected.Length); }
            CapacityThrow(operation,close); CapacityReadCompleted=true;
        }
    }
}
