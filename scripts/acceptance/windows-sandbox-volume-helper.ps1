# Task-only persistent manager. Not executed by imports or substitute tests.
param([switch]$Run, [string]$TaskId, [string]$Root, [string]$NativeSha256, [switch]$StartupDiagnostic, [string]$CapacityProbeSha256, [switch]$CandidateCapture,
    [string]$InputSourceSha256, [string]$InputToolSha256,
    [string]$TaskPackageSha256, [string]$TaskRunnerSha256, [string]$TaskSnapshotId)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:transientOwner = $null
$script:transientReported = $false
$script:terminalReportAttempted = $false
$script:candidateStages = @($null,$null)
$script:candidateReceiptUnknown = $false
$script:inputStage = $null
$script:taskResultStage = $null
function Test-TransientUnknown { return ($null -ne $script:transientOwner -and $script:transientOwner.Unknown) }
function Assert-TransientHealthy {
    if (Test-TransientUnknown) { throw 'Transient close unknown; no further file access' }
    if ($script:candidateReceiptUnknown) { throw 'Candidate receipt close unknown; no further file access' }
}
function Write-TransientFailure([string]$phase) {
    if (-not (Test-TransientUnknown) -or $script:transientReported) { return }
    # Mark before attempting output: an output failure does not authorize a retry or filesystem fallback.
    $script:transientReported = $true
    if ($phase.Length -gt 40) { throw 'Transient phase bound' }
    $owner = $script:transientOwner
    $operation = $owner.OperationException
    $close = $owner.CloseException
    $value = [ordered]@{ protocol='super-pi-volume-transient-v1'; taskId=$TaskId; phase=$phase;
        role=$owner.Role.ToString(); handle=$owner.RetainedHandle; closeUnknown=$true;
        opened=$owner.Opened; closed=$owner.Closed; closeAttempts=$owner.CloseAttempts; closeError=$owner.CloseError;
        operationType=$(if($null -ne $operation){$operation.GetType().FullName.Substring(0,[Math]::Min(160,$operation.GetType().FullName.Length))}else{$null});
        operationHresult=$(if($null -ne $operation){$operation.HResult}else{$null});
        operationNativeCode=$(if($operation -is [ComponentModel.Win32Exception]){$operation.NativeErrorCode}else{$null});
        closeType=$(if($null -ne $close){$close.GetType().FullName.Substring(0,[Math]::Min(160,$close.GetType().FullName.Length))}else{$null});
        closeHresult=$(if($null -ne $close){$close.HResult}else{$null}) }
    $json = $value | ConvertTo-Json -Compress -Depth 3
    if ([Text.Encoding]::UTF8.GetByteCount($json)+2 -gt 1024) { throw 'Transient diagnostic budget' }
    [Console]::Error.WriteLine($json); [Console]::Error.Flush()
}
function Write-TerminalFailure {
    if (-not (Test-TransientUnknown) -and -not $script:candidateReceiptUnknown -and -not $script:terminalReportAttempted) {
        $script:terminalReportAttempted = $true
        try { $script:phase = 'blocked-control'; Write-State 'fatal' 'control-or-journal-failed' } catch {}
    }
    # The file-report attempt can itself create an unknown transient close.
    if (Test-TransientUnknown) { try { Write-TransientFailure 'blocked-control' } catch {} }
}
function Write-StartupDiagnostic([bool]$ok, $failure) {
    $errorInfo = $null
    if ($null -ne $failure) {
        $cause = $failure.Exception.GetBaseException()
        $message = $cause.Message
        $errorInfo = [ordered]@{ exception = $cause.GetType().FullName; hresult = $cause.HResult;
            nativeCode = $(if ($cause -is [ComponentModel.Win32Exception]) { $cause.NativeErrorCode } else { $null });
            message = $message.Substring(0,[Math]::Min(256,$message.Length)); messageTruncated = ($message.Length -gt 256) }
    }
    $value = [ordered]@{ protocol = 'super-pi-volume-startup-v1'; taskId = $TaskId; ok = $ok;
        step = $script:startupStep; completed = $script:startupCompleted; error = $errorInfo }
    $json = $value | ConvertTo-Json -Compress -Depth 4
    if ([Text.Encoding]::UTF8.GetByteCount($json) + 2 -gt 2048) { throw 'Startup receipt budget' }
    # Encode only this dedicated receipt; do not move the original OutputEncoding step.
    $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n")
    $output = [Console]::OpenStandardOutput()
    $output.Write($bytes,0,$bytes.Length); $output.Flush()
}
$script:startupStep = 'arguments'
$script:startupCompleted = 'none'
try {
if (-not $Run) { throw 'Explicit task invocation is required' }
if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess) { throw 'PowerShell 7 x64 is required; no fallback' }
if ($TaskId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $NativeSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid fixed arguments' }
if (-not [string]::IsNullOrEmpty($CapacityProbeSha256) -and $CapacityProbeSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid capacity probe digest' }
if ($CandidateCapture -and -not [string]::IsNullOrEmpty($CapacityProbeSha256)) { throw 'Candidate and capacity profiles are exclusive' }
if (-not [string]::IsNullOrEmpty($InputSourceSha256) -or -not [string]::IsNullOrEmpty($InputToolSha256)) {
    if (-not $CandidateCapture -or -not [string]::IsNullOrEmpty($CapacityProbeSha256) -or
        $InputSourceSha256 -cnotmatch '^[0-9a-f]{64}$' -or $InputToolSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Fixed input/candidate profile required' }
}
if (-not [string]::IsNullOrEmpty($TaskPackageSha256) -or -not [string]::IsNullOrEmpty($TaskRunnerSha256) -or -not [string]::IsNullOrEmpty($TaskSnapshotId)) {
    if (-not $CandidateCapture -or -not [string]::IsNullOrEmpty($CapacityProbeSha256) -or
        -not [string]::IsNullOrEmpty($InputSourceSha256) -or -not [string]::IsNullOrEmpty($InputToolSha256) -or
        $TaskPackageSha256 -cnotmatch '^[0-9a-f]{64}$' -or $TaskRunnerSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $TaskSnapshotId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'Exclusive task package profile required' }
}
if ($Root -notmatch '^[A-Za-z]:\\' -or $Root -match '[%\[\]\x00-\x1f]' -or $Root.Length -gt 180 -or [IO.Path]::GetFullPath($Root) -cne $Root) { throw 'Invalid private root' }
$script:startupCompleted = 'arguments'; $script:startupStep = 'assembly-check'
$assemblyPath = [IO.Path]::Combine($Root, 'volume-native.dll')
if ((Get-Item -LiteralPath $assemblyPath).Length -gt 131072 -or (Get-FileHash -LiteralPath $assemblyPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $NativeSha256) { throw 'Native assembly identity/hash' }
$script:startupCompleted = 'assembly-check'; $script:startupStep = 'assembly-load'
[void][Reflection.Assembly]::LoadFile($assemblyPath)
if ($CandidateCapture -and ($null -eq [SuperPiVolume.NativeDisk].GetMethod('CaptureCandidateManifest') -or
    $null -eq [SuperPiVolume.NativeDisk].GetMethod('CaptureCandidateBatch'))) { throw 'Candidate capture assembly required' }
$script:startupCompleted = 'assembly-load'; $script:startupStep = 'output-encoding'
if (-not [string]::IsNullOrEmpty($InputSourceSha256) -and $null -eq [SuperPiVolume.NativeDisk].GetMethod('InstallInputs')) { throw 'Input installation assembly required' }
if (-not [string]::IsNullOrEmpty($TaskPackageSha256) -and ($null -eq [SuperPiVolume.NativeDisk].GetMethod('InstallTaskInputs') -or
    $null -eq [SuperPiVolume.NativeDisk].GetMethod('CaptureTaskResult'))) { throw 'Task installation/result assembly required' }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$script:startupCompleted = 'output-encoding'; $script:startupStep = 'native-constructor'
$script:transientOwner = New-Object SuperPiVolume.TransientOwner
$script:native = New-Object SuperPiVolume.NativeDisk($Root, [Guid]$TaskId, $script:transientOwner)
$script:startupCompleted = 'native-constructor'; $script:startupStep = 'complete'
if ($StartupDiagnostic) { Write-StartupDiagnostic $true $null; exit 0 }
} catch {
    if (Test-TransientUnknown) {
        try { Write-TransientFailure $script:startupStep } catch {}
        while ($true) { [Threading.Thread]::Sleep(1000) } # Caller retains responsibility even when NativeDisk construction failed.
    }
    if (-not $StartupDiagnostic) { throw }
    Write-StartupDiagnostic $false $_
    # Keep the original PowerShell error record on stderr; host preserves only its bounded raw prefix.
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
}
# Import directly into this PowerShell 7 process; the invocation settings disable implicit WinPS compatibility.
Import-Module Storage -SkipEditionCheck -ErrorAction Stop
$script:phase = 'new'
$script:partitionNumber = $null
$script:diskKey = $null
$script:volume = $null
$script:exchangeId = $null
$script:released = $false
$script:requestSequence = 0
$script:physical = $null
$script:readyConfirmed = $false
$script:controlFailed = $false
$script:probeAttempted = $false
$script:guestReadAttempted = $false
$script:capacityInstallAttempted = $false
$script:capacityReadAttempted = $false

function Write-State([string]$kind, $errorCode) {
    try {
    Assert-TransientHealthy
    if ($null -ne $errorCode -and $errorCode -cnotin @('storage-operation-failed','storage-identity-failed','control-or-journal-failed')) { throw 'Unknown error code' }
    $state = [ordered]@{ protocol = 'super-pi-volume-v1'; taskId = $TaskId; sequence = $script:requestSequence; kind = $kind;
        phase = $script:phase; error = $errorCode; imageCreated = $script:native.Created; imageId = $script:native.ImageId;
        diskId = $TaskId; physicalPath = $script:physical; volumePath = $script:volume; exchangeId = $script:exchangeId;
        capacity = 134217728; imageBudget = 135266304; shareAdmission = $false;
        detached = $script:native.DetachConfirmed; managementClosed = $script:native.Closed; closeUnknown = $script:native.CloseUnknown }
    $json = $state | ConvertTo-Json -Compress -Depth 4
    if ([Text.Encoding]::UTF8.GetByteCount($json) + 2 -gt 8192) { throw 'Journal budget exceeded' }
    if ($script:native.Fingerprint($Root, $true) -cne $script:native.RootId) { throw 'Journal root identity changed' }
    $next = [IO.Path]::Combine($Root, 'volume-helper.next.json')
    $journal = [IO.Path]::Combine($Root, 'volume-helper.json')
    $stream = [IO.File]::Open($next, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($json); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() }
    finally { $stream.Dispose() }
    # PowerShell converts $null to an empty string for this .NET string argument.
    if ([IO.File]::Exists($journal)) { [IO.File]::Replace($next, $journal, [System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($next, $journal) }
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    } catch { $script:controlFailed = $true; throw }
}
function One($items, [string]$description) {
    $values = @($items)
    if ($values.Count -ne 1) { throw "Ambiguous $description" }
    return $values[0]
}
function Write-Evidence([string]$name, $record) {
    try {
        Assert-TransientHealthy
        if ($name -cnotin @('volume-probe.json','volume-guest-read.json','volume-error-read-guest.json','volume-error-prepare.json','volume-error-probe.json','volume-error-verify.json','volume-error-release.json','volume-error-exit.json',
            'volume-capacity-install.json','volume-capacity-read.json','volume-error-install-capacity.json','volume-error-read-capacity.json')) { throw 'Unknown evidence leaf' }
        if ($script:native.Fingerprint($Root,$true) -cne $script:native.RootId) { throw 'Evidence root identity changed' }
        $bytes=[Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress -Depth 4))
        if ($bytes.Length -gt 4096) { throw 'Evidence budget' }
        $file=[IO.File]::Open([IO.Path]::Combine($Root,$name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $file.Write($bytes,0,$bytes.Length); $file.Flush() } finally { $file.Dispose() }
    } catch { $script:controlFailed=$true; throw }
}
function Invoke-VolumeProbe {
    if ($script:phase -cne 'prepared-not-share-admitted' -or -not $script:readyConfirmed -or $script:probeAttempted) { throw 'Native probe admission' }
    try { Verify-Ready } catch { throw [SuperPiVolume.StorageIdentityException]::new('Probe volume binding failed',$_.Exception) }
    $script:probeAttempted=$true
    try { $script:native.ProbeExchange($script:volume,$script:exchangeId) }
    finally {
        Write-Evidence 'volume-probe.json' ([ordered]@{ protocol='super-pi-volume-probe-v1'; taskId=$TaskId;
            volumePath=$script:volume; exchangeId=$script:exchangeId; fileId=$script:native.ProbeFileId;
            bytes=32; matched=$script:native.ProbeMatched; opened=$script:native.ProbeOpened;
            closed=$script:native.ProbeClosed; closeUnknown=$script:native.CloseUnknown })
    }
}
function Invoke-GuestRead {
    if ($script:phase -cne 'prepared-not-share-admitted' -or -not $script:readyConfirmed -or $script:guestReadAttempted) { throw 'Guest read admission' }
    $script:guestReadAttempted=$true
    try {
        try { Verify-Ready } catch { throw [SuperPiVolume.StorageIdentityException]::new('Guest read volume binding failed',$_.Exception) }
        $script:native.ReadGuestExchange($script:volume,$script:exchangeId)
    } finally {
        Write-Evidence 'volume-guest-read.json' ([ordered]@{ protocol='super-pi-volume-guest-read-v1'; taskId=$TaskId;
            volumePath=$script:volume; exchangeId=$script:exchangeId; fileId=$script:native.GuestReadFileId;
            requestedBytes=32; bytes=$script:native.GuestReadBytes; matched=$script:native.GuestReadMatched;
            opened=$script:native.GuestReadOpened; closed=$script:native.GuestReadClosed; peak=$script:native.GuestReadPeak;
            fileRetained=$script:native.GuestFileRetained; directoryRetained=$script:native.GuestDirectoryRetained;
            fileCloseError=$script:native.GuestFileCloseError; directoryCloseError=$script:native.GuestDirectoryCloseError;
            closeUnknown=$script:native.CloseUnknown })
    }
}
function Write-CapacityReceipt([string]$stage) {
    if ($stage -cnotin @('install','read')) { throw 'Fixed capacity receipt stage' }
    Write-Evidence ('volume-capacity-'+$stage+'.json') ([ordered]@{ protocol='super-pi-volume-capacity-v1'; stage=$stage;
        taskId=$TaskId; volumePath=$script:volume; exchangeId=$script:exchangeId; probeSha256=$CapacityProbeSha256;
        installed=$script:native.CapacityInstalled; readCompleted=$script:native.CapacityReadCompleted;
        probeId=$script:native.CapacityProbeId; slotId=$script:native.CapacitySlotId; sentinelId=$script:native.CapacitySentinelId;
        fillId=$script:native.CapacityFillId; fillLength=$script:native.CapacityFillLength; fillAllocation=$script:native.CapacityFillAllocation;
        resultBase64=$script:native.CapacityResultBase64; sentinelMatched=$script:native.CapacitySentinelMatched;
        opened=$script:native.CapacityOpened; closed=$script:native.CapacityClosed; peak=$script:native.CapacityPeak;
        closeErrors=@($script:native.CapacityCloseErrors); retainedHandles=@($script:native.CapacityRetainedHandles); closeUnknown=$script:native.CloseUnknown })
}
function Invoke-CapacityInstall {
    if ($CapacityProbeSha256 -cnotmatch '^[0-9a-f]{64}$' -or $script:phase -cne 'prepared-not-share-admitted' -or
        -not $script:readyConfirmed -or $script:capacityInstallAttempted) { throw 'Capacity installation admission' }
    $script:capacityInstallAttempted=$true
    try {
        try { Verify-Ready } catch { throw [SuperPiVolume.StorageIdentityException]::new('Capacity install volume binding failed',$_.Exception) }
        $script:native.InstallCapacity($script:volume,$script:exchangeId,$CapacityProbeSha256)
    } finally { Write-CapacityReceipt 'install' }
}
function Invoke-CapacityRead {
    if ($CapacityProbeSha256 -cnotmatch '^[0-9a-f]{64}$' -or $script:phase -cne 'prepared-not-share-admitted' -or
        -not $script:readyConfirmed -or -not $script:capacityInstallAttempted -or -not $script:native.CapacityInstalled -or $script:capacityReadAttempted) { throw 'Capacity read admission' }
    $script:capacityReadAttempted=$true
    try {
        try { Verify-Ready } catch { throw [SuperPiVolume.StorageIdentityException]::new('Capacity read volume binding failed',$_.Exception) }
        $script:native.ReadCapacity($script:volume,$script:exchangeId)
    } finally { Write-CapacityReceipt 'read' }
}
# These commands do not establish a VM/read lease. The host dispatcher remains unwired.
function Get-CandidateException($failure) {
    if ($null -eq $failure) { return $null }
    $cause=$failure.GetBaseException()
    $name=$cause.GetType().FullName -creplace '[^A-Za-z0-9._+]', '?'
    return ,@($name.Substring(0,[Math]::Min(64,$name.Length)), $cause.HResult,
        $(if($cause -is [ComponentModel.Win32Exception]){$cause.NativeErrorCode}else{$null}))
}
function Get-CandidateIo($io) {
    if ($null -eq $io) { return $null }
    return ,@($io.Success,$io.Error,$io.Count)
}
function New-CandidateReceiptStream([string]$name) {
    Assert-TransientHealthy
    return [IO.File]::Open([IO.Path]::Combine($Root,$name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
}
function Write-CandidateReceipt($owner,[string]$name,$record) {
    if ($owner.receiptAttempted) { throw 'Candidate receipt already attempted' }
    $owner.receiptAttempted=$true
    $bytes=$null
    try {
        Assert-TransientHealthy
        $prefix=$(if($owner.stage -ceq 'task-input' -or $owner.stage -ceq 'task-result'){$owner.stage}else{'candidate-'+$owner.stage})
        $expected=$prefix+'-'+$(if($null -eq $owner.captureException){'receipt'}else{'error'})+'.json'
        if ($name -cne $expected) { throw 'Fixed candidate receipt leaf' }
        $bytes=[Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 7 -Compress))
        $owner.allocatedBytes=$bytes.Length
        if ($bytes.Length -gt 4096) { throw 'Candidate receipt budget' }
        if ($script:native.Fingerprint($Root,$true) -cne $script:native.RootId) { throw 'Candidate receipt root identity changed' }
        $owner.stream=New-CandidateReceiptStream $name
        $owner.opened=1
        $owner.handle=$owner.stream.SafeFileHandle.DangerousGetHandle().ToInt64().ToString('X')
        $owner.stream.Write($bytes,0,$bytes.Length); $owner.writeCompleted=$true
        $owner.stream.Flush(); $owner.flushCompleted=$true
    } catch { $owner.operationException=$_.Exception }
    finally {
        if ($null -ne $owner.stream) {
            $owner.closeAttempts=1
            try { $owner.stream.Dispose(); $owner.closed=1; $owner.stream=$null; $owner.handle=$null }
            catch { $owner.closeException=$_.Exception; $owner.closeUnknown=$true; $script:candidateReceiptUnknown=$true }
        }
        if ($null -ne $bytes) { [Array]::Clear($bytes,0,$bytes.Length); $owner.clearedBytes=$bytes.Length }
    }
    if ($null -ne $owner.operationException) { throw $owner.operationException }
    if ($null -ne $owner.closeException) { throw $owner.closeException }
}
function Get-CandidateSuccess([string]$stage) {
    Assert-TransientHealthy
    $prefix=$(if($stage -ceq 'manifest'){'CandidateManifest'}else{'CandidateBatch'})
    if (-not $script:native.($prefix+'Captured') -or $script:native.CloseUnknown -or
        $script:native.($prefix+'Opened') -ne $script:native.($prefix+'Closed')) { throw 'Candidate capture not closed successfully' }
    $retained=$script:native.($prefix+'RetainedHandles')
    foreach($handle in $retained) { if($null -ne $handle){throw 'Candidate retained business handle'} }
    $record=[ordered]@{ protocol='super-pi-candidate-capture-v1'; stage=$stage; taskId=$TaskId;
        volumePath=$script:volume; exchangeId=$script:exchangeId; carrierId=$script:native.($prefix+'CarrierId');
        bytes=$script:native.($prefix+'Bytes'); sha256=$script:native.($prefix+'Sha256');
        handles=[ordered]@{opened=$script:native.($prefix+'Opened');closed=$script:native.($prefix+'Closed');
            peak=$script:native.($prefix+'Peak');closeUnknown=$false;retained=@()} }
    if ($stage -ceq 'manifest') { $record.sourceId=$script:native.CandidateManifestSourceId }
    else {
        $record.requestSha256=$script:native.CandidateBatchRequestSha256
        $items=$script:native.CandidateBatchItems
        if ($items.Length -gt 16) { throw 'Candidate item bound' }
        $rows=[object[]]::new($items.Length)
        for($i=0;$i -lt $items.Length;$i++) { $rows[$i]=[object[]]@($items[$i].SourceId,$items[$i].Bytes,$items[$i].Sha256) }
        $record.items=$rows
    }
    return $record
}
function Get-CandidateFailure($owner) {
    $stage=$owner.stage; $prefix=$(if($stage -ceq 'manifest'){'CandidateManifest'}else{'CandidateBatch'})
    $record=[ordered]@{protocol='super-pi-candidate-capture-error-v1';stage=$stage;taskId=$TaskId;
        volumePath=$script:volume;exchangeId=$script:exchangeId;captured=$script:native.($prefix+'Captured');
        carrierId=$script:native.($prefix+'CarrierId');bytes=$script:native.($prefix+'Bytes');sha256=$script:native.($prefix+'Sha256');
        handles=[ordered]@{opened=$script:native.($prefix+'Opened');closed=$script:native.($prefix+'Closed');peak=$script:native.($prefix+'Peak');
            closeUnknown=$script:native.CloseUnknown;retained=$script:native.($prefix+'RetainedHandles');errors=$script:native.($prefix+'CloseErrors')};
        capture=(Get-CandidateException $owner.captureException);
        operation=(Get-CandidateException $script:native.($prefix+'OperationException'));
        close=(Get-CandidateException $script:native.($prefix+'CloseException'));
        allocatedBytes=$script:native.($prefix+'AllocatedBytes');clearedBytes=$script:native.($prefix+'ClearedBytes');
        retainsOperations=$script:native.($prefix+'RetainsOperations') }
    if ($stage -ceq 'manifest') {
        $record.sourceId=$script:native.CandidateManifestSourceId
        $record.read=Get-CandidateIo $script:native.CandidateManifestReadResult
        $record.write=Get-CandidateIo $script:native.CandidateManifestWriteResult
        $record.flush=Get-CandidateIo $script:native.CandidateManifestFlushResult
    } else {
        $record.requestId=$script:native.CandidateBatchRequestId; $record.requestSha256=$script:native.CandidateBatchRequestSha256
        $record.requestRead=Get-CandidateIo $script:native.CandidateBatchRequestRead
        $record.flush=Get-CandidateIo $script:native.CandidateBatchFlushResult
        $facts=$script:native.CandidateBatchIoFacts
        if ($facts.Length -gt 16) { throw 'Candidate IO fact bound' }
        $rows=[object[]]::new($facts.Length)
        for($i=0;$i -lt $facts.Length;$i++) {
            $rows[$i]=[object[]]@($facts[$i].Index,$facts[$i].RequestedBytes,(Get-CandidateIo $facts[$i].Read),(Get-CandidateIo $facts[$i].Write))
        }
        $record.io=$rows # Available prefix only: a metadata failure may precede the next IO fact.
    }
    return $record
}
function Write-CandidateTerminal($owner) {
    # Receipt/report failure is terminal. No second file-report attempt, including the outer catch.
    $script:controlFailed=$true; $script:terminalReportAttempted=$true
    # The same pre-write marker covers startup/transient and candidate report diagnostics.
    if ($script:transientReported) { return }
    $script:transientReported=$true
    $transient=$null
    if (Test-TransientUnknown) {
        $t=$script:transientOwner
        $transient=@($t.Role.ToString(),$t.RetainedHandle,$t.CloseError,
            (Get-CandidateException $t.OperationException),(Get-CandidateException $t.CloseException))
    }
    $record=[ordered]@{protocol='super-pi-candidate-report-failure-v1';taskId=$TaskId;stage=$owner.stage;
        capture=(Get-CandidateException $owner.captureException);report=(Get-CandidateException $owner.reportException);
        receipt=@($owner.opened,$owner.closed,$owner.closeAttempts,$owner.handle,$owner.writeCompleted,$owner.flushCompleted,
            (Get-CandidateException $owner.operationException),(Get-CandidateException $owner.closeException));
        transient=$transient}
    $json=$record | ConvertTo-Json -Compress -Depth 5
    if ([Text.Encoding]::UTF8.GetByteCount($json)+2 -gt 1024) { throw 'Candidate diagnostic budget' }
    [Console]::Error.WriteLine($json); [Console]::Error.Flush()
}
function Invoke-CandidateCapture([string]$stage) {
    Assert-TransientHealthy
    if ($stage -cnotin @('manifest','batch')) { throw 'Fixed candidate capture stage' }
    $index=$(if($stage -ceq 'manifest'){0}else{1})
    if (-not $CandidateCapture -or $script:phase -cne 'prepared-not-share-admitted' -or -not $script:readyConfirmed -or
        $script:controlFailed -or $script:native.CloseUnknown -or $null -ne $script:candidateStages[$index] -or
        ($stage -ceq 'batch' -and -not $script:native.CandidateManifestCaptured)) { throw 'Candidate capture admission' }
    # Own the attempt before Verify-Ready or any native/file operation. There is no retry.
    $owner=[ordered]@{stage=$stage;captureException=$null;reportException=$null;receiptAttempted=$false;
        stream=$null;handle=$null;opened=0;closed=0;closeAttempts=0;closeUnknown=$false;writeCompleted=$false;flushCompleted=$false;
        operationException=$null;closeException=$null;allocatedBytes=0;clearedBytes=0}
    $script:candidateStages[$index]=$owner
    $record=$null
    try {
        try { Verify-Ready } catch { throw [SuperPiVolume.StorageIdentityException]::new('Candidate volume binding failed',$_.Exception) }
        if ($stage -ceq 'manifest') { $script:native.CaptureCandidateManifest($script:volume,$script:exchangeId) }
        else { $script:native.CaptureCandidateBatch($script:volume,$script:exchangeId) }
        $record=Get-CandidateSuccess $stage
    } catch { $owner.captureException=$_.Exception }
    try {
        Assert-TransientHealthy
        if ($null -ne $owner.captureException) { $record=Get-CandidateFailure $owner }
        $leaf='candidate-'+$stage+'-'+$(if($null -eq $owner.captureException){'receipt'}else{'error'})+'.json'
        Write-CandidateReceipt $owner $leaf $record
    } catch {
        $owner.reportException=$_.Exception
        try { Write-CandidateTerminal $owner } catch {}
        throw $owner.reportException
    }
    if ($null -ne $owner.captureException) { throw $owner.captureException }
}
function Invoke-InputInstall {
    Assert-TransientHealthy
    if ($InputSourceSha256 -cnotmatch '^[0-9a-f]{64}$' -or $InputToolSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        -not $CandidateCapture -or $null -ne $script:inputStage -or $script:phase -cne 'prepared-not-share-admitted' -or
        -not $script:readyConfirmed -or $script:controlFailed -or $script:native.CloseUnknown) { throw 'Input installation admission' }
    $owner=[ordered]@{stage='input';captureException=$null;reportException=$null;receiptAttempted=$false;
        stream=$null;handle=$null;opened=0;closed=0;closeAttempts=0;closeUnknown=$false;writeCompleted=$false;flushCompleted=$false;
        operationException=$null;closeException=$null;allocatedBytes=0;clearedBytes=0}
    $script:inputStage=$owner
    try {
        try { Verify-Ready } catch { throw [SuperPiVolume.StorageIdentityException]::new('Input volume binding failed',$_.Exception) }
        $script:native.InstallInputs($script:volume,$script:exchangeId,$InputSourceSha256,$InputToolSha256)
    } catch { $owner.captureException=$_.Exception }
    try {
        $record=[ordered]@{protocol='super-pi-input-install-v1';taskId=$TaskId;volumePath=$script:volume;exchangeId=$script:exchangeId;
            installed=$script:native.InputsInstalled;sourceSha256=$InputSourceSha256;toolSha256=$InputToolSha256;
            ids=[ordered]@{sourceCarrier=$script:native.InputSourceCarrierId;toolCarrier=$script:native.InputToolCarrierId;
                workspace=$script:native.InputWorkspaceId;tools=$script:native.InputToolsId;
                source=$script:native.InputSourceId;tool=$script:native.InputToolId};
            handles=[ordered]@{opened=$script:native.InputOpened;closed=$script:native.InputClosed;peak=$script:native.InputPeak;
                retained=$script:native.InputRetainedHandles;errors=$script:native.InputCloseErrors;closeUnknown=$script:native.CloseUnknown};
            buffers=[ordered]@{allocated=$script:native.InputAllocated;cleared=$script:native.InputCleared};
            failure=[ordered]@{capture=(Get-CandidateException $owner.captureException);
                operation=(Get-CandidateException $script:native.InputOperationException);close=(Get-CandidateException $script:native.InputCloseException)}}
        $leaf='candidate-input-'+$(if($null -eq $owner.captureException){'receipt'}else{'error'})+'.json'
        Write-CandidateReceipt $owner $leaf $record
    } catch {
        $owner.reportException=$_.Exception
        try { Write-CandidateTerminal $owner } catch {}
        throw $owner.reportException
    }
    if ($null -ne $owner.captureException) { throw $owner.captureException }
}
function New-TaskStage([string]$stage) {
    return [ordered]@{stage=$stage;captureException=$null;reportException=$null;receiptAttempted=$false;
        stream=$null;handle=$null;opened=0;closed=0;closeAttempts=0;closeUnknown=$false;writeCompleted=$false;flushCompleted=$false;
        operationException=$null;closeException=$null;allocatedBytes=0;clearedBytes=0}
}
function Invoke-TaskInstall {
    Assert-TransientHealthy
    if ([string]::IsNullOrEmpty($TaskPackageSha256) -or -not $CandidateCapture -or $null -ne $script:inputStage -or
        $script:phase -cne 'prepared-not-share-admitted' -or -not $script:readyConfirmed -or
        $script:controlFailed -or $script:native.CloseUnknown) { throw 'Task installation admission' }
    $owner=New-TaskStage 'task-input'
    $script:inputStage=$owner
    try {
        try { Verify-Ready } catch { throw [SuperPiVolume.StorageIdentityException]::new('Task installation volume binding failed',$_.Exception) }
        $script:native.InstallTaskInputs($script:volume,$script:exchangeId,$TaskPackageSha256,$TaskRunnerSha256,$TaskId,$TaskSnapshotId)
    } catch { $owner.captureException=$_.Exception }
    try {
        $record=[ordered]@{protocol='super-pi-task-install-v1';taskId=$TaskId;snapshotId=$TaskSnapshotId;
            volumePath=$script:volume;exchangeId=$script:exchangeId;installed=$script:native.InputsInstalled;
            packageSha256=$TaskPackageSha256;runnerSha256=$TaskRunnerSha256;
            ids=[ordered]@{packageCarrier=$script:native.InputSourceCarrierId;runnerCarrier=$script:native.InputToolCarrierId;
                workspace=$script:native.InputWorkspaceId;tools=$script:native.InputToolsId;
                package=$script:native.InputSourceId;runner=$script:native.InputToolId};
            handles=[ordered]@{opened=$script:native.InputOpened;closed=$script:native.InputClosed;peak=$script:native.InputPeak;
                retained=$script:native.InputRetainedHandles;errors=$script:native.InputCloseErrors;closeUnknown=$script:native.CloseUnknown};
            buffers=[ordered]@{allocated=$script:native.InputAllocated;cleared=$script:native.InputCleared};
            failure=[ordered]@{capture=(Get-CandidateException $owner.captureException);
                operation=(Get-CandidateException $script:native.InputOperationException);close=(Get-CandidateException $script:native.InputCloseException)}}
        $leaf='task-input-'+$(if($null -eq $owner.captureException){'receipt'}else{'error'})+'.json'
        Write-CandidateReceipt $owner $leaf $record
    } catch {
        $owner.reportException=$_.Exception
        try { Write-CandidateTerminal $owner } catch {}
        throw $owner.reportException
    }
    if ($null -ne $owner.captureException) { throw $owner.captureException }
}
function Invoke-TaskResult {
    Assert-TransientHealthy
    if ([string]::IsNullOrEmpty($TaskPackageSha256) -or -not $CandidateCapture -or $null -eq $script:inputStage -or
        $null -ne $script:taskResultStage -or $script:phase -cne 'prepared-not-share-admitted' -or -not $script:readyConfirmed -or
        $script:controlFailed -or $script:native.CloseUnknown -or -not $script:native.InputsInstalled) { throw 'Task result admission' }
    $owner=New-TaskStage 'task-result'
    $script:taskResultStage=$owner
    try {
        try { Verify-Ready } catch { throw [SuperPiVolume.StorageIdentityException]::new('Task result volume binding failed',$_.Exception) }
        $script:native.CaptureTaskResult($script:volume,$script:exchangeId)
    } catch { $owner.captureException=$_.Exception }
    try {
        $record=[ordered]@{protocol='super-pi-task-result-capture-v1';taskId=$TaskId;snapshotId=$TaskSnapshotId;
            volumePath=$script:volume;exchangeId=$script:exchangeId;captured=$script:native.TaskResultCaptured;
            sourceId=$script:native.TaskResultSourceId;carrierId=$script:native.TaskResultCarrierId;
            bytes=$script:native.TaskResultBytes;sha256=$script:native.TaskResultSha256;
            handles=[ordered]@{opened=$script:native.TaskResultOpened;closed=$script:native.TaskResultClosed;peak=$script:native.TaskResultPeak;
                retained=$script:native.TaskResultRetainedHandles;errors=$script:native.TaskResultCloseErrors;closeUnknown=$script:native.CloseUnknown};
            buffers=[ordered]@{allocated=$script:native.TaskResultAllocatedBytes;cleared=$script:native.TaskResultClearedBytes};
            io=[ordered]@{read=(Get-CandidateIo $script:native.TaskResultReadResult);write=(Get-CandidateIo $script:native.TaskResultWriteResult);
                flush=(Get-CandidateIo $script:native.TaskResultFlushResult)};
            nativeOperations=[SuperPiVolume.NativeDisk]::TaskResultNativeOperations;retainsOperations=$script:native.TaskResultRetainsOperations;
            failure=[ordered]@{capture=(Get-CandidateException $owner.captureException);
                operation=(Get-CandidateException $script:native.TaskResultOperationException);close=(Get-CandidateException $script:native.TaskResultCloseException)}}
        $leaf='task-result-'+$(if($null -eq $owner.captureException){'receipt'}else{'error'})+'.json'
        Write-CandidateReceipt $owner $leaf $record
    } catch {
        $owner.reportException=$_.Exception
        try { Write-CandidateTerminal $owner } catch {}
        throw $owner.reportException
    }
    if ($null -ne $owner.captureException) { throw $owner.captureException }
}
function Get-OwnedDisk([switch]$ForRelease) {
    $script:native.VerifyImage()
    $physical = $script:native.PhysicalPath()
    if ($script:physical -and $physical -cne $script:physical) { throw 'Physical device changed' }
    $image = One (Get-DiskImage -ImagePath $script:native.Image -ErrorAction Stop) 'image'
    if (-not $image.Attached -or $image.DevicePath -ine $physical -or $image.ImagePath -ine $script:native.Image) { throw 'Image/device binding changed' }
    $disk = One ($image | Get-Disk -ErrorAction Stop) 'disk'
    $number = [uint32]($physical -replace '^.*PhysicalDrive', '')
    if ($disk.Number -ne $number -or $disk.Size -ne 134217728 -or $disk.IsBoot -or $disk.IsSystem -or
        (-not $ForRelease -and ($disk.IsOffline -or $disk.IsReadOnly))) { throw 'Unexpected owned disk' }
    $key = [string]$disk.Path + '|' + [string]$disk.UniqueId + '|' + [string]$disk.Signature
    if ($script:diskKey -and $key -cne $script:diskKey) { throw 'Initialized disk identity changed' }
    $script:physical = $physical
    return $disk
}
function Get-OwnedPartition {
    $disk = Get-OwnedDisk
    $partition = One (Get-Partition -DiskNumber $disk.Number -ErrorAction Stop) 'partition'
    $related = One (Get-Disk -Partition $partition -ErrorAction Stop) 'partition disk'
    if ($related.Path -cne $disk.Path -or $related.UniqueId -cne $disk.UniqueId -or $partition.PartitionNumber -ne $script:partitionNumber -or
        $partition.Offset -ne 1048576 -or $partition.Size -ne 132120576 -or $partition.DriveLetter) { throw 'Partition binding changed' }
    return $partition
}
function Verify-Ready {
    $partition = Get-OwnedPartition
    $current = One ($partition | Get-Volume -ErrorAction Stop) 'volume'
    if ($current.Path -ine $script:volume -or $current.FileSystem -ne 'NTFS' -or $current.DriveLetter -or $current.Size -gt 132120576 -or $current.Size -lt 33554432) { throw 'Volume binding changed' }
    $number = [uint32]($script:physical -replace '^.*PhysicalDrive', '')
    $script:native.VerifyVolume($script:volume, $number, 1048576, 132120576)
    $script:native.VerifyExchange($script:volume, $script:exchangeId)
}
function Prepare-Volume {
    if ($script:phase -ne 'new') { throw 'No preparation retry' }
    $script:native.EnableTaskPrivilege() # Existing process token only; no elevation or feature enablement.
    $script:phase = 'creating'; Write-State 'progress' $null
    $script:native.Create(); $script:phase = 'created'; Write-State 'progress' $null
    $script:native.Attach(); $script:phase = 'attached'; Write-State 'progress' $null
    $disk = Get-OwnedDisk
    if ($disk.PartitionStyle -ne 'RAW' -or $disk.NumberOfPartitions -ne 0) { throw 'New disk is not RAW and empty' }
    # Every destructive target is freshly derived from the held VHD, never a guessed disk number.
    [void](Initialize-Disk -InputObject $disk -PartitionStyle MBR -PassThru -Confirm:$false -ErrorAction Stop)
    $disk = Get-OwnedDisk
    if ($disk.PartitionStyle -ne 'MBR' -or $disk.NumberOfPartitions -ne 0) { throw 'Unexpected initialized layout' }
    $script:diskKey = [string]$disk.Path + '|' + [string]$disk.UniqueId + '|' + [string]$disk.Signature
    $script:phase = 'initialized'; Write-State 'progress' $null
    $disk = Get-OwnedDisk
    $partition = One (New-Partition -InputObject $disk -Offset 1048576 -Size 132120576 -MbrType IFS -AssignDriveLetter:$false -ErrorAction Stop) 'new partition'
    $script:partitionNumber = $partition.PartitionNumber
    $partition = Get-OwnedPartition
    $script:phase = 'partitioned'; Write-State 'progress' $null
    [void](Format-Volume -Partition $partition -FileSystem NTFS -AllocationUnitSize 4096 -NewFileSystemLabel 'SuperPiTask' -Confirm:$false -ErrorAction Stop)
    $partition = Get-OwnedPartition
    $formatted = One ($partition | Get-Volume -ErrorAction Stop) 'formatted volume'
    $script:volume = [string]$formatted.Path
    $number = [uint32]($script:physical -replace '^.*PhysicalDrive', '')
    $script:native.VerifyVolume($script:volume, $number, 1048576, 132120576)
    $script:exchangeId = $script:native.CreateExchange($script:volume)
    Verify-Ready
    $script:readyConfirmed = $true
    $script:phase = 'prepared-not-share-admitted'
}
function Release-Volume {
    if ($script:released) { return }
    if ($script:native.CloseUnknown) { throw 'Native close unknown; retain resources' }
    if (-not $script:native.Created) {
        $script:native.ConfirmNoCreatedImage()
        $script:released = $true; $script:phase = 'released'; return
    }
    if ($script:native.Closed) {
        $script:native.DeleteOwnedImage()
        $script:released = $true; $script:phase = 'released'; return
    }
    $script:native.VerifyImage()
    if ($script:readyConfirmed) { Verify-Ready }
    if ($script:native.AttachAttempted) {
        $image = One (Get-DiskImage -ImagePath $script:native.Image -ErrorAction Stop) 'release image'
        if ($image.Attached) {
            [void](Get-OwnedDisk -ForRelease)
            $script:native.Detach()
        }
        $after = One (Get-DiskImage -ImagePath $script:native.Image -ErrorAction Stop) 'detached image'
        if ($after.Attached) { throw 'Detach not confirmed' }
        # GUID history in mount manager is not evidence of an active attachment.
        $script:native.ConfirmDetached(($null -ne $script:volume), $script:volume)
    }
    $script:native.CloseManagement()
    $script:native.DeleteOwnedImage()
    $script:released = $true; $script:phase = 'released'
}
function Read-Request {
    $line = New-Object Text.StringBuilder
    while ($true) {
        $character = [Console]::In.Read()
        if ($character -lt 0) { throw 'Control pipe lost' }
        if ($character -eq 10) { break }
        if ($line.Length -ge 512) { throw 'Request bound exceeded' }
        [void]$line.Append([char]$character)
    }
    $request = $line.ToString() | ConvertFrom-Json
    $keys = @($request.PSObject.Properties.Name | Sort-Object) -join ','
    if ($keys -cne 'command,sequence,taskId' -or $request.taskId -cne $TaskId -or $request.sequence -ne ($script:requestSequence + 1) -or
        $request.command -cnotin @('prepare','verify','probe','read-guest','install-capacity','read-capacity','install-input','install-task','read-task-result','read-candidate-manifest','read-candidate-batch','release','exit') -or $request.sequence -gt 16) { throw 'Invalid control request' }
    $script:requestSequence = [int]$request.sequence
    return $request.command
}
function Invoke-VolumeCommand([string]$command) {
    Assert-TransientHealthy
    if ($script:controlFailed) { throw 'Control/journal failure is terminal' }
    $errorCode = $null
    try {
        switch ($command) {
            'prepare' { Prepare-Volume }
            'verify' { if ($script:phase -ne 'prepared-not-share-admitted') { throw 'Not prepared' }; Verify-Ready }
            'probe' { Invoke-VolumeProbe }
            'read-guest' { Invoke-GuestRead }
            'install-capacity' { Invoke-CapacityInstall }
            'read-capacity' { Invoke-CapacityRead }
            'install-input' { Invoke-InputInstall }
            'install-task' { Invoke-TaskInstall }
            'read-task-result' { Invoke-TaskResult }
            'read-candidate-manifest' { Invoke-CandidateCapture 'manifest' }
            'read-candidate-batch' { Invoke-CandidateCapture 'batch' }
            'release' { Release-Volume }
            'exit' { if (-not $script:released) { throw 'Cannot exit while ownership remains' } }
            default { throw 'Unknown fixed command' }
        }
    } catch {
        if (Test-TransientUnknown) { throw }
        if ($script:controlFailed) { throw }
        $isIdentity=$false; $nested=$_.Exception
        for($depth=0;$null -ne $nested -and $depth -lt 8;$depth++) {
            if($nested -is [SuperPiVolume.StorageIdentityException]) { $isIdentity=$true; break }
            $nested=$nested.InnerException
        }
        $errorCode=$(if($isIdentity){'storage-identity-failed'}else{'storage-operation-failed'})
        $cause=$_.Exception.GetBaseException()
        if ($command -cnotin @('read-candidate-manifest','read-candidate-batch','install-input','install-task','read-task-result')) {
        Write-Evidence ('volume-error-'+$command+'.json') ([ordered]@{ command=$command; phase=$script:phase;
            classification=$errorCode; exception=$cause.GetType().FullName; hresult=$cause.HResult;
            nativeCode=$(if ($cause -is [ComponentModel.Win32Exception]) { $cause.NativeErrorCode } else { $null });
            message=$cause.Message.Substring(0,[Math]::Min(512,$cause.Message.Length)) })
        }
        $script:phase = 'blocked'
    }
    Write-State 'reply' $errorCode
    return ($command -ceq 'exit' -and $null -eq $errorCode)
}
try {
    while ($true) {
        $command = Read-Request
        if (Invoke-VolumeCommand $command) { exit 0 }
    }
} catch {
    # EOF/journal/protocol failure cannot be turned into an implicit detach while a VM may use it.
    Write-TerminalFailure
    while ($true) { [Threading.Thread]::Sleep(1000) } # Retained task helper; never automatic relaunch/kill.
}
