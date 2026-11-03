using System;
using System.ComponentModel;
using System.Reflection;
using SuperPiVolume;

public sealed class TransientNativeCanary {
    public int Calls;
    public bool Created { get { return false; } } public string ImageId { get { return null; } }
    public bool DetachConfirmed { get { return false; } } public bool Closed { get { return false; } }
    public bool CloseUnknown { get { return false; } } public string RootId { get { return "fake-root"; } }
    public string Fingerprint(string path,bool directory) { Calls++; throw new InvalidOperationException("forbidden-native-canary"); }
}
public sealed class TransientFailingWriter : System.IO.StringWriter {
    public int Attempts;
    public override void WriteLine(string value) { Attempts++; throw new System.IO.IOException("injected-diagnostic-write"); }
}
// No NativeDisk construction or native calls; ownership transfer is exercised with fake handles.
public static class TransientChecks {
    static void Need(bool value,string message) { if(!value) throw new Exception(message); }
    static Exception Failure(Action action) { try { action(); } catch(Exception error) { return error; } throw new Exception("expected failure"); }
    static void Released(TransientOwner owner) {
        Need(!owner.Active && !owner.Unknown && owner.RetainedHandle==null && owner.Role==TransientRole.None
            && owner.OperationException==null && owner.CloseException==null && owner.CloseError==null,"known closure releases references");
    }
    public static TransientOwner UnknownOwner(int mode) {
        var owner=new TransientOwner(); owner.Claim();
        Failure(delegate { owner.Run<int>(TransientRole.Fingerprint,delegate { return new IntPtr(0x1234); },
            delegate { if(mode==2) throw new Win32Exception(5,"operation"); return 7; },
            delegate { if(mode==1) throw new InvalidOperationException("close bridge"); return mode==0 ? (int?)0 : 6; }); });
        return owner;
    }
    public static string Run() {
        int cases=0,acquisitions=0,closes=0;
        var serial=new TransientOwner(); serial.Claim();
        for(int i=1;i<=8;i++) {
            var role=(TransientRole)i; int result=serial.Run(role,delegate { acquisitions++; return new IntPtr(100+i); },
                delegate(IntPtr handle) { Need(serial.Active && serial.Role==role && serial.RetainedHandle==handle.ToInt64().ToString("X"),"immediate owned registration"); return i; },
                delegate { closes++; return null; });
            Need(result==i,"result preserved"); Released(serial); cases++;
        }
        Need(serial.Opened==8 && serial.Closed==8 && serial.CloseAttempts==8,"serial counts"); cases++;
        Need(Failure(serial.Claim) is InvalidOperationException,"no rebind"); cases++;
        foreach(IntPtr invalid in new IntPtr[]{IntPtr.Zero,new IntPtr(-1)}) {
            var owner=new TransientOwner(); int invoked=0;
            Need(Failure(delegate { owner.Run(TransientRole.ImageInfo,delegate { return invalid; },delegate { invoked++; return 0; },delegate { invoked++; return null; }); }) is ArgumentException,"invalid acquire refused");
            Need(invoked==0 && owner.Opened==0 && owner.CloseAttempts==0,"invalid result not closed"); Released(owner); cases++;
        }
        var opening=new TransientOwner(); var openError=new Win32Exception(5); int later=0;
        Need(Object.ReferenceEquals(Failure(delegate { opening.Run<int>(TransientRole.VolumeExtents,delegate { throw openError; },delegate { later++; return 0; },delegate { later++; return null; }); }),openError),"open error identity");
        Need(later==0 && opening.Opened==0 && opening.CloseAttempts==0,"open failure no undefined close"); Released(opening); cases++;
        var actionFailure=new TransientOwner(); var actionError=new Win32Exception(23); int closed=0;
        Need(Object.ReferenceEquals(Failure(delegate { actionFailure.Run<int>(TransientRole.ProbeRead,delegate { return new IntPtr(201); },
            delegate { throw actionError; },delegate { closed++; return null; }); }),actionError),"original operation preserved");
        Need(closed==1 && actionFailure.Opened==1 && actionFailure.Closed==1,"known close despite operation error"); Released(actionFailure); cases++;
        for(int mode=0;mode<3;mode++) {
            var owner=UnknownOwner(mode);
            Need(owner.Unknown && owner.Active && owner.Opened==1 && owner.Closed==0 && owner.CloseAttempts==1
                && owner.RetainedHandle=="1234" && owner.Role==TransientRole.Fingerprint && owner.Claimed,"unknown retained after constructor-shaped failure");
            Need(owner.CloseError==(mode==1 ? (int?)null : mode==0 ? 0 : 6),"close raw error including zero");
            Need(mode==1 ? owner.CloseException is InvalidOperationException : owner.CloseException is Win32Exception,"close exception distinct");
            Need(mode==2 ? owner.OperationException is Win32Exception && ((Win32Exception)owner.OperationException).NativeErrorCode==5 : owner.OperationException==null,"operation facts distinct");
            var operation=owner.OperationException; var close=owner.CloseException; int invoked=0;
            Need(Failure(delegate { owner.Run(TransientRole.Fingerprint,delegate { invoked++; return new IntPtr(202); },delegate { invoked++; return 0; },delegate { invoked++; return null; }); }) is InvalidOperationException,"unknown stops before acquisition");
            Need(Failure(owner.Claim) is InvalidOperationException,"unknown cannot be rebound");
            Need(invoked==0 && owner.CloseAttempts==1 && Object.ReferenceEquals(operation,owner.OperationException)
                && Object.ReferenceEquals(close,owner.CloseException),"blocked attempts do not replace evidence or retry"); cases++;
        }
        var simultaneous=new TransientOwner(); var primary=new Exception("operation"); var secondary=new Exception("close"); int closeCount=0;
        Need(Object.ReferenceEquals(Failure(delegate { simultaneous.Run<int>(TransientRole.Privilege,delegate { return new IntPtr(301); },
            delegate { throw primary; },delegate { closeCount++; throw secondary; }); }),primary),"operation wins without destroying close");
        Need(Object.ReferenceEquals(simultaneous.OperationException,primary) && Object.ReferenceEquals(simultaneous.CloseException,secondary)
            && simultaneous.CloseError==null && closeCount==1,"two separate exception identities"); cases++;
        object constructed=null; var callerOwned=new TransientOwner(); callerOwned.Claim();
        Failure(delegate { callerOwned.Run<int>(TransientRole.Fingerprint,delegate { return new IntPtr(401); },delegate { return 0; },delegate { return 6; }); constructed=new object(); });
        Need(constructed==null && callerOwned.Unknown && callerOwned.RetainedHandle=="191","failure before assignment retains external responsibility"); cases++;
        var reentry=new TransientOwner(); int nested=0;
        reentry.Run(TransientRole.ExchangePath,delegate { return new IntPtr(501); },delegate {
            Need(Failure(delegate { reentry.Run(TransientRole.ImageInfo,delegate { nested++; return new IntPtr(502); },delegate { return 0; },delegate { return null; }); }) is InvalidOperationException,"reentry refused"); return 0;
        },delegate { return null; });
        Need(nested==0,"reentry did not open"); Released(reentry); cases++;
        foreach(TransientRole invalid in new TransientRole[]{TransientRole.None,(TransientRole)9}) {
            var owner=new TransientOwner(); int invoked=0;
            Need(Failure(delegate { owner.Run(invalid,delegate { invoked++; return new IntPtr(601); },delegate { return 0; },delegate { return null; }); }) is ArgumentException,"fixed role required");
            Need(invoked==0,"role validation before factory"); Released(owner); cases++;
        }
        var nulls=new TransientOwner();
        Need(Failure(delegate { nulls.Run<int>(TransientRole.ImageInfo,null,delegate { return 0; },delegate { return null; }); }) is ArgumentException,"null factory"); Released(nulls); cases++;
        foreach(FieldInfo field in typeof(TransientOwner).GetFields(BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic)) {
            Need(!typeof(Delegate).IsAssignableFrom(field.FieldType) && !field.FieldType.IsArray,"no callbacks, growable list, or pool retained");
        } cases++;
        return "{\"cases\":"+cases+",\"serialOpened\":"+serial.Opened+",\"serialClosed\":"+serial.Closed+
            ",\"responsibilitySlots\":1,\"unknownCloseAttempts\":1,\"unknownAcquisitions\":0,\"nativeDiskInstances\":0,\"callbacksRetained\":0}";
    }
}

