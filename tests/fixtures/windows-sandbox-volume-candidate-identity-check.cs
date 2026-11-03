using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace CandidateIdentityCheck {
    public sealed class Observation {
        public uint ProcessId;
        public bool Opened, OperationFailed, CloseFailed, Closed;
        public int CloseAttempts;
        public string Handle, Identity, FinalPath, OperationType, OperationMessage;
        public int? OperationCode, CloseCode;
        public long Bytes;
        public uint Attributes, Links;
    }
    public static class Native {
        [StructLayout(LayoutKind.Sequential)] struct Info {
            public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
            public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
        static bool attempted;
        static IntPtr retained;
        static void Need(bool value, string message) { if(!value) throw new InvalidOperationException(message); }
        public static Observation Inspect(string file) {
            Need(!attempted, "Single metadata attempt"); attempted=true;
            Observation result=new Observation(); result.ProcessId=GetCurrentProcessId();
            try {
                Need(file!=null && file.Length<=240 && file.EndsWith(@"\identity.bin", StringComparison.Ordinal), "Fixed metadata leaf");
                // FILE_READ_ATTRIBUTES; share read/write/delete so the original Node write fd remains valid.
                IntPtr handle=CreateFile(file,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
                if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                retained=handle; result.Opened=true; result.Handle=handle.ToInt64().ToString("X");
                Info info;
                if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                result.Attributes=info.Attributes; result.Links=info.Links;
                result.Bytes=((long)info.SizeHigh<<32)|info.SizeLow;
                result.Identity=info.Serial.ToString("X8")+":"+info.IndexHigh.ToString("X8")+info.IndexLow.ToString("X8");
                Need((info.Attributes & (0x10|0x200|0x400|0x800|0x4000))==0 && info.Links==1 && result.Bytes==32, "Native regular/single-link/length/attributes");
                StringBuilder final=new StringBuilder(512);
                uint length=GetFinalPathNameByHandle(handle,final,512,0);
                if(length==0) throw new Win32Exception(Marshal.GetLastWin32Error());
                Need(length<512, "Final path bound"); result.FinalPath=final.ToString();
                Need(String.Equals(result.FinalPath,@"\\?\"+file,StringComparison.OrdinalIgnoreCase), "Native final path");
            } catch(Exception error) {
                result.OperationFailed=true; result.OperationType=error.GetType().FullName;
                result.OperationMessage=error.Message.Length<=128 ? error.Message : error.Message.Substring(0,128);
                Win32Exception win=error as Win32Exception; if(win!=null) result.OperationCode=win.NativeErrorCode;
            } finally {
                if(result.Opened) {
                    result.CloseAttempts=1;
                    if(CloseHandle(retained)) { result.Closed=true; retained=IntPtr.Zero; }
                    else { result.CloseFailed=true; result.CloseCode=Marshal.GetLastWin32Error(); }
                }
            }
            return result;
        }
    }
}
