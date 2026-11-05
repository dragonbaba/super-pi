// Opt-in local VM acceptance; ordinary CI does not create a sandbox.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import { WorkspaceSandboxBackend } from '../packages/coding-agent/src/core/sandbox/workspace-backend.ts';

const enabled=process.platform==='win32' && process.env.SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE==='1';
const probe=String.raw`$dns=$false; $https=$false; try { $dns=[System.Net.Dns]::GetHostAddresses('registry.npmjs.org').Count -gt 0; $r=Invoke-WebRequest 'https://registry.npmjs.org/-/ping' -TimeoutSec 15; $https=$r.StatusCode -eq 200 } catch {}; [pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();cwd=(Get-Location).Path;dns=$dns;https=$https;fixture=(Get-Content ./fixture.txt -Raw).Trim()} | ConvertTo-Json -Compress`;

test('live workspace preserves project paths and explicitly controls DNS/HTTPS/npm', {skip:!enabled,timeout:300000}, async () => {
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sandbox-workspace-live-'))),identity=await fs.lstat(root,{bigint:true});
    const project=path.join(root,'project'),artifacts=path.join(root,'artifacts');await fs.mkdir(project);await fs.mkdir(artifacts);
    await fs.writeFile(path.join(project,'fixture.txt'),'workspace-fixture\n');
    const Backend=process.env.SUPERPI_SANDBOX_USE_DIST==='1' ? (await import('../packages/coding-agent/dist/core/sandbox/workspace-backend.js')).WorkspaceSandboxBackend : WorkspaceSandboxBackend;
    try {
        for(const [mode,network] of [['read-only','disabled'],['sandbox-write','enabled']]) {
            const backend=new Backend(project,artifacts,mode,{network});
            try {
                const listed=await backend.invoke('ls',{path:project.replaceAll('\\','/')});assert.equal(listed.text,'fixture.txt');
                const read=await backend.invoke('read',{path:path.join(project,'fixture.txt')});assert.match(read.text,/workspace-fixture/);
                const projectLiteral=project.replaceAll("'","''");
                const command=probe+`; if((Get-Content -LiteralPath '${projectLiteral}\\fixture.txt' -Raw).Trim() -ne 'workspace-fixture'){throw 'Absolute project path mismatch'}; if((node -p 'process.cwd()') -ne '${projectLiteral}'){throw 'Native process cwd mismatch'}`;
                const reply=await backend.invoke('powershell',{command,timeout:30}),report=JSON.parse(reply.text);
                assert.match(report.version,/^7\./);assert.equal(report.fixture,'workspace-fixture');
                assert.equal(report.cwd,project);
                assert.equal(report.dns,network==='enabled');assert.equal(report.https,network==='enabled');
                if(network==='enabled') {
                    const install=await backend.invoke('powershell',{command:"npm install --ignore-scripts --no-audit --no-fund --save-exact is-number@7.0.0; if($LASTEXITCODE){throw 'npm install failed'}; node -e \"if(!require('is-number')(42))process.exit(1)\"; if($LASTEXITCODE){throw 'installed dependency failed'}",timeout:90});
                    assert.deepEqual(install.changes.map(item=>item.path).sort(),['package-lock.json','package.json']);
                    assert.equal(await fs.readdir(project).then(files=>files.length),1);
                    report.npmInstall=true;report.hostUnchanged=true;report.dependencyWritebacks=0;
                }
                assert.equal(backend.diagnostics.starts,1);
                console.log('WORKSPACE_NETWORK_LIVE '+JSON.stringify({mode,network,...report,calls:backend.diagnostics.calls}));
            } finally {
                await backend.close();assert.equal(backend.diagnostics.vm,false);assert.equal(backend.diagnostics.ownedArtifacts,0);assert.equal(backend.diagnostics.sourceFiles,0);
                console.log('WORKSPACE_NETWORK_CLOSED '+JSON.stringify(backend.diagnostics));
            }
        }
    } finally {
        const current=await fs.lstat(root,{bigint:true});assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);assert.equal(await fs.realpath(root),root);
        await fs.unlink(path.join(project,'fixture.txt'));await fs.rmdir(project);await fs.rmdir(artifacts);await fs.rmdir(root);
    }
});

test('live active sandbox cancellation joins repeated close and releases physical owners', {skip:!enabled,timeout:300000}, async () => {
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sandbox-workspace-active-'))),identity=await fs.lstat(root,{bigint:true});
    const project=path.join(root,'project'),artifacts=path.join(root,'artifacts');await fs.mkdir(project);await fs.mkdir(artifacts);
    await fs.writeFile(path.join(project,'fixture.txt'),'active-fixture\n');
    const Backend=process.env.SUPERPI_SANDBOX_USE_DIST==='1' ? (await import('../packages/coding-agent/dist/core/sandbox/workspace-backend.js')).WorkspaceSandboxBackend : WorkspaceSandboxBackend;
    const backend=new Backend(project,artifacts,'read-only',{network:'disabled'}),controller=new AbortController();
    try {
        assert.equal((await backend.invoke('ls',{})).text,'fixture.txt');
        const vm=backend.vm;
        const operation=backend.invoke('powershell',{command:'Start-Sleep -Seconds 60',timeout:90},controller.signal);
        const observed=Promise.allSettled([operation]);
        const deadline=performance.now()+10000;
        while(!vm.execution && performance.now()<deadline) await delay(10);
        assert.ok(vm.execution?.operation.pid,'Owned execution CLI must be physically launched before cancellation');
        assert.equal(vm.execution.operation.result,undefined);
        const activePid=vm.execution.operation.pid,started=performance.now();controller.abort();
        const first=backend.close(),second=backend.close();assert.equal(first,second);
        await Promise.all([first,second]);
        assert.equal((await observed)[0].status,'rejected');
        assert.equal(vm.state,'closed');assert.equal(vm.active,undefined);assert.equal(vm.execution,undefined);assert.equal(vm.connection,undefined);
        assert.ok(vm.calls.every(call=>call.result && call.pid===call.result.pid),'Every owned CLI must have physically settled');
        assert.deepEqual(await fs.readdir(project),['fixture.txt']);assert.equal(await fs.readFile(path.join(project,'fixture.txt'),'utf8'),'active-fixture\n');
        assert.equal(backend.diagnostics.pending,false);assert.equal(backend.diagnostics.vm,false);assert.equal(backend.diagnostics.ownedArtifacts,0);assert.equal(backend.diagnostics.sourceFiles,0);
        console.log('WORKSPACE_ACTIVE_CLOSED '+JSON.stringify({instanceId:vm.id,activePid,cancelToCloseMs:performance.now()-started,
            scope:'Guest already warmed; physical execution CLI in flight, not a proof of guest command entry',state:vm.state,diagnostics:backend.diagnostics,
            calls:vm.calls.map(call=>({kind:call.kind,pid:call.pid,requestedUtc:call.requestedUtc,outcome:call.outcome,
                startedUtc:call.result.spawnObservedUtc,closedUtc:call.result.closedUtc,exitCode:call.result.exitCode,signal:call.result.signal}))}));
    } finally {
        controller.abort();await backend.close();
        const current=await fs.lstat(root,{bigint:true});assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);assert.equal(await fs.realpath(root),root);
        await fs.unlink(path.join(project,'fixture.txt'));await fs.rmdir(project);await fs.rmdir(artifacts);await fs.rmdir(root);
    }
});
