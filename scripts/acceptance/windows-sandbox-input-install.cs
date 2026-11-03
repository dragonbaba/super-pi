// Optional cold acceptance partial: one original captured source and one fixed offline tool.
using System;
using System.ComponentModel;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace SuperPiVolume {
    public sealed partial class NativeDisk {
        readonly IntPtr[] inputHandles = new IntPtr[7];
        readonly bool[] inputOpenedSlots = new bool[7];
        readonly bool[] inputClosedSlots = new bool[7];
        readonly bool[] inputCloseAttempted = new bool[7];
        readonly int?[] inputCloseErrors = new int?[7];
        bool inputAttempted;
        public bool InputsInstalled { get; private set; }
        public int InputOpened { get; private set; }
        public int InputClosed { get; private set; }
        public int InputPeak { get; private set; }
        public long InputAllocated { get; private set; }
        public long InputCleared { get; private set; }
        public string InputSourceCarrierId { get; private set; }
        public string InputToolCarrierId { get; private set; }
        public string InputWorkspaceId { get; private set; }
        public string InputToolsId { get; private set; }
        public string InputSourceId { get; private set; }
        public string InputToolId { get; private set; }
        public Exception InputOperationException { get; private set; }
        public Exception InputCloseException { get; private set; }
        public int?[] InputCloseErrors { get { return (int?[])inputCloseErrors.Clone(); } }
        public string[] InputRetainedHandles {
            get { var result = new string[7]; for(int i=0;i<7;i++) if(inputOpenedSlots[i] && !inputClosedSlots[i])
                result[i]=inputHandles[i].ToInt64().ToString("X"); return result; }
        }
        void OpenInput(int slot,string name,uint access,uint share,uint creation,uint flags) {
            Need(!CloseUnknown && !inputOpenedSlots[slot] && !inputCloseAttempted[slot],"Input slot unavailable");
            IntPtr handle=CreateFile(name,access,share,IntPtr.Zero,creation,flags,IntPtr.Zero);
            if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            inputHandles[slot]=handle; inputOpenedSlots[slot]=true; InputOpened++; InputPeak=Math.Max(InputPeak,InputOpened-InputClosed);
        }
        void CloseInput(int slot) {
            if(!inputOpenedSlots[slot] || inputCloseAttempted[slot]) return;
            inputCloseAttempted[slot]=true;
            try {
                if(!CloseHandle(inputHandles[slot])) {
                    int error=Marshal.GetLastWin32Error(); inputCloseErrors[slot]=error;
                    throw new Win32Exception(error,"Input handle close unknown");
                }
                inputHandles[slot]=IntPtr.Zero; inputClosedSlots[slot]=true; InputClosed++;
            } catch(Exception failure) {
                CloseUnknown=true;
                if(InputCloseException==null) InputCloseException=failure;
                throw;
            }
        }
        string InspectInput(int slot,string expected,string parentId,bool directory,long maximum,uint pathFlags,out long length) {
            try {
                FileInfo file; StandardInfo standard;
                Win(GetFileInformationByHandle(inputHandles[slot],out file));
                Win(GetFileInformationByHandleEx(inputHandles[slot],1,out standard,(uint)Marshal.SizeOf(typeof(StandardInfo))));
                var actual=new StringBuilder(512); uint count=GetFinalPathNameByHandle(inputHandles[slot],actual,512,pathFlags);
                Win(count>0); ProbeInvariant(count<512 && String.Equals(actual.ToString(),expected,StringComparison.OrdinalIgnoreCase),"Input final path changed");
                string id=file.Serial.ToString("X8")+":"+file.IndexHigh.ToString("X8")+file.IndexLow.ToString("X8");
                ProbeInvariant(Regex.IsMatch(parentId??"",@"\A[0-9A-F]{8}:[0-9A-F]{16}\z")
                    && id.Substring(0,9)==parentId.Substring(0,9),"Input volume changed");
                ProbeInvariant((file.Attributes&0x4E00)==0 && ((file.Attributes&0x10)!=0)==directory
                    && standard.Directory==directory && !standard.DeletePending,"Input ordinary object required");
                length=standard.EndOfFile;
                if(!directory) ProbeInvariant(file.Links==1 && standard.Links==1
                    && (((long)file.SizeHigh<<32)|file.SizeLow)==length && length>=0 && length<=maximum
                    && standard.AllocationSize>=0 && standard.AllocationSize<=Capacity,"Input link/length/allocation");
                return id;
            } catch(StorageIdentityException) { throw; }
            catch(Exception error) { throw new StorageIdentityException("Input handle identity unavailable",error); }
        }
        string ReadInput(int slot,string leaf,int maximum,string expectedHash,ref byte[] bytes) {
            string name=Root+"\\"+leaf; long length;
            OpenInput(slot,name,0x80000000,1,3,0x00200000);
            string id=InspectInput(slot,@"\\?\"+name,RootId,false,maximum,0,out length);
            Need(length>0,"Empty input carrier");
            bytes=new byte[(int)length]; InputAllocated+=bytes.Length;
            uint read; bool ok=ReadFile(inputHandles[slot],bytes,(uint)bytes.Length,out read,IntPtr.Zero);
            int error=ok?0:Marshal.GetLastWin32Error(); if(!ok) throw new Win32Exception(error);
            Need(read==bytes.Length,"Short input carrier");
            using(var hash=SHA256.Create()) ProbeInvariant(BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant()==expectedHash,"Input carrier digest changed");
            ProbeInvariant(InspectInput(slot,@"\\?\"+name,RootId,false,maximum,0,out length)==id && length==bytes.Length,"Input carrier changed");
            CloseInput(slot); return id;
        }
        string CreateInputDirectory(int slot,string name,string parentId) {
            Win(CreateDirectory(name,IntPtr.Zero)); OpenInput(slot,name,0x80000000,1,3,0x02200000);
            long length; return InspectInput(slot,name,parentId,true,0,1,out length);
        }
        string WriteInput(int slot,string name,string parentId,byte[] bytes) {
            OpenInput(slot,name,0x40000080,0,1,0x80200000); long length;
            string id=InspectInput(slot,name,parentId,false,bytes.Length,1,out length);
            ProbeInvariant(length==0,"New input file is not empty"); uint written;
            bool ok=WriteFile(inputHandles[slot],bytes,(uint)bytes.Length,out written,IntPtr.Zero);
            int error=ok?0:Marshal.GetLastWin32Error(); if(!ok) throw new Win32Exception(error);
            Need(written==bytes.Length,"Short input publication"); Win(FlushFileBuffers(inputHandles[slot]));
            ProbeInvariant(InspectInput(slot,name,parentId,false,bytes.Length,1,out length)==id && length==bytes.Length,"Input publication changed");
            CloseInput(slot); return id;
        }
        public void InstallInputs(string volume,string exchangeId,string sourceSha256,string toolSha256) {
            Need(!inputAttempted && !CloseUnknown && Regex.IsMatch(sourceSha256??"", @"\A[0-9a-f]{64}\z")
                && Regex.IsMatch(toolSha256??"", @"\A[0-9a-f]{64}\z"),"One fixed input installation required");
            inputAttempted=true; byte[] source=null,tool=null; Exception operation=null,close=null;
            string exchange=volume+"exchange", workspace=exchange+"\\workspace", tools=exchange+"\\tools";
            try {
                ProbeVolumeIdentity(volume,exchangeId);
                ProbeInvariant(Fingerprint(Root,true)==RootId,"Input carrier root changed");
                InputSourceCarrierId=ReadInput(0,"input-source.bin",4096,sourceSha256,ref source);
                InputToolCarrierId=ReadInput(1,"offline-worker.exe",65536,toolSha256,ref tool);
                OpenInput(2,exchange,0x80000000,1,3,0x02200000); long length;
                ProbeInvariant(InspectInput(2,exchange,exchangeId,true,0,1,out length)==exchangeId,"Input exchange changed");
                InputWorkspaceId=CreateInputDirectory(3,workspace,exchangeId);
                InputToolsId=CreateInputDirectory(4,tools,exchangeId);
                InputSourceId=WriteInput(5,workspace+"\\source.txt",InputWorkspaceId,source);
                InputToolId=WriteInput(6,tools+"\\offline-worker.exe",InputToolsId,tool);
                ProbeInvariant(InspectInput(4,tools,exchangeId,true,0,1,out length)==InputToolsId
                    && InspectInput(3,workspace,exchangeId,true,0,1,out length)==InputWorkspaceId
                    && InspectInput(2,exchange,exchangeId,true,0,1,out length)==exchangeId,"Input directories changed");
                ProbeVolumeIdentity(volume,exchangeId);
            } catch(Exception error) { operation=error; InputOperationException=error; }
            finally {
                for(int i=6;i>=0;i--) try { CloseInput(i); } catch(Exception error) { if(close==null) close=error; }
                if(InputCloseException==null) InputCloseException=close;
                if(source!=null) { Array.Clear(source,0,source.Length); InputCleared+=source.Length; }
                if(tool!=null) { Array.Clear(tool,0,tool.Length); InputCleared+=tool.Length; }
            }
            if(operation!=null) ExceptionDispatchInfo.Capture(operation).Throw();
            if(close!=null) ExceptionDispatchInfo.Capture(close).Throw();
            InputsInstalled=true;
        }
    }
}
