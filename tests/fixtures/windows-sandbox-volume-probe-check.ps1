param([string]$HelperPath,[string]$NativeAssembly,[string]$FixtureRoot,[string]$PreflightPath)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PowerShell 7 x64 required; no fallback'}
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$PSModuleAutoLoadingPreference='None'; Set-StrictMode -Version Latest
if(Get-Module Storage){throw 'Storage loaded in substitutes'}
[void][Reflection.Assembly]::LoadFile($NativeAssembly)
if(-not [SuperPiVolume.NativeDisk].GetMethod('ProbeExchange')){throw 'Native probe type missing'}
foreach($source in @($HelperPath,$PreflightPath)){
 $tokens=$null;$errors=$null
 $parsed=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw (($errors | ForEach-Object {'{0}:{1}' -f $_.ErrorId,$_.Extent.StartLineNumber}) -join ',')}
 if($source -ceq $HelperPath){$ast=$parsed}
}
$script:transientOwner=$null
$script:candidateReceiptUnknown=$false
foreach($name in @('Test-TransientUnknown','Assert-TransientHealthy','Write-Evidence','Invoke-VolumeProbe','Invoke-VolumeCommand','Read-Request')){
 $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($nodes.Count -ne 1){throw 'Function selection mismatch'}
 . ([ScriptBlock]::Create($nodes[0].Extent.Text))
}
class ProbeSubstitute {
 [string]$RootId='root'; [string]$ProbeFileId='AABBCCDD:0000000000000003'
 [bool]$ProbeMatched=$false; [int]$ProbeOpened=0; [int]$ProbeClosed=0; [bool]$CloseUnknown=$false
 [string]$Mode=''; [int]$Calls=0
 [Reflection.MethodInfo]$IdentityInvariant
 [string] Fingerprint([string]$path,[bool]$directory){return $this.RootId}
 [void] ProbeExchange([string]$volume,[string]$id){
  $this.Calls++
  if($volume -cne '\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\' -or $id -cne 'AABBCCDD:0000000000000002'){throw 'Probe target mismatch'}
  $this.ProbeOpened=1; $this.ProbeClosed=1
  if($this.Mode -ceq 'write-failure'){throw 'Injected write failure'}
  if($this.Mode -ceq 'close-unknown'){$this.ProbeClosed=0;$this.CloseUnknown=$true;throw 'Injected close unknown'}
  if($this.Mode -ceq 'native-identity'){[void]$this.IdentityInvariant.Invoke($null,[object[]]@($false,'Injected native identity failure'))}
  $this.ProbeOpened=2;$this.ProbeClosed=2;$this.ProbeMatched=$true
 }
}
function Verify-Ready {$script:verifications++}
function Write-State {param($kind,$errorCode) $script:lastError=$errorCode}
function Release-Volume {$script:releaseCalls++;$script:released=$true;$script:phase='released'}
function Expect-Failure([scriptblock]$call){$threw=$false;try{& $call}catch{$threw=$true};if(-not $threw){throw ('Expected failure: '+$call.ToString())}}
function Reset-Case([string]$name,[string]$mode){
 $script:Root=[IO.Path]::Combine($FixtureRoot,$name);[void][IO.Directory]::CreateDirectory($script:Root)
 $script:TaskId='11111111-2222-3333-4444-555555555555';$script:requestSequence=0
 $script:native=[ProbeSubstitute]::new();$script:native.Mode=$mode
 $script:native.IdentityInvariant=[SuperPiVolume.NativeDisk].GetMethod('ProbeInvariant',[Reflection.BindingFlags]'NonPublic,Static')
 $script:volume='\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\';$script:exchangeId='AABBCCDD:0000000000000002'
 $script:phase='prepared-not-share-admitted';$script:readyConfirmed=$true;$script:probeAttempted=$false;$script:controlFailed=$false
 $script:verifications=0;$script:releaseCalls=0;$script:released=$false;$script:lastError=$null
}
$cases=0
Reset-Case 'success' ''; [void](Invoke-VolumeCommand 'probe')
$receipt=[IO.File]::ReadAllText([IO.Path]::Combine($Root,'volume-probe.json')) | ConvertFrom-Json
if(-not $receipt.matched -or $receipt.opened -ne 2 -or $receipt.closed -ne 2 -or $null -ne $script:lastError -or $script:verifications -ne 1){throw 'Probe success evidence'}
$successReceipt=$receipt;$cases++
Expect-Failure {Invoke-VolumeProbe};if($script:native.Calls -ne 1){throw 'Probe repeated'};$cases++
foreach($mode in @('write-failure','close-unknown','native-identity')){
 Reset-Case $mode $mode;[void](Invoke-VolumeCommand 'probe')
 $receipt=[IO.File]::ReadAllText([IO.Path]::Combine($Root,'volume-probe.json')) | ConvertFrom-Json
 $failure=[IO.File]::ReadAllText([IO.Path]::Combine($Root,'volume-error-probe.json')) | ConvertFrom-Json
 $expectedCode=$(if($mode -ceq 'native-identity'){'storage-identity-failed'}else{'storage-operation-failed'})
 if($receipt.matched -or $script:lastError -cne $expectedCode -or $failure.classification -cne $expectedCode -or $failure.command -cne 'probe' -or $script:phase -cne 'blocked'){throw 'Missing failed probe evidence'}
 if($mode -ceq 'close-unknown' -and (-not $receipt.closeUnknown -or $receipt.closed -ne 0)){throw 'Close unknown was hidden'}
 $cases++
}
Reset-Case 'journal' '';[IO.File]::WriteAllText([IO.Path]::Combine($Root,'volume-probe.json'),'x')
Expect-Failure {Invoke-VolumeCommand 'probe'};Expect-Failure {Invoke-VolumeCommand 'release'}
if(-not $script:controlFailed -or $script:releaseCalls -ne 0){throw 'Journal failure released disk'};$cases++
Reset-Case 'request' '';$old=[Console]::In;$probeInput=[IO.StringReader]::new('{"command":"probe","sequence":1,"taskId":"11111111-2222-3333-4444-555555555555"}'+[char]10)
try{[Console]::SetIn($probeInput);if((Read-Request) -cne 'probe' -or $script:requestSequence -ne 1){throw 'Probe request rejected'}}finally{[Console]::SetIn($old);$probeInput.Dispose()};$cases++
if(Get-Module Storage){throw 'Storage provider was loaded'}
@{cases=$cases;realStorageOperations=0;helperParsed=$true;preflightParsed=$true;probe=$successReceipt}|ConvertTo-Json -Depth 4 -Compress
