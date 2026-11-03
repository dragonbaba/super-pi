param([string]$HelperPath,[string]$NativeAssembly,[string]$SamplesBase64)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PS7 x64 required'}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::LoadFile($NativeAssembly)
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($HelperPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Helper parse'}
$names=@('Test-TransientUnknown','Assert-TransientHealthy','Write-TransientFailure','Write-TerminalFailure','Write-State','Write-Evidence',
    'Get-CandidateException','Get-CandidateIo','New-CandidateReceiptStream','Write-CandidateReceipt','Get-CandidateSuccess',
    'Get-CandidateFailure','Write-CandidateTerminal','Invoke-CandidateCapture','Invoke-VolumeCommand','Read-Request')
foreach($name in $names){
    $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($nodes.Count -ne 1){throw 'Exact helper function selection'}
    . ([ScriptBlock]::Create($nodes[0].Extent.Text))
}
$actualState=(Get-Item -LiteralPath Function:Write-State).ScriptBlock
$actualEvidence=(Get-Item -LiteralPath Function:Write-Evidence).ScriptBlock
$script:TaskId='11111111-2222-3333-4444-555555555555'
$script:Root='D:\not-accessed'
$samples=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SamplesBase64)) | ConvertFrom-Json
function Need([bool]$condition,[string]$message) { if(-not $condition){throw $message} }
function Reject([scriptblock]$action,[string]$expected) {
    $caughtError=$null; try{& $action}catch{$caughtError=$_.Exception}
    Need ($null -ne $caughtError -and $caughtError.GetBaseException().Message -ceq $expected) ('Expected rejection: '+$expected)
}
function Unknown-Transient {
    return [pscustomobject]@{Unknown=$true;Role='Fingerprint';RetainedHandle='FFFFFFFFFFFFFFFF';CloseError=0;
        OperationException=[ComponentModel.Win32Exception]::new(5,'metadata');CloseException=[IO.IOException]::new('metadata close');
        Opened=1;Closed=0;CloseAttempts=1}
}
function Reset([string]$scenario,[int]$count=1) {
    $s=$samples | Where-Object count -eq $count
    $script:native=[CandidateHelperNative]::new()
    $script:native.Configure($count,$s.manifestBytes,$s.manifestSha,$s.requestSha,$s.payloadSha)
    $script:mode=$scenario; $script:native.Mode=$(if($scenario -in @('capture','worst','fingerprint')){$scenario}else{''})
    $script:CandidateCapture=$true; $script:phase='prepared-not-share-admitted'; $script:readyConfirmed=$true; $script:controlFailed=$false
    $script:transientOwner=$null; $script:transientReported=$false; $script:terminalReportAttempted=$false
    $script:candidateReceiptUnknown=$false; $script:candidateStages=@($null,$null)
    $script:volume='\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\'; $script:exchangeId='AABBCCDD:0000000000000001'
    $script:requestSequence=0; $script:verifyCalls=0; $script:opens=0; $script:replies=0; $script:genericEvidence=0
    $script:streams=[Collections.Generic.List[object]]::new(); $script:leaves=[Collections.Generic.List[string]]::new()
    $script:lastError=$null
}
function Verify-Ready {
    $script:verifyCalls++
    Need ($null -ne $script:candidateStages[0] -or $null -ne $script:candidateStages[1]) 'Attempt must precede verification'
    if($script:mode -ceq 'identity'){throw 'verify identity'}
}
function New-CandidateReceiptStream([string]$name) {
    $script:opens++
    if($script:mode -ceq 'open'){throw 'receipt open'}
    $stream=[CandidateReceiptStream]::new(); $stream.Mode=$script:mode
    $script:streams.Add($stream); $script:leaves.Add($name)
    return $stream
}
function Write-State {
    param($kind,$errorCode)
    $script:replies++; $script:lastError=$errorCode
    foreach($stream in $script:streams) {
        Need ($stream.Closes -eq 1 -and $stream.Cleared) 'Reply before receipt closure/clear'
        if($null -eq $errorCode){Need ($stream.Writes -eq 1 -and $stream.Flushes -eq 1) 'Reply before write/flush'}
    }
}
function Write-Evidence { param($name,$record) $script:genericEvidence++; throw 'forbidden generic evidence' }
function Cleared-Receipts {
    foreach($owner in $script:candidateStages) { if($null -ne $owner){
        Need ($owner.allocatedBytes -eq $owner.clearedBytes) 'Receipt buffer retained'
        if(-not $owner.closeUnknown){Need ($null -eq $owner.stream -and $null -eq $owner.handle) 'Closed receipt references retained'}
    }}
}
$results=[Collections.Generic.List[object]]::new()
$cases=0; $maxReceipt=0; $maxDiagnostic=0; $guardCalls=0
foreach($count in @(0,1,16)){
    Reset 'ok' $count
    $savedIn=[Console]::In
    $first=@{command='read-candidate-manifest';sequence=1;taskId=$TaskId}|ConvertTo-Json -Compress
    $second=@{command='read-candidate-batch';sequence=2;taskId=$TaskId}|ConvertTo-Json -Compress
    $reader=[IO.StringReader]::new($first+[Environment]::NewLine+$second+[Environment]::NewLine)
    try {
        [Console]::SetIn($reader)
        Need ((Read-Request) -ceq 'read-candidate-manifest') 'Manifest request'
        [void](Invoke-VolumeCommand 'read-candidate-manifest')
        Need ((Read-Request) -ceq 'read-candidate-batch') 'Batch request'
        [void](Invoke-VolumeCommand 'read-candidate-batch')
    } finally { [Console]::SetIn($savedIn); $reader.Dispose() }
    Need ($script:replies -eq 2 -and $script:opens -eq 2 -and $script:verifyCalls -eq 2 -and
        $script:native.Manifests -eq 1 -and $script:native.Batches -eq 1 -and $script:native.ItemReads -eq 1 -and
        $script:native.Fingerprints -eq 2 -and $null -eq $script:lastError -and $script:genericEvidence -eq 0) 'Success counts'
    Need (($script:leaves -join ',') -ceq 'candidate-manifest-receipt.json,candidate-batch-receipt.json') 'Success leaves'
    foreach($stream in $script:streams) { $n=[Text.Encoding]::UTF8.GetByteCount($stream.Text); Need ($n -le 4096) 'Receipt bound';$maxReceipt=[Math]::Max($maxReceipt,$n) }
    Cleared-Receipts
    $results.Add([ordered]@{count=$count;manifest=$script:streams[0].Text;batch=$script:streams[1].Text})
    Reject {Invoke-CandidateCapture 'manifest'} 'Candidate capture admission'
    Reject {Invoke-CandidateCapture 'batch'} 'Candidate capture admission'
    Need ($script:opens -eq 2 -and $script:verifyCalls -eq 2) 'Success cannot repeat'
    $cases++
}
foreach($scenario in @('off','phase','ready','control','native-close','duplicate','batch-first','transient','stage')){
    Reset 'ok'; $stage='manifest'; $expected='Candidate capture admission'
    switch($scenario){
        'off' {$script:CandidateCapture=$false}
        'phase' {$script:phase='new'}
        'ready' {$script:readyConfirmed=$false}
        'control' {$script:controlFailed=$true}
        'native-close' {$script:native.CloseUnknown=$true}
        'duplicate' {$script:candidateStages[0]=@{}}
        'batch-first' {$stage='batch'}
        'transient' {$script:transientOwner=Unknown-Transient;$expected='Transient close unknown; no further file access'}
        'stage' {$stage='other';$expected='Fixed candidate capture stage'}
    }
    Reject {Invoke-CandidateCapture $stage} $expected
    Need ($script:opens -eq 0 -and $script:verifyCalls -eq 0 -and $script:native.Fingerprints -eq 0 -and
        $script:native.Manifests -eq 0 -and $script:native.Batches -eq 0) 'Rejected admission acquired resources'
    $cases++
}
foreach($stage in @('manifest','batch')){
    foreach($scenario in @('capture','identity')){
        Reset $scenario; if($stage -ceq 'batch'){$script:native.CandidateManifestCaptured=$true}
        [void](Invoke-VolumeCommand ('read-candidate-'+$stage))
        Need ($script:phase -ceq 'blocked' -and $script:replies -eq 1 -and $script:opens -eq 1 -and $script:genericEvidence -eq 0 -and
            $script:native.ItemReads -eq 0 -and $script:leaves[0] -ceq ('candidate-'+$stage+'-error.json')) 'Capture failure facts'
        $receipt=$script:streams[0].Text | ConvertFrom-Json
        Need (-not $receipt.captured -and $null -ne $receipt.capture -and $receipt.protocol -ceq 'super-pi-candidate-capture-error-v1') 'Failure schema'
        Need ($script:lastError -ceq $(if($scenario -ceq 'identity'){'storage-identity-failed'}else{'storage-operation-failed'})) 'Failure classification'
        Cleared-Receipts; $cases++
    }
}
Reset 'worst' 16; $script:native.CandidateManifestCaptured=$true
[void](Invoke-VolumeCommand 'read-candidate-batch')
$worstText=$script:streams[0].Text; $worst=$worstText | ConvertFrom-Json
$worstBytes=[Text.Encoding]::UTF8.GetByteCount($worstText); Need ($worstBytes -le 4096) 'Worst error bound'
Need ($worst.io.Count -eq 16 -and $worst.handles.retained.Count -eq 7 -and $worst.handles.closed -eq 91 -and
    $null -eq $worst.handles.errors[0] -and $worst.handles.errors[1] -eq 0 -and
    $worst.io[15][2][1] -eq [int]::MinValue -and $worst.io[15][3][2] -eq [uint32]::MaxValue -and
    $null -eq $worst.flush[1] -and $worst.requestRead[1] -eq [int]::MinValue -and $null -ne $worst.operation -and
    $null -ne $worst.close -and $script:native.ItemReads -eq 0) 'Raw worst failure facts lost'
Cleared-Receipts; $cases++
foreach($scenario in @('open','write','flush','close','write-close','flush-close','fingerprint','capture-write','transient-report','simultaneous','diagnostic-fail')){
    Reset $scenario; $script:native.CandidateManifestCaptured=$true
    if($scenario -ceq 'capture-write'){$script:native.Mode='capture';$script:mode='write'}
    $writer=[CandidateDiagnosticWriter]::new();$writer.Fail=($scenario -ceq 'diagnostic-fail')
    $savedError=[Console]::Error
    if($scenario -in @('transient-report','simultaneous','diagnostic-fail')){
        $originalReceipt=(Get-Item -LiteralPath Function:Write-CandidateReceipt).ScriptBlock
        function Write-CandidateReceipt($owner,[string]$name,$record) {
            if($script:mode -ceq 'simultaneous'){
                $script:mode='write-close'
                try { & $originalReceipt $owner $name $record } catch { $script:transientOwner=Unknown-Transient; throw }
            } else { $script:transientOwner=Unknown-Transient; throw 'injected transient report failure' }
        }
    }
    try {
        [Console]::SetError($writer)
        $caught=$null;try{[void](Invoke-VolumeCommand 'read-candidate-batch')}catch{$caught=$_.Exception}
        Need ($null -ne $caught -and $script:controlFailed -and $script:terminalReportAttempted -and
            $script:transientReported -and $script:replies -eq 0 -and $script:genericEvidence -eq 0) 'Report failure must hold without reply'
        $owner=$script:candidateStages[1]; Need ($null -ne $owner.reportException) 'Report error lost'
        if($scenario -ceq 'capture-write'){Need ($null -ne $owner.captureException -and $script:native.ItemReads -eq 0) 'Original capture lost/failed Items read'}
        $before=$script:opens; $fingerprints=$script:native.Fingerprints
        Write-TerminalFailure; Write-CandidateTerminal $owner; Write-TransientFailure 'blocked-control'
        Need ($writer.Attempts -eq 1 -and $script:opens -eq $before -and $script:native.Fingerprints -eq $fingerprints) 'Repeated diagnostics or file fallback'
        if($writer.Fail){Need ($writer.ToString().Length -eq 0) 'Failed writer unexpected output'}
        else {
            $text=$writer.ToString();$size=[Text.Encoding]::UTF8.GetByteCount($text);Need ($size -le 1024) 'Terminal diagnostic bound'
            $maxDiagnostic=[Math]::Max($maxDiagnostic,$size);$diagnostic=$text|ConvertFrom-Json
            Need ($diagnostic.protocol -ceq 'super-pi-candidate-report-failure-v1') 'Candidate diagnostic'
            if($scenario -ceq 'capture-write'){Need ($diagnostic.capture[2] -eq 5 -and $diagnostic.report[2] -eq 0) 'Capture and report raw errors'}
            if($scenario -ceq 'simultaneous'){
                Need ($diagnostic.transient[1] -ceq 'FFFFFFFFFFFFFFFF' -and $diagnostic.transient[2] -eq 0 -and
                    $diagnostic.receipt[3] -ceq '4567' -and $null -ne $diagnostic.receipt[7]) 'Combined responsibility diagnostic'
            }
        }
        foreach($stream in $script:streams){Need ($stream.Closes -eq 1 -and $stream.Cleared) 'Stream repeated close or retained bytes'}
        if($script:candidateReceiptUnknown){
            Need ($owner.closeUnknown -and $null -ne $owner.stream -and $owner.handle -ceq '4567' -and
                $owner.closed -eq 0 -and $owner.closeAttempts -eq 1 -and $null -ne $owner.closeException) 'Unknown stream responsibility lost'
            $message=$(if(Test-TransientUnknown){'Transient close unknown; no further file access'}else{'Candidate receipt close unknown; no further file access'})
            foreach($call in @({& $actualState 'reply' $null},{& $actualEvidence 'volume-probe.json' @{}},{Invoke-VolumeCommand 'release'},{Invoke-CandidateCapture 'manifest'})){
                Reject $call $message; $guardCalls++
            }
            Need ($script:opens -eq $before -and $script:native.Fingerprints -eq $fingerprints) 'Unknown receipt opened another file'
        }
        Cleared-Receipts
    } finally {
        [Console]::SetError($savedError);$writer.Dispose()
        if($scenario -in @('transient-report','simultaneous','diagnostic-fail')){Set-Item -LiteralPath Function:Write-CandidateReceipt -Value $originalReceipt}
    }
    $cases++
}
Reset 'ok';$script:transientOwner=Unknown-Transient
$writer=[CandidateDiagnosticWriter]::new();$savedError=[Console]::Error
try{
    [Console]::SetError($writer);Write-TransientFailure 'native-constructor';Write-TerminalFailure
    Need ($writer.Attempts -eq 1 -and $script:replies -eq 0) 'Startup transient diagnostic compatibility'
    Need (($writer.ToString()|ConvertFrom-Json).protocol -ceq 'super-pi-volume-transient-v1') 'Startup protocol changed'
}finally{[Console]::SetError($savedError);$writer.Dispose()}
$cases++
foreach($fixture in @('guest-read-check','capacity-helper-check','helper-check','journal-check','probe-check')){
    $tokens=$null;$errors=$null
    $parsed=[Management.Automation.Language.Parser]::ParseFile([IO.Path]::Combine([IO.Path]::GetDirectoryName($PSCommandPath),'windows-sandbox-volume-'+$fixture+'.ps1'),[ref]$tokens,[ref]$errors)
    Need ($errors.Count -eq 0 -and $parsed.Extent.Text.Contains('$script:candidateReceiptUnknown=$false')) 'Old extraction fixture guard initialization'
}
Need ([SuperPiVolume.NativeDisk]::CandidateManifestNativeOperations -eq 0 -and [SuperPiVolume.NativeDisk]::CandidateBatchNativeOperations -eq 0) 'Native adapter unexpectedly used'
$script:native=$null;$script:streams.Clear();$script:candidateStages=@($null,$null);$script:transientOwner=$null
$output=[ordered]@{cases=$cases;guardCalls=$guardCalls;maximumSuccessReceipt=$maxReceipt;worstErrorBytes=$worstBytes;
    maximumDiagnostic=$maxDiagnostic;nativeAdapterCalls=0;helperMainExecuted=$false;results=$results}
$json=$output|ConvertTo-Json -Depth 7 -Compress
Need ([Text.Encoding]::UTF8.GetByteCount($json)+2 -le 8192) 'Check output bound'
[Console]::WriteLine($json)
