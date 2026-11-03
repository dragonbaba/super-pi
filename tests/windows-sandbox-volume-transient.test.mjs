import { PINNED_SANDBOX_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";

test("transient responsibility survives failed construction and blocks reporting I/O after unknown close", { timeout: 40000, ...PINNED_SANDBOX_TEST_OPTIONS }, t => {
    const workspace = fileURLToPath(new URL("..", import.meta.url)), parent = path.join(workspace, ".artifacts");
    assert.equal(fs.realpathSync(parent), parent); assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
    const root = path.join(parent, "volume-transient-check-" + randomUUID()); fs.mkdirSync(root);
    const identity = fs.lstatSync(root, { bigint: true }), assembly = path.join(root, "transient-check.dll");
    const runs = []; let closed = true;
    t.after(() => {
        let files = null, inspectionError;
        if (closed) {
            try {
                const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
                assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
                const names = fs.readdirSync(root); assert.ok(names.length <= 1 && names.every(name => name === "transient-check.dll"));
                files = names.map(name => { const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
                    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.ok(stat.size <= 131072n);
                    return { file, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) }; });
            } catch (error) { inspectionError = error; }
        }
        const evidence = Buffer.from(JSON.stringify({ kind: "transient-offline-evidence", root, identity: { dev: String(identity.dev), ino: String(identity.ino) },
            processesClosed: closed, inspectionError: inspectionError ? String(inspectionError.message).slice(0, 256) : null, files, runs }) + "\n");
        assert.ok(evidence.length <= 12288);
        for (let offset = 0; offset < evidence.length;) { const n = fs.writeSync(1, evidence, offset, evidence.length - offset); assert.ok(n > 0); offset += n; }
        assert.equal(closed, true, "Unclosed check process; retain recorded root"); if (inspectionError) throw inspectionError;
        let removed = 0;
        try {
            for (const item of files) { const stat = fs.lstatSync(item.file, { bigint: true });
                assert.equal(String(stat.dev), item.dev); assert.equal(String(stat.ino), item.ino); assert.equal(String(stat.size), item.size);
                assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.equal(fs.realpathSync(item.file), item.file);
                fs.unlinkSync(item.file); removed++; }
            const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
            assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root);
            fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
        } catch (error) {
            fs.writeSync(1, JSON.stringify({ kind: "transient-offline-cleanup", rootRemoved: false, retained: true, filesRemoved: removed, error: String(error.message).slice(0, 128) }) + "\n");
            throw error;
        }
        fs.writeSync(1, JSON.stringify({ kind: "transient-offline-cleanup", rootRemoved: true, filesRemoved: removed }) + "\n");
    });
    function run(role, executable, args) {
        const record = { role, requestedUtc: new Date().toISOString(), phase: "requested-unknown", pid: null, status: null, signal: null,
            error: null, exception: null, stdoutBytes: null, stderrBytes: null, stdoutBase64: null, stderrBase64: null, truncated: null };
        runs.push(record); closed = false;
        let result;
        try { result = spawnSync(executable, args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 8192 }); }
        catch (error) {
            record.phase = "call-threw-unknown"; record.error = String(error.code ?? error.name).slice(0, 64);
            record.exception = String(error.message).slice(0, 256); throw error;
        }
        closed = Number.isInteger(result.status) || typeof result.signal === "string";
        Object.assign(record, { phase: closed ? "closed" : "unresolved", pid: result.pid ?? null, status: result.status, signal: result.signal,
            error: result.error?.code ?? null, stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0,
            stdoutBase64: result.stdout?.subarray(0, 2048).toString("base64") ?? "", stderrBase64: result.stderr?.subarray(0, 1024).toString("base64") ?? "",
            truncated: (result.stdout?.length ?? 0) > 2048 || (result.stderr?.length ?? 0) > 1024 });
        assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.signal, null);
        assert.equal(result.stderr.length, 0); assert.ok(result.stdout.length <= 2048); return result.stdout;
    }
    verifyPowerShell7();
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    const native = fs.readFileSync(path.join(workspace, "scripts/acceptance/windows-sandbox-volume-native.cs"), "utf8");
    assert.equal(native.includes("CloseTransient("), false);
    for (const role of ["Fingerprint", "Privilege", "ImageInfo", "VolumeExtents", "ExchangePath", "ProbeWrite", "ProbeRead", "DetachPresence"]) {
        assert.equal((native.match(new RegExp("WithTransient(?:<int>)?\\(TransientRole\\." + role + ",", "g")) ?? []).length, 1);
    }
    run("compile", compiler, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly,
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-native.cs"),
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-capacity-core.cs"),
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-capacity-protocol.cs"),
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-capacity-host.cs"),
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-candidate-manifest.cs"),
        path.join(workspace, "tests/fixtures/windows-sandbox-volume-transient-check.cs")]);
    assert.ok(fs.statSync(assembly).size <= 131072);
    const script = String.raw`$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PS7 x64 required'}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::LoadFile([IO.Path]::Combine([Environment]::CurrentDirectory,'transient-check.dll'))
$core=[TransientChecks]::Run() | ConvertFrom-Json
$workspace='D:\RMProjects\Pi'
$helper=[IO.Path]::Combine($workspace,'scripts\acceptance\windows-sandbox-volume-helper.ps1')
$savedOut=[Console]::Out; $parseOutput=[IO.StringWriter]::new()
try {
    [Console]::SetOut($parseOutput)
    & ([IO.Path]::Combine($workspace,'tests\fixtures\windows-sandbox-volume-startup-parse.ps1')) -Helper $helper
} finally { [Console]::SetOut($savedOut) }
$startup=$parseOutput.ToString() | ConvertFrom-Json
$parseOutput.Dispose()
if(-not $startup.parsed -or $startup.helperExecuted -or $startup.storageCalls -ne 0){throw 'Startup parse-only result'}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Helper parse'}
foreach($name in @('Test-TransientUnknown','Assert-TransientHealthy','Write-TransientFailure','Write-TerminalFailure','Write-State','Write-Evidence','Invoke-VolumeCommand')) {
    $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($nodes.Count -ne 1){throw 'Exact function selection'}
    . ([ScriptBlock]::Create($nodes[0].Extent.Text))
}
$script:transientOwner=$null
$script:candidateReceiptUnknown=$false
if(Test-TransientUnknown){throw 'Null caller owner must be healthy'}
Assert-TransientHealthy
$script:TaskId='11111111-2222-3333-4444-555555555555'
$script:Root='D:\not-accessed'; $script:requestSequence=1; $script:physical=$null; $script:volume=$null; $script:exchangeId=$null
function Verify-Ready { $script:verifyCalls++; throw 'forbidden-dispatch-canary' }
$guards=0; $maxDiagnostic=0
for($mode=0;$mode -lt 3;$mode++) {
    $script:transientOwner=[TransientChecks]::UnknownOwner($mode); $script:transientReported=$false; $script:controlFailed=$false
    foreach($invoke in @({Write-State 'reply' $null},{Write-Evidence 'volume-probe.json' @{}},{Invoke-VolumeCommand 'verify'})) {
        $script:controlFailed=$false; $script:phase='prepared-not-share-admitted'; $script:verifyCalls=0; $script:native=[TransientNativeCanary]::new()
        $cause=$null; try { & $invoke } catch { $cause=$_.Exception.GetBaseException().Message }
        if($cause -cne 'Transient close unknown; no further file access' -or $script:transientOwner.CloseAttempts -ne 1 -or
           $script:native.Calls -ne 0 -or $script:verifyCalls -ne 0){throw 'Expected transient admission refusal before native/file/dispatch canaries'}
        $guards++
    }
    $savedError=[Console]::Error; $writer=[IO.StringWriter]::new()
    try {
        [Console]::SetError($writer); Write-TransientFailure 'native-constructor'
        $first=$writer.ToString(); Write-TransientFailure 'native-constructor'
        if($writer.ToString() -cne $first){throw 'Diagnostic repeated'}
    } finally { [Console]::SetError($savedError) }
    $writer.Dispose(); $bytes=[Text.Encoding]::UTF8.GetByteCount($first); $maxDiagnostic=[Math]::Max($maxDiagnostic,$bytes)
    if($bytes -gt 1024){throw 'Diagnostic bound'}; $record=$first | ConvertFrom-Json
    if($record.protocol -cne 'super-pi-volume-transient-v1' -or $record.taskId -cne $TaskId -or $record.handle -cne '1234' -or
       $record.role -cne 'Fingerprint' -or -not $record.closeUnknown -or $record.opened -ne 1 -or $record.closed -ne 0 -or $record.closeAttempts -ne 1){throw 'Exact responsibility record'}
    if($mode -eq 0 -and $record.closeError -ne 0){throw 'Zero raw close error'}
    if($mode -eq 1 -and ($null -ne $record.closeError -or $record.closeType -cne 'System.InvalidOperationException')){throw 'Unknown thrown-close code'}
    if($mode -eq 2 -and ($record.operationNativeCode -ne 5 -or $record.closeError -ne 6)){throw 'Independent original errors'}
}
function Write-State {
    param($kind,$errorCode)
    $script:reportCalls++
    if($kind -cne 'fatal' -or $errorCode -cne 'control-or-journal-failed'){throw 'Unexpected terminal report'}
    if($script:terminalMode -ceq 'known-report-ok'){return}
    if($script:terminalMode -ceq 'known-report-failed'){throw 'known-report-failure'}
    $script:transientOwner=[TransientChecks]::UnknownOwner(2)
    throw 'report-became-unknown'
}
$terminalModes=0; $writeFailureAttempts=0
foreach($terminalMode in @('existing-unknown','became-unknown','diagnostic-write-failed','known-report-failed','known-report-ok')) {
    $script:terminalMode=$terminalMode; $script:reportCalls=0; $script:terminalReportAttempted=$false; $script:transientReported=$false
    $script:transientOwner=$(if($terminalMode -ceq 'existing-unknown'){[TransientChecks]::UnknownOwner(2)}else{$null})
    $savedError=[Console]::Error
    $writer=$(if($terminalMode -ceq 'diagnostic-write-failed'){[TransientFailingWriter]::new()}else{[IO.StringWriter]::new()})
    try { [Console]::SetError($writer); Write-TerminalFailure; $first=$writer.ToString(); Write-TerminalFailure }
    finally { [Console]::SetError($savedError) }
    if($script:reportCalls -ne $(if($terminalMode -ceq 'existing-unknown'){0}else{1}) -or $writer.ToString() -cne $first){throw 'Terminal report repeated or file fallback'}
    if($terminalMode -like 'known-report-*') {
        if((Test-TransientUnknown) -or $script:transientReported -or $first.Length -ne 0){throw 'Known report invented unknown responsibility'}
    } else {
        if(-not (Test-TransientUnknown) -or -not $script:transientReported -or $script:transientOwner.RetainedHandle -cne '1234' -or $script:transientOwner.CloseAttempts -ne 1){throw 'Terminal unknown responsibility lost'}
        if($terminalMode -ceq 'diagnostic-write-failed') {
            if($writer.Attempts -ne 1 -or $first.Length -ne 0){throw 'Failed diagnostic retried'}; $writeFailureAttempts=$writer.Attempts
        } else {
            $record=$first | ConvertFrom-Json
            if($record.handle -cne '1234' -or $record.operationNativeCode -ne 5 -or $record.closeError -ne 6 -or $record.phase -cne 'blocked-control'){throw 'Terminal original errors missing'}
            $bytes=[Text.Encoding]::UTF8.GetByteCount($first); if($bytes -gt 1024){throw 'Terminal diagnostic bound'}; $maxDiagnostic=[Math]::Max($maxDiagnostic,$bytes)
        }
    }
    $writer.Dispose(); $terminalModes++
}
$fixtures=@('guest-read-check','capacity-helper-check','helper-check','journal-check','probe-check')
foreach($suffix in $fixtures) {
    $fixture=[IO.Path]::Combine($workspace,'tests\fixtures\windows-sandbox-volume-'+$suffix+'.ps1')
    $tokens=$null; $errors=$null; $parsed=[Management.Automation.Language.Parser]::ParseFile($fixture,[ref]$tokens,[ref]$errors)
    if($errors.Count -or -not $parsed.Extent.Text.Contains('$script:transientOwner=$null') -or
       -not $parsed.Extent.Text.Contains("'Test-TransientUnknown'") -or -not $parsed.Extent.Text.Contains("'Assert-TransientHealthy'")){throw 'Old fixture dependency parse'}
}
$tries=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
$fatal=$tries[1].CatchClauses[0].Body.Statements[0]
if($fatal.Extent.Text -cne 'Write-TerminalFailure' -or $tries[1].CatchClauses[0].Body.Statements[1] -isnot [Management.Automation.Language.WhileStatementAst]){throw 'Actual terminal reporting must precede retained loop'}
$script:transientOwner=$null; $script:native=$null
[Console]::WriteLine(([ordered]@{core=$core; startupParseOnly=$startup.parsed; guards=$guards; diagnosticModes=3; diagnosticMaximum=$maxDiagnostic; terminalModes=$terminalModes; writeFailureAttempts=$writeFailureAttempts; fixtureParses=5; helperExecuted=$false; storageCalls=0} | ConvertTo-Json -Depth 4 -Compress))
`;
    const bytes = run("pure-check", POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
    assert.ok(result.diagnosticMaximum > 0 && result.diagnosticMaximum <= 1024);
    delete result.diagnosticMaximum;
    assert.deepEqual(result, { core: { cases: 24, serialOpened: 8, serialClosed: 8, responsibilitySlots: 1, unknownCloseAttempts: 1,
        unknownAcquisitions: 0, nativeDiskInstances: 0, callbacksRetained: 0 }, startupParseOnly: true,
        guards: 9, diagnosticModes: 3, terminalModes: 5, writeFailureAttempts: 1, fixtureParses: 5, helperExecuted: false, storageCalls: 0 });
});

