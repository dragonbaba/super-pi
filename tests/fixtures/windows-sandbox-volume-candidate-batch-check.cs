using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Security.Cryptography;
using System.Text;
using SuperPiVolume;

public static class CandidateBatchChecks {
    const string Root=@"D:\owned-task",RootId="12345678:0000000000000001";
    const string Volume=@"\\?\Volume{12345678-1234-4567-89ab-123456789abc}\",ExchangeId="87654321:0000000000000001";
    const string SourceId="87654321:0000000000000002",ManifestCarrier="12345678:0000000000000002",Task="11111111-2222-3333-4444-555555555555";
    static int cases,maximumOpened,maximumPeak,maximumAllocated,maximumRetained,maximumRequestBytes;
    static void Need(bool value,string message) { if(!value) throw new Exception(message); }
    static Exception Failure(Action action) { try { action(); } catch(Exception error) { return error; } throw new Exception("expected refusal"); }
    static string Hash(byte[] bytes) { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
    sealed class ManifestFake : IManifestOps {
        readonly byte[] source=Encoding.ASCII.GetBytes("{\"fixture\":\"opaque-manifest\"}"); byte[] carrier=new byte[0];
        public void VerifyBinding() {}
        public IntPtr Open(int slot,ManifestOpen spec) { return new IntPtr(10+slot); }
        public ManifestMeta Inspect(int slot,IntPtr handle) {
            return new ManifestMeta { Id=slot==0 ? ExchangeId : slot==1 ? SourceId : ManifestCarrier,
                Path=slot==0 ? Volume+"exchange" : slot==1 ? Volume+@"exchange\candidates.json" : @"\\?\"+Root+@"\candidate-manifest.bin",
                Attributes=slot==0 ? 0x10u : 0u,Directory=slot==0,Links=1,Length=slot==1 ? source.Length : slot==2 ? carrier.Length : 0,
                Allocation=0,Creation=1,WriteTime=2,Consistent=true };
        }
        public ManifestIo Read(IntPtr h,byte[] bytes) { Buffer.BlockCopy(source,0,bytes,0,bytes.Length); return new ManifestIo(true,null,(uint)bytes.Length); }
        public ManifestIo Write(IntPtr h,byte[] bytes) { carrier=(byte[])bytes.Clone(); return new ManifestIo(true,null,(uint)bytes.Length); }
        public ManifestIo Flush(IntPtr h) { return new ManifestIo(true,null,0); }
        public int? Close(IntPtr h) { return null; }
    }
    static ManifestCapture Manifest(bool run) {
        var capture=new ManifestCapture(new ManifestBinding(Root,RootId,Volume,ExchangeId),new ManifestFake()); if(run) capture.Run(); return capture;
    }
    static BatchBinding Binding(ManifestCapture captured) { return new BatchBinding(new Guid(Task),captured,Root,RootId,Volume,ExchangeId); }
    static byte[] Wire(BatchBinding binding,string[] paths) {
        var text=new StringBuilder("{\"protocol\":\"super-pi-candidate-read-request-v1\",\"taskId\":\""+Task+"\",\"manifestSha256\":\""+binding.ManifestSha+"\",\"paths\":[");
        for(int i=0;i<paths.Length;i++) { if(i>0) text.Append(','); text.Append('"').Append(paths[i]).Append('"'); }
        return Encoding.UTF8.GetBytes(text.Append("]}").ToString());
    }
    sealed class Entry {
        public string Path,Id; public bool Directory; public byte[] Data;
    }
    sealed class Opened {
        public Entry Entry; public BatchOpen Spec; public int Inspections,Closes; public bool Closed;
    }
    sealed class Fake : IBatchOps {
        public readonly BatchBinding Binding;
        public readonly string[] Paths;
        public readonly Dictionary<string,Entry> Tree=new Dictionary<string,Entry>(StringComparer.OrdinalIgnoreCase);
        public readonly List<Opened> Records=new List<Opened>(98);
        public readonly List<byte[]> Buffers=new List<byte[]>(17);
        public readonly List<byte> Carrier=new List<byte>(16384);
        public int Calls,VerifyCalls,OpenCalls,ReadCalls,WriteCalls,FlushCalls,FailVerify,FailOpen;
        public bool CarrierOpened;
        public Func<Opened,ManifestMeta,ManifestMeta> Change;
        public Func<string,ManifestIo?> ReadOverride;
        public ManifestIo? WriteOverride,FlushOverride;
        public string ReadThrowPath,CloseThrowPath;
        public Exception ReadException=new Exception("read bridge"),CloseException=new Exception("close bridge");
        public Func<string,int?> CloseError;
        int identity=16;
        public Fake(BatchBinding binding,string[] paths,int[] lengths) {
            Binding=binding; Paths=(string[])paths.Clone(); Add(Volume+"exchange",true,ExchangeId,new byte[0]); Add(binding.Payload,true,"87654321:0000000000000003",new byte[0]);
            Add(binding.Request,false,"12345678:0000000000000003",Wire(binding,paths));
            Add(binding.Carrier,false,"12345678:0000000000000004",new byte[0]);
            for(int i=0;i<paths.Length;i++) {
                string current=binding.Payload; string[] parts=paths[i].Split('/');
                for(int j=0;j<parts.Length;j++) {
                    current+=@"\"+parts[j];
                    if(j<parts.Length-1) { if(!Tree.ContainsKey(current)) Add(current,true,NextId(),new byte[0]); }
                    else { var bytes=new byte[lengths[i]]; for(int b=0;b<bytes.Length;b++) bytes[b]=(byte)((b+i)%251); Add(current,false,NextId(),bytes); }
                }
            }
        }
        string NextId() { return "87654321:"+ (identity++).ToString("X16"); }
        void Add(string path,bool directory,string id,byte[] bytes) { Tree.Add(path,new Entry { Path=path,Directory=directory,Id=id,Data=bytes }); }
        public string Leaf(string relative) { return Binding.Payload+@"\"+relative.Replace('/','\\'); }
        public void VerifyBinding() { Calls++; VerifyCalls++; if(VerifyCalls==FailVerify) throw new StorageIdentityException("binding changed"); }
        public IntPtr Open(BatchOpen spec) {
            Calls++; OpenCalls++; if(OpenCalls==FailOpen) throw new Win32Exception(5);
            Entry entry; if(!Tree.TryGetValue(spec.File.Path,out entry)) throw new Win32Exception(2);
            bool writer=spec.File.Path==Binding.Carrier;
            Need(spec.Directory==entry.Directory && spec.Guid==entry.Path.StartsWith(Volume,StringComparison.Ordinal),"open path kind");
            Need(spec.File.Access==(writer ? 0x40000080u : 0x80000000u) && spec.File.Share==(entry.Directory ? 1u : 0u),"access/share");
            Need(spec.File.Creation==(writer ? 1u : 3u) && spec.File.Flags==(writer ? 0x80200000u : entry.Directory ? 0x02200000u : 0x00200000u),"creation/reparse flags");
            if(writer) { Need(!CarrierOpened && Records.Count==1 && Records[0].Closed,"request closed before CREATE_NEW carrier"); CarrierOpened=true; }
            Need(Records.Count<98,"bounded owned fake handle trace"); Records.Add(new Opened { Entry=entry,Spec=spec }); return new IntPtr(100+Records.Count);
        }
        Opened Record(IntPtr handle) { var record=Records[(int)handle.ToInt64()-101]; Need(!record.Closed,"operation on already closed handle"); return record; }
        public ManifestMeta Inspect(IntPtr handle,bool guid,bool directory) {
            Calls++; var record=Record(handle); record.Inspections++;
            Need(guid==record.Spec.Guid && directory==record.Spec.Directory,"same handle inspection kind");
            var entry=record.Entry;
            var value=new ManifestMeta { Id=entry.Id,Path=guid ? entry.Path : @"\\?\"+entry.Path,Attributes=entry.Directory ? 0x10u : 0u,
                Directory=entry.Directory,Links=1,Length=entry.Path==Binding.Carrier ? Carrier.Count : entry.Data.Length,Allocation=0,
                Creation=1,WriteTime=2,Consistent=true };
            return Change==null ? value : Change(record,value);
        }
        public ManifestIo Read(IntPtr handle,byte[] bytes) {
            Calls++; ReadCalls++; var record=Record(handle); Buffers.Add(bytes);
            if(record.Entry.Path==ReadThrowPath) throw ReadException;
            ManifestIo value=(ReadOverride==null ? (ManifestIo?)null : ReadOverride(record.Entry.Path)) ?? new ManifestIo(true,null,(uint)bytes.Length);
            int count=Math.Min(bytes.Length,Math.Min(record.Entry.Data.Length,(int)Math.Min(value.Count,4096u)));
            Buffer.BlockCopy(record.Entry.Data,0,bytes,0,count); return value;
        }
        public ManifestIo Write(IntPtr handle,byte[] bytes) {
            Calls++; WriteCalls++; Need(Record(handle).Entry.Path==Binding.Carrier,"private carrier only");
            var value=WriteOverride ?? new ManifestIo(true,null,(uint)bytes.Length); int count=Math.Min(bytes.Length,(int)Math.Min(value.Count,4096u));
            Need(Carrier.Count+count<=16384,"bounded fake payload"); for(int i=0;i<count;i++) Carrier.Add(bytes[i]); return value;
        }
        public ManifestIo Flush(IntPtr handle) { Calls++; FlushCalls++; Need(Record(handle).Entry.Path==Binding.Carrier,"flush carrier"); return FlushOverride ?? new ManifestIo(true,null,0); }
        public int? Close(IntPtr handle) {
            Calls++; var record=Record(handle); record.Closes++; Need(record.Closes==1,"no close retry");
            if(record.Entry.Path==CloseThrowPath) throw CloseException;
            int? error=CloseError==null ? null : CloseError(record.Entry.Path); if(!error.HasValue) record.Closed=true; return error;
        }
    }
    static BatchCapture Run(Fake fake,bool success,bool identity) {
        var capture=new BatchCapture(fake.Binding,fake); Exception failure=null;
        try { capture.Run(); } catch(Exception error) { failure=error; }
        Need((failure==null)==success && capture.Captured==success,"capture outcome");
        if(identity) Need(failure is StorageIdentityException,"typed identity refusal");
        Need(capture.AllocatedBytes==capture.ClearedBytes && capture.AllocatedBytes<=20480 && capture.RetainedBufferBytes==0,"bounded allocation and clearing");
        foreach(byte[] bytes in fake.Buffers) foreach(byte value in bytes) Need(value==0,"actual scratch cleared");
        Need(capture.RetainsOperations==capture.Handles.Unknown,"callback ownership after completion");
        int unresolved=0;
        foreach(var record in fake.Records) { Need(record.Closes==1,"every acquired handle attempted exactly once"); if(!record.Closed) unresolved++; }
        Need(unresolved==capture.Handles.Opened-capture.Handles.Closed,"unresolved identities counted");
        if(success) {
            Need(capture.Bytes==fake.Carrier.Count && capture.Sha256==Hash(fake.Carrier.ToArray()),"aggregate bound to bytes");
            var items=capture.Items; int sum=0;
            Need(items.Length==fake.Paths.Length,"ordered item count");
            for(int i=0;i<items.Length;i++) { var source=fake.Tree[fake.Leaf(fake.Paths[i])]; sum+=items[i].Bytes;
                Need(items[i].SourceId==source.Id && items[i].Bytes==source.Data.Length && items[i].Sha256==Hash(source.Data),"ordered item bytes/hash"); }
            Need(sum==capture.Bytes && capture.Handles.Opened==capture.Handles.Closed,"length prefix sum/closed proof");
            if(items.Length>0) { items[0]=new CandidateBatchItem("changed",999,"changed"); Need(capture.Items[0].SourceId!="changed","success snapshot isolated"); }
        } else Need(Failure(delegate { var denied=capture.Items; }) is InvalidOperationException,"no partial success");
        var facts=capture.Facts; if(facts.Length>0) { facts[0]=new CandidateBatchIo(999,999,null,null); Need(capture.Facts[0].Index!=999,"IO snapshots isolated"); }
        int calls=fake.Calls; Need(Failure(capture.Run) is InvalidOperationException,"one-shot capture"); capture.Handles.CloseRange(0,6); Need(fake.Calls==calls,"no replay or close retry");
        maximumOpened=Math.Max(maximumOpened,capture.Handles.Opened); maximumPeak=Math.Max(maximumPeak,capture.Handles.Peak);
        maximumAllocated=Math.Max(maximumAllocated,capture.AllocatedBytes); maximumRetained=Math.Max(maximumRetained,unresolved);
        if(success) maximumRequestBytes=Math.Max(maximumRequestBytes,fake.Tree[fake.Binding.Request].Data.Length); cases++; return capture;
    }
    static void RejectRequest(BatchBinding binding,byte[] bytes) {
        Exception error=Failure(delegate { BatchRequest.Parse(bytes,binding.TaskId,binding.ManifestSha); });
        Need(error is InvalidOperationException || error is DecoderFallbackException,"request rejection type"); cases++;
    }
    public static string CheckHostRequest(string encoded,string task,string manifestSha) {
        byte[] bytes=Convert.FromBase64String(encoded);
        try { var parsed=BatchRequest.Parse(bytes,task,manifestSha); return "{\"count\":"+parsed.Count+",\"sha256\":\""+Hash(bytes)+"\"}"; }
        finally { Array.Clear(bytes,0,bytes.Length); }
    }
    public static string Run() {
        cases=maximumOpened=maximumPeak=maximumAllocated=maximumRetained=maximumRequestBytes=0;
        var manifest=Manifest(true); var binding=Binding(manifest);
        Need(Failure(delegate { Binding(Manifest(false)); }) is InvalidOperationException,"uncaptured manifest cannot authorize batch"); cases++;
        Need(Failure(delegate { new BatchBinding(new Guid(Task),manifest,Root,RootId,Volume.Replace("1234","2345"),ExchangeId); }) is StorageIdentityException,"same captured volume"); cases++;
        Need(Failure(delegate { new BatchBinding(Guid.Empty,manifest,Root,RootId,Volume,ExchangeId); }) is InvalidOperationException,"native task identity required"); cases++;
        Need(BatchRequest.Parse(Wire(binding,new string[0]),Task,binding.ManifestSha).Count==0,"empty request"); cases++;
        var longest=new string[16]; var lengths=new int[16];
        for(int i=0;i<16;i++) { longest[i]=new string('a',29)+"/"+new string('b',29)+"/"+new string('c',29)+"/"+new string('d',28)+i.ToString("D2"); lengths[i]=1024; Need(longest[i].Length==120,"maximum path fixture"); }
        Need(BatchRequest.Parse(Wire(binding,longest),Task,binding.ManifestSha).Count==16,"maximum accepted request"); cases++;
        foreach(string invalid in new string[]{"", "../a", ".git/config", "a//b", "/a", "a/", "a\\b", "a:b", "a.", "CON.txt", "com9", "LPT1.log", "a~1", "a b", "é.txt", "a/b/c/d/e", new string('a',65),new string('a',121)})
            RejectRequest(binding,Wire(binding,new string[]{invalid}));
        string valid=Encoding.UTF8.GetString(Wire(binding,new string[]{"a.txt"}));
        foreach(string invalid in new string[]{valid+"\n", "\uFEFF"+valid,valid.Replace("\"paths\":[","\"extra\":0,\"paths\":["),
            valid.Replace("\"paths\":[","\"paths\":[],\"paths\":["),valid.Replace(Task,"22222222-2222-3333-4444-555555555555"),
            valid.Replace(binding.ManifestSha,new string('f',64)),valid.Replace("a.txt","a\\u002Etxt"),valid.Replace("\"protocol\":"," \"protocol\":")})
            RejectRequest(binding,Encoding.UTF8.GetBytes(invalid));
        RejectRequest(binding,new byte[]{0xC0,0xAF}); RejectRequest(binding,new byte[4097]);
        RejectRequest(binding,Wire(binding,new string[]{"a.txt","A.txt"}));
        RejectRequest(binding,Wire(binding,new string[]{"dir","DIR/a.txt"}));
        RejectRequest(binding,Wire(binding,new string[]{"dir/a.txt","DIR"}));
        var tooMany=new string[17]; for(int i=0;i<17;i++) tooMany[i]="a"+i; RejectRequest(binding,Wire(binding,tooMany));
        Run(new Fake(binding,new string[0],new int[0]),true,false);
        var zero=new Fake(binding,new string[]{"empty.txt"},new int[]{0}); var zeroResult=Run(zero,true,false);
        Need(zero.ReadCalls==1 && zero.WriteCalls==0 && zero.FlushCalls==1 && zeroResult.Items[0].Sha256==Hash(new byte[0]),"empty file no synthetic IO");
        Run(new Fake(binding,new string[]{"a.txt"},new int[]{4096}),true,false);
        Run(new Fake(binding,new string[]{"a.txt","dir/b.txt"},new int[]{3,0}),true,false);
        var maximum=new Fake(binding,longest,lengths); var maxResult=Run(maximum,true,false);
        Need(maxResult.Handles.Opened==98 && maxResult.Handles.Peak==7 && maxResult.Bytes==16384 && maximum.VerifyCalls==19,"maximum business model");
        Run(new Fake(binding,new string[]{"a","b","c","d","e"},new int[]{4096,4096,4096,4096,1}),false,false);
        Run(new Fake(binding,new string[]{"a"},new int[]{4097}),false,true);
        var oversized=new Fake(binding,new string[]{"a"},new int[]{1}); oversized.Tree[binding.Request].Data=new byte[4097]; var oversizedResult=Run(oversized,false,true);
        Need(!oversized.CarrierOpened && oversizedResult.AllocatedBytes==0,"reject request size before allocation/carrier");
        var wrongRequest=new Fake(binding,new string[]{"a"},new int[]{1}); wrongRequest.Tree[binding.Request].Data=Encoding.UTF8.GetBytes(valid.Replace(Task,"22222222-2222-3333-4444-555555555555"));
        Run(wrongRequest,false,false); Need(!wrongRequest.CarrierOpened,"validate approved request before carrier");
        for(int kind=0;kind<2;kind++) {
            int selected=kind; var fake=new Fake(binding,new string[]{"a"},new int[]{32});
            fake.Change=delegate(Opened opened,ManifestMeta value) { if(opened.Entry.Path==fake.Leaf("a")) { if(selected==0) value.Attributes|=0x400; else value.Links=2; } return value; };
            Run(fake,false,true);
        }
        var requestVolume=new Fake(binding,new string[]{"a"},new int[]{1}); requestVolume.Tree[binding.Request].Id="87654321:0000000000000003"; Run(requestVolume,false,true);
        var requestAlias=new Fake(binding,new string[]{"a"},new int[]{1}); requestAlias.Tree[binding.Request].Id=ManifestCarrier; Run(requestAlias,false,true);
        var carrierAlias=new Fake(binding,new string[]{"a"},new int[]{1}); carrierAlias.Tree[binding.Carrier].Id=carrierAlias.Tree[binding.Request].Id; Run(carrierAlias,false,true);
        var carrierExisting=new Fake(binding,new string[]{"a"},new int[]{1}); carrierExisting.Carrier.Add(1); Run(carrierExisting,false,true);
        var manifestAlias=new Fake(binding,new string[]{"a"},new int[]{1}); manifestAlias.Tree[manifestAlias.Leaf("a")].Id=SourceId; Run(manifestAlias,false,true);
        var repeated=new Fake(binding,new string[]{"a","b"},new int[]{1,1}); repeated.Tree[repeated.Leaf("b")].Id=repeated.Tree[repeated.Leaf("a")].Id; Run(repeated,false,true);
        var parentDrift=new Fake(binding,new string[]{"a"},new int[]{32}); parentDrift.Change=delegate(Opened opened,ManifestMeta value) { if(opened.Entry.Path==binding.Payload && opened.Inspections==2) value.WriteTime++; return value; }; Run(parentDrift,false,true);
        var leafDrift=new Fake(binding,new string[]{"a"},new int[]{32}); leafDrift.Change=delegate(Opened opened,ManifestMeta value) { if(opened.Entry.Path==leafDrift.Leaf("a") && opened.Inspections==2) value.Length--; return value; }; Run(leafDrift,false,true);
        var carrierDrift=new Fake(binding,new string[]{"a"},new int[]{32}); carrierDrift.Change=delegate(Opened opened,ManifestMeta value) { if(opened.Entry.Path==binding.Carrier && opened.Inspections==2) value.Id="12345678:0000000000000009"; return value; }; Run(carrierDrift,false,true);
        var shortRequest=new Fake(binding,new string[]{"a"},new int[]{32}); shortRequest.ReadOverride=delegate(string path) { return path==binding.Request ? (ManifestIo?)new ManifestIo(true,null,1) : null; }; Run(shortRequest,false,false); Need(!shortRequest.CarrierOpened,"short request stops");
        foreach(ManifestIo raw in new ManifestIo[]{new ManifestIo(false,0,0),new ManifestIo(true,null,31)}) {
            var fake=new Fake(binding,new string[]{"a"},new int[]{32}); fake.ReadOverride=delegate(string path) { return path==fake.Leaf("a") ? (ManifestIo?)raw : null; };
            var result=Run(fake,false,false); Need(result.Facts[0].Read.Value.Error==raw.Error && result.Facts[0].Read.Value.Count==raw.Count && fake.WriteCalls==0,"raw read retained");
        }
        foreach(ManifestIo raw in new ManifestIo[]{new ManifestIo(false,112,0),new ManifestIo(true,null,31)}) {
            var fake=new Fake(binding,new string[]{"a"},new int[]{32}); fake.WriteOverride=raw;
            var result=Run(fake,false,false); Need(result.Facts[0].Write.Value.Error==raw.Error && result.Facts[0].Write.Value.Count==raw.Count,"raw write retained");
        }
        var flush=new Fake(binding,new string[]{"a"},new int[]{32}); flush.FlushOverride=new ManifestIo(false,5,0); Need(Run(flush,false,false).FlushResult.Value.Error==5,"raw flush retained");
        for(int ordinal=1;ordinal<=4;ordinal++) { var fake=new Fake(binding,new string[]{"a"},new int[]{32}); fake.FailVerify=ordinal; Run(fake,false,true); Need(fake.VerifyCalls==ordinal,"binding failure stops"); }
        foreach(int ordinal in new int[]{1,2,5}) { var fake=new Fake(binding,new string[]{"a"},new int[]{32}); fake.FailOpen=ordinal; Run(fake,false,false); }
        for(int kind=0;kind<3;kind++) {
            var fake=new Fake(binding,kind==1 ? new string[]{"a","b"} : new string[]{"a"},kind==1 ? new int[]{32,32} : new int[]{32}); int selected=kind;
            string failed=kind==0 ? binding.Request : kind==1 ? fake.Leaf("a") : binding.Carrier;
            fake.CloseError=delegate(string path) { return path==failed ? (int?)(selected==0 ? 0 : 6) : null; };
            var result=Run(fake,false,false); Need(result.OperationException==null && result.CloseException is Win32Exception,"close-only failure remains distinct");
            if(kind==0) Need(!fake.CarrierOpened,"request close unknown blocks carrier");
            if(kind==1) Need(fake.OpenCalls==5 && fake.WriteCalls==1,"source close unknown prevents next candidate");
        }
        var combined=new Fake(binding,new string[]{"a"},new int[]{32}); combined.ReadThrowPath=combined.Leaf("a"); combined.CloseThrowPath=combined.ReadThrowPath;
        combined.CloseError=delegate(string path) { return path==binding.Carrier ? (int?)6 : null; };
        var combinedResult=Run(combined,false,false);
        Need(Object.ReferenceEquals(combinedResult.OperationException,combined.ReadException) && Object.ReferenceEquals(combinedResult.CloseException,combined.CloseException),"both original exceptions retained");
        Need(combinedResult.Handles.Errors[0]==6 && combinedResult.Handles.Errors[3]==null && combinedResult.Handles.Retained[0]!=null && combinedResult.Handles.Retained[3]!=null,"two exact unresolved handles");
        var closeErrors=combinedResult.Handles.Errors; var retained=combinedResult.Handles.Retained; closeErrors[0]=0; retained[0]=null;
        Need(combinedResult.Handles.Errors[0]==6 && combinedResult.Handles.Retained[0]!=null,"unresolved snapshots cannot change responsibility");
        Need(NativeDisk.CandidateManifestNativeOperations==0 && NativeDisk.CandidateBatchNativeOperations==0,"no native adapter calls");
        return "{\"cases\":"+cases+",\"maximumOpened\":"+maximumOpened+",\"maximumPeak\":"+maximumPeak+
            ",\"maximumAllocatedBytes\":"+maximumAllocated+",\"maximumUnresolvedHandles\":"+maximumRetained+
            ",\"maximumAcceptedRequestBytes\":"+maximumRequestBytes+",\"nativeDiskInstances\":0,\"nativeAdapterCalls\":0}";
    }
}

