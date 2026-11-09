// One real source/read/Agent/apply fixture for the explicit input execution acceptance.
// The producer owns the transferred original capture before any native source acquisition.
import assert from "node:assert/strict";
import { mkdtemp, open, lstat, realpath, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, parse } from "node:path";
import { registerHooks } from "node:module";
import { Type } from "typebox";
import ts from "typescript";
import { Agent } from "../../packages/agent/src/agent.ts";
import { SessionFiles } from "../../packages/coding-agent/src/core/files/session-files.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.ts";
import { wrapToolDefinition } from "../../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { createReadToolDefinition } from "../../packages/coding-agent/src/core/tools/read.ts";
import { createPowerShellToolDefinition } from "../../packages/coding-agent/src/core/tools/powershell.ts";
import { mutationRequestHash } from "../../packages/coding-agent/src/core/files/file-invocation.ts";
import { originalCommittedFileIdentity } from "../../packages/coding-agent/src/core/files/file-commit.ts";
import { originalCreatedFileIdentity } from "../../packages/coding-agent/src/core/files/file-creation.ts";
import { nativeFileDiagnostics, nativeFileRequest, disposeNativeFileWorker } from "../../packages/coding-agent/src/core/files/native-file-client.ts";
import { applyCapturedWrites } from "./windows-sandbox-apply-captured-writes.mjs";
import { INPUT_LIMITS } from "./windows-sandbox-input-snapshot.mjs";
import { WindowsWorkspaceInputCapture } from "./windows-sandbox-workspace-input-capture.mjs";
import { WindowsSourceNative } from "./windows-sandbox-source-native.mjs";

const aliasNames = ["file-invocation", "file-host", "file-batch-protocol", "file-commit", "file-creation", "input-workspace-grant-lease", "session-input-read-permission"];
const aliases = new Map(aliasNames.map(name => [`@super-pi/coding-agent/internal/files/${name}`,
    new URL(`../../packages/coding-agent/src/core/files/${name}.ts`, import.meta.url).href]));
const loadedAliases = new Set(), lifecycleUrl = new URL("../../packages/extensions/resource-lifecycle-guard/index.ts", import.meta.url).href;
const browserManagerUrl = new URL("../../packages/chrome-devtools/src/browser-manager.ts", import.meta.url).href;
const browserRuntimeUrl = new URL("../../packages/chrome-devtools/src/runtime.ts", import.meta.url).href;
let browserRuntime, browserRuntimeResolutions = 0;
let transformed = 0, transformSourceBytes = 0, transformOutputBytes = 0;
const loader = registerHooks({
    resolve(specifier, context, next) {
        if (context.parentURL === browserManagerUrl && specifier === "./runtime.ts") {
            assert.equal(browserRuntimeResolutions++, 0);
            return { url: browserRuntimeUrl, shortCircuit: true };
        }
        const url = aliases.get(specifier);
        if (url) { loadedAliases.add(specifier); return { url, shortCircuit: true }; }
        return next(specifier, context);
    },
    load(url, context, next) {
        const result = next(url, context);
        if (url !== lifecycleUrl) return result;
        assert.equal(transformed++, 0);
        const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
        transformSourceBytes = Buffer.byteLength(source); assert.ok(transformSourceBytes <= 131072);
        const output = ts.transpileModule(source, { fileName: "resource-lifecycle-guard/index.ts",
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: false } }).outputText;
        transformOutputBytes = Buffer.byteLength(output); assert.ok(transformOutputBytes <= 262144);
        return { format: "module", source: output };
    },
});
let lifecycle;
try {
    ({ default: lifecycle } = await import(lifecycleUrl));
    ({ state: browserRuntime } = await import(browserRuntimeUrl));
    assert.equal(browserRuntimeResolutions, 1);
    assert.equal(browserRuntime.managedBrowser, undefined); assert.equal(browserRuntime.launchPromise, undefined);
    const contract = await import("../../packages/extensions/resource-lifecycle-guard/permission-contract.ts");
    assert.equal(contract.mutationRequestHash, mutationRequestHash);
    assert.equal((await import("@super-pi/coding-agent/internal/files/file-commit")).originalCommittedFileIdentity, originalCommittedFileIdentity);
    assert.equal((await import("@super-pi/coding-agent/internal/files/file-creation")).originalCreatedFileIdentity, originalCreatedFileIdentity);
} finally { loader.deregister(); }
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const id = stat => ({ dev: stat.dev, ino: stat.ino });
const loggedId = value => value ? { dev: String(value.dev), ino: String(value.ino) } : null;
const permissionSymbol = Symbol.for("pi.session-permission.path-approval.v2");
const FIXTURE_MODEL = { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
class FixtureStream {
    constructor(phase, withCall) {
        this.message = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture",
            content: withCall ? [{ type: "toolCall", id: `captured-${phase}`, name: "captured_host_fixture", arguments: { phase } }]
                : [{ type: "text", text: "done" }], stopReason: withCall ? "toolUse" : "stop", timestamp: 1,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    }
    async *[Symbol.asyncIterator]() { yield { type: "done", reason: this.message.stopReason, message: this.message }; }
    async result() { return this.message; }
}

export async function runInputHostFixture(produce, taskId, snapshotId, retain) {
    assert.equal(typeof produce, "function");
    assert.equal(typeof retain, "function");
    let root, source, destination, rootNode, sourceNode, newNode, fixtureHandle;
    let runtime, events, owner, session, runner, agent;
    let safe = true, succeeded = false, fixtureOpen = 0, fixtureCloseAttempts = 0, fixtureClosed = 0, fixtureWriteBytes = 0;
    let parentCalls = 0, nestedCalls = 0, batchAttempts = 0, approvals = 0, realReceipts = 0;
    let bootstrap, bootstrapReport, bootstrapDisposeAttempted = false;
    let workerStats, statsAttempted = false, workerRetained = false, lastBatchHash, nativeOwnerClosed = false, boundaryClosed = false, providerOwnersClosed = false;
    const nodes = [], failures = [], weak = [], outcomes = [], preparationFailures = [], readSnapshots = [];
    // Adopt the actual frame before creating any fixture or native resource.
    // Even evidence serialization/output failure cannot lose its original owner.
    const responsibility = {
        get fixtureHandle() { return fixtureHandle; }, get bootstrap() { return bootstrap; },
        get runtime() { return runtime; }, get owner() { return owner; }, get runner() { return runner; },
        get agent() { return agent; }, get session() { return session; }, get events() { return events; },
        nodes, failures,
    };
    retain(responsibility);
    let recordedFactBytes = 0, streamCalls = 0, selectedPhase;
    const childResults = [], parentResults = [];
    function resultFact(result) {
        return valueCopy({ toolCallId: result.toolCallId, toolName: result.toolName, isError: result.isError,
            executionStatus: result.executionStatus, content: result.content, observationFailure: result.observationFailure });
    }
    async function runParent(phase) {
        selectedPhase = phase; const before = streamCalls;
        await agent.prompt(`Run the bounded ${phase} fixture.`);
        const matches = agent.state.messages.filter(message => message.role === "toolResult" && message.toolCallId === `captured-${phase}`);
        parentResults.push(valueCopy({ phase, streamCalls: streamCalls - before, errorMessage: agent.state.errorMessage,
            results: matches.map(resultFact) }));
        assert.equal(matches.length, 1, "Original parent result must be present");
        assert.equal(streamCalls - before, 2, "One fixed intent and one stop response");
        return matches[0];
    }
    function valueCopy(value) {
        if (value === undefined) return undefined;
        const json = JSON.stringify(value); recordedFactBytes += Buffer.byteLength(json);
        assert.ok(recordedFactBytes <= 8192, "Bounded receipt and preparation facts");
        return JSON.parse(json); // Independent values must not retain original receipt keys.
    }
    const workerBefore = nativeFileDiagnostics();
    assert.equal(workerBefore.loaded, false); assert.equal(workerBefore.pending, 0);
    async function closeFixture() {
        if (!fixtureHandle) return;
        fixtureCloseAttempts++;
        try { await fixtureHandle.close(); fixtureClosed++; fixtureHandle = undefined; }
        catch (error) { safe = false; throw error; }
    }
    function observeOriginalReceipts(details) {
        if (!Array.isArray(details?.items)) return;
        assert.ok(details.items.length <= 2);
        for (const item of details.items) {
            const receipt = item.receipt;
            const fact = receipt?.creation ? originalCreatedFileIdentity(receipt.creation)
                : receipt?.commit ? originalCommittedFileIdentity(receipt.commit) : undefined;
            outcomes.push(valueCopy({ itemId: item.itemId, target: item.target, status: item.status, reason: item.reason,
                stateChanged: item.stateChanged, requiresVerification: item.requiresVerification, identity: fact,
                receipt: receipt && { status: receipt.status, category: receipt.category, cause: receipt.cause,
                    stateChanged: receipt.stateChanged, requiresVerification: receipt.requiresVerification,
                    fileCreated: receipt.fileCreated, retryable: receipt.retryable, createdDirectories: receipt.createdDirectories,
                    creation: receipt.creation, commit: receipt.commit } }));
            if (item.status !== "succeeded") safe = false;
            if (!receipt) continue;
            realReceipts++;
            const original = receipt.creation ?? receipt.commit;
            if (item.status !== "succeeded") continue;
            assert.ok(fact && Object.isFrozen(fact));
            const node = fact.path === destination ? newNode : fact.path === source ? sourceNode : undefined;
            assert.ok(node); node.expected = { dev: BigInt(fact.device), ino: BigInt(fact.inode) }; node.issuedIdentity = fact; node.plannedOnly = false;
            weak.push(new WeakRef(original));
        }
    }
    try {
        const parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-input-execution-"));
        rootNode = { path: root, kind: "directory", parent, expected: undefined, removed: false }; nodes.push(rootNode);
        rootNode.expected = id(await lstat(root, { bigint: true }));
        source = join(root, "source.txt"); destination = join(root, "new.txt");
        sourceNode = { path: source, kind: "file", parent: root, expected: undefined, removed: false }; nodes.push(sourceNode);
        fixtureHandle = await open(source, "wx"); fixtureOpen++;
        try { sourceNode.expected = id(await fixtureHandle.stat({ bigint: true })); sourceNode.initialIdentity = { ...sourceNode.expected }; await fixtureHandle.writeFile("alpha"); fixtureWriteBytes += 5; }
        finally { await closeFixture(); }
        newNode = { path: destination, kind: "file", parent: root, expected: undefined, plannedOnly: true, removed: false }; nodes.push(newNode);
        console.log(JSON.stringify({ root, rootIdentity: loggedId(rootNode.expected), source, originalSourceIdentity: loggedId(sourceNode.expected), plannedNew: destination }));
        events = createEventBus(); runtime = createExtensionRuntime(); owner = runtime.nativeFiles = new SessionFiles(runtime, events);
        session = SessionManager.inMemory(root);
        const extension = await loadExtensionFromFactory(lifecycle, root, events, runtime, "<captured-host-original-permission>");
        assert.equal(owner.requiresPermission, true);
        runner = new ExtensionRunner([extension], runtime, root, session, {});
        const definitions = { read: createReadToolDefinition(root), powershell: createPowerShellToolDefinition(root) }; owner.install(definitions);
        definitions.captured_host_fixture = { name: "captured_host_fixture", label: "captured host fixture", description: "Bounded acceptance parent",
            parameters: Type.Object({ phase: Type.String({ enum: ["input"] }) }, { additionalProperties: false }),
            orchestration: true, executionMode: "sequential",
            async execute(_id, input, _signal, _update, _ctx, execution) {
                assert.ok(execution); parentCalls++; assert.ok(parentCalls <= 1);
                const read = await execution.callTool("read", { path: "source.txt" });
                childResults.push(resultFact(read)); assert.equal(read.isError, false);
                const text = read.content.filter(item => item.type === "text").map(item => item.text).join("\n");
                const match = /snapshot=(snap_[A-Za-z0-9_-]{22})/.exec(text); assert.ok(match);
                assert.equal(owner.hasRevision(match[1], source, session.getSessionId()), true);
                readSnapshots.push({ phase: input.phase, snapshot: match[1] });
                const pinned = owner.pinReadRevisions(_ctx);
                let capturedInput;
                try {
                    const revisions = pinned.revisions, original = revisions.get(match[1]); assert.ok(original);
                    capturedInput = { taskId, snapshotId, sessionId: session.getSessionId(), epoch: revisions.generation,
                        sourceRoot: { path: root, identity: { ...rootNode.expected } }, budget: { ...INPUT_LIMITS },
                        entries: [{ path: "source.txt", classification: "ordinary", expose: true, operation: "modify", parents: [],
                            revision: match[1], identity: { dev: original.identity.dev, ino: original.identity.ino,
                                size: original.identity.size, mtimeNs: original.identity.mtimeNs, ctimeNs: original.identity.ctimeNs },
                            sha256: original.sha256 }] };
                } finally { pinned.dispose(); }
                const drive = parse(root).root, driveIdentity = id(await lstat(drive, { bigint: true }));
                bootstrap = new WindowsSourceNative();
                let volumePath;
                try { volumePath = bootstrap.volumeForDrive(drive); }
                finally { bootstrapDisposeAttempted = true; bootstrap.dispose(); bootstrapReport = bootstrap.diagnostics; bootstrap = undefined; }
                let captured = new WindowsWorkspaceInputCapture(capturedInput, { drive, volumePath, identity: driveIdentity }, owner, _ctx);
                // produce takes sole cleanup responsibility synchronously, before
                // its first await/capture. This frame only borrows until transfer.
                // Trusted original invocation arguments, not a serialized permission.
                // The fixture supplies tool identity; it does not authorize a future
                // production command coordinator on behalf of a real user.
                const pending = produce(captured, match[1], Object.freeze({ owner, runtime, ctx: _ctx, execution, parentToolCallId: _id, signal: _signal }));
                captured = undefined; capturedInput = undefined;
                const produced = await pending;
                const result = await applyCapturedWrites(produced.candidate, execution, produced.binding);
                childResults.push(resultFact(result));
                return { content: [{ type: "text", text: result.isError ? "Captured write rejected" : "Captured write completed" }],
                    details: { phase: input.phase, childIsError: result.isError }, isError: result.isError };
            },
        };
        const wrappers = new Map();
        agent = new Agent({ initialState: { model: FIXTURE_MODEL }, streamFn() {
                assert.ok(streamCalls < 2); assert.equal(selectedPhase, "input");
                return new FixtureStream(selectedPhase, streamCalls++ % 2 === 0);
            },
            async beforeToolCall({ toolCall, args, context, parentToolCallId, nestedIssuedAt }) {
                if (parentToolCallId) { nestedCalls++; assert.ok(nestedCalls <= 2); }
                if (toolCall.name === "file_batch") batchAttempts++;
                const definition = definitions[toolCall.name];
                assert.equal(context.tools.find(tool => tool.name === toolCall.name)?.execute, wrappers.get(toolCall.name)?.execute);
                let decision;
                try { decision = await runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, parentToolCallId, nestedIssuedAt, input: args }, definition); }
                catch (error) {
                    if (toolCall.name === "file_batch") {
                        assert.ok(preparationFailures.length < 2);
                        preparationFailures.push(valueCopy({ toolCallId: toolCall.id, parentToolCallId,
                            requestHash: mutationRequestHash("file_batch", args), snapshot: args.operations[1]?.snapshot,
                            target: args.operations[1]?.path, reason: error instanceof Error ? error.message : String(error) }));
                    }
                    throw error;
                }
                if (toolCall.name === "file_batch" && !decision?.block) {
                    const approval = Object.getOwnPropertyDescriptor(args, permissionSymbol)?.value;
                    assert.ok(approval && typeof approval.assertCurrent === "function" && decision.finalAuthorization);
                    assert.equal(approval.requestHash, mutationRequestHash("file_batch", args));
                    assert.equal(owner.getDiagnostics().pending, 1); approvals++; lastBatchHash = approval.requestHash;
                }
                return decision;
            },
            async afterToolCall({ toolCall, args, result, isError, parentToolCallId }) {
                if (toolCall.name === "file_batch") observeOriginalReceipts(result.details);
                return runner.emitToolResult({ type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, parentToolCallId,
                    input: args, content: result.content, details: result.details, isError });
            },
        });
        runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => agent.state.tools.map(tool => tool.name),
            getAllTools: () => Object.values(definitions), appendEntry: (kind, data) => { assert.ok(session.getBranch().length < 64); session.appendCustomEntry(kind, data); } },
            { getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => undefined,
                isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false });
        for (const definition of Object.values(definitions)) wrappers.set(definition.name, wrapToolDefinition(definition, () => runner.createContext()));
        agent.state.tools = [...wrappers.values()];
        await runner.emit({ type: "session_start" });
        const success = await runParent("input");
        assert.equal(success.isError, false); assert.equal(realReceipts, 2); assert.equal(approvals, 1);
        assert.equal(preparationFailures.length, 0); assert.equal(readSnapshots.length, 1);
        for (const [path, text] of [[source, "alpha-guest\r\n"], [destination, "derived:alpha\r\n"]]) {
            const bytes = await readFile(path); try { assert.equal(bytes.toString(), text); } finally { bytes.fill(0); }
        }
        const progress = session.getBranch().filter(entry => entry.type === "custom" && entry.customType === "file-mutation-progress-v2");
        assert.equal(progress.length, 6); assert.ok(progress.every(entry => entry.data.requestHash === lastBatchHash));
        assert.equal(owner.getDiagnostics().pending, 0); assert.equal(owner.getDiagnostics().inFlight, 0);
        assert.equal(owner.getDiagnostics().revisions, 0);
        statsAttempted = true; workerStats = await nativeFileRequest("stats"); assert.equal(workerStats.activeHandles, 0); assert.equal(workerStats.activeDescriptors, 0);
        assert.ok(workerStats.calls <= 128 && workerStats.publicationAttempts <= 1);
        succeeded = true;
    } catch (error) { failures.push(error); safe = false; }
    finally {
        if (fixtureHandle || bootstrap) safe = false;
        try {
            await agent?.waitForIdle();
            if (runner) await runner.emit({ type: "session_shutdown" }); else await owner?.dispose();
            nativeOwnerClosed = !owner || owner.getDiagnostics().closed;
            if (runtime) { await runtime.executionBoundary.dispose(); boundaryClosed = runtime.executionBoundary.participantCount === 0; await runtime.disposeProviderOwners(); providerOwnersClosed = true; }
            runner?.invalidate("captured host fixture closed", true); events?.clear();
            agent?.reset(); if (agent) agent.state.tools = [];
            session?.newSession();
        } catch (error) { failures.push(error); safe = false; }
        const beforeDispose = nativeFileDiagnostics();
        if (beforeDispose.loaded && !statsAttempted && beforeDispose.pending === 0 && !beforeDispose.failed) {
            statsAttempted = true;
            try { workerStats = await nativeFileRequest("stats"); } catch (error) { failures.push(error); safe = false; }
        }
        if (beforeDispose.pending !== 0 || beforeDispose.loaded
            && (beforeDispose.failed || workerStats?.activeHandles !== 0 || workerStats?.activeDescriptors !== 0)) {
            safe = false; workerRetained = beforeDispose.loaded; // Never terminate to conceal unresolved native ownership.
        } else try { await disposeNativeFileWorker(); } catch (error) { failures.push(error); safe = false; workerRetained = true; }
        if (safe) for (let index = nodes.length - 1; index >= 0; index--) {
            const node = nodes[index];
            try {
                assert.ok(node.expected);
                const current = await lstat(node.path, { bigint: true });
                assert.ok(same(current, node.expected) && !current.isSymbolicLink());
                assert.equal(node.kind === "file" ? current.isFile() : current.isDirectory(), true);
                assert.equal(dirname(resolve(node.path)), node.parent); assert.equal(await realpath(node.path), node.path);
                if (index > 0) assert.ok(same(await lstat(root, { bigint: true }), rootNode.expected));
                if (node.kind === "file") await unlink(node.path); else await rmdir(node.path);
                node.removed = true; await assert.rejects(lstat(node.path), { code: "ENOENT" });
            } catch (error) { failures.push(error); safe = false; break; }
        }
    }
    const worker = nativeFileDiagnostics();
    const evidence = { succeeded, safe, nodes: nodes.map(node => ({ ...node, expected: loggedId(node.expected), initialIdentity: loggedId(node.initialIdentity) })),
        fixtureOpen, fixtureCloseAttempts, fixtureClosed, fixtureWriteBytes, retainedFixtureHandle: !!fixtureHandle,
        parentCalls, nestedCalls, batchAttempts, approvals, realReceipts,
        nativeOwnerClosed, boundaryClosed, providerOwnersClosed, statsAttempted, workerRetained, workerStats,
        workerStartsDelta: worker.workerStarts - workerBefore.workerStarts, workerCallsDelta: worker.calls - workerBefore.calls,
        workerLoaded: worker.loaded, workerPending: worker.pending, outcomes, preparationFailures, readSnapshots, recordedFactBytes,
        streamCalls, childResults, parentResults, browserRuntimeResolutions, transformed, transformSourceBytes, transformOutputBytes,
        bootstrapDisposeAttempted, bootstrapReport, managedBrowserHeld: !!browserRuntime.managedBrowser,
        browserLaunchPending: !!browserRuntime.launchPromise, implicitNodeOsIoFullyInstrumented: false,
        errors: failures.map(error => String(error).slice(0, 400)) };
    const line = JSON.stringify(evidence); assert.ok(Buffer.byteLength(line) <= 12288); console.log(line);
    const summary = { succeeded, safe, root, rootRemoved: rootNode?.removed ?? false,
        parentCalls, nestedCalls, batchAttempts, approvals, realReceipts, fixtureOpen, fixtureClosed, fixtureWriteBytes,
        nativeOwnerClosed, boundaryClosed, providerOwnersClosed, workerRetained, workerLoaded: worker.loaded, workerPending: worker.pending,
        workerCallsDelta: worker.calls - workerBefore.calls, evidenceBytes: Buffer.byteLength(line) + 1 };
    const passed = failures.length === 0 && safe && succeeded && nodes.length === 3 && nodes.every(node => node.removed)
        && fixtureOpen === 1 && fixtureCloseAttempts === 1 && fixtureClosed === 1 && fixtureWriteBytes === 5
        && parentCalls === 1 && nestedCalls === 2 && batchAttempts === 1 && approvals === 1 && realReceipts === 2
        && streamCalls === 2 && childResults.length === 2 && parentResults.length === 1 && weak.length === 2
        && !workerRetained && worker.workerStarts - workerBefore.workerStarts === 1 && !worker.loaded && worker.pending === 0
        && worker.calls - workerBefore.calls <= 128 && nativeOwnerClosed && boundaryClosed && providerOwnersClosed
        && transformed === 1 && browserRuntimeResolutions === 1 && !browserRuntime.managedBrowser && !browserRuntime.launchPromise;
    const unresolved = nodes.some(node => !node.removed) || fixtureHandle || bootstrap || workerRetained
        || !nativeOwnerClosed || !boundaryClosed || !providerOwnersClosed;
    const retained = unresolved ? responsibility : undefined;
    retain(retained);
    return { passed, summary, weak, retained };
}
