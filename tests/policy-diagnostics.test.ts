import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool } from "../packages/coding-agent/src/core/tools/bash.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createJiti } from "jiti";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { getEncoding } from "js-tiktoken";
import { streamSimple } from "../packages/ai/src/api/openai-completions.ts";
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";
import { renderPolicyDiagnostic } from "../packages/extensions/resource-lifecycle-guard/policy-diagnostics.ts";
import { sanitizePolicyFeedback } from "../packages/extensions/resource-lifecycle-guard/policy-diagnostics.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectPowerShellResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/powershell-lifecycle.ts";
import { inspectPowerShellPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-powershell.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";

// Offline evidence strings. They are passed to scanners and fixtures only.
test("native PowerShell lifecycle distinguishes expressions, data and owned foreground launches", () => {
  for (const command of [
    "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo | Select-Object Name,Culture }; $s.Dispose()",
    "$s=New-Object System.Text.StringBuilder; try { [void]$s.Append('Start-Job'); $s.ToString() } finally { $s.Clear() }",
    "Write-Output 'Start-Process foo; Start-Job {}'; # Start-Job\nWrite-Output 1",
    "<# outer <# Start-Job #> nested #> Write-Output 1",
    "& 'C:/Program Files/tool.exe' --help",
    "& { Write-Output 1 }; Write-Output 2 2>&1",
    "Write-Output `&; Write-Output `;", "Write-Output 1 && Write-Output 2",
    "Write-Output -As'Job'", "Write-Output '-AsJob'", "$p.StartInfo.FileName = 'tool.exe'; $p.StartTime",
    "Start-Process -FilePath tool.exe -Wait; Start-Process -FilePath other.exe -Wait",
    "Start-Process tool.exe 2>&1 -Wait", "Start-Process tool.exe -Wait 2>&1",
    "echo $((1 + $null))",
    "[void][object]$s.ToString()", "[System.Collections.Generic.List[string]]$items", "[string[]]$items",
    "[System.Collections.Generic.Dictionary[string,System.Collections.Generic.List[int]]]$items", "[int[][]]$items",
    "Write-Output report.Start (Get-Date)", "Write-Output report.InvokeScript (Get-Date)",
    "Write-Output status=Start-Job", "Write-Output status=-AsJob", "Write-Output status=@options",
    "Start-Process tool.exe -ArgumentList mode=foreground -Wait",
    "$items=@(1,2); $options=@{Name='sample'; Value=1}; Write-Output $options.Name",
    "Write-Output @{Start-Job='data'; Label='safe'}", "Get-CimClass Win32_Process | Select-Object CimClassName",
    "Start-BitsTransfer -Source 'https://example.invalid/a' -Destination 'a.txt'",
    "${name}='safe'; [string]${space name}='safe'; ${name}.ToUpper()",
    "${escaped`}}='safe'; Write-Output ${escaped`}}", "Write-Output { 1 } Start-Job",
    "if ((Write-Output { 1 } Start-Job)) { Write-Output safe } else { Write-Output { 2 } Start-Job }",
    ":outer while ($false) { Write-Output safe }", "if ($true)\n{ Write-Output safe }",
    "for ($i=0; $i -lt 2; $i++) { Write-Output $i }", "for ($i=2; $i -gt 0; --$i) { Write-Output $i }",
    "param() Write-Output safe", "param([string]$name='safe') Write-Output $name",
    "New-Item -Path file.txt -ItemType File", "Set-Item -Path Env:SP_FIXTURE -Value literal",
    "Set-Service -Name Missing -Description 'metadata'", "Set-Service -Name Missing -Status Stopped", "Set-Service -Name Missing -Status:'Paused'",
	"Set-Service -Name ($name) -Description ($description)", "Set-Service -Name Missing -Status $status",
    "exit 0", "data D {} Write-Output safe", "Set-Variable -Name Count -Value 1",
    "do {} while ($false) Write-Output safe", "do {} until ($true) Write-Output safe",
    "Get-Variable Count", "Get-Variable -Name Count -Scope Local -ValueOnly", "gv -Name:Count -ErrorAction Stop",
    "Get-Variable Count -OutVariable result", "gv Count -s 0", "gv Count -ov result -vb:$false", "gv Count -ValueO:$true",
    'Get-Item -LiteralPath "FileSystem::$file"', "Get-ChildItem -Path ./src -Recurse",
    "Write-Output SessionState PSVariable SessionStateProxy", "Get-Variable SessionState -ValueOnly",
    "Get-Variable Count -Scope $scope -ErrorAction $action", "gv Count -Verbose:$flag",
    "$text=123 -as [string]; Write-Output $text", "Write-Output ($text -as 'string')",
    "'a' | ForEach-Object ToUpper", "'a' | % -MemberName ToUpper", "'a' | foreach Length",
    "ForEach-Object -InputObject (Get-Date) -MemberName ToString", "ForEach-Object -Parallel { 1 } -As'Job'",
    'Get-ChildItem -LiteralPath "FileSystem::$file" -Recurse -Depth $depth -ErrorAction $action',
    'Get-Item -fo -LiteralPath "FileSystem::$file"', "Get-Item foo=bar", "Write-Output wmiclass System.Management.ManagementClass",
    "New-Object -TypeName System.Text.StringBuilder -ArgumentList $capacity", "New-Object -ArgumentList ($capacity) -TypeName System.Text.StringBuilder",
    "New-Object System.Text.StringBuilder -Property @{Capacity=16}", "Get-WmiObject -Class Win32_OperatingSystem", "gwmi Win32_OperatingSystem",
    "Write-Output 1 -PipelineVariable observed", "Write-Output 1 -pv:observed",
    "$arguments=@('--version'); Start-Process tool.exe -ArgumentList $arguments -Wait",
    "Start-Process $executable -ArgumentList ($arguments) -Wait", "Start-Process tool.exe -Wait -WorkingDirectory $directory",
    "${PSDef`aultParameterValues}=@{}",
    "Write-Output 1 -OutVariable: result", "Get-Variable -Name: Count -ValueOnly: $false",
    "New-Object -TypeName: System.Text.StringBuilder", "'a' | ForEach-Object -MemberName: ToUpper -Verbose: $flag",
    'Get-Item -LiteralPath: "FileSystem::$file" -Force: $force', "Set-Service -Name Missing -Status: Paused",
    "Start-Process tool.exe -Wait:$true", "Start-Process tool.exe -Wait: $true", "Start-Process tool.exe —Wait:$TRUE",
    "Write-Output [scriptblock]", "Write-Output '[scriptblock]::Create'",
    "$sb=[scriptblock]$block", "$sb=$text -as [scriptblock]", "[scriptblock[]]$blocks=$items",
    "[ int ] $number=1", "[System.Collections.Generic.List[ string ]] $items=$null", "[ <#type#> string ] $text='safe'",
    "Start-Process tool.exe -Wai", "Start-Process tool.exe -Wai: $true", "Start-Process tool.exe -Wa Continue -Wai:$true",
    "1 | ForEach-Object -Parallel { $_ } -AsJob:$false", "1 | % -Parallel { $_ } -As: $FALSE",
    "Start-BitsTransfer -Source a -Destination b -As:$false", "Resume-BitsTransfer -BitsJob $job -As: $false",
    "Start-BitsTransfer -Source ($source -as [string]) -Destination b",
    'Get-WmiObject -Query "SELECT Name FROM Win32_Process WHERE Name = \'meta_class\'"',
    'gwmi -Q: "SELECT Name FROM Win32_Process WHERE Name = \'ClassDefsOnly\'"',
    "Set-Content file.txt -Value $text", "Set-Content -Value ($text) -LiteralPath: file.txt",
    'Set-Content -LiteralPath "FileSystem::$file" -Value $text', "Set-Content file.txt -Value 'Variable:PSDefaultParameterValues'",
    "Add-Content file.txt -Value $text", "Clear-Content file.txt", "sc.exe query MyService",
    "Get-Content file.txt -First: 1", "gc -Last $count -Path file.txt", 'Get-Content -LiteralPath "FileSystem::$file" -Raw',
    "cat.exe file.txt", "Get-Content -ReadCount $batch file.txt",
    "$content | Set-Content -LiteralPath file.txt",
    "Start-Service -Name Spooler -WhatIf", "Start-Service -Name Spooler -WhatIf:$true", "Restart-Service Spooler -wi",
    "Resume-Service Spooler -WhatIf: $true", "Set-Service Spooler -Status Running -WhatIf",
    "Start-Process tool.exe -wi", "Start-Process tool.exe 2>&1 -WhatIf", "Start-Process tool.exe > output.txt -Wait",
    "Write-Output report.SessionState metadata.PSVariable .SessionState",
    "Start-Process tool.exe -ArgumentList mode=foreground -WhatIf",
    "Start-Process tool.exe -ArgumentList `> -Wait",
    "Start-Process tool.exe -ArgumentList data> -Wait", 'Start-Process tool.exe -ArgumentList foo"bar"> -Wait',
    'Start-Process tool.exe -ArgumentList "data"`"> -Wait', "Start-Service Spooler>> -WhatIf",
    "1 | Tee-Object -Variable captured", "1 | tee -Var: captured", "1 | Tee-Object -Path file.txt", "1 | tee -LiteralPath $file",
    "Write-Output -- -AsJob -Asynchronous", "example.exe -asynchronous", "1 | ForEach-Object -- ToString",
    "Write-Output -- (Write-Output 1 -OutVariable captured) -OutVariable PSDefaultParameterValues",
    "Get-WmiObject -Class Win32_Service -As:$false", "Test-Connection localhost -AsJob:$false",
    "foreach ($item in Write-Output 1,2) { Write-Output $item }", "foreach ($item in $items) { Write-Output $item }",
    "foreach ($a in @(1)) { foreach ($b in @(2)) { Write-Output $b } }",
    "Get-ChildItem -LiteralPath . -Filter ($pattern)", "Get-ChildItem -Filter ($pattern) -LiteralPath . -Depth ($depth)",
    "Get-Item -LiteralPath . -ErrorAction ($mode)", "Write-Output report.StartService report.ResumeService",
    "Get-ChildItem -Filter mode=data -LiteralPath .",
    "Get-WmiObject Win32_Process -As`Job", "Start-BitsTransfer -Source a -Destination b -As`ynchronous",
    "ForEach-Object -InputObject mode=data -Parallel { $_ } -AsJob:$false",
    "New-Object System.Text.StringBuilder -Property @{Append='property-method-ok';Capacity=32}",
    "New-Object PSObject -Property @{Data=@{Run='data'}}", "$value.ConvertTo[object]()",
    "<# outer <# marker #> Write-Output after-comment", "[ <# outer <# marker #> int ]$number=1",
    "<# outer <# nested #> outer #> Start-Process tool.exe",
    "Add-Type -AssemblyName System.Speech", "Add-Type -Assem: System.Runtime -PassThru", "Add-Type -A:System.Runtime",
    "Start-BitsTransfer -Source a -Destination b -Suspended:$false", "Start-BitsTransfer -Source a -Destination b -Su: $false",
    "Write-Output report.ExecuteShellCommand WbemScripting.SWbemLocator",
    'Write-Output "value=$($value)"; Write-Output done', 'Write-Output "value=$("nested $($value)")"; Write-Output done',
    "Write-Output @'\nStart-Job is text\n'@; Write-Output done", 'Write-Output @"\ntext\n"@; Write-Output done',
    "& $program mode=Start-Job; Write-Output done", "& (Get-Command tool) mode=Start-Job; Write-Output done",
    "$h['some-key'] = Write-Output data", "$h[('some'+'-key')] = Write-Output data", "$object.'some-name' = 1",
    "[CmdletBinding()] param() Write-Output data", "[CmdletBinding()]param() Write-Output data",
    "Invoke-Command -ScriptBlock { 1 }", "icm -ScriptBlock { 1 } -AsJob:$false", "iwmi -Class Win32_Process -Name GetOwner -As:$false",
    "Invoke-Command -ApplicationName app -Authentication Default -ArgumentList $args -ScriptBlock { 1 }",
    "systemctl --user status example.service", "systemctl --property start show example.service", "systemctl --host=server status example.service",
    "systemctl -Hserver --user status example.service", "systemctl --unknown status example.service",
    "systemctl --host $server status example.service",
    "systemctl -ql status example.service", "systemctl -qlHserver status example.service", "systemctl -qlH server status example.service",
    "systemctl -qlpstart show example.service",
    "[ValidateScript({ $_ -gt 0 })]$Value=1", "[ValidateSet('Start-Job')]$Value='Start-Job'",
    "[ValidateScript({ $text='Start-Job'; $true })]$Value=1", "[CmdletBinding()]param([ValidateScript({ $_ -gt 0 })]$Value=1) Write-Output $Value",
    "Invoke-Command -ComputerName server -ScriptBlock { 1 } -InDisconnectedSession:$false",
    "icm -ComputerName server -ScriptBlock { 1 } -Discon:$false", "icm -ScriptBlock { 1 } -InputObject $data -InformationAction Continue",
    "[ValidateSet(Start)]$Value='Start'", "[OutputType(Start)]param() Write-Output data",
    "[MetadataFixture(Start)]$Value='Start'",
    "[ValidateSet(\nStart, Stop)]$Value='Start'", "[ValidateScript({ $_ -eq 'Start' })]$Value='Start'",
    "Invoke-Command -ScriptBlock { 1 } -As`\n -Verbose", "icm -ScriptBlock { 1 } -InDis`\r\n -Verbose",
    "Start-Process tool.exe -Wai `\n -Verbose", "Start-Service Missing -WhatI `\r\n -Verbose",
    "systemctl enable example.service", "systemctl --now disable example.service", "systemctl mask --now example.service",
    "systemctl enable -- example.service --now", "systemctl --property --now enable example.service",
    "systemctl enable example.service --property --now",
    "systemctl reenable example.service", "systemctl reenable -- example.service --now",
    'cmd.exe /c echo start', 'cmd /d /c dir', 'cmd.exe /c start "" /wait tool.exe',
    'cmd /d /s /c start /b /wait "title" tool.exe', 'cmd /c start "" /d "C:/Program Files" /wait tool.exe',
    'cmd /c start /?', 'Write-Output cmd.exe /c start "" tool.exe',
    'cmd /c start "" /wait $program',
    'cmd /c start "" /d $directory /wait tool.exe',
    'cmd /c start "$title" /wait tool.exe',
    '. Write-Output data', '. "Write-Output" data', 'Write-Output . Start-Job', '. ./fixture.ps1',
    'class Fixture { [void] Start() {} }', 'class Fixture { static [void] Start() { Write-Output data } }',
    'class Fixture { [void] Start([string]$text) { Write-Output $text } }', 'enum Fixture { Start; Stop }',
    '[pscustomobject]@{ Start = 1; Nested = [pscustomobject]@{ Start = 2 } }', '[object[]]@(1,2)',
    'Write-Output “Start-Job”', '‘Start-Job’', '& “Write-Output” data', '. ‘Write-Output’ data',
    'Write-Output @“\nStart-Job is data\n”@; Write-Output done', 'Write-Output ‘a’’b’', '& "Sta""rt-Job"',
    'Invoke-Item ./report.txt -WhatIf', 'ii ./report.txt -wi', 'ii ./report.txt -WhatI:$true',
  ]) assert.equal(inspectPowerShellResourceLifecycle({ command }), undefined, command);
  // Runtime capabilities are not proof of detached execution. These still need
  // opaque-script authorization; the lifecycle filter is not a language sandbox.
  for (const command of [
    "Add-Type -TypeDefinition 'public class X {}'", "Add-Type -Name X -MemberDefinition 'public static void Go() {}'",
    "Add-Type -Path code.cs", "Add-Type -AssemblyName $assembly", "Add-Type -AssemblyName:($assembly)",
    "Add-Type @'\npublic class X {}\n'@",
    "New-Item -ItemType File -Path ./out.txt -Value $content", "Set-Item -LiteralPath Env:SP_FLAG -Value $value",
    "New-Item -Name out.txt -Value ([string]$content)", "Set-Item -Path $path -Value @{nested=$content}",
    "Get-Item $path", "Get-Variable *", "New-Object -TypeName $type -Property $properties",
    "[type]::GetTypeFromProgID('WbemScripting.SWbemLocator')", "[Activator]::CreateInstance($type)",
    "New-Object -ComObject WbemScripting.SWbemLocator", "New-Object System.Management.ManagementClass",
    "$t=[type]::GetTypeFromProgID('WbemScripting.SWbemLocator'); $w=[Activator]::CreateInstance($t); $svc=$w.ConnectServer('.', 'root\\cimv2'); $p=$svc.Get('Win32_Process'); $p.Create('notepad.exe')",
    "$p=New-Object System.Diagnostics.Process; $p.StartInfo.FileName='notepad.exe'; @($p).ForEach('Start')",
    "$watch=[System.Diagnostics.Stopwatch]::new(); $watch.Start(); $watch.Stop()",
    "$items.ForEach($member)", "$items.PSForEach('Start')", "$object.Invoke[object]()",
    "New-Object PSObject -Property @{Start='data'; Invoke='data'}", "& $program $arguments",
    "Write-Output \"value=$($value.ToString())\"",
    "start.exe $input", "C:/tools/start.exe $input", "cp.exe $source $destination", "& 'C:/tools/start.exe' -OutVariable $data",
  ]) {
    assert.equal(inspectPowerShellResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectPowerShellPermissionScope({ command }, process.cwd())?.kind, "opaque-script", command);
  }
  for (const command of [
    "Start-Job { 1 }", "$job=Start-ThreadJob { 1 }", "Microsoft.PowerShell.Core\\Start-Job {}", "Sta`rt-Job {}",
    "Start-Process tool.exe", "saps tool.exe", "Start-Process tool.exe -Wait; Start-Process other.exe",
    "Start-Process --% tool.exe -Wait", "Start-Process -- tool.exe -Wait", "Start-Process tool.exe -Wait:$false",
    "Start-Process tool.exe '-Wait'", "Start-Process tool.exe -Wa'it'", "Start-Process tool.exe @options -Wait",
    "Start-Process tool.exe > -Wait", "Start-Process tool.exe -ArgumentList mode=-Wait",
    "Write-Output 1 &", "Write-Output 1 & & 'tool.exe'", "& { Start-Job {} }", "Write-Output $(Start-Job {})",
    "${job}=Start-Job { 1 }", "[object]${space name}=Start-Job { 1 }", "$h=@{value=(Start-Job { 1 })}",
    "if ($true) {} Start-Job {}", "foreach ($item in Start-Process missing.exe) { $item }",
    "do {} until ($true) Start-Job {}", "param() Start-Job {}", "Write-Output -- (Start-Process missing.exe)",
    "<# outer <# nested #>\nStart-Job {}\n#>",
    "ForEach-Object -Parallel {} -AsJob", "1 | % -Parallel { 1 } -Asj", "1 | ForEach-Object -Parallel {} —AsJob:$true",
    "ForEach-Object -InputObject mode=data -Parallel { 1 } -AsJob", "1 | ForEach-Object -Parallel { Start-Job {} } -AsJob:$false",
    "Get-WmiObject -Class Win32_Service -As", "Test-Connection localhost -AsJob", "Write-Output -- -AsJob; Test-Connection localhost -AsJob",
    "Start-BitsTransfer -Source a -Destination b -Asynchronous", "Resume-BitsTransfer -BitsJob $job -As",
    "Start-BitsTransfer -Source a -Destination b -Suspended", "Start-BitsTransfer -Source a -Destination b -Su:$true",
    "Start-BitsTransfer -Source a -Destination b -Suspended:$flag",
    "Start-Service Missing", "Resume-Service Missing", "Set-Service Missing -Status Running",
    "Start-Service Missing -WhatIf:$false", "Start-Service Missing > -WhatIf",
    "Start-ScheduledTask -TaskName Missing", "Register-ScheduledJob -Name Missing -ScriptBlock {1}", "Invoke-Item missing.exe",
    "bash -c 'sleep 30 &'", "docker run -d image", "docker.exe run --env mode=foreground -d image",
    'Write-Output "value=$($value)"; Start-Job { 1 }', 'Write-Output "value=$("nested $($value)")"; Start-Job { 1 }',
    "Write-Output @'\ntext\n'@; Start-Job { 1 }", 'Write-Output @"\ntext\n"@; Start-Process missing.exe',
    "& $program; Start-Job { 1 }", "& (Get-Command tool); Start-Job { 1 }",
    "$h['some-key'] = Start-Job { 1 }", "$h[('some'+'-key')] = Start-Job { 1 }", "$object.'some-name' = Start-Process missing.exe",
    "($a,$b) = Start-Job { 1 }", "[CmdletBinding()] param() Start-Job { 1 }", "[CmdletBinding()]param() Start-Job { 1 }",
    "Invoke-Command -ComputerName server -ScriptBlock { 1 } -AsJob", "icm -ComputerName server -ScriptBlock { 1 } -Asj",
    "Invoke-WmiMethod -Class Win32_Process -Name Create -AsJob", "iwmi -Class Win32_Process -Name Create -As",
    "systemctl --user start example.service", "systemctl restart example.service", "systemctl --host=server --type service restart example.service",
    "systemctl.exe -Hserver --user reload-or-restart example.service",
    "systemctl -ql restart example.service", "systemctl -qlHserver restart example.service", "systemctl -qlH server restart example.service",
    "[ValidateScript({ Start-Job { 1 } | Out-Null; $true })]$Value=1",
    "[CmdletBinding()]param([ValidateScript({ Start-Job { 1 }; $true })]$Value=1) Write-Output $Value",
    "Invoke-Command -ComputerName server -ScriptBlock { 1 } -InDisconnectedSession",
    "icm -ComputerName server -ScriptBlock { 1 } -InDis", "icm -ComputerName server -ScriptBlock { 1 } -Disconnected",
    "icm -ComputerName server -ScriptBlock { 1 } -Discon:$true", "icm -ComputerName server -ScriptBlock { 1 } -Discon:$flag",
    "[ValidateSet(Start)]$Value='Start'; Start-Job { 1 }", "[OutputType(Start)]param() Start-Job { 1 }",
    "Invoke-Command -ScriptBlock { 1 } -As `\n -Verbose", "icm -ScriptBlock { 1 } -InDis `\r\n -Verbose",
    "1 | ForEach-Object -Parallel { 1 } -As `\n -Verbose", "Start-BitsTransfer -Source a -Destination b -Su `\n -Verbose",
    "systemctl --now enable example.service", "systemctl enable --now example.service",
    "systemctl enable example.service --now", "systemctl -qlHserver --now enable example.service",
    "systemctl --now reenable example.service", "systemctl reenable --now example.service", "systemctl reenable example.service --now",
    'cmd.exe /c start "" tool.exe', 'cmd /d /s /c start "" /b tool.exe',
    'cmd /c start "/wait" tool.exe', 'cmd /c start "" /d "/wait" tool.exe', 'cmd /c start "" tool.exe /wait',
    'cmd /c start "" /wait tool.exe; cmd /c start "" other.exe',
    'cmd /c start "" $program',
    'cmd /c start "" /d $directory tool.exe',
    'cmd /c start "$title" tool.exe', 'cmd /c start tool".exe" /wait',
    '. Start-Job { 1 }', '. "Start-Job" { 1 }', '. Start-Process tool.exe',
    'class Fixture { [void] Start() { Start-Job { 1 } } }', 'class Fixture { [void] Start() {} } Start-Job { 1 }',
    'class Fixture { [void] Start() {} [void] Other() { Start-Job { 1 } } }',
    '[pscustomobject]@{ Start = (Start-Job { 1 }) }', '& “Start-Job” { 1 }', '. ‘Start-Job’ { 1 }',
    'Write-Output @‘\ndata\n’@; Start-Job { 1 }', 'Invoke-Item ./report.txt -WhatIf:$false', 'ii ./report.txt -wi:$flag',
    "Write-Output 'unterminated", "x ".repeat(2049), "x".repeat(128 * 1024 + 1),
  ]) assert.ok(inspectPowerShellResourceLifecycle({ command }), command);
});

const USER_COMMANDS = [
  'tasklist /FI "PID eq 5064" /FO CSV 2>&1 | head -3; echo "---1352---"; tasklist /FI "PID eq 1352" /FO CSV 2>&1 | head -3',
  'echo "=== PID 1352 身份 ==="; wmic process where "ProcessId=1352" get Name,ExecutablePath 2>&1 | head -5; echo "--- 备用查询 ---"; powershell -NoProfile -Command "Get-Process -Id 1352 | Select-Object Id,ProcessName,Path | Format-List" 2>&1 | head -10',
  'cmd /c "wmic process where ProcessId=1352 get Name,ExecutablePath /format:list" 2>&1 | head -8',
  'echo "=== 模拟 Claude Code 连接，抓取源地址 ==="; curl -4 -v --max-time 15 -o /dev/null https://api.anthropic.com/ 2>&1 | grep -iE "Trying|Connected to|bound|from" | head -6',
] as const;

test("offline user command fixtures distinguish descriptor copies from launcher refusals", () => {
  const first = inspectHighRiskBashMutation({ command: USER_COMMANDS[0] }, process.cwd());
  assert.equal(first, undefined);
  assert.equal(inspectBashResourceLifecycle({ command: USER_COMMANDS[1] })?.startsWith("[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED]"), true);
  const third = inspectHighRiskBashMutation({ command: USER_COMMANDS[2] }, process.cwd());
  assert.equal(third, undefined);
  const fourth = inspectHighRiskBashMutation({ command: USER_COMMANDS[3] }, process.cwd());
  assert.equal(fourth, undefined);
});

test("redirection evidence distinguishes syntax from quoted and heredoc data", () => {
  const syntax = inspectHighRiskBashMutation({ command: "tasklist 2>&1 | head" }, process.cwd());
  assert.equal(syntax, undefined);
  assert.equal(inspectHighRiskBashMutation({ command: "printf '%s' '2>&1'" }, process.cwd()), undefined);
  const boundedData = "cat <<'EOF'\n2>&1\nEOF";
  assert.equal(inspectHighRiskBashMutation({ command: boundedData }, process.cwd()), undefined);
  const inputScope = inspectBashPermissionScope({ command: boundedData }, process.cwd());
  assert.ok(inputScope); assert.ok(inputScope.primitives.includes("stdin_data:cat")); assert.equal(inputScope.unverifiableScope, true, "literal data still needs opaque-input authorization");
  const heredoc = inspectHighRiskBashMutation({ command: "cat -n <<'EOF'\n2>&1\nEOF" }, process.cwd());
  assert.ok(heredoc?.primitives.includes("heredoc_uninspectable"));
  assert.notEqual(heredoc?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
  assert.equal(inspectBashPermissionScope({ command: "printf '%s' '2>&1'" }, process.cwd())?.unverifiableScope, false);
});

test("multiple causes retain parser order and do not let full-access bypass verification", () => {
  const scan = inspectHighRiskBashMutation({ command: "tasklist 2>&1 | head; rm -rf $TARGET" }, process.cwd());
  assert.ok(scan?.primitives.includes("rm_recursive"));
  assert.equal(scan?.unverifiableScope, true);
  assert.notEqual(scan?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
});

test("unsupported descriptor syntax stays opaque after static copies", () => {
  const scan = inspectHighRiskBashMutation({ command: "echo x 2>&1 3>&$fd | head" }, process.cwd());
  assert.equal(scan?.unverifiableScope, true);
  assert.ok(scan?.primitives.includes("unverifiable_redirection"));
  assert.notEqual(scan?.diagnostic?.diagnostic.syntax, "2>&1");
});

test("blocked tool projection keeps the legacy empty-reason fallback and final permission decision", async () => {
  const tool = {
    name: "fixture", label: "fixture", description: "offline", parameters: { type: "object", properties: {} } as any,
    execute: async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }),
  } as any;
  async function dispatch(reason: unknown) {
    const agent = new Agent({
      streamFn: () => { throw new Error("offline provider must not be called"); },
      beforeToolCall: async () => ({ block: true, reason } as any),
    });
    agent.state.tools = [tool];
    try { return await agent.dispatchHostTool({ type: "toolCall", id: "reason", name: "fixture", arguments: {} }); }
    finally { agent.abort(); }
  }
  for (const reason of [undefined, null, "", "   "]) {
    const result = await dispatch(reason);
    assert.equal(result.content[0]?.type, "text");
    assert.equal((result.content[0] as any).text, "Tool execution was blocked");
  }
  const feedback = "用户拒绝：" + "说明 ".repeat(200);
  const structured = JSON.stringify({
    ok: false, category: "POLICY_BLOCKED", operation: "bash", permissionMode: "full-access",
    policyReason: "user_rejected", primitives: ["opaque_shell_wrapper", "unverifiable_target"],
    rejectionReason: feedback, stateChanged: false, retryable: false,
  });
  const refusal = await dispatch(structured);
  const refusalText = (refusal.content[0] as any).text as string;
  assert.match(refusalText, /^\[POLICY_BLOCKED:USER_REJECTED\]/);
  assert.doesNotMatch(refusalText, /launcher|native tool|shell bypass/i);
  assert.ok(refusalText.length < 500);
  assert.match(refusalText, /User feedback:/);
  const unsafeFeedback = await dispatch(JSON.stringify({
    category: "POLICY_BLOCKED", policyReason: "user_rejected", stateChanged: false,
    rejectionReason: "password=\"correct horse battery staple\"\u0001", retryable: false,
  }));
  assert.equal((unsafeFeedback.details as any)?.rejectionReason, undefined);
  assert.doesNotMatch(JSON.stringify(unsafeFeedback.details), /correct horse battery staple/);
  const changed = await dispatch(JSON.stringify({ category: "POLICY_BLOCKED", policyReason: "user_rejected", stateChanged: true, primitives: ["opaque_shell_wrapper"] }));
  assert.match((changed.content[0] as any).text, /\"stateChanged\":true/);
  const finalDecision = await dispatch(JSON.stringify({
    category: "POLICY_BLOCKED", policyReason: "user_rejected", stateChanged: false,
    primitives: ["oversized_uninspectable"],
    diagnostic: { code: "INSPECTION_LIMIT", category: "POLICY_BLOCKED", retryable: false, action: "change_arguments" },
  }));
  assert.match((finalDecision.content[0] as any).text, /^\[POLICY_BLOCKED:USER_REJECTED\]/);
  assert.doesNotMatch((finalDecision.content[0] as any).text, /INSPECTION_LIMIT/);
});

test("rejection feedback is bounded and redacts URLs, credentials, and long paths", () => {
  const feedback = sanitizePolicyFeedback("拒绝 https://user:secret@example.invalid/path?q=private_token; token=abc123 authorization: Bearer SUPER_SECRET path=\"/synthetic/private/long/session/file.jsonl\" C:\\private\\long\\session\\file.jsonl");
  assert.ok(feedback);
  assert.doesNotMatch(feedback!, /user:secret|\?q=private_token|token=abc123|SUPER_SECRET|\/synthetic\/private|C:\\private/);
  assert.match(feedback!, /URL redacted|credential redacted|path redacted/);
  assert.ok(feedback!.length <= 240);
});

test("policy feedback redacts complete quoted multi-word credentials", () => {
  const feedback = sanitizePolicyFeedback('password="correct horse battery staple" token=FAKE_TOKEN path=/synthetic/private/long/session.jsonl');
  assert.ok(feedback);
  assert.doesNotMatch(feedback!, /correct horse battery staple|FAKE_TOKEN|private\/long/);
  assert.match(feedback!, /credential redacted/);
  assert.match(feedback!, /path redacted/);
});

test("production extension preflight reaches the first refusal without backend or process use", async () => {
  const jiti = createJiti(import.meta.url);
  const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
  const cwd = process.cwd();
  const runtime = createExtensionRuntime();
  const extensions = [await loadExtensionFromFactory((pi: any) => lifecycle(pi), cwd, createEventBus(), runtime)];
  const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), {} as never);
  const activeTools = ["bash"];
  let executions = 0;
  const agent = new Agent({
    streamFn: () => { throw new Error("offline provider must not be called"); },
    beforeToolCall: async ({ toolCall, args }) => runner.emitToolCall({
      type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown>,
    } as never),
  });
  let catalogReads = 0;
  const configuredTools: any[] = [];
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => activeTools, getAllTools: () => { catalogReads++; return configuredTools; } } as never, {
    getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
    isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
  } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async () => undefined }, "tui");
  await runner.emit({ type: "session_start" } as never);
  const bash = createBashTool(cwd, {
    exposeSessionEnvironment: false,
    operations: { exec: async () => { executions++; return { exitCode: 0 }; } },
  });
  agent.state.tools = [{ ...bash, execute: (id: any, input: any, signal: any, update: any) => { executions++; return (bash.execute as any)(id, input, signal, update); } }];
  try {
    const lifecycleResult = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    const mutationResult = await agent.dispatchHostTool({ type: "toolCall", id: "fd", name: "bash", arguments: { command: USER_COMMANDS[0] } });
    const lifecycleText = lifecycleResult.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const mutationText = mutationResult.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    assert.match(lifecycleText, /^\[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED\] Not executed:/);
    assert.match(lifecycleText, /directly inspectable foreground command/);
    assert.equal(catalogReads, 0);
    activeTools.push("tool_search");
    const unavailable = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper-unavailable", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    assert.doesNotMatch(JSON.stringify(unavailable.content), /Use tool_search/);
    configuredTools.push({ name: "powershell" });
    const discoverable = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper-discoverable", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    if (process.platform === "win32") {
      assert.match(JSON.stringify(discoverable.content), /Use tool_search.*powershell.*read its schema/);
      assert.match(JSON.stringify(discoverable.content), /describeTools.*callTool.*new script/);
    } else assert.doesNotMatch(JSON.stringify(discoverable.content), /Use tool_search|enabled native PowerShell/);
    const expectedCatalogReads = process.platform === "win32" ? 2 : 0;
    assert.equal(catalogReads, expectedCatalogReads);
    activeTools.push("powershell");
    const availableResult = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper-available", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    const availableText = availableResult.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (process.platform === "win32") assert.match(availableText, /Use the enabled native PowerShell tool/);
    else assert.match(availableText, /directly inspectable foreground command/);
    assert.equal(catalogReads, expectedCatalogReads + (process.platform === "win32" ? 1 : 0), "active native tools also check host availability on refusal; platform-unavailable tools do not enumerate");
    assert.match(mutationText, /^\[POLICY_BLOCKED:CONFIRMATION_CANCELLED\] Not executed:/);
    const machineDetails = mutationResult.details as any;
    assert.equal(machineDetails.executionStatus, "not_executed");
    assert.equal(machineDetails.operation, "bash");
    assert.equal(machineDetails.permissionMode, "workspace-write");
    assert.equal(machineDetails.primitives?.includes("unverifiable_redirection"), false);
    assert.equal(machineDetails.opaqueScript, true);
    assert.equal(machineDetails.stateChanged, false);
    assert.equal(executions, 0);
  } finally {
    agent.abort();
    runner.invalidate();
    await runner.emit({ type: "session_shutdown" } as never);
  }
});

test("provider wire receives one projected refusal after real Agent preflight", async () => {
  const jiti = createJiti(import.meta.url);
  const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
  const cwd = process.cwd();
  const runtime = createExtensionRuntime();
  const extensions = [await loadExtensionFromFactory((pi: any) => lifecycle(pi), cwd, createEventBus(), runtime)];
  const sessionManager = SessionManager.inMemory(cwd);
  const runner = new ExtensionRunner(extensions, runtime, cwd, sessionManager, {} as never);
  const model: any = { id: "offline", name: "offline", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 128 };
  const wire: any[] = [];
  let backend = 0;
  let requests = 0;
  const providerFetch = async (_url: string | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    wire.push(payload);
    requests++;
    const body = requests === 1
      ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "policy-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: USER_COMMANDS[0] }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
      : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "replanned" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const activeTools = ["bash"];
  const agent = new Agent({
    initialState: { model },
    convertToLlm,
    streamFn: (requestModel, context, options) => streamSimple(requestModel as any, context, { ...(options as any), apiKey: "offline", fetch: providerFetch }),
    beforeToolCall: async ({ toolCall, args }) => runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown> } as never),
  });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => activeTools } as never, {
    getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
    isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
  } as never);
  const bash = createBashTool(cwd, { exposeSessionEnvironment: false, operations: { exec: async () => { backend++; return { exitCode: 0 }; } } });
  agent.state.tools = [{ ...bash, execute: (id: any, input: any, signal: any, update: any) => (backend++, (bash.execute as any)(id, input, signal, update)) }];
  try {
    await runner.emit({ type: "session_start" } as never);
    await agent.prompt("wire fixture");
    assert.equal(requests, 2);
    assert.equal(backend, 0);
    const results = agent.state.messages.filter(message => message.role === "toolResult") as any[];
    assert.equal(results.length, 1);
    assert.equal(results[0].toolCallId, "policy-call");
    assert.match(results[0].content[0].text, /^\[POLICY_BLOCKED:CONFIRMATION_REQUIRED\]/);
    const secondMessages = JSON.stringify(wire[1].messages);
    assert.equal((wire[1].messages as any[]).filter(message => message.role === "tool").length, 1);
    assert.match(secondMessages, /POLICY_BLOCKED:CONFIRMATION_REQUIRED/);
    assert.doesNotMatch(secondMessages, /unverifiable_dynamic_scope/);
    assert.equal((secondMessages.match(/POLICY_BLOCKED:CONFIRMATION_REQUIRED/g) ?? []).length, 1);
  } finally {
    agent.abort(); runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never);
  }
});

test("legacy structured refusal keeps a trusted inspection limit and sanitized feedback on the next provider wire", async () => {
  const model: any = { id: "offline", name: "offline", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 128 };
  const wire: any[] = [];
  let requests = 0;
  const providerFetch = async (_url: string | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    wire.push(payload);
    requests++;
    const body = requests === 1
      ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "legacy-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo fixture" }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
      : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "replanned" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const legacyReason = JSON.stringify({
    ok: false,
    category: "POLICY_BLOCKED",
    operation: "bash",
    permissionMode: "workspace-write",
    policyReason: "unverifiable_target",
    primitives: ["oversized_uninspectable"],
    diagnostic: { code: "INSPECTION_LIMIT", category: "POLICY_BLOCKED", retryable: false, action: "change_arguments" },
    rejectionReason: "用户备注 token=FAKE_TOKEN https://example.invalid/query?secret=FAKE C:\\synthetic\\private\\long\\session.jsonl",
    stateChanged: false,
    retryable: false,
  });
  const agent = new Agent({
    initialState: { model },
    convertToLlm,
    streamFn: (requestModel, context, options) => streamSimple(requestModel as any, context, { ...(options as any), apiKey: "offline", fetch: providerFetch }),
    beforeToolCall: async ({ toolCall }) => ({ block: true, reason: legacyReason } as any),
  });
  agent.state.tools = [{ name: "bash", label: "bash", description: "fixture", parameters: { type: "object", properties: {} }, execute: async () => { throw new Error("backend must not run"); } } as any];
  try {
    await agent.prompt("legacy wire fixture");
    assert.equal(requests, 2);
    const result = agent.state.messages.find(message => message.role === "toolResult") as any;
    const text = result.content[0].text as string;
    assert.match(text, /^\[POLICY_BLOCKED:INSPECTION_LIMIT\]/);
    assert.match(text, /analysis limit/);
    assert.doesNotMatch(text, /DYNAMIC_TARGET|FAKE_TOKEN|example\.invalid|private\\long/);
    const secondMessages = JSON.stringify(wire[1].messages);
    assert.match(secondMessages, /POLICY_BLOCKED:INSPECTION_LIMIT/);
    assert.doesNotMatch(secondMessages, /FAKE_TOKEN|example\.invalid|private\\long|DYNAMIC_TARGET/);
    assert.equal((wire[1].messages as any[]).filter(message => message.role === "tool").length, 1);
  } finally {
    agent.abort();
  }
});

test("default TUI keeps the diagnostic code, syntax and recovery readable", () => {
  initTheme("dark");
  const component = new ToolExecutionComponent("bash", "policy", {}, { showImages: false }, undefined, { requestRender(): void {} } as never, process.cwd());
  component.updateResult({ content: [{ type: "text", text: "[POLICY_BLOCKED:FD_DUP_UNSUPPORTED] Not executed:\nBash analysis does not support `2>&1`.\nNext: omit stream merging only if stderr need not pass through the pipe; resubmit for authorization." }], isError: true });
  const rendered = component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "");
  assert.match(rendered, /FD_DUP_UNSUPPORTED/);
  assert.match(rendered, /2>&1/);
  assert.match(rendered, /Next:/);
});

test("Bash default error preview keeps the first useful Node exception and exit status", () => {
  initTheme("dark");
  const component = new ToolExecutionComponent("bash", "node-failure", {}, { showImages: false }, undefined, { requestRender(): void {} } as never, process.cwd());
  component.markExecutionStarted();
  component.setArgsComplete();
  const output = [
    "Error: retrying",
    "file:///tmp/synthetic/fixture.mjs:1",
    "const = ;",
    "      ^",
    "",
    "SyntaxError: Unexpected token '='",
    "    at compileSourceTextModule (node:internal/modules/esm/utils:346:16)",
    ...Array.from({ length: 14 }, (_, index) => `    at frame${index} (file:///tmp/synthetic/fixture.mjs:${index + 5}:1)`),
    "Command exited with code 1",
    "[Node script recovery] preserve the first useful error and location; do not retry unchanged source.",
  ].join("\n");
  component.updateResult({ content: [{ type: "text", text: output }], isError: true }, false, true);
  const collapsed = component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "");
  assert.match(collapsed, /fixture\.mjs:1/);
  assert.match(collapsed, /SyntaxError: Unexpected token/);
  assert.match(collapsed, /const = ;/);
  assert.match(collapsed, /Command exited with code 1/);
  assert.doesNotMatch(collapsed, /Error: retrying/);
  assert.doesNotMatch(collapsed, /frame13/);
  component.setExpanded(true);
  const expanded = component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "");
  assert.match(expanded, /frame13/);
  assert.match(expanded, /\[Node script recovery\]/);
});

test("diagnostic token budget is measured through provider serialization", async () => {
  const diagnostic = { code: "FD_DUP_UNSUPPORTED" as const, category: "POLICY_BLOCKED" as const, syntax: "2>&1", retryable: false, action: "omit_syntax" as const };
  const shortText = renderPolicyDiagnostic(diagnostic);
  const legacyJson = JSON.stringify({ ok: false, category: "POLICY_BLOCKED", operation: "bash", permissionMode: "full-access", policyReason: "unverifiable_target", highRisk: true, opaqueScript: true, primitives: ["unverifiable_redirection", "unverifiable_dynamic_scope"], stateChanged: false, retryable: false });
  const encoding = getEncoding("cl100k_base");
  const oldTokens = encoding.encode(legacyJson).length;
  const shortTokens = encoding.encode(shortText).length;
  let wire: any;
  const model: any = { id: "offline", name: "offline", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 128 };
  const stream = streamSimple(model, { messages: [{ role: "user", content: shortText, timestamp: 0 }] as any }, { apiKey: "offline", fetch: async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  await stream.result();
  const wireText = wire.messages[0].content as string;
  assert.equal(wireText, shortText);
  assert.ok(shortTokens < 128, `${shortTokens} estimated tokens`);
  assert.ok(oldTokens > shortTokens);
  assert.doesNotMatch(JSON.stringify(wire), /unverifiable_dynamic_scope/);
  console.log(JSON.stringify({ legacyJsonEstimatedTokens: oldTokens, candidateShortTextEstimatedTokens: shortTokens, providerWireContentCodeUnits: wireText.length }));
});
