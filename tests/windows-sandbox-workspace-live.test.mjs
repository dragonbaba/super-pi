// Opt-in local VM acceptance; ordinary CI does not create a sandbox.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
                const reply=await backend.invoke('powershell',{command:probe,timeout:30}),report=JSON.parse(reply.text);
                assert.match(report.version,/^7\./);assert.equal(report.fixture,'workspace-fixture');
                assert.equal(report.cwd,mode==='read-only'?'C:\\SuperPiInput':'C:\\SuperPiWorkspace');
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
