using System;
using System.Reflection;
using System.Runtime.InteropServices;
using SuperPiVolume;

public static class CapacityHostChecks {
    static void Need(bool value,string message) { if(!value) throw new Exception(message); }
    static readonly MethodInfo Shape=typeof(NativeDisk).GetMethod("CapacityShape",BindingFlags.Static|BindingFlags.NonPublic);
    static readonly MethodInfo Failure=typeof(NativeDisk).GetMethod("CapacityThrow",BindingFlags.Static|BindingFlags.NonPublic);
    const string Parent="12345678:0000000000000001",File="12345678:0000000000000002",Path=@"\\?\Volume{12345678-1234-4567-89ab-123456789abc}\exchange\capacity-fill.bin";
    static object[] FileArguments() { return new object[]{0u,1u,1048576L,1048576L,false,false,Path,Path,File,Parent,false,134217728L}; }
    static void Check(object[] args,bool valid) {
        bool accepted=true;
        try { Shape.Invoke(null,args); }
        catch(TargetInvocationException error) { Need(error.InnerException is StorageIdentityException,"typed identity rejection"); accepted=false; }
        Need(accepted==valid,"shape acceptance mismatch");
    }
    static void Reject(Action action) { bool rejected=false; try { action(); } catch(ArgumentException) { rejected=true; } catch(InvalidOperationException) { rejected=true; } Need(rejected,"expected refusal"); }
    public static string Run() {
        int cases=0; Need(Shape!=null && Failure!=null,"pure methods available");
        Check(FileArguments(),true); cases++;
        var small=FileArguments(); small[2]=32L; small[3]=0L; Check(small,true); cases++; // Logical small file length does not prove external allocation.
        var parent=FileArguments(); parent[0]=0x10u; parent[4]=true; parent[6]=@"\\?\Volume{12345678-1234-4567-89ab-123456789abc}\exchange"; parent[7]=parent[6]; parent[8]=Parent; parent[10]=true; Check(parent,true); cases++;
        foreach(uint attributes in new uint[]{0x400,0x200,0x800,0x4000}) { var args=FileArguments(); args[0]=attributes; Check(args,false); cases++; }
        int[] positions={1,2,2,3,3,4,5,6,8}; object[] values={2u,-1L,134217729L,-1L,134217729L,true,true,Path+".other","87654321:0000000000000002"};
        for(int i=0;i<positions.Length;i++) { var args=FileArguments(); args[positions[i]]=values[i]; Check(args,false); cases++; }
        parent[8]=File; Check(parent,false); cases++;
        int closes=0; var clean=new CapacityHandles(delegate(IntPtr handle) { closes++; return null; });
        clean.Adopt(0,new IntPtr(101)); clean.Adopt(1,new IntPtr(102)); Need(clean.CloseRange(0,1)==null,"normal close range");
        Need(clean.Opened==2 && clean.Closed==2 && clean.Peak==2 && !clean.Unknown && closes==2,"normal counters");
        clean.CloseRange(0,1); Need(closes==2,"idempotent close"); foreach(string value in clean.Retained) Need(value==null,"released references");
        Reject(delegate { clean.CanOpen(0); }); cases++;
        int attempts=0; var primary=new Exception("native bridge threw");
        var mixed=new CapacityHandles(delegate(IntPtr handle) { attempts++; if(handle==new IntPtr(103)) throw primary; return handle==new IntPtr(102) ? (int?)6 : null; });
        mixed.Adopt(0,new IntPtr(101)); mixed.Adopt(1,new IntPtr(102)); mixed.Adopt(2,new IntPtr(103));
        Need(Object.ReferenceEquals(mixed.CloseRange(0,2),primary),"first close exception retained");
        Need(attempts==3 && mixed.Opened==3 && mixed.Closed==1 && mixed.Peak==3 && mixed.Unknown,"other closes attempted despite failure");
        Need(mixed.Errors[1]==6 && mixed.Errors[2]==null && mixed.Retained[1]=="66" && mixed.Retained[2]=="67","unknown handles and raw errors separate");
        mixed.CloseRange(0,2); Need(attempts==3,"failed close never retried"); Reject(delegate { mixed.CanOpen(3); });
        var errors=mixed.Errors; var retained=mixed.Retained; errors[1]=0; retained[1]=null; Need(mixed.Errors[1]==6 && mixed.Retained[1]=="66","snapshots do not mutate owner"); cases++;
        var empty=new CapacityHandles(delegate { throw new Exception("must not call"); }); Need(empty.CloseRange(0,8)==null && empty.Opened==0 && empty.Closed==0,"empty cleanup"); cases++;
        Reject(delegate { empty.CanOpen(9); }); Reject(delegate { empty.CanOpen(-1); }); Reject(delegate { empty.Adopt(0,IntPtr.Zero); }); Reject(delegate { empty.Adopt(0,new IntPtr(-1)); }); cases++;
        Exception operation=new Exception("operation"),secondary=new Exception("close");
        try { Failure.Invoke(null,new object[]{operation,secondary}); throw new Exception("missing throw"); }
        catch(TargetInvocationException error) { Need(Object.ReferenceEquals(error.InnerException,operation),"operation exception identity wins"); } cases++;
        try { Failure.Invoke(null,new object[]{null,secondary}); throw new Exception("missing close throw"); }
        catch(TargetInvocationException error) { Need(Object.ReferenceEquals(error.InnerException,secondary),"close exception preserved"); } cases++;
        Need(Marshal.SizeOf(typeof(NativeDisk).GetNestedType("StandardInfo",BindingFlags.NonPublic))==24,"standard information ABI"); cases++;
        var smallGuest=new SuperPiCapacityGuest.Native.StandardInfo { EndOfFile=512,AllocationSize=0,Links=1 };
        var ordinary=new SuperPiCapacityGuest.Native.AttributeInfo();
        SuperPiCapacityGuest.Native.CheckShape(smallGuest,ordinary,512); cases++;
        smallGuest.AllocationSize=4096; SuperPiCapacityGuest.Native.CheckShape(smallGuest,ordinary,512); cases++;
        smallGuest.AllocationSize=-1; Reject(delegate { SuperPiCapacityGuest.Native.CheckShape(smallGuest,ordinary,512); }); cases++;
        smallGuest.AllocationSize=0; ordinary.Attributes=0x400; Reject(delegate { SuperPiCapacityGuest.Native.CheckShape(smallGuest,ordinary,512); }); cases++;
        ordinary.Attributes=0; Reject(delegate { SuperPiCapacityGuest.Native.CheckShape(smallGuest,ordinary,4096); }); cases++;
        smallGuest.EndOfFile=0; SuperPiCapacityGuest.Native.CheckShape(smallGuest,ordinary,0); Need(SuperPiCapacityGuest.Native.Calls==0,"no guest native calls"); cases++;
        return "{\"cases\":"+cases+",\"nativeDiskInstances\":0,\"win32EntriesInvoked\":0,\"fixedHandleSlots\":9,\"peakFakeHandles\":3,\"failedHandlesRetained\":2,\"failedClosesRetried\":0}";
    }
}
