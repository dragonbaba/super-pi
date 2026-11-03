using System;
using System.ComponentModel;
using System.Security.Cryptography;
using SuperPiVolume;

// This fixture constructs only pure capture/ledger objects, never NativeDisk.
public static class CandidateManifestChecks {
    const string Root=@"D:\owned-task",RootId="12345678:0000000000000001";
    const string Volume=@"\\?\Volume{12345678-1234-4567-89ab-123456789abc}\";
    const string ExchangeId="87654321:0000000000000001",SourceId="87654321:0000000000000002",CarrierId="12345678:0000000000000002";
    static int cases,peakFakeHandles,maximumBuffer,maximumRetained,failedCloseRetries;
    static void Need(bool value,string message) { if(!value) throw new Exception(message); }
    static ManifestBinding Binding() { return new ManifestBinding(Root,RootId,Volume,ExchangeId); }
    static string Hash(byte[] bytes) { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
    sealed class Fake : IManifestOps {
        public readonly byte[] Source;
        public byte[] Carrier=new byte[0],ObservedBuffer;
        public readonly int[] Opens=new int[3],Closes=new int[3],Inspections=new int[3];
        public readonly int?[] CloseErrors=new int?[3];
        public readonly Exception[] CloseThrows=new Exception[3];
        public int VerifyCalls,ReadCalls,WriteCalls,FlushCalls,FailVerify,FailOpen=-1;
        public ManifestIo? ReadOverride,WriteOverride,FlushOverride;
        public Exception ReadThrows;
        public Func<int,int,ManifestMeta,ManifestMeta> Change;
        public Fake(int bytes) { Source=new byte[bytes]; for(int i=0;i<bytes;i++) Source[i]=(byte)(i%251); }
        public void VerifyBinding() { VerifyCalls++; if(VerifyCalls==FailVerify) throw new StorageIdentityException("fake binding changed"); }
        public IntPtr Open(int slot,ManifestOpen spec) {
            Need(slot>=0 && slot<3,"fixed slot");
            string expected=slot==0 ? Volume+"exchange" : slot==1 ? Volume+@"exchange\candidates.json" : Root+@"\candidate-manifest.bin";
            Need(spec.Path==expected,"fixed path");
            Need(spec.Access==(slot==2 ? 0x40000080u : 0x80000000u),"required access only");
            Need(spec.Share==(slot==0 ? 1u : 0u),"parent read share, exclusive leaves");
            Need(spec.Creation==(slot==2 ? 1u : 3u),"existing source/new private carrier");
            Need(spec.Flags==(slot==0 ? 0x02200000u : slot==1 ? 0x00200000u : 0x80200000u),"reparse/write-through flags");
            if(slot==2) Need(Closes[0]==1 && Closes[1]==1,"source handles closed before output");
            if(slot==FailOpen) throw new Win32Exception(5,"fake open failed");
            Opens[slot]++; return new IntPtr(101+slot);
        }
        public ManifestMeta Inspect(int slot,IntPtr handle) {
            Need(handle==new IntPtr(101+slot),"same inspected handle");
            int call=++Inspections[slot];
            var value=new ManifestMeta { Id=slot==0 ? ExchangeId : slot==1 ? SourceId : CarrierId,
                Path=slot==0 ? Volume+"exchange" : slot==1 ? Volume+@"exchange\candidates.json" : @"\\?\"+Root+@"\candidate-manifest.bin",
                Attributes=slot==0 ? 0x10u : 0u,Directory=slot==0,Links=1,Length=slot==1 ? Source.Length : slot==2 ? Carrier.Length : 0,
                Allocation=0,Creation=1,WriteTime=2,Consistent=true };
            return Change==null ? value : Change(slot,call,value);
        }
        public ManifestIo Read(IntPtr handle,byte[] bytes) {
            Need(handle==new IntPtr(102),"source read handle"); ReadCalls++; ObservedBuffer=bytes;
            if(ReadThrows!=null) throw ReadThrows;
            ManifestIo result=ReadOverride ?? new ManifestIo(true,null,(uint)bytes.Length);
            Buffer.BlockCopy(Source,0,bytes,0,Math.Min(bytes.Length,Math.Min(Source.Length,(int)Math.Min(result.Count,4096u))));
            return result;
        }
        public ManifestIo Write(IntPtr handle,byte[] bytes) {
            Need(handle==new IntPtr(103),"carrier write handle"); WriteCalls++;
            ManifestIo result=WriteOverride ?? new ManifestIo(true,null,(uint)bytes.Length);
            int count=Math.Min(bytes.Length,(int)Math.Min(result.Count,4096u)); Carrier=new byte[count]; Buffer.BlockCopy(bytes,0,Carrier,0,count); return result;
        }
        public ManifestIo Flush(IntPtr handle) { Need(handle==new IntPtr(103),"carrier flush handle"); FlushCalls++; return FlushOverride ?? new ManifestIo(true,null,0); }
        public int? Close(IntPtr handle) {
            int slot=(int)handle.ToInt64()-101; Need(slot>=0 && slot<3,"owned close handle"); Closes[slot]++;
            if(CloseThrows[slot]!=null) throw CloseThrows[slot]; return CloseErrors[slot];
        }
    }
    static ManifestCapture Run(Fake fake,bool accepted,bool identity) {
        var capture=new ManifestCapture(Binding(),fake); Exception failure=null;
        try { capture.Run(); } catch(Exception error) { failure=error; }
        Need((failure==null)==accepted && capture.Captured==accepted,"capture outcome");
        if(identity) Need(failure is StorageIdentityException,"typed identity failure");
        Need(capture.AllocatedBytes==capture.ClearedBytes && capture.AllocatedBytes<=4096,"bounded scratch cleared");
        if(fake.ObservedBuffer!=null) foreach(byte value in fake.ObservedBuffer) Need(value==0,"actual scratch zeroed");
        Need(capture.RetainsOperations==capture.Handles.Unknown,"only unresolved handles retain callback");
        int retained=0;
        for(int i=0;i<3;i++) {
            Need(fake.Closes[i]==fake.Opens[i],"each opened fake handle has exactly one close attempt");
            Need(fake.Closes[i]<=1,"no close retry");
            if(capture.Handles.Retained[i]!=null) retained++;
        }
        Need(retained==capture.Handles.Opened-capture.Handles.Closed,"exact unresolved slots");
        peakFakeHandles=Math.Max(peakFakeHandles,capture.Handles.Peak); maximumRetained=Math.Max(maximumRetained,retained);
        maximumBuffer=Math.Max(maximumBuffer,capture.AllocatedBytes);
        int calls=fake.VerifyCalls+fake.ReadCalls+fake.WriteCalls+fake.FlushCalls;
        for(int i=0;i<3;i++) calls+=fake.Opens[i]+fake.Closes[i]+fake.Inspections[i];
        bool repeated=false; try { capture.Run(); } catch(InvalidOperationException) { repeated=true; }
        Need(repeated,"second capture rejected");
        int after=fake.VerifyCalls+fake.ReadCalls+fake.WriteCalls+fake.FlushCalls;
        for(int i=0;i<3;i++) after+=fake.Opens[i]+fake.Closes[i]+fake.Inspections[i];
        Need(after==calls,"no operations on retry");
        capture.Handles.CloseRange(0,2);
        for(int i=0;i<3;i++) { Need(fake.Closes[i]<=1,"cleanup never retries failed close"); if(fake.Closes[i]>1) failedCloseRetries++; }
        cases++; return capture;
    }
    static void RejectBinding(string root,string rootId,string volume,string exchangeId) {
        bool refused=false; try { new ManifestBinding(root,rootId,volume,exchangeId); } catch(StorageIdentityException) { refused=true; }
        Need(refused,"invalid binding refused"); cases++;
    }
    public static string Run() {
        cases=peakFakeHandles=maximumBuffer=maximumRetained=failedCloseRetries=0;
        foreach(int bytes in new int[]{1,32,4096}) {
            var fake=new Fake(bytes); var result=Run(fake,true,false);
            Need(result.Handles.Opened==3 && result.Handles.Closed==3 && result.Handles.Peak==2,"normal handle counters");
            Need(result.SourceId==SourceId && result.CarrierId==CarrierId && result.Bytes==bytes,"capture identities");
            Need(result.Sha256==Hash(fake.Source) && result.Sha256==Hash(fake.Carrier),"captured bytes hash");
            Need(fake.VerifyCalls==3 && fake.ReadCalls==1 && fake.WriteCalls==1 && fake.FlushCalls==1,"fixed sequence");
        }
        var empty=new Fake(0); var emptyResult=Run(empty,false,false);
        Need(emptyResult.OperationException!=null && !(emptyResult.OperationException is StorageIdentityException) && empty.ReadCalls==0 && empty.Opens[2]==0,"empty invalid data");
        Run(new Fake(4097),false,true);
        foreach(uint attribute in new uint[]{0x400,0x200,0x800,0x4000}) {
            var fake=new Fake(32); fake.Change=delegate(int slot,int call,ManifestMeta value) { if(slot==1) value.Attributes|=attribute; return value; }; Run(fake,false,true);
        }
        for(int kind=0;kind<13;kind++) {
            int current=kind; var fake=new Fake(32);
            fake.Change=delegate(int slot,int call,ManifestMeta value) {
                if(slot!=1) return value;
                switch(current) {
                    case 0: value.Links=2; break;
                    case 1: value.Length=-1; break;
                    case 2: value.Allocation=-1; break;
                    case 3: value.Directory=true; break;
                    case 4: value.Attributes=0x10; break;
                    case 5: value.DeletePending=true; break;
                    case 6: value.Path+=".other"; break;
                    case 7: value.Id="12345678:0000000000000002"; break;
                    case 8: value.Id=ExchangeId; break;
                    case 9: value.Consistent=false; break;
                    case 10: value.Id="invalid"; break;
                    case 11: if(call==2) value.WriteTime++; break;
                    case 12: if(call==2) value.Id="87654321:0000000000000003"; break;
                } return value;
            }; Run(fake,false,true);
        }
        for(int slot=0;slot<3;slot+=2) {
            int current=slot; var fake=new Fake(32);
            fake.Change=delegate(int i,int call,ManifestMeta value) { if(i==current && call==2) value.Id=current==0 ? "87654321:0000000000000009" : "12345678:0000000000000009"; return value; };
            Run(fake,false,true);
        }
        for(int kind=0;kind<3;kind++) {
            int current=kind; var fake=new Fake(32);
            fake.Change=delegate(int slot,int call,ManifestMeta value) {
                if(slot==2 && (current==0 && call==1 || current>0 && call==2)) {
                    if(current==0) value.Length=1; if(current==1) value.Length=31; if(current==2) value.Path=Root+@"\candidate-manifest.bin";
                } return value;
            }; Run(fake,false,true);
        }
        foreach(ManifestIo value in new ManifestIo[]{new ManifestIo(false,5,0),new ManifestIo(false,0,0),new ManifestIo(false,null,0),new ManifestIo(true,null,31),new ManifestIo(true,5,32)}) {
            var fake=new Fake(32); fake.ReadOverride=value; var result=Run(fake,false,false);
            Need(result.ReadResult.Value.Error==value.Error && result.ReadResult.Value.Count==value.Count && fake.Opens[2]==0,"read raw result preserved");
        }
        foreach(ManifestIo value in new ManifestIo[]{new ManifestIo(false,112,0),new ManifestIo(true,null,31)}) {
            var fake=new Fake(32); fake.WriteOverride=value; var result=Run(fake,false,false);
            Need(result.WriteResult.Value.Error==value.Error && result.WriteResult.Value.Count==value.Count && fake.FlushCalls==0,"write result preserved");
        }
        var flush=new Fake(32); flush.FlushOverride=new ManifestIo(false,5,0); var flushResult=Run(flush,false,false);
        Need(flushResult.FlushResult.Value.Error==5,"flush raw result preserved");
        for(int ordinal=1;ordinal<=3;ordinal++) { var fake=new Fake(32); fake.FailVerify=ordinal; var result=Run(fake,false,true); Need(fake.VerifyCalls==ordinal,"binding refusal stops"); }
        for(int slot=0;slot<3;slot++) { var fake=new Fake(32); fake.FailOpen=slot; Run(fake,false,false); }
        var thrown=new Fake(32); var operation=new Exception("read bridge threw"); thrown.ReadThrows=operation;
        Need(Object.ReferenceEquals(Run(thrown,false,false).OperationException,operation),"operation exception identity");
        for(int slot=0;slot<3;slot++) {
            var fake=new Fake(32); fake.CloseErrors[slot]=slot==1 ? 0 : 6;
            var result=Run(fake,false,false);
            Need(result.OperationException==null && result.CloseException is Win32Exception,"close distinct from operation");
            Need(result.Handles.Errors[slot]==fake.CloseErrors[slot] && result.Handles.Retained[slot]==(101+slot).ToString("X"),"raw close zero/identity retained");
            if(slot<2) Need(fake.Opens[2]==0,"source close failure blocks carrier");
            var copy=result.Handles.Retained; copy[slot]=null; var errors=result.Handles.Errors; errors[slot]=999;
            Need(result.Handles.Retained[slot]!=null && result.Handles.Errors[slot]==fake.CloseErrors[slot],"ledger copies isolated");
        }
        var combined=new Fake(32); combined.ReadThrows=operation; var closeException=new Exception("close bridge threw");
        combined.CloseThrows[1]=closeException; combined.CloseErrors[0]=6;
        var combinedResult=Run(combined,false,false);
        Need(Object.ReferenceEquals(combinedResult.OperationException,operation) && Object.ReferenceEquals(combinedResult.CloseException,closeException),"operation and close independently retained");
        Need(combinedResult.Handles.Errors[1]==null && combinedResult.Handles.Errors[0]==6 && combinedResult.Handles.Opened==2 && combinedResult.Handles.Closed==0,"thrown close not fabricated as native code");
        RejectBinding(@"\\server\share",RootId,Volume,ExchangeId);
        RejectBinding(Root,RootId,@"D:\",ExchangeId);
        RejectBinding(Root+"\\",RootId,Volume,ExchangeId);
        RejectBinding(Root,RootId.ToLowerInvariant(),Volume,ExchangeId+"x");
        Need(NativeDisk.CandidateManifestNativeOperations==0,"no native manifest adapter operation invoked");
        return "{\"cases\":"+cases+",\"nativeDiskInstances\":0,\"nativeAdapterCalls\":0,\"fixedHandleSlots\":3,\"peakFakeHandles\":"+peakFakeHandles+
            ",\"maximumScratchBytes\":"+maximumBuffer+",\"maximumUnresolvedHandles\":"+maximumRetained+",\"failedClosesRetried\":"+failedCloseRetries+"}";
    }
}

