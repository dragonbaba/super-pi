using System;
using System.ComponentModel;
using System.Text;
using SuperPiVolume;

// All operations below are memory fakes. The real adapter is never instantiated or called.
public static class FaultDiagnosticChecks {
    const string Root=@"D:\owned-task",RootId="12345678:0000000000000001",ImageId="12345678:0000000000000002";
    const string Task="11111111-1111-4111-8111-111111111111",Instance="22222222-2222-4222-8222-222222222222";
    const string Volume=@"\\?\Volume{33333333-3333-4333-8333-333333333333}\";
    static int cases,peak,retained,maximumScratch;
    static void Need(bool ok,string message) { if(!ok) throw new Exception(message); }
    static DiagnosticBinding Binding() { return new DiagnosticBinding(Root,RootId,ImageId,134218240,Task,Instance,Volume); }
    sealed class Fake : IFaultDiagnosticOps {
        public readonly int[] Opens=new int[4],Closes=new int[4],Inspects=new int[2];
        public int Calls,InfoCalls,FailOpen=-1,FailInspect=-1,FailInspectCall=1,FailInfo=-1,CloseFailure=-1,CloseThrow=-1;
        public int BadInfo=-1,InfoMode,MetaSlot=-1,MetaCall=1,MetaMode,GuidCode=2,CloseAllUnknown;
        public bool GuidOpens,OpenThrows,UndefinedHandle=true;
        public byte[] Scratch;
        public Exception Preserved=new Exception("fixed fake operation");
        public DiagnosticOpened Open(int slot,DiagnosticOpen spec) {
            Calls++; Need(Array.TrueForAll(Closes,x=>x==0),"no acquisition after any close");
            Need(slot>=0 && slot<4 && Opens[slot]++==0,"one acquisition per slot");
            Need(spec.Path==(slot==0 ? Root : slot==3 ? Volume.TrimEnd('\\') : Root+@"\task.vhd"),"exact path");
            if(slot<2) Need(spec.Access==0x80 && spec.Share==3 && spec.Creation==3 && spec.Flags==(slot==0 ? 0x02200000u : 0x00200000u),"metadata no delete share");
            if(slot==2) Need(spec.Access==0x80000 && spec.Flags==0 && spec.Version==1 && spec.RWDepth==0,"read-only VHD parameters");
            if(slot==3) Need(spec.Access==0 && spec.Share==7 && spec.Creation==3 && spec.Flags==0,"GUID query only");
            if(slot==FailOpen) { if(OpenThrows) throw Preserved; return new DiagnosticOpened(5,UndefinedHandle ? new IntPtr(999) : IntPtr.Zero); }
            if(slot==3 && !GuidOpens) return new DiagnosticOpened((uint)GuidCode,new IntPtr(999));
            return new DiagnosticOpened(0,new IntPtr(101+slot));
        }
        public DiagnosticMeta Inspect(int slot,IntPtr handle) {
            Calls++; Need(handle==new IntPtr(101+slot),"same metadata handle"); int call=++Inspects[slot];
            Need(Array.TrueForAll(Closes,x=>x==0),"metadata kept open through final check");
            if(slot==FailInspect && call==FailInspectCall) throw Preserved;
            var value=new DiagnosticMeta { Id=slot==0 ? RootId : ImageId,Path=@"\\?\"+(slot==0 ? Root : Root+@"\task.vhd"),
                Attributes=slot==0 ? 0x10u : 0u,Directory=slot==0,Links=1,Length=slot==0 ? 0 : 134218240,
                Allocation=slot==0 ? 0 : 134221824,Creation=1,Written=2,Consistent=true };
            if(slot==MetaSlot && call==MetaCall) switch(MetaMode) {
                case 0:value.Id="12345678:0000000000000003";break;
                case 1:value.Path+=@"\other";break;
                case 2:value.Attributes|=0x400;break;
                case 3:value.Attributes|=0x800;break;
                case 4:value.Attributes|=0x200;break;
                case 5:value.Attributes|=0x4000;break;
                case 6:value.Links=2;break;
                case 7:value.DeletePending=true;break;
                case 8:value.Directory=!value.Directory;break;
                case 9:value.Consistent=false;break;
                case 10:value.Length++;break;
                case 11:value.Allocation=134217727;break;
                case 12:value.Allocation=135266305;break;
                case 13:value.Written++;break;
                case 14:value.Creation++;break;
            }
            return value;
        }
        public DiagnosticInfo Info(IntPtr handle,byte[] bytes) {
            Calls++; int call=++InfoCalls;
            Need(handle==new IntPtr(103) && bytes.Length==64,"same VHD/fixed scratch");
            Need(Scratch==null || Object.ReferenceEquals(Scratch,bytes),"reuse one scratch");
            Scratch=bytes; uint version=BitConverter.ToUInt32(bytes,0);
            Need(version==new uint[]{2,1,7,13}[call-1],"fixed query order");
            for(int i=4;i<64;i++) Need(bytes[i]==0,"scratch cleared between queries");
            if(call==FailInfo) { for(int i=0;i<64;i++) bytes[i]=255; return new DiagnosticInfo { Error=87,Size=uint.MaxValue,Used=uint.MaxValue }; }
            byte[] content=version==2 ? new Guid(Task).ToByteArray() : version==1 ? BitConverter.GetBytes((ulong)134217728) : BitConverter.GetBytes(version==7 ? 2u : 0u);
            Buffer.BlockCopy(content,0,bytes,8,content.Length); Array.Clear(content,0,content.Length);
            var result=new DiagnosticInfo { Error=0,Size=64,Used=version==2 ? 24u : version==1 ? 32u : 12u };
            if(call==BadInfo) {
                if(InfoMode==0) result.Used--;
                if(InfoMode==1) result.Size=8;
                if(InfoMode==2) result.Size=65;
                if(InfoMode==3) result.Used=65;
                if(InfoMode==4) bytes[0]=99;
                if(InfoMode==5) bytes[8]^=1;
                if(InfoMode==6) bytes[9]=1; // Four-byte BOOL must not be read as one byte.
            }
            return result;
        }
        public int? Close(IntPtr handle) {
            Calls++; int slot=(int)handle.ToInt64()-101; Need(slot>=0 && slot<4,"never close undefined output");
            Need(Closes[slot]++==0,"no duplicate close");
            if(slot==CloseThrow) throw Preserved;
            return slot==CloseFailure || CloseAllUnknown!=0 ? (int?)6 : null;
        }
    }
    static FaultDiagnosticOwner Run(Fake fake,bool success) {
        var owner=new FaultDiagnosticOwner(Binding(),fake); Exception error=null;
        try { owner.Run(); } catch(Exception actual) { error=actual; }
        Need((error==null)==success && owner.Succeeded==success,"expected diagnostic outcome");
        Need(success ? owner.SuccessReceipt!=null : owner.SuccessReceipt==null,"no failed success receipt");
        Need(owner.AllocatedBytes==owner.ClearedBytes && owner.AllocatedBytes<=64,"scratch released");
        if(fake.Scratch!=null) foreach(byte b in fake.Scratch) Need(b==0,"actual scratch zero");
        Need(owner.RetainsOperations==owner.Unknown,"only unknown retains ops");
        for(int i=0;i<4;i++) {
            int expected=(i<3 && fake.Opens[i]==1 && i!=fake.FailOpen || i==3 && fake.GuidOpens && i!=fake.FailOpen) ? 1 : 0;
            Need(fake.Closes[i]==expected && fake.Closes[i]<=1,"one close per successful acquired handle");
        }
        int unresolved=0; foreach(string handle in owner.RetainedHandles) if(handle!=null) unresolved++;
        Need(unresolved==owner.Opened-owner.Closed,"unknown handle responsibility retained");
        int before=fake.Calls; bool rejected=false;
        try { owner.Run(); } catch(InvalidOperationException) { rejected=true; }
        Need(rejected && fake.Calls==before,"one-shot blocks all subsequent operations");
        peak=Math.Max(peak,owner.Peak); retained=Math.Max(retained,unresolved); maximumScratch=Math.Max(maximumScratch,owner.AllocatedBytes); cases++;
        return owner;
    }
    static string Quote(string value) { return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\n","\\n")+"\""; }
    public static string Run() {
        Need(cases==0,"fixture once"); FaultDiagnosticNative.AssertLayout();
        FaultDiagnosticOwner normal=Run(new Fake(),true);
        Need(normal.Opened==3 && normal.Closed==3 && normal.Peak==3,"normal three held handles");
        Run(new Fake { GuidCode=3 },true);
        for(int i=0;i<4;i++) {
            var f=new Fake { FailOpen=i }; var owner=Run(f,false);
            Need(owner.OperationErrors[i]==5,"raw open error retained; undefined output ignored");
            f=new Fake { FailOpen=i,OpenThrows=true }; owner=Run(f,false);
            Need(Object.ReferenceEquals(owner.OperationException,f.Preserved),"operation exception identity");
        }
        for(int i=0;i<2;i++) for(int call=1;call<=2;call++) {
            var f=new Fake { FailInspect=i,FailInspectCall=call }; var owner=Run(f,false);
            Need(Object.ReferenceEquals(owner.OperationException,f.Preserved),"metadata operation failure preserved");
        }
        for(int call=1;call<=4;call++) {
            var owner=Run(new Fake { FailInfo=call },false);
            Need(owner.OperationErrors[2]==87,"DWORD error, not last error");
            for(int mode=0;mode<=5;mode++) Run(new Fake { BadInfo=call,InfoMode=mode },false);
        }
        Run(new Fake { BadInfo=4,InfoMode=6 },false);
        for(int slot=0;slot<2;slot++) for(int mode=0;mode<10;mode++) Run(new Fake { MetaSlot=slot,MetaMode=mode },false);
        for(int mode=10;mode<=12;mode++) Run(new Fake { MetaSlot=1,MetaMode=mode },false);
        for(int slot=0;slot<2;slot++) for(int mode=0;mode<=14;mode++) {
            // Root EOF/allocation have no absolute image bounds, but every field must remain stable.
            Run(new Fake { MetaSlot=slot,MetaCall=2,MetaMode=mode },false);
        }
        Run(new Fake { GuidOpens=true },false);
        foreach(int code in new int[]{1,5,21,32}) Run(new Fake { GuidCode=code },false);
        for(int slot=0;slot<4;slot++) {
            var owner=Run(new Fake { GuidOpens=slot==3,CloseFailure=slot },false);
            Need(owner.Unknown && owner.CloseErrors[slot]==6 && owner.RetainedHandles[slot]!=null,"close raw error retains exact slot");
            var f=new Fake { GuidOpens=slot==3,CloseThrow=slot }; owner=Run(f,false);
            Need(Object.ReferenceEquals(owner.CloseException,f.Preserved),"close exception distinct");
        }
        Run(new Fake { GuidOpens=true,CloseAllUnknown=1 },false);
        var both=new Fake { FailInfo=1,CloseFailure=1 }; var failed=Run(both,false);
        Need(failed.OperationErrors[2]==87 && failed.CloseErrors[1]==6,"operation and close failures independent");
        Need(FaultDiagnosticNative.NativeCalls==0,"native adapter must never run");
        return "{\"cases\":"+cases+",\"nativeAdapterCalls\":"+FaultDiagnosticNative.NativeCalls+",\"fixedHandleSlots\":4,\"peakFakeHandles\":"+peak
            +",\"maximumUnresolvedHandles\":"+retained+",\"maximumScratchBytes\":"+maximumScratch+",\"failedClosesRetried\":0,\"receipt\":"+Quote(normal.SuccessReceipt)+"}";
    }
}

