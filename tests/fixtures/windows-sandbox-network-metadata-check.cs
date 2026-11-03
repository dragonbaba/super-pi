// Pure fakes through the shared collector. Never calls the system interface enumerator.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Web.Script.Serialization;
internal static class NetworkMetadataChecks {
    static int count;
    static void Check(bool value) { count++; if (!value) throw new Exception("check-" + count); }
    sealed class Unicast : UnicastIPAddressInformationCollection {
        public int size;
        public override int Count { get { return size; } }
        public override IEnumerator<UnicastIPAddressInformation> GetEnumerator() { return new List<UnicastIPAddressInformation>().GetEnumerator(); }
    }
    sealed class Gateways : GatewayIPAddressInformationCollection {
        public int size;
        public override int Count { get { return size; } }
        public override IEnumerator<GatewayIPAddressInformation> GetEnumerator() { return new List<GatewayIPAddressInformation>().GetEnumerator(); }
    }
    sealed class Properties : IPInterfaceProperties {
        public Unicast unicast = new Unicast(); public Gateways gateways = new Gateways(); public int gatewayReads;
        public override UnicastIPAddressInformationCollection UnicastAddresses { get { return unicast; } }
        public override GatewayIPAddressInformationCollection GatewayAddresses { get { gatewayReads++; return gateways; } }
        public override bool IsDnsEnabled { get { throw new Exception("unused"); } }
        public override string DnsSuffix { get { throw new Exception("unused"); } }
        public override bool IsDynamicDnsEnabled { get { throw new Exception("unused"); } }
        public override MulticastIPAddressInformationCollection MulticastAddresses { get { throw new Exception("unused"); } }
        public override IPAddressInformationCollection AnycastAddresses { get { throw new Exception("unused"); } }
        public override IPAddressCollection DnsAddresses { get { throw new Exception("unused"); } }
        public override IPAddressCollection DhcpServerAddresses { get { throw new Exception("unused"); } }
        public override IPAddressCollection WinsServersAddresses { get { throw new Exception("unused"); } }
        public override IPv4InterfaceProperties GetIPv4Properties() { throw new Exception("unused"); }
        public override IPv6InterfaceProperties GetIPv6Properties() { throw new Exception("unused"); }
    }
    sealed class Nic : NetworkInterface {
        public string id = "fake"; public int kind = 6, state = 1, reads, statusReads, propertyReads; public Exception error;
        public Properties properties = new Properties();
        public override string Id { get { reads++; return id; } }
        public override NetworkInterfaceType NetworkInterfaceType { get { reads++; return (NetworkInterfaceType)kind; } }
        public override OperationalStatus OperationalStatus { get { reads++; statusReads++; return (OperationalStatus)state; } }
        public override IPInterfaceProperties GetIPProperties() { propertyReads++; if (error != null) throw error; return properties; }
    }
    static NetworkMetadataEntry.Receipt Capture(params NetworkInterface[] all) {
        return NetworkMetadataEntry.Capture("11111111-2222-3333-4444-555555555555", t => SandboxNetworkProbe.CollectInterfaces(all, t));
    }
    static void Failure(NetworkMetadataEntry.Receipt r, string stage, string reason) { Check(!r.trace.complete && r.trace.stage == stage && r.trace.reason == reason && r.errorType != null && r.hresult != null); }
    static int Main() {
        try {
            var empty = Capture(); Check(empty.trace.complete && empty.trace.count == 0 && empty.trace.index == null && empty.trace.completedCount == 0);
            var first = new Nic(); var good = Capture(first); Check(good.trace.complete && good.trace.completedCount == 1 && good.trace.type == 6 && good.trace.status == 1);
            var virtualNic = new Nic { kind = 53 }; var virtualResult = SandboxNetworkProbe.CollectInterfaces(new NetworkInterface[] { virtualNic });
            Check(virtualResult.Length == 1 && virtualResult[0].type == 53 && virtualResult[0].status == 1 && virtualNic.propertyReads == 1);
            Check(Capture(new Nic { kind = 53 }).trace.complete);
            Failure(Capture(new Nic { kind = 53, state = 4 }), "status", "unknown-interface-kind-or-state");
            var all = new NetworkInterface[33]; all[0] = new Nic(); var large = Capture(all);
            Failure(large, "count", "interface-count-bound"); Check(large.trace.count == 33 && large.trace.index == null && ((Nic)all[0]).reads == 0);
            var next = new Nic(); var badId = new Nic { id = "" }; var identity = Capture(badId, next);
            Failure(identity, "identity", "interface-identity"); Check(identity.trace.index == 0 && identity.trace.type == null && badId.reads == 1 && next.reads == 0);
            var duplicate = Capture(new Nic(), new Nic()); Failure(duplicate, "identity", "interface-identity"); Check(duplicate.trace.index == 1 && duplicate.trace.completedCount == 1 && duplicate.trace.type == null);
            foreach (int kind in new int[] { 1, 999 }) {
                var bad = new Nic { kind = kind }; var r = Capture(bad, next); Failure(r, "type", "unknown-interface-kind-or-state");
                Check(r.trace.type == kind && r.trace.status == null && bad.statusReads == 0 && bad.propertyReads == 0 && next.reads == 0);
                try { SandboxNetworkProbe.CollectInterfaces(new NetworkInterface[] { bad }); Check(false); } catch (InvalidOperationException) { Check(true); }
            }
            foreach (int status in new int[] { 4, 999 }) {
                var bad = new Nic { state = status }; var r = Capture(bad, next); Failure(r, "status", "unknown-interface-kind-or-state");
                Check(r.trace.status == status && r.trace.unicastCount == null && bad.propertyReads == 0 && next.reads == 0);
            }
            var native = Capture(new Nic { error = new Win32Exception(5, "must-not-export") }); Failure(native, "properties", null);
            Check(native.nativeErrorCode == 5 && native.trace.unicastCount == null && !new JavaScriptSerializer().Serialize(native).Contains("must-not-export"));
            var manyAddresses = new Nic(); manyAddresses.properties.unicast.size = 33; var addresses = Capture(manyAddresses, next);
            Failure(addresses, "unicast-count", "interface-address-count-bound"); Check(addresses.trace.unicastCount == 33 && addresses.trace.gatewayCount == null && manyAddresses.properties.gatewayReads == 0 && next.reads == 0);
            var manyGateways = new Nic(); manyGateways.properties.gateways.size = 33; var gateways = Capture(manyGateways, next);
            Failure(gateways, "gateway-count", "interface-address-count-bound"); Check(gateways.trace.gatewayCount == 33 && gateways.trace.unicastCount == 0 && next.reads == 0);
            foreach (bool gateway in new bool[] { false, true }) {
                var r = NetworkMetadataEntry.Capture("fixture", t => { t.stage = gateway ? "gateway" : "unicast"; SandboxNetworkProbe.CountAddress(new SandboxNetworkProbe.Adapter(), AddressFamily.Unknown, gateway, t); });
                Failure(r, gateway ? "gateway" : "unicast", gateway ? "unknown-gateway-family" : "unknown-address-family");
            }
            var entry = new SandboxNetworkProbe.Adapter(); SandboxNetworkProbe.CountAddress(entry, AddressFamily.InterNetwork, false, null); SandboxNetworkProbe.CountAddress(entry, AddressFamily.InterNetworkV6, true, null);
            Check(entry.ipv4 == 1 && entry.ipv6 == 0 && entry.gateways4 == 0 && entry.gateways6 == 1);
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = true, checks = count })); return 0;
        } catch (Exception error) { Console.WriteLine(error.Message); return 1; }
    }
}
