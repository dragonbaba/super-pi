param([Parameter(Mandatory=$true)][string]$SourcePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess) { throw 'Fixed PS7 x64' }
function Need($condition, [string]$message) { if (-not $condition) { throw $message } }
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($SourcePath,[ref]$tokens,[ref]$parseErrors)
Need ($parseErrors.Count -eq 0) 'Source parse errors'
$names=@('Write-SuperPiDiagnosticUtf8','Invoke-SuperPiDiagnosticOwner')
$definitions=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })
Need ($definitions.Count -eq 2) 'Exactly two top-level functions'
foreach ($name in $names) {
    $matches=@($definitions | Where-Object { $_.Name -ceq $name })
    Need ($matches.Count -eq 1) 'Unique original function'
    . ([scriptblock]::Create($matches[0].Extent.Text))
}
# Only original function extents above are loaded. The real script entry never runs.
$taskId='11111111-1111-4111-8111-111111111111'
$receipt='{"protocol":"synthetic-flow-only"}' + "`n"
$runs=0; $emits=0; $holds=0; $scenarios=0; $replayRejected=0
foreach ($mode in @('success','known-fail','output-fail','unknown','unknown-output','unknown-wrapper','hold-returns')) {
    $operation=[ComponentModel.Win32Exception]::new(5)
    $closing=[ComponentModel.Win32Exception]::new(6)
    $invocation=[InvalidOperationException]::new('fixture invocation')
    $script:holdSentinel=[InvalidOperationException]::new('fixture hold never returns')
    $unknown=$mode -in @('unknown','unknown-output','unknown-wrapper','hold-returns')
    $succeeded=$mode -in @('success','output-fail')
    $owner=[pscustomobject]@{
        RunCount=0; Succeeded=$succeeded; Unknown=$unknown; Adapter=[object]::new()
        OperationException=$(if ($succeeded) {$null} else {$operation})
        CloseException=$(if ($unknown) {$closing} else {$null})
        InvocationFault=$(if ($succeeded) {$null} else {$invocation})
        SuccessReceipt=$(if ($succeeded) {$receipt} else {$null})
        Opened=3; Closed=$(if ($unknown) {2} else {3}); Peak=3
        RetainedHandles=@($null,$null,$(if($unknown){'67'}else{$null}),$null)
        CloseAttempts=@($true,$true,$true,$false)
        OperationErrors=@($null,$null,5,$null); CloseErrors=@($null,$null,6,$null)
    }
    if ($mode -eq 'unknown-wrapper') { $owner.CloseAttempts=@($true) }
    $owner | Add-Member -MemberType ScriptMethod -Name Run -Value {
        $this.RunCount++
        if ($null -ne $this.InvocationFault) { throw $this.InvocationFault }
    }
    $adapter=$owner.Adapter
    $state=@{ Owner=$owner; RunAttempted=$false; InvocationException=$null; OperationException=$null; CloseException=$null
        WrapperException=$null; OutputException=$null; OutputAttempted=$false; HoldEntered=$false; EncodedAllocated=0; EncodedCleared=0 }
    $script:observed=@{ emits=0; holds=0; line=$null; owner=$null; state=$null }
    $emit={
        param($line,$givenState)
        $script:observed.emits++; $script:observed.line=$line
        Need ([Object]::ReferenceEquals($givenState,$state)) 'Same state in emit'
        if ($mode -in @('output-fail','unknown-output')) { throw [IO.IOException]::new('fixture write failure') }
    }
    $hold={
        param($originalOwner,$givenState)
        $script:observed.holds++; $script:observed.owner=$originalOwner; $script:observed.state=$givenState
        if ($mode -ne 'hold-returns') { throw $script:holdSentinel }
    }
    $status=$null; $caught=$null
    try { $status=Invoke-SuperPiDiagnosticOwner $owner $taskId $state $emit $hold }
    catch { $caught=$_.Exception }
    Need ($owner.RunCount -eq 1) 'One Run'
    Need ([Object]::ReferenceEquals($state.Owner,$owner)) 'Original owner held'
    Need ([Object]::ReferenceEquals($owner.Adapter,$adapter)) 'Original adapter held'
    if ($succeeded) {
        Need ($script:observed.line -ceq $receipt) 'Original success receipt unchanged'
        Need ($null -eq $state.OperationException -and $null -eq $state.CloseException) 'No substituted native errors'
    } else {
        Need ([Object]::ReferenceEquals($state.OperationException,$operation)) 'Original operation error'
        Need ($null -ne $state.InvocationException) 'Invocation wrapper separately preserved'
        Need (-not [Object]::ReferenceEquals($state.OperationException,$state.InvocationException)) 'Invocation is not native fact'
        if ($unknown) { Need ([Object]::ReferenceEquals($state.CloseException,$closing)) 'Original close error' }
        if ($mode -ne 'unknown-wrapper') {
            $failure=ConvertFrom-Json -InputObject $script:observed.line
            Need ($failure.protocol -ceq 'super-pi-manager-loss-diagnostic-failure-v1') 'No success receipt on failure'
            Need ($failure.operation.nativeCode -eq 5 -and $failure.retained.Count -eq 4) 'Native facts/four responsibility slots'
            if ($unknown) { Need ($failure.close.nativeCode -eq 6 -and $failure.retained[2] -ceq '67') 'Exact unresolved handle' }
        }
    }
    if ($unknown) {
        Need ($null -ne $caught -and $null -eq $status) 'Unknown never returns an exit result'
        Need ($state.HoldEntered -and $script:observed.holds -eq 1) 'One hold'
        Need ([Object]::ReferenceEquals($script:observed.owner,$owner) -and [Object]::ReferenceEquals($script:observed.state,$state)) 'Hold receives originals'
        Need ($owner.RetainedHandles[2] -ceq '67') 'Unresolved exact handle retained'
        if ($mode -eq 'hold-returns') { Need ($caught.Message.Contains('hold unexpectedly returned')) 'Returned hold rejected' }
        else { Need ([Object]::ReferenceEquals($caught.GetBaseException(),$script:holdSentinel)) 'Outer fixture catches hold sentinel' }
    } else {
        Need ($null -eq $caught -and $script:observed.holds -eq 0) 'Known closed does not hold'
        Need ($status -eq $(if($mode -eq 'success'){0}else{1})) 'Correct exit result'
    }
    if ($mode -in @('output-fail','unknown-output')) { Need ($null -ne $state.OutputException) 'Output error separate' }
    if ($mode -eq 'unknown-wrapper') {
        Need ($null -ne $state.WrapperException -and -not $state.OutputAttempted -and $script:observed.emits -eq 0) 'Preparation failure still holds'
    } else { Need ($state.OutputAttempted -and $script:observed.emits -eq 1) 'Single output attempt' }
    if ($mode -eq 'success') {
        try { [void](Invoke-SuperPiDiagnosticOwner $owner $taskId $state $emit $hold); throw 'Replay accepted' }
        catch { Need ($_.Exception.Message.Contains('Original one-shot')) 'Replay refused'; $replayRejected++ }
        Need ($owner.RunCount -eq 1 -and $script:observed.emits -eq 1) 'Replay performs no work'
        $scenarios++
    }
    $runs += $owner.RunCount; $emits += $script:observed.emits; $holds += $script:observed.holds; $scenarios++
    # Only fake resources exist; release fixture references explicitly after assertions.
    $state.Clear(); $owner.Adapter=$null; $owner=$null; $adapter=$null; $script:observed.Clear()
}
$totalAllocated=0; $totalCleared=0; $writeCalls=0; $flushCalls=0
foreach ($mode in @('bytes','write-failure','flush-failure','over-bound')) {
    $stream=[IO.MemoryStream]::new()
    $script:encodingObserved=@{ borrowed=$null; writes=0; flushes=0 }
    $state=@{EncodedAllocated=0;EncodedCleared=0}; $caught=$null
    $text=$(if($mode -eq 'over-bound'){('x'*4096)+"`n"}else{$receipt})
    try {
        Write-SuperPiDiagnosticUtf8 $text {
            param($bytes)
            $script:encodingObserved.writes++; $script:encodingObserved.borrowed=$bytes
            if ($mode -eq 'write-failure') { throw [IO.IOException]::new('write') }
            $stream.Write($bytes,0,$bytes.Length)
        } {
            $script:encodingObserved.flushes++
            if ($mode -eq 'flush-failure') { throw [IO.IOException]::new('flush') }
            $stream.Flush()
        } $state
    } catch { $caught=$_.Exception }
    try {
        Need ($state.EncodedAllocated -eq $state.EncodedCleared) 'Encoding bytes cleared on every exit'
        if ($mode -eq 'over-bound') {
            Need ($null -ne $caught -and $state.EncodedAllocated -eq 0 -and $script:encodingObserved.writes -eq 0 -and $script:encodingObserved.flushes -eq 0) 'Bound rejected before allocation/write'
        } else {
            Need ($script:encodingObserved.writes -eq 1) 'No write retry'
            Need ($script:encodingObserved.flushes -eq $(if($mode -eq 'write-failure'){0}else{1})) 'No flush retry'
            Need ($script:encodingObserved.borrowed.Length -eq $state.EncodedAllocated) 'Same borrowed encoding bytes'
            foreach ($b in $script:encodingObserved.borrowed) { Need ($b -eq 0) 'Encoded array actually zero' }
            Need (($null -eq $caught) -eq ($mode -eq 'bytes')) 'Write/flush exception retained'
            if ($mode -eq 'bytes') {
                $actual=$stream.ToArray(); $expected=[Text.UTF8Encoding]::new($false,$true).GetBytes($receipt)
                Need ($actual.Length -eq $expected.Length) 'Exact length: no BOM or extra newline'
                for($i=0;$i -lt $actual.Length;$i++){Need ($actual[$i] -eq $expected[$i]) 'Exact bytes'}
                [Array]::Clear($actual,0,$actual.Length); [Array]::Clear($expected,0,$expected.Length)
            }
        }
        $totalAllocated+=$state.EncodedAllocated; $totalCleared+=$state.EncodedCleared
        $writeCalls+=$script:encodingObserved.writes; $flushCalls+=$script:encodingObserved.flushes; $scenarios++
    } finally {
        [Array]::Clear($stream.GetBuffer(),0,$stream.Capacity); $stream.Dispose()
        $script:encodingObserved.Clear(); $state.Clear()
    }
}
$ast=$null; $tokens=$null; $definitions=$null; $matches=$null; $script:holdSentinel=$null
$result=[ordered]@{ scenarios=$scenarios; originalRuns=$runs; emitAttempts=$emits; holdEntries=$holds; replayRejected=$replayRejected
    encodingWrites=$writeCalls; encodingFlushes=$flushCalls; encodedAllocated=$totalAllocated; encodedCleared=$totalCleared
    nativeCalls=0; entryExecutions=0; diskArtifacts=0; byteProof='original-function-memory-stream' }
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::WriteLine(($result|ConvertTo-Json -Compress))

