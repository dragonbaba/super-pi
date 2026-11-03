# Explicit read-only diagnostic entry. No storage module, file receipt, attach/detach or permission change.
param([switch]$RunDiagnostic, [string]$TaskId, [string]$InstanceId, [string]$Root,
    [string]$RootId, [string]$ImageId, [long]$ImageBytes, [string]$VolumePath, [string]$NativeSha256)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-SuperPiDiagnosticUtf8([string]$Text, [scriptblock]$WriteBytes, [scriptblock]$Flush, [hashtable]$State) {
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $count = $encoding.GetByteCount($Text)
    if ($count -le 0 -or $count -gt 4096 -or -not $Text.EndsWith("`n", [StringComparison]::Ordinal)) { throw 'Diagnostic output bound/LF' }
    $bytes = $encoding.GetBytes($Text)
    $State.EncodedAllocated += $bytes.Length
    try {
        [void](& $WriteBytes $bytes)
        [void](& $Flush)
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        $State.EncodedCleared += $bytes.Length
    }
}

function Invoke-SuperPiDiagnosticOwner($Owner, [string]$TaskId, [hashtable]$State, [scriptblock]$Emit, [scriptblock]$Hold) {
    if (-not [Object]::ReferenceEquals($State.Owner, $Owner) -or $State.RunAttempted) { throw 'Original one-shot diagnostic owner required' }
    $State.RunAttempted = $true
    $status = 1
    try {
        try { [void]$Owner.Run() }
        catch { $State.InvocationException = $_.Exception }
        # Keep original native operation/close facts; do not replace them with PowerShell's invocation wrapper.
        $State.OperationException = $Owner.OperationException
        $State.CloseException = $Owner.CloseException
        $success = ($null -eq $State.InvocationException -and $Owner.Succeeded -and -not $Owner.Unknown)
        if ($success) {
            $line = $Owner.SuccessReceipt
            if ([string]::IsNullOrEmpty($line) -or -not $line.EndsWith("`n", [StringComparison]::Ordinal) -or $line.EndsWith("`r`n", [StringComparison]::Ordinal)) {
                throw 'Native success receipt missing original LF'
            }
        } else {
            $facts = @{}
            foreach ($name in @('OperationException','CloseException','InvocationException')) {
                $errorValue = $State[$name]
                $facts[$name] = $(if ($null -eq $errorValue) { $null } else {
                    [ordered]@{ type=$errorValue.GetType().FullName; hresult=$errorValue.HResult;
                        nativeCode=$(if ($errorValue -is [ComponentModel.Win32Exception]) { $errorValue.NativeErrorCode } else { $null }) }
                })
            }
            $handles = $Owner.RetainedHandles
            $attempts = $Owner.CloseAttempts
            $operations = $Owner.OperationErrors
            $closes = $Owner.CloseErrors
            if ($handles.Length -ne 4 -or $attempts.Length -ne 4 -or $operations.Length -ne 4 -or $closes.Length -ne 4) { throw 'Fixed diagnostic responsibility slots' }
            $line = ([ordered]@{ protocol='super-pi-manager-loss-diagnostic-failure-v1'; taskId=$TaskId; unknown=[bool]$Owner.Unknown;
                opened=$Owner.Opened; closed=$Owner.Closed; peak=$Owner.Peak; retained=$handles; closeAttempts=$attempts;
                operationErrors=$operations; closeErrors=$closes; operation=$facts.OperationException;
                close=$facts.CloseException; invocation=$facts.InvocationException } | ConvertTo-Json -Compress -Depth 5) + "`n"
        }
        if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 4096) { throw 'Diagnostic line budget' }
        $State.OutputAttempted = $true
        try {
            [void](& $Emit $line $State)
            if ($success) { $status = 0 }
        } catch { $State.OutputException = $_.Exception }
    } catch { $State.WrapperException = $_.Exception }
    finally {
        if ($Owner.Unknown) {
            $State.HoldEntered = $true
            [void](& $Hold $Owner $State)
            throw 'Unknown owner hold unexpectedly returned'
        }
    }
    return $status
}

$script:diagnosticOwner = $null
$script:diagnosticState = $null
$script:diagnosticOutput = $null
$script:diagnosticStep = 'arguments'
try {
    if (-not $RunDiagnostic) { throw 'Explicit diagnostic invocation required' }
    if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess) {
        throw 'PowerShell 7 x64 required; no fallback'
    }
    if ($TaskId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' -or
        $InstanceId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' -or
        $RootId -cnotmatch '^[0-9A-F]{8}:[0-9A-F]{16}$' -or $ImageId -cnotmatch '^[0-9A-F]{8}:[0-9A-F]{16}$' -or
        $NativeSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ImageBytes -lt 134217728 -or $ImageBytes -gt 135266304 -or
        $VolumePath -cnotmatch '^\\\\\?\\Volume\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}\\$') { throw 'Invalid fixed diagnostic binding' }
    if ($Root.Length -gt 180 -or $Root -cnotmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($Root) -cne $Root) { throw 'Canonical private root required' }
    $rootAttributes = [IO.File]::GetAttributes($Root)
    if (([int]$rootAttributes -band 19456) -ne 0 -or ([int]$rootAttributes -band 16) -eq 0) { throw 'Private diagnostic root attributes' }
    $script:diagnosticStep = 'assembly-check'
    $assemblyPath = [IO.Path]::Combine($Root, 'volume-native.dll')
    $assembly = Get-Item -LiteralPath $assemblyPath -Force
    if ($assembly.PSIsContainer -or ([int]$assembly.Attributes -band 19968) -ne 0 -or $assembly.Length -le 0 -or $assembly.Length -gt 131072 -or
        (Get-FileHash -LiteralPath $assemblyPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $NativeSha256) { throw 'Fixed private diagnostic assembly' }
    $script:diagnosticStep = 'assembly-load'
    [void][Reflection.Assembly]::LoadFile($assemblyPath)
    $script:diagnosticStep = 'owner'
    # The original owner is a strong script reference before its sole Run invocation.
    $script:diagnosticOwner = [SuperPiVolume.FaultDiagnosticOwner]::new($Root, $RootId, $ImageId, $ImageBytes, $TaskId, $InstanceId, $VolumePath)
    $script:diagnosticState = @{
        Owner=$script:diagnosticOwner; RunAttempted=$false; InvocationException=$null; OperationException=$null; CloseException=$null;
        WrapperException=$null; OutputException=$null; OutputAttempted=$false; HoldEntered=$false; EncodedAllocated=0; EncodedCleared=0
    }
    $script:diagnosticOutput = [Console]::OpenStandardOutput()
    $script:diagnosticStep = 'run'
    $exitResult = Invoke-SuperPiDiagnosticOwner $script:diagnosticOwner $TaskId $script:diagnosticState {
        param($line, $state)
        Write-SuperPiDiagnosticUtf8 $line {
            param($bytes)
            $script:diagnosticOutput.Write($bytes, 0, $bytes.Length)
        } { $script:diagnosticOutput.Flush() } $state
    } {
        param($originalOwner, $state)
        # No stdin handoff, retry, close or automatic termination; the original owner and state stay rooted.
        while ($true) { [Threading.Thread]::Sleep(1000) }
    }
    exit $exitResult
} catch {
    # Even an unexpected wrapper exception cannot turn native Unknown into a process exit.
    if ($null -ne $script:diagnosticOwner -and $script:diagnosticOwner.Unknown) {
        while ($true) { [Threading.Thread]::Sleep(1000) }
    }
    # No exception message/path and no retry of any partially written diagnostic receipt.
    try {
        $failure = [ordered]@{ protocol='super-pi-diagnostic-entry-failure-v1'; step=$script:diagnosticStep; type=$_.Exception.GetType().FullName }
        $text = ($failure | ConvertTo-Json -Compress) + "`n"
        if ([Text.Encoding]::UTF8.GetByteCount($text) -le 1024) { [Console]::Error.Write($text) }
    } catch {}
    exit 1
}

