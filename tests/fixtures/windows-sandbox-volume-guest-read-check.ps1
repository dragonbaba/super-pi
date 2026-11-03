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
foreach($name in @('Test-TransientUnknown','Assert-TransientHealthy','Invoke-GuestRead','Invoke-VolumeCommand','Read-Request')){
    $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($nodes.Count -ne 1){throw 'Function selection mismatch'}
    . ([ScriptBlock]::Create($nodes[0].Extent.Text))
}
class GuestReadSubstitute {
    [int]$GuestReadOpened=0; [int]$GuestReadClosed=0; [int]$GuestReadPeak=0; [uint32]$GuestReadBytes=0
    [bool]$GuestReadMatched=$false; [object]$GuestReadFileId=$null; [bool]$CloseUnknown=$false
    [bool]$GuestFileRetained=$false; [bool]$GuestDirectoryRetained=$false
    [object]$GuestFileCloseError=$null; [object]$GuestDirectoryCloseError=$null
    [string]$Mode=''; [int]$Calls=0
    [void] ReadGuestExchange([string]$volume,[string]$exchange){
        $this.Calls++
        if($volume -cne '\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\' -or $exchange -cne 'AABBCCDD:0000000000000002'){throw 'Wrong guest read binding'}
        $this.GuestReadOpened=2; $this.GuestReadClosed=2; $this.GuestReadPeak=2; $this.GuestReadBytes=32
        $this.GuestReadFileId='AABBCCDD:0000000000000003'
        if($this.Mode -ceq 'marker'){throw 'Injected marker mismatch'}
        if($this.Mode -in @('file-close','both-close')){
            $this.GuestReadClosed=1; $this.GuestFileRetained=$true; $this.GuestFileCloseError=6; $this.CloseUnknown=$true
            if($this.Mode -ceq 'both-close'){$this.GuestReadClosed=0;$this.GuestDirectoryRetained=$true;$this.GuestDirectoryCloseError=5}
            throw 'Injected close failure'
        }
        $this.GuestReadMatched=$true
    }
}
function Verify-Ready {$script:verified++; if($script:mode -ceq 'identity'){throw 'Injected verification failure'}}
function Write-State {param($kind,$errorCode) $script:lastError=$errorCode}
function Write-Evidence {param($name,$record) if($script:mode -ceq 'journal'){ $script:controlFailed=$true; throw 'Injected receipt failure' }; if($script:receipts.Contains($name)){throw 'Duplicate receipt'}; $script:receipts[$name]=$record}
function Release-Volume {$script:released=$true; $script:phase='released'; $script:releases++}
function Reject([scriptblock]$call){$failed=$false;try{& $call}catch{$failed=$true};if(-not $failed){throw 'Expected rejection'}}
function Reset([string]$mode){
    $script:mode=$mode; $script:native=[GuestReadSubstitute]::new(); $script:native.Mode=$mode
    $script:TaskId='11111111-2222-3333-4444-555555555555'; $script:volume='\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\'
    $script:exchangeId='AABBCCDD:0000000000000002'; $script:phase='prepared-not-share-admitted'
    $script:readyConfirmed=$true; $script:guestReadAttempted=$false; $script:controlFailed=$false
    $script:receipts=[ordered]@{}; $script:lastError=$null; $script:verified=0; $script:releases=0; $script:released=$false; $script:requestSequence=0
}
$cases=0
Reset ''; [void](Invoke-VolumeCommand 'read-guest'); $success=$script:receipts['volume-guest-read.json']
if(-not $success.matched -or $success.opened -ne 2 -or $success.closed -ne 2 -or $success.bytes -ne 32 -or $script:verified -ne 1 -or $null -ne $script:lastError){throw 'Guest read success receipt'}
$cases++; Reject {Invoke-GuestRead}; if($script:native.Calls -ne 1){throw 'Guest read repeated'}; $cases++
foreach($mode in @('marker','file-close','both-close','identity')){
    Reset $mode; [void](Invoke-VolumeCommand 'read-guest')
    $r=$script:receipts['volume-guest-read.json']; $e=$script:receipts['volume-error-read-guest.json']
    $expected=$(if($mode -ceq 'identity'){'storage-identity-failed'}else{'storage-operation-failed'})
    if($r.matched -or $script:lastError -cne $expected -or $e.classification -cne $expected -or $e.command -cne 'read-guest'){throw 'Failure evidence mismatch'}
    if($mode -ceq 'both-close' -and ($r.closed -ne 0 -or $r.fileCloseError -ne 6 -or $r.directoryCloseError -ne 5)){throw 'Close errors lost'}
    if($mode -ceq 'identity' -and ($r.opened -ne 0 -or $script:native.Calls -ne 0)){throw 'Read after identity failure'}
    $cases++
}
Reset 'journal'; Reject {Invoke-VolumeCommand 'read-guest'}; Reject {Invoke-VolumeCommand 'release'}
if(-not $script:controlFailed -or $script:releases -ne 0){throw 'Receipt failure released volume'}; $cases++
Reset ''; $original=[Console]::In
foreach($json in @('{"command":"read-guest","sequence":1,"taskId":"11111111-2222-3333-4444-555555555555"}', '{"command":"read-guest","path":"outside","sequence":2,"taskId":"11111111-2222-3333-4444-555555555555"}')){
    $inputReader=[IO.StringReader]::new($json+[char]10)
    try{[Console]::SetIn($inputReader);if($script:requestSequence -eq 0){if((Read-Request) -cne 'read-guest'){throw 'Fixed command rejected'}}else{Reject {Read-Request}}}
    finally{[Console]::SetIn($original);$inputReader.Dispose()}; $cases++
}
$flags=[Reflection.BindingFlags]'NonPublic,Static'
$marker=[SuperPiVolume.NativeDisk].GetMethod('GuestMarker',$flags)
$bytes=$marker.Invoke($null,[object[]]@([Guid]$TaskId))
if($bytes.Length -ne 32 -or [Text.Encoding]::ASCII.GetString($bytes) -cne ('111111112222333344445555555555'+"`r`n")){throw 'Native marker bytes'}; $cases++
$shape=[SuperPiVolume.NativeDisk].GetMethod('GuestShape',$flags)
$file=$script:volume+'exchange\guest-control.bin'
[object[]]$baseline=@([uint32]32,[uint32]1,[uint64]32,$false,$false,$file,$file,'AABBCCDD:0000000000000003',$script:exchangeId,$false)
[void]$shape.Invoke($null,$baseline); $cases++
foreach($change in @(@(0,[uint32]0x420),@(1,[uint32]2),@(2,[uint64]31),@(2,[uint64]33),@(3,$true),@(4,$true),@(5,'C:\fallback'),@(7,'DEADBEEF:0000000000000003'))){
    $arguments=$baseline.Clone(); $arguments[$change[0]]=$change[1]; Reject {[void]$shape.Invoke($null,$arguments)}; $cases++
}
[object[]]$directory=@([uint32]16,[uint32]1,[uint64]0,$false,$true,($script:volume+'exchange'),($script:volume+'exchange'),$script:exchangeId,$script:exchangeId,$true)
[void]$shape.Invoke($null,$directory); $cases++
$throwFirst=[SuperPiVolume.NativeDisk].GetMethod('ThrowGuestFailure',$flags)
$primary=[SuperPiVolume.StorageIdentityException]::new('primary-identity'); $fileClose=[ComponentModel.Win32Exception]::new(6,'file-close'); $directoryClose=[ComponentModel.Win32Exception]::new(5,'directory-close')
foreach($sample in @(@($primary,$fileClose,$directoryClose),@($null,$fileClose,$directoryClose),@($null,$null,$directoryClose))){
    $caught=$null
    try{[void]$throwFirst.Invoke($null,[object[]]$sample)}catch{$caught=$_.Exception.GetBaseException()}
    $expected=$sample[0]; if($null -eq $expected){$expected=$sample[1]}; if($null -eq $expected){$expected=$sample[2]}
    if(-not [object]::ReferenceEquals($caught,$expected)){throw 'Original operation/first close failure was replaced'}; $cases++
}
[void]$throwFirst.Invoke($null,[object[]]@($null,$null,$null)); $cases++
if(Get-Module Storage){throw 'Storage unexpectedly loaded'}
@{cases=$cases;realStorageOperations=0;nativeConstructors=0;helperParsed=$true;businessHandles=0;success=$success}|ConvertTo-Json -Depth 4 -Compress
