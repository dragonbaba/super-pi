param([Parameter(Mandatory)][string]$AssemblyPath,[Parameter(Mandatory)][string]$FilePath)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PS7 x64 required'}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::LoadFile($AssemblyPath)
$result=[CandidateIdentityCheck.Native]::Inspect($FilePath)
$line=$result | ConvertTo-Json -Depth 4 -Compress
if([Text.Encoding]::UTF8.GetByteCount($line+"`n") -gt 2048){throw 'Metadata output bound'}
[Console]::Out.WriteLine($line)
if($result.OperationFailed -or $result.CloseFailed){exit 2}
exit 0
