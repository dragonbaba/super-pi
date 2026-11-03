// Explicit fault-diagnostic building block only. No NativeDisk, task launch or static I/O.
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace SuperPiVolume {
    internal struct DiagnosticOpen {
        public string Path;
        public uint Access, Share, Creation, Flags, Version, RWDepth;
    }
    internal struct DiagnosticOpened {
        public readonly uint Error;
        public readonly IntPtr Handle; // Undefined on failed OpenVirtualDisk; never adopted then.
        public DiagnosticOpened(uint error,IntPtr handle) { Error=error; Handle=handle; }
    }
    internal struct DiagnosticInfo {
        public uint Error, Size, Used;
    }
    internal struct DiagnosticMeta {
        public string Id, Path;
        public uint Attributes, Links;
        public long Length, Allocation;
        public ulong Creation, Written;
        public bool Directory, DeletePending, Consistent;
    }
    internal interface IFaultDiagnosticOps {
        DiagnosticOpened Open(int slot,DiagnosticOpen specification);
        DiagnosticMeta Inspect(int slot,IntPtr handle);
        DiagnosticInfo Info(IntPtr handle,byte[] buffer);
        int? Close(IntPtr handle);
    }
    internal sealed class DiagnosticBinding {
        internal const long Capacity=134217728, Budget=135266304;
        public readonly string Root, Image, RootId, ImageId, TaskId, InstanceId, Volume;
        public readonly long ImageBytes;
        public DiagnosticBinding(string root,string rootId,string imageId,long imageBytes,string taskId,string instanceId,string volume) {
            Need(root!=null && root.Length<=180 && Regex.IsMatch(root,@"\A[A-Za-z]:\\")
                && Path.GetFullPath(root)==root && !root.EndsWith(@"\"),"Canonical local root required");
            string[] parts=root.Substring(3).Split('\\');
            foreach(string part in parts) Need(part.Length>0 && part.Length<=64
                && Regex.IsMatch(part,@"\A[A-Za-z0-9_.-][A-Za-z0-9 _.-]*\z")
                && part!="." && part!=".." && !part.EndsWith(".") && !part.EndsWith(" "),"Bounded root segment");
            Need(FileId(rootId) && FileId(imageId) && rootId!=imageId && rootId.Substring(0,9)==imageId.Substring(0,9),"Original file identities");
            Need(Uuid(taskId) && Uuid(instanceId) && taskId!=instanceId,"Original task/instance IDs");
            Need(imageBytes>=Capacity && imageBytes<=Budget,"Original image length");
            Need(volume!=null && Regex.IsMatch(volume,@"\A\\\\\?\\Volume\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}\\\z"),"Original volume GUID");
            Root=root; Image=root+@"\task.vhd"; RootId=rootId; ImageId=imageId; ImageBytes=imageBytes;
            TaskId=taskId; InstanceId=instanceId; Volume=volume;
        }
        internal static void Need(bool condition,string message) { if(!condition) throw new InvalidOperationException(message); }
        static bool FileId(string s) { return s!=null && Regex.IsMatch(s,@"\A[0-9A-F]{8}:[0-9A-F]{16}\z"); }
        static bool Uuid(string s) { Guid id; return s!=null && Guid.TryParseExact(s,"D",out id) && id!=Guid.Empty && id.ToString("D")==s; }
        public DiagnosticOpen Specification(int slot) {
            if(slot==0 || slot==1) return new DiagnosticOpen { Path=slot==0 ? Root : Image, Access=0x80, Share=3,
                Creation=3, Flags=slot==0 ? 0x02200000u : 0x00200000u };
            if(slot==2) return new DiagnosticOpen { Path=Image,Access=0x00080000,Flags=0,Version=1,RWDepth=0 };
            if(slot==3) return new DiagnosticOpen { Path=Volume.TrimEnd('\\'),Access=0,Share=7,Creation=3,Flags=0 };
            throw new ArgumentOutOfRangeException("slot");
        }
    }
    // Caller retains this owner before Run. Unknown closure retains the exact handle and adapter.
    // No finalizer, retry, rescue open, privilege change, attachment or deletion.
    public sealed class FaultDiagnosticOwner {
        DiagnosticBinding binding;
        IFaultDiagnosticOps ops;
        readonly IntPtr[] handles=new IntPtr[4];
        readonly string[] acquired=new string[4];
        readonly bool[] attempts=new bool[4],operationFailed=new bool[4],closeFailed=new bool[4];
        readonly int?[] operationErrors=new int?[4],closeErrors=new int?[4];
        public bool Attempted { get; private set; }
        public bool Succeeded { get; private set; }
        public bool Unknown { get; private set; }
        public bool RetainsOperations { get { return ops!=null; } }
        public int Opened { get; private set; }
        public int Closed { get; private set; }
        public int Peak { get; private set; }
        public int AllocatedBytes { get; private set; }
        public int ClearedBytes { get; private set; }
        public int GuidError { get; private set; }
        public Exception OperationException { get; private set; }
        public Exception CloseException { get; private set; }
        public string SuccessReceipt { get; private set; }
        public string[] RetainedHandles { get { var copy=new string[4]; for(int i=0;i<4;i++) if(handles[i]!=IntPtr.Zero) copy[i]=handles[i].ToInt64().ToString("X"); return copy; } }
        public int?[] OperationErrors { get { return (int?[])operationErrors.Clone(); } }
        public int?[] CloseErrors { get { return (int?[])closeErrors.Clone(); } }
        public bool[] CloseAttempts { get { return (bool[])attempts.Clone(); } }
        public FaultDiagnosticOwner(string root,string rootId,string imageId,long imageBytes,string taskId,string instanceId,string volume)
            : this(new DiagnosticBinding(root,rootId,imageId,imageBytes,taskId,instanceId,volume),new FaultDiagnosticNative()) {}
        internal FaultDiagnosticOwner(DiagnosticBinding binding,IFaultDiagnosticOps ops) {
            if(binding==null || ops==null) throw new ArgumentNullException("diagnostic owner");
            this.binding=binding; this.ops=ops;
        }
        static void Need(bool condition,string message) { DiagnosticBinding.Need(condition,message); }
        void Open(int slot) {
            Need(!Unknown && acquired[slot]==null && ops!=null,"Diagnostic acquisition stopped");
            DiagnosticOpened result=ops.Open(slot,binding.Specification(slot));
            if(result.Error!=0) { // Failed output handle is undefined, including nonzero garbage.
                if(slot==3) { GuidError=unchecked((int)result.Error); if(result.Error!=2 && result.Error!=3) throw new Win32Exception(GuidError,"GUID absence unknown"); return; }
                throw new Win32Exception(unchecked((int)result.Error),"Diagnostic open failed");
            }
            if(result.Handle==IntPtr.Zero || result.Handle==new IntPtr(-1)) { Unknown=true; throw new InvalidOperationException("Invalid successful handle"); }
            for(int i=0;i<4;i++) if(handles[i]==result.Handle) { Unknown=true; throw new InvalidOperationException("Duplicate live handle"); }
            handles[slot]=result.Handle; acquired[slot]=result.Handle.ToInt64().ToString("X"); Opened++; Peak=Math.Max(Peak,Opened-Closed);
            if(slot==3) throw new InvalidOperationException("Original GUID still opens");
        }
        void Shape(DiagnosticMeta value,int slot) {
            bool directory=slot==0;
            Need(value.Consistent && (value.Attributes&0x4E00)==0 && ((value.Attributes&0x10)!=0)==directory
                && value.Directory==directory && !value.DeletePending && value.Links==1,"Diagnostic file shape");
            Need(value.Id==(directory ? binding.RootId : binding.ImageId)
                && String.Equals(value.Path,@"\\?\"+(directory ? binding.Root : binding.Image),StringComparison.OrdinalIgnoreCase),"Diagnostic file identity/path");
            if(!directory) Need(value.Length==binding.ImageBytes && value.Allocation>=DiagnosticBinding.Capacity
                && value.Allocation<=DiagnosticBinding.Budget,"Diagnostic image allocation/EOF");
        }
        static void Stable(DiagnosticMeta before,DiagnosticMeta after) {
            Need(before.Id==after.Id && before.Path==after.Path && before.Attributes==after.Attributes && before.Links==after.Links
                && before.Length==after.Length && before.Allocation==after.Allocation && before.Creation==after.Creation
                && before.Written==after.Written,"Diagnostic metadata changed");
        }
        void Query(byte[] bytes,uint version,int minimum) {
            Array.Clear(bytes,0,bytes.Length); bytes[0]=(byte)version;
            DiagnosticInfo result=ops.Info(handles[2],bytes);
            if(result.Error!=0) throw new Win32Exception(unchecked((int)result.Error),"GET_INFO failed");
            Need(result.Size>=minimum && result.Size<=64 && result.Used>=minimum && result.Used<=result.Size
                && BitConverter.ToUInt32(bytes,0)==version,"GET_INFO short/invalid output"); // Never parse failed/short output.
        }
        void CloseAll() {
            for(int i=3;i>=0;i--) {
                if(handles[i]==IntPtr.Zero || attempts[i]) continue;
                attempts[i]=true;
                try {
                    int? code=ops.Close(handles[i]);
                    if(code.HasValue) { closeErrors[i]=code; throw new Win32Exception(code.Value,"Diagnostic close unknown"); }
                    handles[i]=IntPtr.Zero; Closed++;
                } catch(Exception error) {
                    closeFailed[i]=true; Unknown=true;
                    if(CloseException==null) CloseException=error;
                }
            }
        }
        static string Quote(string value) { return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"")+"\""; }
        string Receipt() {
            Need(!Unknown && Opened==3 && Closed==3 && GuidError>=2 && GuidError<=3,"Diagnostic not conclusively closed");
            var text=new StringBuilder(1024);
            text.Append("{\"protocol\":\"super-pi-manager-loss-diagnostic-v1\",\"taskId\":").Append(Quote(binding.TaskId))
                .Append(",\"instanceId\":").Append(Quote(binding.InstanceId)).Append(",\"rootId\":").Append(Quote(binding.RootId))
                .Append(",\"imageId\":").Append(Quote(binding.ImageId)).Append(",\"diskId\":").Append(Quote(binding.TaskId))
                .Append(",\"imageBytes\":").Append(binding.ImageBytes.ToString(CultureInfo.InvariantCulture))
                .Append(",\"volumePath\":").Append(Quote(binding.Volume))
                .Append(",\"virtualBytes\":134217728,\"subtype\":2,\"isLoaded\":false,\"guid\":{\"opened\":false,\"error\":")
                .Append(GuidError).Append("},\"handles\":[");
            string[] roles={"root","image","vhd-info"};
            for(int i=0;i<3;i++) {
                Need(!operationFailed[i] && !closeFailed[i] && attempts[i],"Diagnostic handle errors");
                if(i!=0) text.Append(',');
                text.Append('[').Append(Quote(roles[i])).Append(',').Append(Quote(acquired[i])).Append(",1,true,false,null,false,null]");
            }
            text.Append("]}\n"); string result=text.ToString();
            Need(Encoding.UTF8.GetByteCount(result)<=4096,"Diagnostic receipt budget"); return result;
        }
        public void Run() {
            Need(!Attempted,"Diagnostic is one-shot"); Attempted=true;
            byte[] scratch=null; int current=-1;
            try {
                FaultDiagnosticNative.AssertLayout(); // Pure managed layout assertions, no native call.
                current=0; Open(0); DiagnosticMeta root=ops.Inspect(0,handles[0]); Shape(root,0);
                current=1; Open(1); DiagnosticMeta image=ops.Inspect(1,handles[1]); Shape(image,1);
                current=2; Open(2);
                scratch=new byte[64]; AllocatedBytes=64;
                Query(scratch,2,24);
                Need(new Guid(BitConverter.ToInt32(scratch,8),BitConverter.ToInt16(scratch,12),BitConverter.ToInt16(scratch,14),
                    scratch[16],scratch[17],scratch[18],scratch[19],scratch[20],scratch[21],scratch[22],scratch[23]).ToString("D")==binding.TaskId,"VHD ID changed");
                Query(scratch,1,32); Need(BitConverter.ToUInt64(scratch,8)==DiagnosticBinding.Capacity,"VHD size changed");
                Query(scratch,7,12); Need(BitConverter.ToUInt32(scratch,8)==2,"VHD not fixed");
                Query(scratch,13,12); Need(BitConverter.ToInt32(scratch,8)==0,"VHD still loaded");
                current=3; Open(3); // Failed 2/3 only. Unexpected success is adopted then rejected.
                current=1; DiagnosticMeta finalImage=ops.Inspect(1,handles[1]); Shape(finalImage,1); Stable(image,finalImage);
                current=0; DiagnosticMeta finalRoot=ops.Inspect(0,handles[0]); Shape(finalRoot,0); Stable(root,finalRoot);
            } catch(Exception error) {
                OperationException=error;
                if(current>=0) { operationFailed[current]=true; var win=error as Win32Exception; if(win!=null) operationErrors[current]=win.NativeErrorCode; }
            } finally {
                CloseAll();
                if(scratch!=null) { Array.Clear(scratch,0,scratch.Length); ClearedBytes=scratch.Length; scratch=null; }
                if(!Unknown && Opened==Closed) ops=null;
            }
            if(OperationException!=null) ExceptionDispatchInfo.Capture(OperationException).Throw();
            if(CloseException!=null) ExceptionDispatchInfo.Capture(CloseException).Throw();
            SuccessReceipt=Receipt(); Succeeded=true; binding=null;
        }
    }
    internal sealed class FaultDiagnosticNative : IFaultDiagnosticOps {
        // Full SDK union storage (Version3 is largest); only Version1+RWDepth are used.
        [StructLayout(LayoutKind.Explicit,Size=44)] internal struct OpenParameters {
            [FieldOffset(0)] public uint Version;
            [FieldOffset(4)] public uint RWDepth;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct StorageType { public uint Device; public Guid Vendor; }
        [StructLayout(LayoutKind.Explicit,Size=32)] internal struct InfoLayout {
            [FieldOffset(0)] public uint Version;
            [FieldOffset(8)] public ulong VirtualSize;
            [FieldOffset(16)] public ulong PhysicalSize;
            [FieldOffset(24)] public uint BlockSize;
            [FieldOffset(28)] public uint SectorSize;
            [FieldOffset(8)] public Guid Identifier;
            [FieldOffset(8)] public uint Subtype;
            [FieldOffset(8)] public int IsLoaded; // Win32 BOOL is four bytes.
        }
        [StructLayout(LayoutKind.Sequential)] internal struct FileInfo {
            public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Serial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct StandardInfo {
            public long Allocation,Length; public uint Links;
            public byte DeletePending,Directory; // BOOLEAN, not Win32 BOOL.
        }
        [DllImport("virtdisk.dll",CharSet=CharSet.Unicode)] static extern uint OpenVirtualDisk(ref StorageType type,string path,uint access,uint flags,ref OpenParameters parameters,out IntPtr handle);
        [DllImport("virtdisk.dll")] static extern uint GetVirtualDiskInformation(IntPtr handle,ref uint bytes,[In,Out] byte[] data,out uint used);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out FileInfo info);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle,int kind,out StandardInfo info,uint bytes);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder path,uint length,uint flags);
        internal static int NativeCalls { get; private set; }
        internal static void AssertLayout() {
            DiagnosticBinding.Need(IntPtr.Size==8 && BitConverter.IsLittleEndian
                && Marshal.SizeOf(typeof(OpenParameters))==44 && Marshal.OffsetOf(typeof(OpenParameters),"RWDepth").ToInt32()==4
                && Marshal.SizeOf(typeof(StorageType))==20 && Marshal.OffsetOf(typeof(StorageType),"Vendor").ToInt32()==4
                && Marshal.SizeOf(typeof(InfoLayout))==32 && Marshal.OffsetOf(typeof(InfoLayout),"Identifier").ToInt32()==8
                && Marshal.OffsetOf(typeof(InfoLayout),"IsLoaded").ToInt32()==8
                && Marshal.SizeOf(typeof(FileInfo))==52 && Marshal.SizeOf(typeof(StandardInfo))==24
                && Marshal.OffsetOf(typeof(StandardInfo),"DeletePending").ToInt32()==20
                && Marshal.OffsetOf(typeof(StandardInfo),"Directory").ToInt32()==21,"Diagnostic x64 ABI");
        }
        public DiagnosticOpened Open(int slot,DiagnosticOpen specification) {
            IntPtr handle;
            if(slot==2) {
                DiagnosticBinding.Need(specification.Access==0x80000 && specification.Flags==0 && specification.Version==1 && specification.RWDepth==0,"Fixed GET_INFO access");
                var type=new StorageType { Device=2,Vendor=new Guid("ec984aec-a0f9-47e9-901f-71415a66345b") };
                var parameters=new OpenParameters { Version=1,RWDepth=0 };
                NativeCalls++; uint code=OpenVirtualDisk(ref type,specification.Path,0x80000,0,ref parameters,out handle);
                return new DiagnosticOpened(code,code==0 ? handle : IntPtr.Zero); // Failure output is never inspected.
            }
            DiagnosticBinding.Need(slot==0 || slot==1 || slot==3,"Fixed file slot");
            NativeCalls++; handle=CreateFile(specification.Path,specification.Access,specification.Share,IntPtr.Zero,specification.Creation,specification.Flags,IntPtr.Zero);
            int error=handle==new IntPtr(-1) ? Marshal.GetLastWin32Error() : 0;
            if(handle==new IntPtr(-1)) return new DiagnosticOpened(error==0 ? 0xFFFFFFFFu : unchecked((uint)error),IntPtr.Zero);
            return new DiagnosticOpened(0,handle);
        }
        static void Win(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        public DiagnosticMeta Inspect(int slot,IntPtr handle) {
            DiagnosticBinding.Need(slot==0 || slot==1,"Only metadata slots");
            FileInfo file; NativeCalls++; Win(GetFileInformationByHandle(handle,out file));
            StandardInfo standard; NativeCalls++; Win(GetFileInformationByHandleEx(handle,1,out standard,24));
            var name=new StringBuilder(512); NativeCalls++; uint length=GetFinalPathNameByHandle(handle,name,512,0);
            if(length==0) throw new Win32Exception(Marshal.GetLastWin32Error(),"Final path failed");
            DiagnosticBinding.Need(length<512,"Final path exceeds fixed buffer");
            long eof=checked((long)(((ulong)file.SizeHigh<<32)|file.SizeLow));
            return new DiagnosticMeta { Id=file.Serial.ToString("X8")+":"+file.IndexHigh.ToString("X8")+file.IndexLow.ToString("X8"),
                Path=name.ToString(),Attributes=file.Attributes,Links=file.Links,Length=standard.Length,Allocation=standard.Allocation,
                Creation=((ulong)file.CreationHigh<<32)|file.CreationLow,Written=((ulong)file.WriteHigh<<32)|file.WriteLow,
                Directory=standard.Directory!=0,DeletePending=standard.DeletePending!=0,
                Consistent=file.Links==standard.Links && (((file.Attributes&0x10)!=0)==(standard.Directory!=0)) && (slot==0 || eof==standard.Length) };
        }
        public DiagnosticInfo Info(IntPtr handle,byte[] buffer) {
            DiagnosticBinding.Need(buffer!=null && buffer.Length==64,"Fixed information buffer");
            uint size=64,used; NativeCalls++; uint code=GetVirtualDiskInformation(handle,ref size,buffer,out used);
            return code==0 ? new DiagnosticInfo { Error=0,Size=size,Used=used } : new DiagnosticInfo { Error=code };
        }
        public int? Close(IntPtr handle) { NativeCalls++; if(CloseHandle(handle)) return null; return Marshal.GetLastWin32Error(); }
    }
}

