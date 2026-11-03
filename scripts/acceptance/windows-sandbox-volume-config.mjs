// Configuration data only; this function never grants permission or launches an instance.
const GUID_VOLUME = /^\\\\\?\\Volume\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}\\$/;
export function singleGuidVolumeConfig(volumePath) {
    if (typeof volumePath !== "string" || volumePath.length !== 49 || !GUID_VOLUME.test(volumePath)) throw Error("Canonical volume GUID required; no aliases or fallback");
    return `<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <vGPU>Disable</vGPU>
  <MemoryInMB>2048</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>${volumePath}exchange</HostFolder><SandboxFolder>C:\\SuperPiVolume</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
</Configuration>
`;
}
