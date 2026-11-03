param([string]$HelperPath, [string]$NativeAssembly, [string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PowerShell 7 x64 required; no fallback'}
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$PSModuleAutoLoadingPreference = 'None'
Set-StrictMode -Version Latest
if (Get-Module Storage) { throw 'Storage provider must not be loaded in substitute checks' }
[void][Reflection.Assembly]::LoadFile($NativeAssembly)
if ([Runtime.InteropServices.Marshal]::SizeOf([type][SuperPiVolume.NativeDisk+CreateParameters]) -ne 56 -or
    [Runtime.InteropServices.Marshal]::OffsetOf([type][SuperPiVolume.NativeDisk+CreateParameters], 'UniqueId').ToInt32() -ne 8 -or
    [Runtime.InteropServices.Marshal]::OffsetOf([type][SuperPiVolume.NativeDisk+CreateParameters], 'MaximumSize').ToInt32() -ne 24) { throw 'x64 creation ABI mismatch' }
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HelperPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw (($parseErrors | ForEach-Object { '{0}:{1}:{2}' -f $_.ErrorId,$_.Extent.StartLineNumber,$_.Extent.StartColumnNumber }) -join ',') }
# Define only these reviewed functions, never the helper entry/loop or NativeDisk constructor.
$script:transientOwner=$null
$script:candidateReceiptUnknown=$false
$names = @('Test-TransientUnknown','Assert-TransientHealthy','One','Get-OwnedDisk','Get-OwnedPartition','Verify-Ready','Prepare-Volume','Release-Volume','Write-State','Invoke-VolumeCommand')
foreach ($name in $names) {
    $matches = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
    if ($matches.Count -ne 1) { throw "Missing function $name" }
    . ([ScriptBlock]::Create($matches[0].Extent.Text))
}
$actualWriteState = ${function:Write-State}
class SubstituteDisk {
    [bool]$Created = $false; [bool]$AttachAttempted = $false; [bool]$Attached = $false
    [bool]$DetachConfirmed = $false; [bool]$Closed = $false; [bool]$CloseUnknown = $false
    [string]$Image; [string]$RootId = 'root'; [string]$ImageId = 'image'; [string]$Fail
    [System.Collections.Generic.List[string]]$Calls = [System.Collections.Generic.List[string]]::new()
    [void] Step([string]$name) { $this.Calls.Add($name); if ($this.Fail -ceq $name) { throw "injected $name" } }
    [void] EnableTaskPrivilege() { $this.Step('privilege') }
    [void] Create() { $this.Step('create'); $this.Created=$true }
    [void] Attach() { $this.AttachAttempted=$true; $this.Step('attach'); $this.Attached=$true }
    [void] VerifyImage() { $this.Step('image-identity') }
    [string] PhysicalPath() { $this.Step('physical'); return '\\.\PhysicalDrive77' }
    [void] VerifyVolume([string]$volume, [uint32]$number, [long]$offset, [long]$length) {
        $this.Step('volume-identity')
        if ($volume -cne '\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\' -or $number -ne 77 -or $offset -ne 1048576 -or $length -ne 132120576) { throw 'Volume relation mismatch' }
    }
    [string] CreateExchange([string]$volume) { $this.Step('exchange'); return 'exchange-id' }
    [void] VerifyExchange([string]$volume,[string]$id) { $this.Step('exchange-identity'); if ($id -cne 'exchange-id') { throw 'Exchange mismatch' } }
    [void] Detach() { $this.Step('detach'); $this.Attached=$false }
    [void] ConfirmDetached([bool]$recorded,[string]$volume) {
        $this.Step('confirm-detached')
        if ($recorded -ne (-not [string]::IsNullOrEmpty($volume))) { throw 'Volume presence contract' }
        $this.DetachConfirmed=$true
    }
    [void] CloseManagement() { $this.Step('close'); $this.Closed=$true }
    [void] DeleteOwnedImage() { $this.Step('delete-image') }
    [void] ConfirmNoCreatedImage() {
        $this.Step('confirm-no-image')
        if ($this.Fail -in @('image-remnant','absence-unknown')) { throw 'Image absence not proven' }
    }
    [string] Fingerprint([string]$path,[bool]$directory) { return $this.RootId }
}
function Write-State {
    param($kind,$errorCode)
    $script:events.Add('journal')
    if ($script:failure -ceq 'journal') { $script:controlFailed=$true; throw 'Injected journal failure' }
}
function Get-DiskImage {
    param($ImagePath,$ErrorAction)
    if ($ImagePath -cne $script:native.Image) { throw 'Wrong image query' }
    if ($script:failure -ceq 'query-unknown') { throw 'injected query error' }
    return [pscustomobject]@{ Attached=$script:native.Attached; DevicePath='\\.\PhysicalDrive77'; ImagePath=$ImagePath }
}
function Get-Disk {
    param($Partition,[Parameter(ValueFromPipeline)]$InputObject)
    process { return $script:diskObject }
}
function Initialize-Disk {
    param($InputObject,$PartitionStyle,[switch]$PassThru,$Confirm,$ErrorAction)
    if ($InputObject -ne $script:diskObject -or $PartitionStyle -cne 'MBR') { throw 'Wrong initialization target' }
    $script:events.Add('initialize'); if ($script:failure -ceq 'initialize') { throw 'injected init failure' }
    $script:diskObject.PartitionStyle='MBR'; $script:diskObject.Signature=123
}
function New-Partition {
    param($InputObject,$Offset,$Size,$MbrType,$AssignDriveLetter,$ErrorAction)
    if ($InputObject -ne $script:diskObject -or $Offset -ne 1048576 -or $Size -ne 132120576 -or $AssignDriveLetter -or $MbrType -cne 'IFS') { throw 'Wrong partition target' }
    $script:events.Add('partition'); if ($script:failure -ceq 'partition') { throw 'injected partition failure' }
    $script:diskObject.NumberOfPartitions=1; return $script:partitionObject
}
function Get-Partition {
    param($DiskNumber,$ErrorAction)
    if ($DiskNumber -ne 77) { throw 'Wrong partition query' }; return $script:partitionObject
}
function Format-Volume {
    param($Partition,$FileSystem,$AllocationUnitSize,$NewFileSystemLabel,$Confirm,$ErrorAction)
    if ($Partition -ne $script:partitionObject -or $FileSystem -cne 'NTFS' -or $AllocationUnitSize -ne 4096) { throw 'Wrong format target' }
    $script:events.Add('format'); if ($script:failure -ceq 'format') { throw 'injected format failure' }
}
function Get-Volume {
    param([Parameter(ValueFromPipeline)]$InputObject)
    process { if ($InputObject -ne $script:partitionObject) { throw 'Wrong volume query' }; return $script:volumeObject }
}
function Reset-Case([string]$failure) {
    $script:failure=$failure; $script:native=[SubstituteDisk]::new(); $script:native.Image=[IO.Path]::Combine($FixtureRoot,'not-created.vhd')
    $script:native.Fail=$failure; $script:events=[Collections.Generic.List[string]]::new()
    $script:phase='new'; $script:partitionNumber=$null; $script:diskKey=$null; $script:volume=$null; $script:exchangeId=$null
    $script:released=$false; $script:physical=$null; $script:readyConfirmed=$false; $script:controlFailed=$false
    $script:diskObject=[pscustomobject]@{ Number=77; Size=134217728; IsBoot=$false; IsSystem=$false; IsOffline=$false; IsReadOnly=$false;
        Path='device-path'; UniqueId='disk-identity'; Signature=0; PartitionStyle='RAW'; NumberOfPartitions=0 }
    $script:partitionObject=[pscustomobject]@{ PartitionNumber=1; Offset=1048576; Size=132120576; DriveLetter=$null }
    $script:volumeObject=[pscustomobject]@{ Path='\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\'; FileSystem='NTFS'; DriveLetter=$null; Size=132120576 }
}
function Expect-Throw([scriptblock]$action) {
    $threw=$false; try { & $action } catch { $threw=$true }
    if (-not $threw) { throw ('Expected refusal; completedCases={0}; failure={1}; nativeFail={2}; action={3}' -f $script:cases,$script:failure,$script:native.Fail,$action.ToString()) }
}
$cases=0
Reset-Case ''
Prepare-Volume
if ($script:phase -cne 'prepared-not-share-admitted' -or ($script:events -join ',') -notmatch 'initialize.*partition.*format') { throw 'Preparation sequence' }
Release-Volume; $count=$script:native.Calls.Count; Release-Volume
if ($count -ne $script:native.Calls.Count -or -not $script:native.Closed -or -not $script:released) { throw 'Release idempotence' }
$cases++
foreach ($failure in @('create','attach','initialize','partition','format','exchange')) {
    Reset-Case $failure; Expect-Throw { Prepare-Volume }
    if ($failure -in @('create','attach') -and $script:events.Contains('initialize')) { throw 'Failure passed initialization' }
    $script:native.Fail=''; $script:failure=''; Release-Volume
    if (-not $script:released) { throw 'Owned failure cleanup' }
    $cases++
}
foreach ($identity in @('number','boot','raw','volume')) {
    Reset-Case ''
    switch ($identity) { 'number' { $script:diskObject.Number=99 }; 'boot' { $script:diskObject.IsBoot=$true }; 'raw' { $script:diskObject.PartitionStyle='GPT' }; 'volume' { $script:volumeObject.Path='C:\ordinary\' } }
    Expect-Throw { Prepare-Volume }
    if ($identity -ne 'volume' -and $script:events.Contains('initialize')) { throw 'Foreign disk initialized' }
    if ($script:native.Calls.Contains('exchange') -and $identity -eq 'volume') { throw 'Fallback directory created' }
    $cases++
}
foreach ($releaseFault in @('detach','query-unknown','image-identity')) {
    Reset-Case ''; Prepare-Volume; $script:failure=$releaseFault; $script:native.Fail=$releaseFault
    Expect-Throw { Release-Volume }
    if ($script:native.Calls.Contains('delete-image') -or $script:native.Closed) { throw 'Unconfirmed detach was released' }
    $cases++
}
Reset-Case ''; Prepare-Volume; $script:native.CloseUnknown=$true; Expect-Throw { Release-Volume }
if ($script:native.Calls.Contains('detach')) { throw 'Close unknown detached' }; $cases++
foreach ($failure in @('image-remnant','absence-unknown')) {
    Reset-Case $failure; Expect-Throw { Release-Volume }
    if ($script:released -or $script:native.Closed -or $script:native.Calls.Contains('delete-image')) { throw 'Unproven image absence released' }
    $cases++
}
Reset-Case 'journal'; Expect-Throw { Invoke-VolumeCommand 'prepare' }
if (-not $script:controlFailed -or $script:native.Calls.Contains('create')) { throw 'Journal failure passed creation' }
$script:failure=''; $count=$script:native.Calls.Count
Expect-Throw { Invoke-VolumeCommand 'release' }
if ($count -ne $script:native.Calls.Count) { throw 'Control failure accepted another operation' }; $cases++
# Actual bounded journal/serialization code, only within the Node-owned synthetic root.
Reset-Case ''; $Root=$FixtureRoot; $TaskId='11111111-2222-3333-4444-555555555555'; $script:requestSequence=1
$script:native.ImageId='AABBCCDD:0000000000000001'
$capture=[IO.StringWriter]::new(); $originalOut=[Console]::Out
try {
    [Console]::SetOut($capture)
    & $actualWriteState 'reply' $null
    $protocolReply=$capture.ToString() | ConvertFrom-Json
    if ($null -ne $protocolReply.error -or $script:controlFailed) { throw 'Success null was coerced' }
    $journal=[IO.Path]::Combine($Root,'volume-helper.json'); $next=[IO.Path]::Combine($Root,'volume-helper.next.json')
    $before=[IO.File]::ReadAllText($journal)
    if ($before -cne $capture.ToString().TrimEnd("`r","`n")) { throw 'Journal/reply mismatch' }; $cases++
    [IO.File]::WriteAllText($next,'x')
    Expect-Throw { & $actualWriteState 'reply' $null }
    if (-not $script:controlFailed -or [IO.File]::ReadAllText($journal) -cne $before) { throw 'Journal failure was not terminal' }; $cases++
} finally { [Console]::SetOut($originalOut); $capture.Dispose() }
if (Get-Module Storage) { throw 'A real storage provider was loaded' }
@{ cases=$cases; realStorageOperations=0; helperParsed=$true; abiSize=56; protocolReply=$protocolReply } | ConvertTo-Json -Compress -Depth 4
