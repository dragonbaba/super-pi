# PowerShell 7 stdio launcher. Hold a logon-session-local mutex for the
# lifetime of the interactive driver. Leave MCP framing on inherited handles.
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'Windows Computer Use requires a Windows desktop.' }
if (!$args.Count -or ![IO.Path]::IsPathFullyQualified($args[0])) {
    throw 'Pass the absolute path to the Windows MCP driver.'
}
$mutex = [Threading.Mutex]::new($false, 'Local\SuperPi.WindowsDesktop')
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $owned = $true }
    if (!$owned) { throw 'Another Super Pi session owns the desktop driver.' }
    $start = [Diagnostics.ProcessStartInfo]::new([string]$args[0])
    $start.UseShellExecute = $false
    for ($i = 1; $i -lt $args.Count; $i++) { $start.ArgumentList.Add([string]$args[$i]) }
    $driver = [Diagnostics.Process]::Start($start)
    try {
        $driver.WaitForExit()
        $code = $driver.ExitCode
    } finally { $driver.Dispose() }
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $code
