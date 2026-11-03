param([Parameter(Mandatory=$true)][string]$NodePath)
# Manual, bounded P3 spike; not part of CI and never changes existing user/toolchain ACLs.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Run in Windows x64 PowerShell 7.' }
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'AppContainer startup requires LOCALAPPDATA.' }
Add-Type -Path (Join-Path $PSScriptRoot 'windows-appcontainer-spike.cs')
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixtureRoot = Join-Path $tempParent ('sp-appcontainer-' + [guid]::NewGuid().ToString('N'))
$owner = $null; $listener = $null; $fixtureCreated = $false
$report = [ordered]@{ backend='win32-appcontainer-spike-v1'; platform=[Environment]::OSVersion.VersionString; passed=$false; fixture=$fixtureRoot }
function Grant-Fixture([string]$Path, [string]$Rights, [bool]$Inherit) {
  $resolved = [IO.Path]::GetFullPath($Path)
  if ($resolved -ne $fixtureRoot -and -not $resolved.StartsWith($fixtureRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Grant escaped fixture' }
  $acl = Get-Acl -LiteralPath $resolved
  $sid = [Security.Principal.SecurityIdentifier]::new($owner.Sid)
  $flags = if ($Inherit) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]$Rights, $flags, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule); Set-Acl -LiteralPath $resolved -AclObject $acl
}
try {
  New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
  $fixtureCreated = $true
  foreach ($name in @('workspace','tools','outside','tmp')) { New-Item -ItemType Directory -Path (Join-Path $fixtureRoot $name) | Out-Null }
  $executable = Join-Path $fixtureRoot 'tools/node.exe'
  Copy-Item -LiteralPath $NodePath -Destination $executable
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-appcontainer-probe.mjs') -Destination (Join-Path $fixtureRoot 'tools/probe.mjs')
  [IO.File]::WriteAllText((Join-Path $fixtureRoot 'tools/readonly.txt'), 'readonly-canary')
  [IO.File]::WriteAllText((Join-Path $fixtureRoot 'outside/canary.txt'), 'outside-canary')
  $owner = [SuperPiAppContainerSpike]::new()
  $report.profile = $owner.ProfileName
  Grant-Fixture $fixtureRoot 'Traverse' $false
  Grant-Fixture (Join-Path $fixtureRoot 'tools') 'ReadAndExecute' $true
  Grant-Fixture (Join-Path $fixtureRoot 'workspace') 'Modify' $true
  Grant-Fixture (Join-Path $fixtureRoot 'tmp') 'Modify' $true
  # Create the escape only after grants, so ACL propagation cannot grant the target.
  New-Item -ItemType Junction -Path (Join-Path $fixtureRoot 'workspace/escape') -Target (Join-Path $fixtureRoot 'outside') | Out-Null
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start()
  $port = $listener.LocalEndpoint.Port
  # Windows uses LOCALAPPDATA to establish the AppContainer environment; the path grants no ACL access.
  $environment = "LOCALAPPDATA=$env:LOCALAPPDATA`0PATH=$($fixtureRoot)\tools`0SystemRoot=$env:SystemRoot`0TEMP=$($fixtureRoot)\tmp`0TMP=$($fixtureRoot)\tmp`0USERPROFILE=$($fixtureRoot)\tmp`0`0"
  $watch = [Diagnostics.Stopwatch]::StartNew()
  # Node's file entry loader stats drive ancestors. Evaluate this fixed probe without granting C:\ metadata access.
  $probe = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'tools/probe.mjs'))
  $report.entryMode = 'inline-module'
  $owner.Start($executable, [string[]]@('--input-type=module', '--eval', $probe, 'probe', $fixtureRoot, "$port"), (Join-Path $fixtureRoot 'workspace'), $environment)
  $report.appContainer = $owner.IsAppContainer(); $report.exitCode = $owner.Wait(10000); $report.elapsedMs = $watch.ElapsedMilliseconds
  $log = [IO.File]::OpenRead((Join-Path $fixtureRoot 'workspace/probe.log'))
  try {
    $bytes = [byte[]]::new(16384)
    $count = $log.Read($bytes, 0, $bytes.Length)
    $report.output = [Text.Encoding]::UTF8.GetString($bytes, 0, $count)
    $report.outputTruncated = $log.Length -gt $count
  } finally { $log.Dispose() }
  $report.results = Get-Content -LiteralPath (Join-Path $fixtureRoot 'workspace/result.json') -Raw | ConvertFrom-Json
  $report.ownedChildrenBeforeClose = $owner.ActiveProcesses()
  $r = $report.results
  $expectedText = 'ภาษาไทย' + "`n" + '${literal}\n' + "`r`n"
  # A timeout (native ETIMEDOUT or our deadline) is not proof of an enforced denial.
  $report.networkDenialConfirmed = -not $r.loopback.connected -and $r.loopback.code -in @('EACCES', 'EPERM')
  $report.passed = $report.appContainer -and $report.exitCode -eq 0 -and $r.workspaceWrite.ok -and $r.workspaceRead.value -ceq $expectedText -and $r.toolchainRead.value -ceq 'readonly-canary' -and -not $r.toolchainWrite.ok -and -not $r.outsideRead.ok -and -not $r.outsideWrite.ok -and -not $r.junctionRead.ok -and $report.networkDenialConfirmed -and $r.child.ok -and $report.ownedChildrenBeforeClose -gt 0
} catch {
  $failure = $_.Exception
  $report.error = $failure.Message
  while ($failure.InnerException) { $failure = $failure.InnerException }
  $report.errorType = $failure.GetType().FullName
  $report.errorHResult = $failure.HResult
  if ($failure -is [ComponentModel.Win32Exception]) { $report.nativeErrorCode = $failure.NativeErrorCode }
}
finally {
  if ($listener) { $listener.Stop() }
  if ($owner) {
    try { $owner.Dispose() } catch { $report.cleanupError = $_.Exception.Message; $report.passed = $false }
    $report.openHandles = $owner.OpenHandles; $report.profileReleased = $owner.ProfileReleased; $report.processesDrained = $owner.Drained
    if ($owner.OpenHandles -ne 0 -or -not $owner.ProfileReleased -or -not $owner.Drained) { $report.passed = $false }
  }
  # Never enumerate targets for another shell; remove only the directory allocated above.
  $resolved = [IO.Path]::GetFullPath($fixtureRoot)
  if ([IO.Path]::GetDirectoryName($resolved) -ne $tempParent) { throw 'Cleanup escaped recorded temporary parent' }
  if ($fixtureCreated -and (Test-Path -LiteralPath $resolved)) {
    try { Remove-Item -LiteralPath $resolved -Recurse -Force } catch { $report.cleanupError = $_.Exception.Message; $report.passed = $false }
  }
}
$report | ConvertTo-Json -Depth 8
if (-not $report.passed) { exit 2 }
