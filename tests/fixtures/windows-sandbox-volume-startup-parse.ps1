param([string]$Helper)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'Fixed PowerShell 7 x64 required; no fallback'}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Helper,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'Helper parse errors'}
$tries=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
if($tries.Count -ne 2){throw 'Unexpected top-level try structure'}
$startup=$tries[0]
$success=$startup.Body.Statements[-1]
if($success -isnot [Management.Automation.Language.IfStatementAst] -or $success.Clauses.Count -ne 1 -or $success.Clauses[0].Item1.Extent.Text -cne '$StartupDiagnostic'){throw 'Startup success guard changed'}
$successBody=$success.Clauses[0].Item2.Statements
if($successBody.Count -ne 2 -or $successBody[0].Extent.Text -cne 'Write-StartupDiagnostic $true $null' -or $successBody[1].Extent.Text -cne 'exit 0'){throw 'Success must terminate'}
if($startup.CatchClauses.Count -ne 1){throw 'Startup catch changed'}
$failure=$startup.CatchClauses[0].Body.Statements
if($failure.Count -ne 5 -or $failure[1].Extent.Text -cne 'if (-not $StartupDiagnostic) { throw }' -or $failure[-1].Extent.Text -cne 'exit 1'){throw 'Known failure must terminate or rethrow normal mode'}
if($failure[2].Extent.Text -cne 'Write-StartupDiagnostic $false $_' -or $failure[3].Extent.Text -cne 'Write-Error -ErrorRecord $_ -ErrorAction Continue'){throw 'Known failure evidence changed'}
$retained=$failure[0]
if($retained -isnot [Management.Automation.Language.IfStatementAst] -or $retained.Clauses[0].Item1.Extent.Text -cne 'Test-TransientUnknown' -or
   -not $retained.Extent.Text.Contains('Write-TransientFailure $script:startupStep') -or
   -not $retained.Extent.Text.Contains('while ($true) { [Threading.Thread]::Sleep(1000) }') -or $retained.Extent.Text.Contains('exit ')){throw 'Unknown construction responsibility must remain held'}
$startupText=$startup.Extent.Text
foreach($forbidden in @('Read-Request','Invoke-VolumeCommand','Prepare-Volume','EnableTaskPrivilege','Initialize-Disk','New-Partition','Format-Volume','.Create(','.Attach(')) {
 if($startupText.Contains($forbidden)){throw 'Startup reaches storage/dispatch'}
}
$expected=@("'arguments'","'assembly-check'","'assembly-load'","'output-encoding'","'native-constructor'","'complete'")
foreach($step in $expected){if(-not $startupText.Contains($step) -and $step -ne "'arguments'"){throw 'Startup step missing'}}
$owner=$startupText.IndexOf('$script:transientOwner = New-Object SuperPiVolume.TransientOwner')
$constructor=$startupText.IndexOf('$script:native = New-Object SuperPiVolume.NativeDisk($Root, [Guid]$TaskId, $script:transientOwner)')
if($owner -lt 0 -or $owner -ge $constructor){throw 'Caller must own transient responsibility before construction'}
if($constructor -lt 0 -or $constructor -ge $startupText.IndexOf('if ($StartupDiagnostic)')){throw 'Original constructor must precede diagnostic exit'}
if($startup.Extent.EndOffset -ge $tries[1].Extent.StartOffset -or -not $tries[1].Extent.Text.Contains('Read-Request')){throw 'Command loop ordering changed'}
[Console]::Out.WriteLine('{"parsed":true,"startupExits":2,"helperExecuted":false,"storageCalls":0}')
