using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using SuperPiCapacity;
using SuperPiCapacityGuest;

public static class CapacityGuestChecks {
    static readonly Guid Task=new Guid("12345678-1234-4567-89ab-123456789abc");
    static void Need(bool value,string message) { if(!value) throw new Exception(message); }
    sealed class Slot : IResultSlot {
        public string Mode=""; public int Mask,Writes,Flushes,Closes; public bool Attempted;
        public byte[] Seen,Copy;
        public readonly Exception WriteError=new Exception("slot-write"),FlushError=new Exception("slot-flush"),CloseError=new Exception("slot-close");
        public bool CloseAttempted { get { return Attempted; } }
        public void Prepare(Guid task) { Need(task==Task,"slot task"); if(Mode=="prepare") throw new Exception("slot-prepare"); }
        public IoResult Write(byte[] bytes) {
            Writes++; Seen=bytes; Copy=(byte[])bytes.Clone();
            if(Mode=="throw") throw WriteError;
            return IoResult.Result((Mask&1)==0,(Mask&1)!=0 ? 112u : 0u,512,(Mask&1)!=0 ? 0u : (Mask&2)!=0 ? 3u : 512u);
        }
        public IoResult Flush() { Flushes++; if(Mode=="throw") throw FlushError; return IoResult.Result((Mask&4)==0,(Mask&4)!=0 ? 5u : 0u,0,0); }
        public IoResult Close() { Closes++; Need(Closes==1,"slot close once"); if(Mode=="throw-before-mark") throw CloseError;
            Attempted=true; if(Mode=="throw") throw CloseError; return IoResult.Result((Mask&8)==0,(Mask&8)!=0 ? 6u : 0u,0,0); }
    }
    sealed class Fill : IFillFile {
        public string Mode=""; public int Writes,Flushes,Closes; public bool Attempted; public byte[] Seen;
        public bool CloseAttempted { get { return Attempted; } }
        public void Prepare() { if(Mode=="prepare") throw new Win32Exception(5); }
        public long ElapsedMilliseconds { get { return Mode=="deadline" ? 20000 : 0; } }
        public IoResult Write(byte[] bytes) { Writes++; Need(Seen==null || Object.ReferenceEquals(Seen,bytes),"payload reuse"); Seen=bytes;
            Need(bytes.Length==1048576 && bytes[0]==0x5A && bytes[bytes.Length-1]==0x5A,"nonzero block");
            return Writes==1 ? IoResult.Result(true,0,1048576,1048576) : IoResult.Result(false,112,1048576,0); }
        public IoResult Flush() { Flushes++; return IoResult.Result(Mode!="dual",Mode=="dual" ? 5u : 0u,0,0); }
        public IoResult Close() { Closes++; Need(Closes==1,"data close once"); if(Mode=="throw-before-mark") throw new Exception("data-close");
            Attempted=true; return IoResult.Result(Mode!="dual",Mode=="dual" ? 6u : 0u,0,0); }
    }
    sealed class Files : IFiles {
        public Slot Slot=new Slot(); public Fill Fill=new Fill(); public bool OpenFails,CreateFails; public int Opens,Creates;
        public IResultSlot OpenSlot() { Opens++; if(OpenFails) throw new Win32Exception(2); return Slot; }
        public IFillFile CreateFill() { Creates++; if(CreateFails) throw new Win32Exception(5); return Fill; }
    }
    static void Cleared(byte[] bytes) { if(bytes!=null) for(int i=0;i<bytes.Length;i++) Need(bytes[i]==0,"buffer cleared"); }
    static byte[] Run(Files files,int expected) {
        Need(GuestRunner.Run(Task,files)==expected,"guest exit"); Need(files.Opens==1 && files.Creates<=1,"no factory retry");
        Need(files.Slot.Closes<=1 && files.Fill.Closes<=1,"no close retry"); Cleared(files.Slot.Seen); Cleared(files.Fill.Seen);
        return files.Slot.Copy;
    }
    public static string Run() {
        int cases=0;
        byte[] initial=CapacityProtocol.Initial(Task); CapacityProtocol.CheckInitial(initial,Task); Need(initial.Length==512 && initial[0]==83,"initial format");
        initial[511]=1; bool rejected=false; try { CapacityProtocol.CheckInitial(initial,Task); } catch(ArgumentException) { rejected=true; } Need(rejected,"all initial bytes checked"); cases++;
        foreach(int mask in new int[]{0,1,2,4,5,6,8,9,10,12,13,14}) {
            var slot=new Slot{Mask=mask}; var result=CapacityProtocol.Deliver(slot,new byte[512]);
            Need(result.Mask==mask && result.ExitCode==(mask==0 ? 0 : 64|mask),"finite exit mapping");
            Need(slot.Writes==1 && slot.Flushes==1 && slot.Closes==1,"three independent calls");
            Need(result.Write.Error==((mask&1)!=0 ? 112u : 0u) && result.Flush.Error==((mask&4)!=0 ? 5u : 0u) && result.Close.Error==((mask&8)!=0 ? 6u : 0u),"separate raw errors"); cases++;
        }
        var throws=new Slot{Mode="throw"}; var thrown=CapacityProtocol.Deliver(throws,new byte[512]);
        Need(thrown.ExitCode==77 && Object.ReferenceEquals(thrown.WriteException,throws.WriteError) && Object.ReferenceEquals(thrown.FlushException,throws.FlushError)
            && Object.ReferenceEquals(thrown.CloseException,throws.CloseError),"three exception identities"); cases++;
        var full=new Files(); byte[] fullBytes=Run(full,0); Need(full.Fill.Writes==2 && full.Fill.Flushes==1 && full.Fill.Closes==1,"bounded full run"); cases++;
        var deadline=new Files(); deadline.Fill.Mode="deadline"; byte[] deadlineBytes=Run(deadline,0); Need(deadline.Fill.Writes==0,"delivery zero without capacity evidence"); cases++;
        var dual=new Files(); dual.Fill.Mode="dual"; byte[] dualBytes=Run(dual,0); Need(BitConverter.ToUInt32(dualBytes,100)==5 && BitConverter.ToUInt32(dualBytes,120)==6,"data errors survive delivery"); cases++;
        var open=new Files{OpenFails=true}; Run(open,96); Need(open.Creates==0 && open.Slot.Closes==0,"no invented slot close"); cases++;
        var setup=new Files(); setup.Slot.Mode="prepare"; Run(setup,96); Need(setup.Creates==0 && setup.Slot.Closes==1,"setup closes slot"); cases++;
        var setupClose=new Files(); setupClose.Slot.Mode="prepare"; setupClose.Slot.Mask=8; Run(setupClose,97); cases++;
        var create=new Files{CreateFails=true}; byte[] createBytes=Run(create,0); Need(BitConverter.ToUInt32(createBytes,40)==1 && create.Fill.Closes==0,"create failure report"); cases++;
        var prepare=new Files(); prepare.Fill.Mode="prepare"; byte[] prepareBytes=Run(prepare,0); Need(BitConverter.ToUInt32(prepareBytes,40)==2 && prepare.Fill.Closes==1 && prepare.Fill.Writes==0,"prepare failure closes data"); cases++;
        var slotThrow=new Files(); slotThrow.Slot.Mode="throw-before-mark"; Run(slotThrow,99); Need(slotThrow.Slot.Closes==1,"no close retry when callback throws before mark"); cases++;
        var fillThrow=new Files(); fillThrow.Fill.Mode="throw-before-mark"; byte[] fillThrowBytes=Run(fillThrow,0); Need(fillThrow.Fill.Closes==1 && BitConverter.ToUInt32(fillThrowBytes,164)==1,"data close exception reported once"); cases++;
        Need(Marshal.SizeOf(typeof(Native.StandardInfo))==24 && Marshal.SizeOf(typeof(Native.AttributeInfo))==8,"Win32 layout sizes");
        Need(Program.Main(new string[0])==98 && Native.Calls==0,"no native calls"); cases++;
        string outputJson="{\"cases\":"+cases+",\"nativeCalls\":"+Native.Calls+",\"maxGuestWrites\":2,\"buffersCleared\":true,\"full\":\""+Convert.ToBase64String(fullBytes)+"\",\"deadline\":\""+Convert.ToBase64String(deadlineBytes)+"\"}";
        Array.Clear(fullBytes,0,fullBytes.Length); Array.Clear(deadlineBytes,0,deadlineBytes.Length); return outputJson;
    }
}
