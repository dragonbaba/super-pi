// Loaded only by the explicitly invoked, task-owned PowerShell helper. No static I/O.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.RegularExpressions;

namespace SuperPiVolume {
    public enum TransientRole { None, Fingerprint, Privilege, ImageInfo, VolumeExtents, ExchangePath, ProbeWrite, ProbeRead, DetachPresence }
    // One serial responsibility slot, owned by the caller before NativeDisk construction.
    // Unknown closure is terminal. No finalizer, retry, static registry, or retained delegates.
    public sealed class TransientOwner {
        IntPtr handle;
        bool running,claimed;
        public bool Unknown { get; private set; }
        public bool Active { get { return running || handle!=IntPtr.Zero; } }
        public bool Claimed { get { return claimed; } }
        public TransientRole Role { get; private set; }
        public string RetainedHandle { get { return handle==IntPtr.Zero ? null : handle.ToInt64().ToString("X"); } }
        public int Opened { get; private set; } public int Closed { get; private set; } public int CloseAttempts { get; private set; }
        public int? CloseError { get; private set; }
        public Exception OperationException { get; private set; } public Exception CloseException { get; private set; }
        public void Claim() { AssertAvailable(); if(claimed || Opened!=0) throw new InvalidOperationException("Fresh transient owner required"); claimed=true; }
        public void AssertAvailable() { if(Unknown || Active) throw new InvalidOperationException("Transient responsibility unresolved"); }
        public T Run<T>(TransientRole role,Func<IntPtr> acquire,Func<IntPtr,T> operation,Func<IntPtr,int?> close) {
            AssertAvailable();
            if(role<TransientRole.Fingerprint || role>TransientRole.DetachPresence || acquire==null || operation==null || close==null)
                throw new ArgumentException("Fixed transient role and operations required");
            running=true; Role=role; T result=default(T); Exception failure=null,closeFailure=null;
            try {
                IntPtr opened=acquire();
                if(opened==IntPtr.Zero || opened==new IntPtr(-1)) throw new ArgumentException("Valid acquired transient handle required");
                handle=opened; Opened++;
                result=operation(handle);
            } catch(Exception error) { failure=error; }
            finally {
                if(handle!=IntPtr.Zero) {
                    CloseAttempts++;
                    try {
                        int? error=close(handle);
                        if(error.HasValue) { CloseError=error; throw new Win32Exception(error.Value,"Transient handle close unknown"); }
                        handle=IntPtr.Zero; Closed++;
                    } catch(Exception error) { Unknown=true; closeFailure=error; }
                }
                running=false;
                if(Unknown) { OperationException=failure; CloseException=closeFailure; }
                else { Role=TransientRole.None; CloseError=null; OperationException=null; CloseException=null; }
            }
            if(failure!=null) ExceptionDispatchInfo.Capture(failure).Throw();
            if(closeFailure!=null) ExceptionDispatchInfo.Capture(closeFailure).Throw();
            return result;
        }
    }
    public sealed class StorageIdentityException : InvalidOperationException {
        public StorageIdentityException(string message) : base(message) {}
        public StorageIdentityException(string message, Exception inner) : base(message,inner) {}
    }
    public sealed partial class NativeDisk {
        public const long Capacity = 128L * 1024 * 1024;
        public const long ImageBudget = 129L * 1024 * 1024;
        public readonly string Root, Image, RootId;
        public readonly Guid Id;
        public string ImageId { get; private set; }
        public bool Created { get; private set; }
        public bool AttachAttempted { get; private set; }
        public bool DetachConfirmed { get; private set; }
        public bool Closed { get; private set; }
        public bool CloseUnknown { get; private set; }
        public int ProbeOpened { get; private set; }
        public int ProbeClosed { get; private set; }
        public bool ProbeMatched { get; private set; }
        public string ProbeFileId { get; private set; }
        public int GuestReadOpened { get; private set; }
        public int GuestReadClosed { get; private set; }
        public int GuestReadPeak { get; private set; }
        public uint GuestReadBytes { get; private set; }
        public bool GuestReadMatched { get; private set; }
        public string GuestReadFileId { get; private set; }
        public int? GuestFileCloseError { get; private set; }
        public int? GuestDirectoryCloseError { get; private set; }
        public bool GuestFileRetained { get { return guestFile != IntPtr.Zero; } }
        public bool GuestDirectoryRetained { get { return guestDirectory != IntPtr.Zero; } }
        private bool probeAttempted;
        private bool guestReadAttempted;
        private IntPtr guestFile, guestDirectory;
        private IntPtr disk;
        readonly TransientOwner transient;

        [StructLayout(LayoutKind.Sequential)] public struct StorageType { public uint DeviceId; public Guid VendorId; }
        // x64 ABI: discriminant plus 8-byte-aligned Version1 union.
        [StructLayout(LayoutKind.Explicit, Size=56)] public struct CreateParameters {
            [FieldOffset(0)] public uint Version;
            [FieldOffset(8)] public Guid UniqueId;
            [FieldOffset(24)] public ulong MaximumSize;
            [FieldOffset(32)] public uint BlockSize;
            [FieldOffset(36)] public uint SectorSize;
            [FieldOffset(40)] public IntPtr Parent;
            [FieldOffset(48)] public IntPtr Source;
        }
        [StructLayout(LayoutKind.Sequential)] struct AttachParameters { public uint Version, Reserved; }
        [StructLayout(LayoutKind.Sequential)] struct FileInfo {
            public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
            public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
        [StructLayout(LayoutKind.Sequential)] struct StandardInfo {
            public long AllocationSize, EndOfFile; public uint Links;
            [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
            [MarshalAs(UnmanagedType.U1)] public bool Directory;
        }
        [StructLayout(LayoutKind.Sequential)] struct Privilege { public uint Count; public Luid Id; public uint Attributes; }
        [DllImport("virtdisk.dll", CharSet=CharSet.Unicode)] static extern uint CreateVirtualDisk(ref StorageType type, string path, uint access, IntPtr security, uint flags, uint provider, ref CreateParameters parameters, IntPtr overlapped, out IntPtr handle);
        [DllImport("virtdisk.dll")] static extern uint AttachVirtualDisk(IntPtr handle, IntPtr security, uint flags, uint provider, ref AttachParameters parameters, IntPtr overlapped);
        [DllImport("virtdisk.dll")] static extern uint DetachVirtualDisk(IntPtr handle, uint flags, uint provider);
        [DllImport("virtdisk.dll", CharSet=CharSet.Unicode)] static extern uint GetVirtualDiskPhysicalPath(IntPtr handle, ref uint bytes, StringBuilder path);
        [DllImport("virtdisk.dll")] static extern uint GetVirtualDiskInformation(IntPtr handle, ref uint size, IntPtr data, IntPtr used);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, byte[] bytes, uint count, out uint read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out FileInfo info);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, out StandardInfo info, uint size);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder name, uint length, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr input, uint inputSize, byte[] output, uint outputSize, out uint returned, IntPtr overlapped);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string name, IntPtr security);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privilege state, uint length, IntPtr previous, IntPtr returned);

        static void Win(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        static void Code(uint code) { if (code != 0) throw new Win32Exception((int)code); }
        static void Need(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
        void TransientHealthy() { transient.AssertAvailable(); }
        int? CloseTransientNative(IntPtr handle) {
            if(!CloseHandle(handle)) return Marshal.GetLastWin32Error();
            if(transient.Role==TransientRole.ProbeWrite || transient.Role==TransientRole.ProbeRead) ProbeClosed++;
            return null;
        }
        T WithTransient<T>(TransientRole role,Func<IntPtr> acquire,Func<IntPtr,T> operation) {
            TransientHealthy();
            try { return transient.Run(role,acquire,operation,CloseTransientNative); }
            finally { if(transient.Unknown) CloseUnknown=true; }
        }
        IntPtr Open(string name, bool directory) {
            IntPtr handle = CreateFile(name, 0x80, 7, IntPtr.Zero, 3, 0x00200000u | (directory ? 0x02000000u : 0), IntPtr.Zero);
            if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return handle;
        }
        public string Fingerprint(string name, bool directory) {
            return WithTransient(TransientRole.Fingerprint,delegate { return Open(name,directory); },delegate(IntPtr handle) {
                FileInfo info; Win(GetFileInformationByHandle(handle, out info));
                Need((info.Attributes & 0x400) == 0 && ((info.Attributes & 0x10) != 0) == directory, "Unexpected reparse/type");
                if (!directory) Need(info.Links == 1, "Unexpected hardlinks");
                return info.Serial.ToString("X8") + ":" + info.IndexHigh.ToString("X8") + info.IndexLow.ToString("X8");
            });
        }
        public NativeDisk(string root, Guid id, TransientOwner transientOwner) {
            if(transientOwner==null) throw new ArgumentNullException("transientOwner");
            transient=transientOwner; transient.Claim();
            Need(IntPtr.Size == 8 && id != Guid.Empty, "x64 and a task disk ID required");
            Root = Path.GetFullPath(root).TrimEnd('\\'); Id = id; Image = Path.Combine(Root, "task.vhd");
            Need(Root == root && Regex.IsMatch(root, @"^[A-Za-z]:\\") && root.Length <= 180, "Canonical private local root required");
            for (string part = root; part != null; part = Path.GetDirectoryName(part)) {
                FileAttributes attributes = File.GetAttributes(part);
                Need((attributes & (FileAttributes.ReparsePoint | FileAttributes.Compressed | FileAttributes.Encrypted)) == 0, "Redirected/compressed/encrypted image parent");
            }
            DriveInfo drive = new DriveInfo(Path.GetPathRoot(root));
            Need(drive.DriveFormat == "NTFS" && drive.AvailableFreeSpace >= ImageBudget + 32L * 1024 * 1024, "Host volume precondition");
            RootId = Fingerprint(Root, true);
            Need(!File.Exists(Image) && !Directory.Exists(Image), "Image must be new");
        }
        public void EnableTaskPrivilege() {
            WithTransient(TransientRole.Privilege,delegate { IntPtr token; Win(OpenProcessToken(GetCurrentProcess(),0x28,out token)); return token; },delegate(IntPtr token) {
                Luid id; Win(LookupPrivilegeValue(null, "SeManageVolumePrivilege", out id));
                Privilege privilege = new Privilege { Count = 1, Id = id, Attributes = 2 };
                Win(AdjustTokenPrivileges(token, false, ref privilege, 0, IntPtr.Zero, IntPtr.Zero));
                Code((uint)Marshal.GetLastWin32Error()); // ERROR_NOT_ALL_ASSIGNED also fails.
                return 0;
            });
        }
        public void Create() {
            Need(!Created && disk == IntPtr.Zero && Fingerprint(Root, true) == RootId, "Creation state/identity");
            StorageType type = new StorageType { DeviceId = 2, VendorId = new Guid("ec984aec-a0f9-47e9-901f-71415a66345b") };
            CreateParameters parameters = new CreateParameters { Version = 1, UniqueId = Id, MaximumSize = (ulong)Capacity, SectorSize = 512 };
            IntPtr result; uint code = CreateVirtualDisk(ref type, Image, 0x001E0000, IntPtr.Zero, 1, 0, ref parameters, IntPtr.Zero, out result);
            Code(code); disk = result; Created = true; // Do not use undefined out handle on failure.
            ImageId = Fingerprint(Image, false); VerifyImage();
        }
        byte[] Info(uint version) {
            Need(disk != IntPtr.Zero && !CloseUnknown, "Management handle unavailable");
            IntPtr data = Marshal.AllocHGlobal(64);
            try {
                for (int i=0; i<64; i++) Marshal.WriteByte(data, i, 0);
                Marshal.WriteInt32(data, (int)version); uint size=64; Code(GetVirtualDiskInformation(disk, ref size, data, IntPtr.Zero));
                byte[] bytes=new byte[64]; Marshal.Copy(data, bytes, 0, 64); return bytes;
            } finally { Marshal.FreeHGlobal(data); }
        }
        public void VerifyImage() {
            Need(Created && !Closed && Fingerprint(Root, true) == RootId && Fingerprint(Image, false) == ImageId, "Image identity changed");
            FileInfoHandleCheck();
            byte[] identifier=Info(2), guid=new byte[16]; Array.Copy(identifier,8,guid,0,16);
            Need(new Guid(guid)==Id && BitConverter.ToInt64(Info(1),8)==Capacity && BitConverter.ToUInt32(Info(7),8)==2, "VHD identifier/size/fixed subtype changed");
        }
        void FileInfoHandleCheck() {
            TransientHealthy(); FileAttributes attributes=File.GetAttributes(Image);
            WithTransient(TransientRole.ImageInfo,delegate { return Open(Image,false); },delegate(IntPtr handle) {
                StandardInfo info; Win(GetFileInformationByHandleEx(handle,1,out info,(uint)Marshal.SizeOf(typeof(StandardInfo))));
                Need((attributes & (FileAttributes.Compressed|FileAttributes.Encrypted|FileAttributes.SparseFile))==0 && !info.Directory
                    && !info.DeletePending && info.Links==1 && info.EndOfFile>=Capacity && info.EndOfFile<=ImageBudget
                    && info.AllocationSize>=Capacity && info.AllocationSize<=ImageBudget,"Fixed image allocation/size precondition");
                return 0;
            });
        }
        public void Attach() {
            VerifyImage(); Need(!AttachAttempted, "No attachment retries"); AttachAttempted=true;
            AttachParameters parameters=new AttachParameters { Version=1 };
            Code(AttachVirtualDisk(disk, IntPtr.Zero, 2, 0, ref parameters, IntPtr.Zero)); // No drive letter, not permanent.
        }
        public string PhysicalPath() {
            VerifyImage(); uint bytes=512; StringBuilder result=new StringBuilder(256);
            Code(GetVirtualDiskPhysicalPath(disk, ref bytes, result));
            Need(Regex.IsMatch(result.ToString(), @"^\\\\\.\\PhysicalDrive[0-9]+$"), "Unexpected physical path"); return result.ToString();
        }
        public void VerifyVolume(string volume, uint diskNumber, long offset, long length) {
            Need(Regex.IsMatch(volume, @"^\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\$"), "Volume GUID path required");
            WithTransient(TransientRole.VolumeExtents,delegate {
                IntPtr handle=CreateFile(volume.TrimEnd('\\'),0,7,IntPtr.Zero,3,0,IntPtr.Zero);
                if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); return handle;
            },delegate(IntPtr handle) {
                byte[] bytes=new byte[64]; uint returned;
                Win(DeviceIoControl(handle,0x00560000,IntPtr.Zero,0,bytes,64,out returned,IntPtr.Zero));
                Need(returned>=32 && BitConverter.ToUInt32(bytes,0)==1 && BitConverter.ToUInt32(bytes,8)==diskNumber
                    && BitConverter.ToInt64(bytes,16)==offset && BitConverter.ToInt64(bytes,24)==length,"Volume extents differ from owned partition");
                return 0;
            });
        }
        public string CreateExchange(string volume) {
            TransientHealthy();
            string exchange=volume+"exchange"; Win(CreateDirectory(exchange,IntPtr.Zero));
            return Fingerprint(exchange,true);
        }
        public void VerifyExchange(string volume, string expected) {
            string exchange=volume+"exchange";
            Need(Fingerprint(exchange,true)==expected,"Exchange identity changed");
            WithTransient(TransientRole.ExchangePath,delegate { return Open(exchange,true); },delegate(IntPtr handle) {
                StringBuilder name=new StringBuilder(512); uint count=GetFinalPathNameByHandle(handle,name,512,1);
                Win(count>0); Need(count<512 && String.Equals(name.ToString().TrimEnd('\\'),exchange,StringComparison.OrdinalIgnoreCase),"Exchange resolves outside owned volume");
                return 0;
            });
        }
        string ProbeIdentity(IntPtr handle, uint expectedSize) {
            try {
                FileInfo info; Win(GetFileInformationByHandle(handle,out info));
                ProbeInvariant((info.Attributes & 0x410)==0 && info.Links==1 && info.SizeHigh==0 && info.SizeLow==expectedSize,"Probe file type/length changed");
                return info.Serial.ToString("X8")+":"+info.IndexHigh.ToString("X8")+info.IndexLow.ToString("X8");
            } catch(StorageIdentityException) { throw; }
            catch(Exception error) { throw new StorageIdentityException("Probe file identity unavailable",error); }
        }
        static void ProbeInvariant(bool ok, string message) { if(!ok) throw new StorageIdentityException(message); }
        void ProbeVolumeIdentity(string volume, string exchangeId) {
            try { VerifyImage(); VerifyExchange(volume,exchangeId); }
            catch(Exception error) { throw new StorageIdentityException("Probe volume identity unavailable",error); }
        }
        public void ProbeExchange(string volume, string exchangeId) {
            Need(!probeAttempted && !CloseUnknown,"No probe retry"); probeAttempted=true;
            ProbeVolumeIdentity(volume,exchangeId);
            string file=volume+"exchange\\native-control.bin";
            byte[] expected=Encoding.ASCII.GetBytes(Id.ToString("N"));
            try {
                WithTransient(TransientRole.ProbeWrite,delegate {
                    IntPtr writer=CreateFile(file,0x40000080,0,IntPtr.Zero,1,0x00200000,IntPtr.Zero);
                    if(writer==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); ProbeOpened++; return writer;
                },delegate(IntPtr writer) {
                    ProbeIdentity(writer,0); uint written;
                    Win(WriteFile(writer,expected,(uint)expected.Length,out written,IntPtr.Zero));
                    Need(written==32,"Short probe write"); Win(FlushFileBuffers(writer));
                    ProbeFileId=ProbeIdentity(writer,32); return 0;
                });
                ProbeVolumeIdentity(volume,exchangeId);
                WithTransient(TransientRole.ProbeRead,delegate {
                    IntPtr reader=CreateFile(file,0x80000000,0,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
                    if(reader==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); ProbeOpened++; return reader;
                },delegate(IntPtr reader) {
                    byte[] actual=new byte[32];
                    try {
                        ProbeInvariant(ProbeIdentity(reader,32)==ProbeFileId,"Probe identity changed before read");
                        uint read; Win(ReadFile(reader,actual,32,out read,IntPtr.Zero)); Need(read==32,"Short probe read");
                        for(int i=0;i<32;i++) ProbeInvariant(actual[i]==expected[i],"Probe bytes differ");
                        ProbeInvariant(ProbeIdentity(reader,32)==ProbeFileId,"Probe identity changed after read"); return 0;
                    } finally { Array.Clear(actual,0,actual.Length); }
                });
            } finally { Array.Clear(expected,0,expected.Length); }
            ProbeVolumeIdentity(volume,exchangeId); ProbeMatched=true;
        }
        // Pure, bounded checks are also exercised without constructing NativeDisk or calling Win32.
        static byte[] GuestMarker(Guid taskId) {
            Need(taskId!=Guid.Empty,"Task marker identity");
            return Encoding.ASCII.GetBytes(taskId.ToString("N").Substring(0,30)+"\r\n");
        }
        static void GuestShape(uint attributes, uint links, ulong size, bool deletePending, bool directory,
            string actualPath, string expectedPath, string actualId, string exchangeId, bool parent) {
            ProbeInvariant((attributes & 0x4E00)==0 && ((attributes & 0x10)!=0)==parent && directory==parent
                && !deletePending,"Guest read reparse/type/attributes/delete state");
            ProbeInvariant(String.Equals(actualPath,expectedPath,StringComparison.OrdinalIgnoreCase),"Guest read final GUID path differs");
            ProbeInvariant(Regex.IsMatch(actualId,@"\A[0-9A-F]{8}:[0-9A-F]{16}\z")
                && Regex.IsMatch(exchangeId,@"\A[0-9A-F]{8}:[0-9A-F]{16}\z"),"Guest read identity shape");
            ProbeInvariant(parent ? actualId==exchangeId : links==1 && size==32 && actualId.Substring(0,9)==exchangeId.Substring(0,9),
                "Guest read parent/volume/link/length identity");
        }
        string GuestIdentity(IntPtr handle, bool parent, string expectedPath, string exchangeId) {
            try {
                FileInfo info; StandardInfo standard;
                Win(GetFileInformationByHandle(handle,out info));
                Win(GetFileInformationByHandleEx(handle,1,out standard,(uint)Marshal.SizeOf(typeof(StandardInfo))));
                StringBuilder name=new StringBuilder(512); uint count=GetFinalPathNameByHandle(handle,name,512,1);
                Win(count>0); ProbeInvariant(count<512,"Guest final path exceeds bound");
                string identity=info.Serial.ToString("X8")+":"+info.IndexHigh.ToString("X8")+info.IndexLow.ToString("X8");
                ulong size=((ulong)info.SizeHigh<<32)|info.SizeLow;
                GuestShape(info.Attributes,info.Links,size,standard.DeletePending,standard.Directory,name.ToString(),expectedPath,identity,exchangeId,parent);
                ProbeInvariant(parent || standard.EndOfFile==32 && standard.Links==1,"Guest standard length/link changed");
                return identity;
            } catch(StorageIdentityException) { throw; }
            catch(Exception error) { throw new StorageIdentityException("Guest read handle identity unavailable",error); }
        }
        void CloseGuestHandle(bool parent) {
            IntPtr handle=parent ? guestDirectory : guestFile;
            if(handle==IntPtr.Zero) return;
            if(!CloseHandle(handle)) {
                int error=Marshal.GetLastWin32Error(); CloseUnknown=true;
                if(parent) GuestDirectoryCloseError=error; else GuestFileCloseError=error;
                throw new Win32Exception(error,"Guest read handle close unknown"); // Retain the exact handle; never retry.
            }
            if(parent) guestDirectory=IntPtr.Zero; else guestFile=IntPtr.Zero;
            GuestReadClosed++;
        }
        static void ThrowGuestFailure(Exception operation, Exception fileClose, Exception directoryClose) {
            Exception first=operation ?? fileClose ?? directoryClose;
            if(first!=null) ExceptionDispatchInfo.Capture(first).Throw();
        }
        public void ReadGuestExchange(string volume, string exchangeId) {
            Need(!guestReadAttempted && !CloseUnknown,"No guest read retry"); guestReadAttempted=true;
            ProbeInvariant(volume!=null && volume.Length==49 && Regex.IsMatch(volume,@"\A\\\\\?\\Volume\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}\\\z"),"Guest canonical volume GUID required");
            ProbeVolumeIdentity(volume,exchangeId);
            string exchange=volume+"exchange", file=exchange+"\\guest-control.bin";
            byte[] expected=GuestMarker(Id), actual=new byte[32];
            Exception operationFailure=null, fileCloseFailure=null, directoryCloseFailure=null;
            try {
                IntPtr opened=CreateFile(exchange,0x80000000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
                if(opened==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                guestDirectory=opened; GuestReadOpened++; GuestReadPeak=1;
                GuestIdentity(guestDirectory,true,exchange,exchangeId);
                opened=CreateFile(file,0x80000000,0,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
                if(opened==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                guestFile=opened; GuestReadOpened++; GuestReadPeak=2;
                GuestReadFileId=GuestIdentity(guestFile,false,file,exchangeId);
                uint count; bool ok=ReadFile(guestFile,actual,32,out count,IntPtr.Zero);
                GuestReadBytes=count; Win(ok); Need(count==32,"Short guest read");
                for(int i=0;i<32;i++) Need(actual[i]==expected[i],"Guest marker differs");
                ProbeInvariant(GuestIdentity(guestFile,false,file,exchangeId)==GuestReadFileId,"Guest file identity changed after read");
                GuestIdentity(guestDirectory,true,exchange,exchangeId);
            } catch(Exception error) { operationFailure=error; }
            finally {
                try {
                    try { CloseGuestHandle(false); } catch(Exception error) { fileCloseFailure=error; }
                    finally { try { CloseGuestHandle(true); } catch(Exception error) { directoryCloseFailure=error; } }
                }
                finally { Array.Clear(actual,0,actual.Length); Array.Clear(expected,0,expected.Length); }
            }
            ThrowGuestFailure(operationFailure,fileCloseFailure,directoryCloseFailure);
            ProbeVolumeIdentity(volume,exchangeId); GuestReadMatched=true;
        }
        public void Detach() { VerifyImage(); Need(AttachAttempted && !DetachConfirmed,"Detach state"); Code(DetachVirtualDisk(disk,0,0)); }
        public void ConfirmDetached(bool volumeRecorded, string volume) {
            Need(!CloseUnknown && BitConverter.ToUInt32(Info(13),8)==0,"Attachment or business handles unresolved");
            if(volumeRecorded) {
                Need(Regex.IsMatch(volume,@"^\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\$"),"Recorded volume GUID required");
                try {
                    WithTransient<int>(TransientRole.DetachPresence,delegate {
                        IntPtr handle=CreateFile(volume.TrimEnd('\\'),0,7,IntPtr.Zero,3,0,IntPtr.Zero);
                        if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); return handle;
                    },delegate(IntPtr handle) { throw new InvalidOperationException("Recorded volume is still available"); });
                } catch(Win32Exception error) {
                    if(CloseUnknown || transient.Unknown || (error.NativeErrorCode!=2 && error.NativeErrorCode!=3 && error.NativeErrorCode!=55 && error.NativeErrorCode!=1167))
                        throw new InvalidOperationException("Volume absence not proven; query error retained",error);
                }
            } else Need(String.IsNullOrEmpty(volume),"Unexpected unrecorded volume path");
            DetachConfirmed=true;
        }
        public void CloseManagement() {
            Need(Created && (!AttachAttempted || DetachConfirmed) && !CloseUnknown,"Attachment/close unresolved");
            if(Closed) return;
            if(!CloseHandle(disk)) { CloseUnknown=true; throw new Win32Exception(Marshal.GetLastWin32Error()); }
            disk=IntPtr.Zero; Closed=true;
        }
        public void ConfirmNoCreatedImage() {
            Need(!Created && disk==IntPtr.Zero && !CloseUnknown && Fingerprint(Root,true)==RootId,"Uncreated image/root state unknown");
            try { File.GetAttributes(Image); }
            catch(FileNotFoundException) { return; } // Only an explicit leaf-not-found result proves absence.
            throw new InvalidOperationException("Partial creation exists or absence is not proven");
        }
        public void DeleteOwnedImage() {
            Need(Closed && !CloseUnknown && Fingerprint(Root,true)==RootId && Fingerprint(Image,false)==ImageId,"Deletion identity/state");
            File.Delete(Image); Need(!File.Exists(Image),"Image deletion incomplete");
        }
        // No finalizer/dispose auto-detach: unknown states retain the helper and ownership.
        // OS termination still closes the handle; parent treats unexpected helper close as unsafe.
    }
}
