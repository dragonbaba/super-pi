param([string]$HelperPath,[string]$NativeAssembly)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PowerShell 7 x64 required'}
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$PSModuleAutoLoadingPreference='None'; Set-StrictMode -Version Latest
[void][Reflection.Assembly]::LoadFile($NativeAssembly)
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($HelperPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Helper parse failed'}
$script:transientOwner=$null
$script:candidateReceiptUnknown=$false
foreach($name in @('Test-TransientUnknown','Assert-TransientHealthy','Write-CapacityReceipt','Invoke-CapacityInstall','Invoke-CapacityRead','Invoke-VolumeCommand','Read-Request')){
    $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($nodes.Count -ne 1){throw 'Function selection mismatch'}
    . ([ScriptBlock]::Create($nodes[0].Extent.Text))
}
class CapacitySubstitute {
    [bool]$CapacityInstalled=$false; [bool]$CapacityReadCompleted=$false; [bool]$CapacitySentinelMatched=$false; [bool]$CloseUnknown=$false
    [object]$CapacityProbeId=$null; [object]$CapacitySlotId=$null; [object]$CapacitySentinelId=$null; [object]$CapacityFillId=$null
    [long]$CapacityFillLength=0; [long]$CapacityFillAllocation=0; [object]$CapacityResultBase64=$null
    [int]$CapacityOpened=0; [int]$CapacityClosed=0; [int]$CapacityPeak=0
    [object[]]$CapacityCloseErrors=[object[]]::new(9); [string[]]$CapacityRetainedHandles=[string[]]::new(9)
    [int]$Installs=0; [int]$Reads=0; [string]$Mode=''
    [void] InstallCapacity([string]$volume,[string]$exchange,[string]$sha) {
        $this.Installs++
        if($volume -cne '\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\' -or $exchange -cne 'AABBCCDD:0000000000000002' -or $sha -cne ('a'*64)){throw 'Wrong capacity binding'}
        $this.CapacityOpened=5; $this.CapacityClosed=5; $this.CapacityPeak=3
        $this.CapacityProbeId='AABBCCDD:0000000000000003'; $this.CapacitySlotId='AABBCCDD:0000000000000004'; $this.CapacitySentinelId='11223344:0000000000000002'
        if($this.Mode -ceq 'operation'){throw 'Injected install failure'}
        if($this.Mode -ceq 'close'){$this.CapacityClosed=4;$this.CapacityRetainedHandles[4]='66';$this.CapacityCloseErrors[4]=6;$this.CloseUnknown=$true;throw 'Injected install close unknown'}
        $this.CapacityInstalled=$true
    }
    [void] ReadCapacity([string]$volume,[string]$exchange) {
        $this.Reads++; $this.CapacityOpened=9; $this.CapacityClosed=9
        $this.CapacityFillId='AABBCCDD:0000000000000005'; $this.CapacityFillLength=1048576; $this.CapacityFillAllocation=1048576
        $this.CapacityResultBase64=[Convert]::ToBase64String([byte[]]::new(512))
        if($this.Mode -ceq 'read-failure'){throw 'Injected metadata failure after report'}
        $this.CapacitySentinelMatched=$true; $this.CapacityReadCompleted=$true
    }
}
function Verify-Ready {$script:verified++; if($script:mode -ceq 'identity'){throw 'Injected identity failure'}}
function Write-State {param($kind,$errorCode) $script:lastError=$errorCode}
function Write-Evidence {param($name,$record)
    if($script:mode -ceq 'journal'){$script:controlFailed=$true;throw 'Injected receipt failure'}
    if($script:receipts.Contains($name)){throw 'Duplicate capacity receipt'}
    $json=$record|ConvertTo-Json -Compress -Depth 4
    if([Text.Encoding]::UTF8.GetByteCount($json) -gt 4096){throw 'Capacity receipt bound'}
    $script:receipts[$name]=$json|ConvertFrom-Json
}
function Release-Volume {$script:releases++}
function Reject([scriptblock]$call){$failed=$false;try{& $call}catch{$failed=$true};if(-not $failed){throw 'Expected rejection'}}
function Reset([string]$mode){
    $script:mode=$mode; $script:native=[CapacitySubstitute]::new(); $script:native.Mode=$mode
    $script:TaskId='11111111-2222-3333-4444-555555555555'; $script:volume='\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\'
    $script:exchangeId='AABBCCDD:0000000000000002'; $script:CapacityProbeSha256='a'*64
    $script:phase='prepared-not-share-admitted'; $script:readyConfirmed=$true; $script:capacityInstallAttempted=$false; $script:capacityReadAttempted=$false
    $script:controlFailed=$false; $script:receipts=[ordered]@{}; $script:lastError=$null; $script:verified=0; $script:releases=0; $script:requestSequence=0
}
$cases=0
Reset ''; [void](Invoke-VolumeCommand 'install-capacity'); $installed=$script:receipts['volume-capacity-install.json']
if(-not $installed.installed -or $installed.closed -ne 5 -or $installed.closeErrors.Count -ne 9 -or $installed.retainedHandles.Count -ne 9 -or $null -ne $script:lastError){throw 'Install receipt/array serialization'}; $cases++
Reject {Invoke-CapacityInstall}; if($script:native.Installs -ne 1){throw 'Repeated installation'}; $cases++
[void](Invoke-VolumeCommand 'read-capacity'); $read=$script:receipts['volume-capacity-read.json']
if(-not $read.readCompleted -or $read.closed -ne 9 -or $read.resultBase64.Length -ne 684 -or $script:verified -ne 2){throw 'Read receipt'}; $cases++
Reject {Invoke-CapacityRead}; if($script:native.Reads -ne 1){throw 'Repeated capacity read'}; $cases++
foreach($mode in @('operation','close','identity')){
    Reset $mode; [void](Invoke-VolumeCommand 'install-capacity'); $r=$script:receipts['volume-capacity-install.json']; $e=$script:receipts['volume-error-install-capacity.json']
    $expected=$(if($mode -ceq 'identity'){'storage-identity-failed'}else{'storage-operation-failed'})
    if($r.installed -or $script:lastError -cne $expected -or $e.classification -cne $expected){throw 'Install failure attribution'}
    if($mode -ceq 'identity' -and $script:native.Installs -ne 0){throw 'Install after failed binding'}
    if($mode -ceq 'close' -and (-not $r.closeUnknown -or $r.retainedHandles[4] -cne '66' -or $r.closeErrors[4] -ne 6)){throw 'Lost close responsibility'}; $cases++
}
Reset ''; [void](Invoke-VolumeCommand 'install-capacity'); $script:native.Mode='read-failure'; [void](Invoke-VolumeCommand 'read-capacity')
$r=$script:receipts['volume-capacity-read.json']; if($r.readCompleted -or $r.resultBase64.Length -ne 684 -or $script:lastError -cne 'storage-operation-failed'){throw 'Lost diagnostic data'}; $cases++
Reset 'journal'; Reject {Invoke-VolumeCommand 'install-capacity'}; Reject {Invoke-VolumeCommand 'release'}
if(-not $script:controlFailed -or $script:releases -ne 0){throw 'Released after journal failure'}; $cases++
Reset ''; Reject {Invoke-CapacityRead}; if($script:native.Reads -ne 0){throw 'Read before install'}; $cases++
Reset ''; $script:CapacityProbeSha256=''; Reject {Invoke-CapacityInstall}; if($script:native.Installs -ne 0){throw 'Legacy helper accepted capacity'}; $cases++
Reset ''; $original=[Console]::In
foreach($json in @('{"command":"install-capacity","sequence":1,"taskId":"11111111-2222-3333-4444-555555555555"}',
    '{"command":"read-capacity","sequence":2,"taskId":"11111111-2222-3333-4444-555555555555"}',
    '{"command":"read-capacity","path":"outside","sequence":3,"taskId":"11111111-2222-3333-4444-555555555555"}')){
    $reader=[IO.StringReader]::new($json+[char]10)
    try{[Console]::SetIn($reader);if($script:requestSequence -lt 2){$expected=$(if($script:requestSequence -eq 0){'install-capacity'}else{'read-capacity'});if((Read-Request) -cne $expected){throw 'Fixed command mismatch'}}else{Reject {Read-Request}}}
    finally{[Console]::SetIn($original);$reader.Dispose()}; $cases++
}
if(Get-Module Storage){throw 'Storage unexpectedly loaded'}
@{cases=$cases;nativeConstructors=0;realStorageOperations=0;helperParsed=$true;fixedSlots=9;success=$true}|ConvertTo-Json -Compress
