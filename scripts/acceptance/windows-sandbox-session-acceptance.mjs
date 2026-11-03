// Explicit real AgentSession smoke. Offline provider responses; real CodeMode,
// native tool registry, Windows Sandbox command backend and session disposal.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createAgentSession } from "../../packages/coding-agent/dist/core/sdk.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/dist/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/dist/core/settings-manager.js";
import { SessionManager } from "../../packages/coding-agent/dist/core/session-manager.js";
const repository = fileURLToPath(new URL("../..", import.meta.url));
if (process.argv.length !== 3 || !["--run-session-once", "--run-project-once", "--run-failure-once", "--run-timeout-once", "--run-cancel-once"].includes(process.argv[2])) throw new Error("Explicit session acceptance required");
const project = process.argv[2] === "--run-project-once";
const failure = process.argv[2] === "--run-failure-once", timeout = process.argv[2] === "--run-timeout-once", cancel = process.argv[2] === "--run-cancel-once";
const root = fs.mkdtempSync(path.join(repository, ".artifacts", "sandbox-session-"));
const rootStat = fs.lstatSync(root, { bigint: true });
console.log(JSON.stringify({ kind: "session-fixture", root, dev: String(rootStat.dev), ino: String(rootStat.ino), pid: process.pid }));
const settings = SettingsManager.inMemory({ executionEnvironment: "sandbox", executionPermissions: {
    approval: "never", rules: [{ tool: "file_batch", decision: "allow", path: "." }] }, compaction: { enabled: false }, retry: { enabled: false } });
if (project) {
    fs.writeFileSync(path.join(root, "data.json"), '{"left":19,"right":23}\n');
    fs.writeFileSync(path.join(root, "build.ps1"), '\ufeff$data=Get-Content -Raw data.json | ConvertFrom-Json\n$value=$data.left+$data.right\nif($value -ne 42){throw "build failed"}\n[IO.File]::WriteAllText((Join-Path $PWD "result.txt"),"answer=$value 中文",[Text.UTF8Encoding]::new($false))\n[IO.File]::WriteAllText((Join-Path $PWD "data.json"),"{`"answer`":$value}",[Text.UTF8Encoding]::new($false))\n[Console]::Write("build-passed:$value")\n');
}
const code = failure || timeout || cancel ? `const r=await callTool("powershell", {command:${JSON.stringify(
    '[IO.File]::WriteAllText((Join-Path $PWD "should-not-publish.txt"),"candidate"); ' + (failure ? '[Console]::Error.Write("expected-error"); exit 23' : 'Start-Sleep -Seconds 20'))},
    timeout:${timeout ? 1 : 30},writes:[{path:"should-not-publish.txt",operation:"add",snapshot:null}]},{allowFailure:true});
    text(r.isError); await show(r.ref);` : project ? `
const script=await tools.read({path:"build.ps1"}); const data=await tools.read({path:"data.json"});
function snapshot(r){const match=r.content.map(b=>b.text||"").join("\\n").match(/snap_[A-Za-z0-9_-]{22}/);if(!match)throw Error("missing snapshot");return match[0];}
const source=snapshot(data);
const r=await tools.powershell({command:"& ./build.ps1",timeout:10,
  inputs:[{path:"build.ps1",snapshot:snapshot(script)},{path:"data.json",snapshot:source}],
  writes:[{path:"data.json",operation:"modify",snapshot:source},{path:"result.txt",operation:"add",snapshot:null}]});
await show(r.ref); text(r.writeback);
` : 'const r=await tools.powershell({command:\'[Console]::Write("normal-session 中文")\',timeout:10}); await show(r.ref);';
const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
const model = { id: "offline-fixture", name: "offline-fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.invalid",
    reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const modelRuntime = { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
    getAuth: async () => undefined, usesBuiltinOpenAICodex: () => false, usesBuiltinOpenAIResponses: () => false,
    isUsingOAuth: () => false, isUsingSubscription: () => false, getAvailableSnapshot: () => [model],
    getAvailable: async () => [model], getError: () => undefined, registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {}, getModel: () => model };
let session, responses = 0, cancelWatch, cancelTimer, cancellationObserved = false;
try {
    await resources.reload(); assert.deepEqual(resources.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, resourceLoader: resources,
        sessionManager: SessionManager.inMemory(root), model, modelRuntime, tools: ["powershell", "read", "file_batch"] }));
    session.agent.streamFunction = () => {
        const content = responses++ === 0 ? [{ type: "toolCall", id: "session-sandbox-parent", name: "codemode",
            arguments: { code } }]
            : [{ type: "text", text: "done" }];
        const message = { role: "assistant", ...model, model: model.id, content, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: 1,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } };
    };
    if (cancel) cancelWatch = setInterval(() => {
        const parent = path.join(root, "sandbox-tasks");
        if (!fs.existsSync(parent)) return;
        const tasks = fs.readdirSync(parent); assert.ok(tasks.length <= 1);
        if (!tasks.length) return;
        try {
            const journal = JSON.parse(fs.readFileSync(path.join(parent, tasks[0], "lifecycle.json"), "utf8"));
            if (journal.vm?.state === "executing-volume-input") {
                clearInterval(cancelWatch); cancelWatch = undefined;
                cancelTimer = setTimeout(() => { cancellationObserved = true; session.agent.abort(); }, 1250);
            }
        } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    }, 100);
    try { await session.prompt("Run the fixed normal-session PowerShell smoke."); }
    catch (error) { if (!cancel || !cancellationObserved) throw error; }
    const result = session.agent.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "session-sandbox-parent");
    if (!cancel) assert.ok(result, "Original CodeMode result missing");
    console.log(JSON.stringify({ kind: "session-result", result }));
    console.log(JSON.stringify({ kind: "sandbox-diagnostics", diagnostics: session._sandboxCommands?.diagnostics }));
    if (!cancel) { assert.equal(result.isError, false); assert.equal(responses, 2); }
    if (!failure && !timeout && !cancel) assert.ok(result.content.some(block => block.type === "text" && block.text === (project ? "build-passed:42" : "normal-session 中文")));
    if (failure || timeout) {
        const child = result.details.codemode.calls.find(call => call.toolName === "powershell");
        assert.equal(child.isError, true); assert.equal(child.failureHandled, true);
        assert.equal(result.details.codemode.calls.length, 1, "Failed commands must not dispatch file_batch");
        if (failure) assert.ok(result.content.some(block => block.type === "text" && block.text === "expected-error"));
    }
    if (failure || timeout || cancel) assert.equal(fs.existsSync(path.join(root, "should-not-publish.txt")), false);
    if (cancel) assert.equal(cancellationObserved, true);
    if (project) {
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8")), { answer: 42 });
        assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8"), "answer=42 中文");
    }
    const taskParent = path.join(root, "sandbox-tasks");
    assert.deepEqual(fs.readdirSync(taskParent), []);
    assert.equal(session._sandboxCommands.diagnostics.retained, false);
    console.log(JSON.stringify({ kind: "session-acceptance", passed: true, actualSandbox: true, project, failure, timeout, cancellationObserved,
        writes: project ? 2 : 0, responses, liveTaskDirectories: 0, root }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
    clearInterval(cancelWatch); clearTimeout(cancelTimer);
    if (session) {
        session.agent.abort(); await session.agent.waitForIdle(); session.dispose();
        await session.waitForSessionLeaseRelease();
    }
}
