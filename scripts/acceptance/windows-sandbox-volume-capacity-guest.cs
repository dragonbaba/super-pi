// Fixed guest-only executable. Compile for the acceptance task; never run this entry on the host.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using SuperPiCapacity;

namespace SuperPiCapacityGuest {
    public interface IFillFile : IFillIo { bool CloseAttempted { get; } void Prepare(); }
    public interface IFiles { IResultSlot OpenSlot(); IFillFile CreateFill(); }
    public static class GuestRunner {
        public static int Run(Guid task,IFiles files) {
            IResultSlot slot=null; IFillFile fill=null; byte[] payload=null;
            bool fillCloseResponsibilityPassed=false,slotCloseResponsibilityPassed=false;
            int exit=CapacityProtocol.InternalFailure;
            try {
                slot=files.OpenSlot(); slot.Prepare(task);
                var result=new FillResult(); DataPhase phase=DataPhase.CreateFailed;
                try {
                    fill=files.CreateFill(); phase=DataPhase.PrepareFailed; fill.Prepare();
                    phase=DataPhase.FillInvoked; fillCloseResponsibilityPassed=true; result=FillCore.Run(fill);
                } catch(Exception error) { result.Stop=StopReason.Exception; result.OperationException=error; }
                finally {
                    if(fill!=null && !fillCloseResponsibilityPassed && !fill.CloseAttempted) {
                        fillCloseResponsibilityPassed=true;
                        try { result.Close=fill.Close(); } catch(Exception error) { result.CloseException=error; }
                    }
                }
                payload=CapacityProtocol.Final(task,phase,result);
                slotCloseResponsibilityPassed=true;
                exit=CapacityProtocol.Deliver(slot,payload).ExitCode;
                if(!slot.CloseAttempted) exit=CapacityProtocol.InternalFailure;
            } catch { exit=slot==null || payload==null ? CapacityProtocol.SetupFailed : CapacityProtocol.InternalFailure; }
            finally {
                if(payload!=null) Array.Clear(payload,0,payload.Length);
                if(fill!=null && !fillCloseResponsibilityPassed && !fill.CloseAttempted) {
                    fillCloseResponsibilityPassed=true;
                    try { fill.Close(); } catch {} exit=CapacityProtocol.InternalFailure;
                }
                if(slot!=null && !slotCloseResponsibilityPassed && !slot.CloseAttempted) {
                    slotCloseResponsibilityPassed=true;
                    try { var close=slot.Close(); if(!close.Attempted || !close.Success || close.Error!=0 || close.Requested!=0 || close.Transferred!=0) exit=CapacityProtocol.SetupCloseFailed; }
                    catch { exit=CapacityProtocol.SetupCloseFailed; }
                }
            }
            return exit; // No early return whose value could hide a later close failure.
        }
    }
    public static class Native {
        public static int Calls;
        [StructLayout(LayoutKind.Explicit,Size=24)] public struct StandardInfo {
            [FieldOffset(0)] public long AllocationSize; [FieldOffset(8)] public long EndOfFile; [FieldOffset(16)] public uint Links;
            [FieldOffset(20)] public byte DeletePending; [FieldOffset(21)] public byte Directory;
        }
        [StructLayout(LayoutKind.Sequential)] public struct AttributeInfo { public uint Attributes,Tag; }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle,int kind,out StandardInfo value,uint bytes);
        [DllImport("kernel32.dll",SetLastError=true,EntryPoint="GetFileInformationByHandleEx")] static extern bool Attributes(IntPtr handle,int kind,out AttributeInfo value,uint bytes);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr handle,byte[] bytes,uint count,out uint read,IntPtr overlapped);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr handle,byte[] bytes,uint count,out uint written,IntPtr overlapped);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(IntPtr handle,long distance,out long position,uint origin);
        static void Need(bool value,string message) { if(!value) throw new InvalidOperationException(message); }
        public static IntPtr Open(bool slot) {
            Calls++; IntPtr handle=CreateFileW(slot ? @"C:\SuperPiVolume\capacity-result.bin" : @"C:\SuperPiVolume\capacity-fill.bin",
                slot ? 0xC0000000u : 0x40000080u,0,IntPtr.Zero,slot ? 3u : 1u,0x80200080u,IntPtr.Zero);
            if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); return handle;
        }
        public static void Shape(IntPtr handle,long length) {
            StandardInfo standard; AttributeInfo attributes;
            Calls++; if(!GetFileInformationByHandleEx(handle,1,out standard,24)) throw new Win32Exception(Marshal.GetLastWin32Error());
            Calls++; if(!Attributes(handle,9,out attributes,8)) throw new Win32Exception(Marshal.GetLastWin32Error());
            CheckShape(standard,attributes,length);
        }
        public static void CheckShape(StandardInfo standard,AttributeInfo attributes,long length) {
            Need((length==0 || length==CapacityProtocol.Bytes) && standard.EndOfFile==length && standard.AllocationSize>=0 && standard.Links==1 && standard.DeletePending==0 && standard.Directory==0
                && (attributes.Attributes & 0x4E10)==0 && attributes.Tag==0,"Fixed ordinary file required");
            // Small resident NTFS content is validated by length and bytes; this is not fill-allocation evidence.
        }
        public static void Initial(IntPtr handle,Guid task) {
            Shape(handle,CapacityProtocol.Bytes); byte[] bytes=new byte[CapacityProtocol.Bytes];
            try {
                uint read; Calls++; bool ok=ReadFile(handle,bytes,(uint)bytes.Length,out read,IntPtr.Zero); int error=ok ? 0 : Marshal.GetLastWin32Error();
                if(!ok) throw new Win32Exception(error); Need(read==bytes.Length,"Short initial slot"); CapacityProtocol.CheckInitial(bytes,task);
                long position; Calls++; if(!SetFilePointerEx(handle,0,out position,0)) throw new Win32Exception(Marshal.GetLastWin32Error()); Need(position==0,"Slot rewind failed");
            } finally { Array.Clear(bytes,0,bytes.Length); }
        }
        public static IoResult Write(IntPtr handle,byte[] bytes) {
            uint written; Calls++; bool ok=WriteFile(handle,bytes,(uint)bytes.Length,out written,IntPtr.Zero);
            uint error=ok ? 0u : unchecked((uint)Marshal.GetLastWin32Error()); return IoResult.Result(ok,error,(uint)bytes.Length,written);
        }
        public static IoResult Flush(IntPtr handle) {
            Calls++; bool ok=FlushFileBuffers(handle); uint error=ok ? 0u : unchecked((uint)Marshal.GetLastWin32Error()); return IoResult.Result(ok,error,0,0);
        }
        public static IoResult Close(ref IntPtr handle,ref bool attempted) {
            Need(!attempted && handle!=IntPtr.Zero,"No handle close retry"); attempted=true;
            Calls++; bool ok=CloseHandle(handle); uint error=ok ? 0u : unchecked((uint)Marshal.GetLastWin32Error());
            if(ok) handle=IntPtr.Zero; return IoResult.Result(ok,error,0,0);
        }
    }
    sealed class Slot : IResultSlot {
        IntPtr handle; bool closeAttempted;
        public Slot() { handle=Native.Open(true); }
        public bool CloseAttempted { get { return closeAttempted; } }
        public void Prepare(Guid task) { Native.Initial(handle,task); }
        public IoResult Write(byte[] bytes) { return Native.Write(handle,bytes); }
        public IoResult Flush() { return Native.Flush(handle); }
        public IoResult Close() { return Native.Close(ref handle,ref closeAttempted); }
    }
    sealed class Fill : IFillFile {
        IntPtr handle; bool closeAttempted; readonly Stopwatch watch=new Stopwatch();
        public Fill() { handle=Native.Open(false); }
        public bool CloseAttempted { get { return closeAttempted; } }
        public void Prepare() { Native.Shape(handle,0); watch.Start(); }
        public long ElapsedMilliseconds { get { return watch.ElapsedMilliseconds; } }
        public IoResult Write(byte[] bytes) { return Native.Write(handle,bytes); }
        public IoResult Flush() { return Native.Flush(handle); }
        public IoResult Close() { return Native.Close(ref handle,ref closeAttempted); }
    }
    sealed class Files : IFiles { public IResultSlot OpenSlot() { return new Slot(); } public IFillFile CreateFill() { return new Fill(); } }
    public static class Program {
        public static int Main(string[] args) {
            Guid task;
            if(args==null || args.Length!=1 || args[0]==null || !Regex.IsMatch(args[0],@"\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z")
                || !Guid.TryParseExact(args[0],"D",out task) || task==Guid.Empty
                || !String.Equals(AppDomain.CurrentDomain.BaseDirectory,@"C:\SuperPiVolume\",StringComparison.OrdinalIgnoreCase)) return CapacityProtocol.InvalidInvocation;
            return GuestRunner.Run(task,new Files());
        }
    }
}
