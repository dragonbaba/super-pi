param([string]$NativeAssembly,[string]$AssemblySha256,[string]$Helper,[string]$Preflight)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess -or [Environment]::ProcessPath -cne 'D:\PowerShell\7\pwsh.exe'){throw 'Fixed PowerShell 7 x64 required'}
if(@(Get-PSSession).Count -ne 0){throw 'Unexpected initial remote session'}
$executionPolicy=[string](Get-ExecutionPolicy)
if($executionPolicy -cne 'RemoteSigned'){throw 'Existing execution policy was not preserved'}
$actualHash=(Get-FileHash -LiteralPath $NativeAssembly -Algorithm SHA256).Hash.ToLowerInvariant()
if($actualHash -cne $AssemblySha256){throw 'Native assembly digest differs'}
[void][Reflection.Assembly]::LoadFile($NativeAssembly)
$type=[type][SuperPiVolume.NativeDisk+CreateParameters]
$sizeOf=[Runtime.InteropServices.Marshal].GetMethod('SizeOf',[type[]]@([type]))
$size=[int]$sizeOf.Invoke($null,[object[]]@($type))
$idOffset=[Runtime.InteropServices.Marshal]::OffsetOf($type,'UniqueId').ToInt32()
$capacityOffset=[Runtime.InteropServices.Marshal]::OffsetOf($type,'MaximumSize').ToInt32()
if($size -ne 56 -or $idOffset -ne 8 -or $capacityOffset -ne 24 -or -not [SuperPiVolume.NativeDisk].GetMethod('ProbeExchange')){throw 'Native type/ABI differs'}
foreach($source in @($Helper,$Preflight)){
 $tokens=$null; $errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
 if($errors.Count -ne 0){throw 'PowerShell source parse failed'}
 if($source -ceq $Helper){
  $tries=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
  $imports=@($ast.EndBlock.Statements | Where-Object {$_.Extent.Text -ceq 'Import-Module Storage -SkipEditionCheck -ErrorAction Stop'})
  if($tries.Count -ne 2 -or $imports.Count -ne 1 -or $imports[0].Extent.StartOffset -le $tries[0].Extent.EndOffset){throw 'Storage import precedes startup-only termination'}
 }
}
Import-Module Storage -SkipEditionCheck -ErrorAction Stop
$modules=@(Get-Module Storage)
if($modules.Count -ne 1 -or $modules[0].Version.ToString() -cne '2.0.0.0' -or $modules[0].ModuleBase -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Storage'){throw 'Unexpected native Storage module'}
$required=@{'Get-DiskImage'=@('ImagePath');'Get-Disk'=@('Number','Partition','Path');'Initialize-Disk'=@('InputObject','PartitionStyle','PassThru');'New-Partition'=@('InputObject','Offset','Size','MbrType','AssignDriveLetter');'Get-Partition'=@('DiskNumber');'Format-Volume'=@('Partition','FileSystem','AllocationUnitSize','NewFileSystemLabel');'Get-Volume'=@('Partition')}
foreach($name in $required.Keys){
 $command=Get-Command -Name $name -Module Storage -ErrorAction Stop
 if($command.ModuleName -cne 'Storage' -or $command.Module.ModuleBase -ine $modules[0].ModuleBase){throw 'Storage command source changed'}
 foreach($parameter in $required[$name]){if(-not $command.Parameters.ContainsKey($parameter)){throw 'Storage parameter missing'}}
}
$sessions=@(Get-PSSession)
$proxies=@(Get-Module | Where-Object {$_.Path -match 'remoteIpMoProxy_|WinPSCompatSession'})
if($sessions.Count -ne 0 -or $proxies.Count -ne 0){throw 'PowerShell compatibility fallback detected'}
@{protocol='super-pi-powershell7-compat-v1';executable=[Environment]::ProcessPath;powershell=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;x64=[Environment]::Is64BitProcess;executionPolicy=$executionPolicy;hashMatches=$true;abiSize=$size;idOffset=$idOffset;capacityOffset=$capacityOffset;storagePath=$modules[0].Path;storageVersion=$modules[0].Version.ToString();commands=7;compatSessions=0;proxyModules=0;parsed=2;nativeConstructed=$false;storageCalls=0}|ConvertTo-Json -Compress
