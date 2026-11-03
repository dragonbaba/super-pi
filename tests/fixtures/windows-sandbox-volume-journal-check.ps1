param([string]$HelperPath, [string]$HelperSha256, [string]$FixtureRoot)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Set-StrictMode -Version Latest
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PowerShell 7 x64 required'}
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$PSModuleAutoLoadingPreference='None'
if(Get-Module Storage){throw 'Storage must not be loaded'}
if((Get-FileHash -LiteralPath $HelperPath -Algorithm SHA256).Hash -ine $HelperSha256){throw 'Helper source changed'}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($HelperPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Helper parse failed'}
$script:transientOwner=$null
$script:candidateReceiptUnknown=$false
foreach($name in @('Test-TransientUnknown','Assert-TransientHealthy','Write-State')) {
    $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($nodes.Count -ne 1){throw 'Unique journal dependency required'}
    . ([ScriptBlock]::Create($nodes[0].Extent.Text))
}
class JournalSubstitute {
    [string]$RootId='synthetic-root'; [bool]$Created=$false; $ImageId=$null
    [bool]$DetachConfirmed=$false; [bool]$Closed=$false; [bool]$CloseUnknown=$false
    [string] Fingerprint([string]$path,[bool]$directory){return $this.RootId}
}
function Describe-Error($record) {
    $outer=$record.Exception; $cause=$outer.GetBaseException()
    return [ordered]@{ outer=$outer.GetType().FullName; outerHresult=$outer.HResult;
        root=$cause.GetType().FullName; hresult=$cause.HResult;
        parameter=$(if($cause -is [ArgumentException]){$cause.ParamName}else{$null});
        message=$cause.Message.Substring(0,[Math]::Min(256,$cause.Message.Length)); truncated=($cause.Message.Length -gt 256) }
}
$script:Root=$FixtureRoot; $script:TaskId='11111111-2222-3333-4444-555555555555'
$script:native=[JournalSubstitute]::new(); $script:requestSequence=1; $script:phase='creating'
$script:physical=$null; $script:volume=$null; $script:exchangeId=$null; $script:controlFailed=$false
$journal=[IO.Path]::Combine($Root,'volume-helper.json'); $next=[IO.Path]::Combine($Root,'volume-helper.next.json')
$capture=[IO.StringWriter]::new(); $originalOutput=[Console]::Out
$failure=$null; $first=$null; $second=$null
try {
    [Console]::SetOut($capture)
    Write-State 'progress' $null
    $first=[IO.File]::ReadAllText($journal)
    if([IO.File]::Exists($next)){throw 'Initial Move did not consume next'}
    $script:native.Created=$true; $script:native.ImageId='AABBCCDD:0000000000000002'; $script:phase='created'
    try { Write-State 'progress' $null } catch { $failure=Describe-Error $_ }
    $published=[IO.File]::ReadAllText($journal)
    $second=$(if([IO.File]::Exists($next)){[IO.File]::ReadAllText($next)}else{$published})
    $lines=@($capture.ToString().Split([char]10,[StringSplitOptions]::RemoveEmptyEntries))
} finally { [Console]::SetOut($originalOutput); $capture.Dispose() }
# Same volume, bytes and three-string overload; only the backup argument differs.
$controlSource=[IO.Path]::Combine($Root,'control-next.json'); $controlTarget=[IO.Path]::Combine($Root,'control.json')
[IO.File]::WriteAllText($controlTarget,$first); [IO.File]::WriteAllText($controlSource,$second)
$controlFailure=$null
try { [IO.File]::Replace($controlSource,$controlTarget,[System.Management.Automation.Language.NullString]::Value) }
catch { $controlFailure=Describe-Error $_ }
$result=[ordered]@{ protocol='super-pi-volume-journal-check-v1'; powershell=$PSVersionTable.PSVersion.ToString();
    helperSha256=$HelperSha256; realStorageOperations=0; helperTopLevelExecuted=$false; firstMoved=$true;
    error=$failure; controlFailed=$script:controlFailed; stdoutRecords=$lines.Count; stdout=$lines;
    first=($first|ConvertFrom-Json); published=($published|ConvertFrom-Json); pending=($second|ConvertFrom-Json);
    nextExists=[IO.File]::Exists($next); controlError=$controlFailure;
    controlMatched=([IO.File]::ReadAllText($controlTarget) -ceq $second); controlSourceAbsent=(-not [IO.File]::Exists($controlSource)) }
$json=$result|ConvertTo-Json -Compress -Depth 6
if([Text.Encoding]::UTF8.GetByteCount($json)+2 -gt 8192){throw 'Diagnostic output budget'}
[Console]::Out.WriteLine($json)
