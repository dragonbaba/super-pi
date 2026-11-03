using System;
using System.ComponentModel;
using System.IO;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using SuperPiVolume;

// Counting substitutes only. No NativeDisk construction, file creation or native adapter call.
public sealed class CandidateReceiptStream {
    public readonly SafeFileHandle SafeFileHandle=new SafeFileHandle(new IntPtr(0x4567),false);
    public int Writes,Flushes,Closes;
    public string Mode;
    public byte[] Borrowed;
    public string Text;
    public void Write(byte[] bytes,int offset,int count) {
        Writes++; Borrowed=bytes; Text=System.Text.Encoding.UTF8.GetString(bytes,offset,count);
        if(Mode=="write" || Mode=="write-close") throw new Win32Exception(0,"receipt write");
    }
    public void Flush() { Flushes++; if(Mode=="flush" || Mode=="flush-close") throw new Win32Exception(112,"receipt flush"); }
    public void Dispose() { Closes++; if(Mode=="close" || Mode=="write-close" || Mode=="flush-close") throw new IOException("receipt close unknown"); }
    public bool Cleared { get { if(Borrowed==null) return true; foreach(byte value in Borrowed) if(value!=0) return false; return true; } }
}
public sealed class CandidateDiagnosticWriter : StringWriter {
    public int Attempts; public bool Fail;
    public override void WriteLine(string value) { Attempts++; if(Fail) throw new IOException("diagnostic write"); base.WriteLine(value); }
}
public sealed class CandidateHelperNative {
    public string RootId { get { return "11223344:0000000000000009"; } }
    public int Fingerprints,Manifests,Batches,ItemReads;
    public string Mode="";
    public bool CloseUnknown;
    public bool CandidateManifestCaptured,CandidateBatchCaptured;
    public string CandidateManifestSourceId="AABBCCDD:0000000000000002";
    public string CandidateManifestCarrierId="11223344:0000000000000001";
    public string CandidateBatchCarrierId="11223344:0000000000000002";
    public string CandidateBatchRequestId="11223344:0000000000000003";
    public string CandidateManifestSha256,CandidateBatchSha256,CandidateBatchRequestSha256;
    public int CandidateManifestBytes,CandidateBatchBytes;
    public int CandidateManifestOpened=3,CandidateManifestClosed=3,CandidateManifestPeak=2;
    public int CandidateBatchOpened,CandidateBatchClosed,CandidateBatchPeak;
    public int?[] CandidateManifestCloseErrors=new int?[3],CandidateBatchCloseErrors=new int?[7];
    public string[] CandidateManifestRetainedHandles=new string[3],CandidateBatchRetainedHandles=new string[7];
    public Exception CandidateManifestOperationException,CandidateManifestCloseException,CandidateBatchOperationException,CandidateBatchCloseException;
    public ManifestIo? CandidateManifestReadResult,CandidateManifestWriteResult,CandidateManifestFlushResult;
    public ManifestIo? CandidateBatchRequestRead,CandidateBatchFlushResult;
    public int CandidateManifestAllocatedBytes,CandidateManifestClearedBytes,CandidateBatchAllocatedBytes,CandidateBatchClearedBytes;
    public bool CandidateManifestRetainsOperations,CandidateBatchRetainsOperations;
    public CandidateBatchIo[] CandidateBatchIoFacts=new CandidateBatchIo[0];
    CandidateBatchItem[] items;
    public CandidateBatchItem[] CandidateBatchItems {
        get { ItemReads++; if(!CandidateBatchCaptured) throw new Exception("failed-items-forbidden"); return items; }
    }
    public void Configure(int count,int manifestBytes,string manifestSha,string requestSha,string payloadSha) {
        CandidateManifestBytes=manifestBytes; CandidateManifestSha256=manifestSha; CandidateBatchRequestSha256=requestSha;
        CandidateBatchSha256=payloadSha; CandidateBatchBytes=count;
        CandidateBatchOpened=CandidateBatchClosed=2+count*3; CandidateBatchPeak=count==0 ? 1 : 4;
        items=new CandidateBatchItem[count];
        using(var sha=SHA256.Create()) for(int i=0;i<count;i++) items[i]=new CandidateBatchItem(
            "AABBCCDD:"+(i+3).ToString("X16"),1,BitConverter.ToString(sha.ComputeHash(new byte[]{(byte)i})).Replace("-","").ToLowerInvariant());
    }
    public string Fingerprint(string path,bool directory) {
        Fingerprints++; if(Mode=="fingerprint") throw new Win32Exception(5,"receipt fingerprint"); return RootId;
    }
    public void CaptureCandidateManifest(string volume,string exchange) {
        Manifests++; if(Mode=="capture") { CandidateManifestOperationException=new Win32Exception(5,"manifest capture"); throw CandidateManifestOperationException; }
        CandidateManifestCaptured=true;
    }
    public void CaptureCandidateBatch(string volume,string exchange) {
        Batches++;
        if(Mode=="capture" || Mode=="worst") {
            CandidateBatchOperationException=new Win32Exception(5,"batch capture");
            if(Mode=="worst") Worst();
            throw CandidateBatchOperationException;
        }
        CandidateBatchCaptured=true;
    }
    public void Worst() {
        CandidateBatchOpened=98;CandidateBatchClosed=91;CandidateBatchPeak=7;CandidateBatchBytes=16384;
        CandidateBatchAllocatedBytes=CandidateBatchClearedBytes=20480;CandidateBatchRetainsOperations=true;CloseUnknown=true;
        CandidateBatchOperationException=new Win32Exception(int.MinValue,"operation");
        CandidateBatchCloseException=new IOException("close");
        for(int i=0;i<7;i++) { CandidateBatchRetainedHandles[i]="FFFFFFFFFFFFFFF"+i.ToString(); CandidateBatchCloseErrors[i]=i==0 ? (int?)null : (i==1 ? 0 : int.MinValue); }
        CandidateBatchRequestRead=new ManifestIo(false,int.MinValue,uint.MaxValue);
        CandidateBatchFlushResult=new ManifestIo(false,null,uint.MaxValue);
        CandidateBatchIoFacts=new CandidateBatchIo[16];
        for(int i=0;i<16;i++) CandidateBatchIoFacts[i]=new CandidateBatchIo(i,4096,
            new ManifestIo(false,int.MinValue,uint.MaxValue),new ManifestIo(false,int.MinValue,uint.MaxValue));
    }
}
