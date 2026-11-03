// New source-resolution acceptance after the preserved §61 import failure.
// Actual installed native-file execution with synthetic captured candidates; no Sandbox/guest claim.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, lstat, realpath, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { Type } from "typebox";
import ts from "typescript";
import { Agent } from "../packages/agent/src/agent.ts";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../packages/coding-agent/src/core/extensions/runner.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { createReadToolDefinition } from "../packages/coding-agent/src/core/tools/read.ts";
import { mutationRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";
import { originalCommittedFileIdentity } from "../packages/coding-agent/src/core/files/file-commit.ts";
import { originalCreatedFileIdentity } from "../packages/coding-agent/src/core/files/file-creation.ts";
import { nativeFileDiagnostics, nativeFileRequest, disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { CapturedCandidateOwner, CAPTURE_PROTOCOL, REQUEST_PROTOCOL } from "../scripts/acceptance/windows-sandbox-volume-candidate-contract.mjs";
import { CANDIDATE_PROTOCOL, CANDIDATE_LIMITS } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
import { applyCapturedWrites } from "../scripts/acceptance/windows-sandbox-apply-captured-writes.mjs";

const aliasNames = ["file-invocation", "file-host", "file-batch-protocol", "file-commit", "file-creation", "input-workspace-grant-lease", "session-input-read-permission"];
const aliases = new Map(aliasNames.map(name => [`@super-pi/coding-agent/internal/files/${name}`,
    new URL(`../packages/coding-agent/src/core/files/${name}.ts`, import.meta.url).href]));
const loadedAliases = new Set(), lifecycleUrl = new URL("../packages/extensions/resource-lifecycle-guard/index.ts", import.meta.url).href;
const browserManagerUrl = new URL("../packages/chrome-devtools/src/browser-manager.ts", import.meta.url).href;
const browserRuntimeUrl = new URL("../packages/chrome-devtools/src/runtime.ts", import.meta.url).href;
let browserRuntime, browserRuntimeResolutions = 0;
let transformed = 0, transformSourceBytes = 0, transformOutputBytes = 0;
const loader = registerHooks({
    resolve(specifier, context, next) {
        if (context.parentURL === browserManagerUrl && specifier === "./runtime.js") {
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
    const contract = await import("../packages/extensions/resource-lifecycle-guard/permission-contract.ts");
    assert.equal(contract.mutationRequestHash, mutationRequestHash);
    assert.equal((await import("@super-pi/coding-agent/internal/files/file-commit")).originalCommittedFileIdentity, originalCommittedFileIdentity);
    assert.equal((await import("@super-pi/coding-agent/internal/files/file-creation")).originalCreatedFileIdentity, originalCreatedFileIdentity);
} finally { loader.deregister(); }
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const id = stat => ({ dev: stat.dev, ino: stat.ino });
const loggedId = value => value ? { dev: String(value.dev), ino: String(value.ino) } : null;
const permissionSymbol = Symbol.for("pi.session-permission.path-approval.v2");

async function exercise() {
    let root, source, destination, rootNode, sourceNode, newNode, fixtureHandle;
    let runtime, events, owner, session, runner, agent;
    let safe = true, succeeded = false, fixtureOpen = 0, fixtureCloseAttempts = 0, fixtureClosed = 0, fixtureWriteBytes = 0;
    let parentCalls = 0, nestedCalls = 0, batchAttempts = 0, approvals = 0, realReceipts = 0, captures = 0, modelAllocated = 0, modelCleared = 0;
    let workerStats, statsAttempted = false, workerRetained = false, lastBatchHash, nativeOwnerClosed = false, boundaryClosed = false, providerOwnersClosed = false;
    const nodes = [], failures = [], weak = [], outcomes = [], preparationFailures = [], readSnapshots = [], capturesLive = new Set();
    let recordedFactBytes = 0;
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
    async function modelCandidate(revision, execution) {
        assert.ok(captures < 2); captures++;
        const taskId = `11111111-2222-3333-4444-${String(captures).padStart(12, "0")}`;
        const snapshotId = `22222222-3333-4444-5555-${String(captures).padStart(12, "0")}`;
        const binding = { taskId, snapshotId, instanceId: "33333333-4444-5555-6666-777777777777",
            volumePath: "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId: "AABBCCDD:0000000000000001" };
        const allowed = [{ path: "new.txt", operation: "add", revision: null }, { path: "source.txt", operation: "modify", revision }];
        const buffers = [];
        const own = bytes => { buffers.push(bytes); modelAllocated += bytes.length; assert.ok(modelAllocated <= 16384); return bytes; };
        const encode = value => own(Buffer.from(JSON.stringify(value)));
        const capture = new CapturedCandidateOwner({ ...binding, budget: { ...CANDIDATE_LIMITS }, allowed }); capturesLive.add(capture);
        try {
            const raw = encode({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId, candidates: allowed.map(({ path, operation }) => ({ path, operation })), report: { exitCode: 0 } });
            const manifestCarrier = "11223344:0000000000000001", batchCarrier = "11223344:0000000000000002";
            capture.acceptManifest(raw, encode({ protocol: CAPTURE_PROTOCOL, stage: "manifest", taskId,
                volumePath: binding.volumePath, exchangeId: binding.exchangeId, carrierId: manifestCarrier,
                bytes: raw.length, sha256: hash(raw), sourceId: "AABBCCDD:0000000000000002",
                handles: { opened: 3, closed: 3, peak: 2, closeUnknown: false, retained: [] } }), manifestCarrier);
            const request = encode({ protocol: REQUEST_PROTOCOL, taskId, manifestSha256: hash(raw), paths: allowed.map(item => item.path) });
            const chunks = [own(Buffer.from("new\r\n")), own(Buffer.from("next\r\n"))], payload = own(Buffer.concat(chunks));
            capture.acceptBatch(payload, encode({ protocol: CAPTURE_PROTOCOL, stage: "batch", taskId,
                volumePath: binding.volumePath, exchangeId: binding.exchangeId, carrierId: batchCarrier,
                bytes: payload.length, sha256: hash(payload), requestSha256: hash(request),
                items: chunks.map((bytes, index) => ["AABBCCDD:" + BigInt(index + 3).toString(16).toUpperCase().padStart(16, "0"), bytes.length, hash(bytes)]),
                handles: { opened: 8, closed: 8, peak: 4, closeUnknown: false, retained: [] } }), batchCarrier);
            return await applyCapturedWrites(capture, execution, binding);
        } finally {
            capture.dispose(); capturesLive.delete(capture);
            assert.equal(capture.diagnostics.retainedPayloadBytes, 0); assert.equal(capture.diagnostics.retainedContext, false);
            for (const bytes of buffers) { bytes.fill(0); modelCleared += bytes.length; }
        }
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
            const lookup = receipt.creation ? originalCreatedFileIdentity : originalCommittedFileIdentity;
            if (item.status !== "succeeded") continue;
            assert.ok(fact && Object.isFrozen(fact));
            const node = fact.path === destination ? newNode : fact.path === source ? sourceNode : undefined;
            assert.ok(node); node.expected = { dev: BigInt(fact.device), ino: BigInt(fact.inode) }; node.issuedIdentity = fact; node.plannedOnly = false;
            for (const copy of [{ ...original }, JSON.parse(JSON.stringify(original)), Object.create(original), new Proxy(original, {})]) assert.equal(lookup(copy), undefined);
            weak.push(new WeakRef(original));
        }
    }
    try {
        const parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-captured-host-"));
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
        const definitions = { read: createReadToolDefinition(root) }; owner.install(definitions);
        definitions.captured_host_fixture = { name: "captured_host_fixture", label: "captured host fixture", description: "Bounded acceptance parent",
            parameters: Type.Object({ phase: Type.String({ enum: ["stale", "success"] }) }, { additionalProperties: false }),
            orchestration: true, executionMode: "sequential",
            async execute(_id, input, _signal, _update, _ctx, execution) {
                assert.ok(execution); parentCalls++; assert.ok(parentCalls <= 2);
                const read = await execution.callTool("read", { path: "source.txt" }); assert.equal(read.isError, false);
                const text = read.content.filter(item => item.type === "text").map(item => item.text).join("\n");
                const match = /snapshot=(snap_[A-Za-z0-9_-]{22})/.exec(text); assert.ok(match);
                assert.equal(owner.hasRevision(match[1], source, session.getSessionId()), true);
                readSnapshots.push({ phase: input.phase, snapshot: match[1] });
                if (input.phase === "stale") {
                    fixtureHandle = await open(source, "r+"); fixtureOpen++;
                    try { assert.ok(same(await fixtureHandle.stat({ bigint: true }), sourceNode.expected)); await fixtureHandle.truncate(0); await fixtureHandle.writeFile("beta"); fixtureWriteBytes += 4; }
                    finally { await closeFixture(); }
                }
                const result = await modelCandidate(match[1], execution);
                return { content: [{ type: "text", text: result.isError ? "Captured write rejected" : "Captured write completed" }],
                    details: { phase: input.phase, childIsError: result.isError }, isError: result.isError };
            },
        };
        const wrappers = new Map();
        agent = new Agent({ streamFn() { throw new Error("No provider in host acceptance"); },
            async beforeToolCall({ toolCall, args, context, parentToolCallId, nestedIssuedAt }) {
                if (parentToolCallId) { nestedCalls++; assert.ok(nestedCalls <= 4); }
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
        const failed = await agent.dispatchHostTool({ type: "toolCall", id: "captured-stale", name: "captured_host_fixture", arguments: { phase: "stale" } });
        assert.equal(failed.isError, true); assert.equal(realReceipts, 0); assert.equal(approvals, 0);
        assert.equal(preparationFailures.length, 1);
        const rejection = preparationFailures[0];
        assert.equal(rejection.parentToolCallId, "captured-stale"); assert.equal(rejection.target, "source.txt");
        assert.equal(readSnapshots.length, 1); assert.equal(rejection.snapshot, readSnapshots[0].snapshot);
        assert.ok(rejection.reason.startsWith(`${rejection.toolCallId}:1: [SNAPSHOT_EDIT_STALE] Source changed or is unavailable. No change.`));
        assert.ok(rejection.reason.endsWith("Preflight failed; no batch item executed."));
        await assert.rejects(lstat(destination), { code: "ENOENT" });
        const staleBytes = await readFile(source); try { assert.equal(staleBytes.toString(), "beta"); } finally { staleBytes.fill(0); }
        const success = await agent.dispatchHostTool({ type: "toolCall", id: "captured-success", name: "captured_host_fixture", arguments: { phase: "success" } });
        assert.equal(success.isError, false); assert.equal(realReceipts, 2); assert.equal(approvals, 1);
        assert.equal(preparationFailures.length, 1); assert.equal(readSnapshots.length, 2);
        assert.notEqual(readSnapshots[0].snapshot, readSnapshots[1].snapshot);
        for (const [path, text] of [[source, "next\r\n"], [destination, "new\r\n"]]) {
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
        if (fixtureHandle) safe = false;
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
    console.log(JSON.stringify({ succeeded, safe, nodes: nodes.map(node => ({ ...node, expected: loggedId(node.expected), initialIdentity: loggedId(node.initialIdentity) })),
        fixtureOpen, fixtureCloseAttempts, fixtureClosed, fixtureWriteBytes, retainedFixtureHandle: !!fixtureHandle,
        parentCalls, nestedCalls, batchAttempts, approvals, realReceipts, captures, modelAllocated, modelCleared, capturesLive: capturesLive.size,
        nativeOwnerClosed, boundaryClosed, providerOwnersClosed, statsAttempted, workerRetained, workerStats, workerStartsDelta: worker.workerStarts - workerBefore.workerStarts,
        workerCallsDelta: worker.calls - workerBefore.calls, workerLoaded: worker.loaded, workerPending: worker.pending,
        outcomes, preparationFailures, readSnapshots, recordedFactBytes, browserRuntimeResolutions,
        managedBrowserHeld: !!browserRuntime.managedBrowser, browserLaunchPending: !!browserRuntime.launchPromise, transformed, transformSourceBytes, transformOutputBytes, aliases: [...loadedAliases],
        guestExecutions: 0, implicitNodeOsIoFullyInstrumented: false, errors: failures.map(error => String(error).slice(0, 800)) }));
    if (failures.length) throw new AggregateError(failures, "Captured host integration or cleanup");
    assert.ok(safe && succeeded && nodes.length === 3 && nodes.every(node => node.removed));
    assert.equal(fixtureOpen, 2); assert.equal(fixtureCloseAttempts, 2); assert.equal(fixtureClosed, 2); assert.equal(fixtureWriteBytes, 9);
    assert.equal(parentCalls, 2); assert.equal(nestedCalls, 4); assert.equal(batchAttempts, 2); assert.equal(captures, 2);
    assert.equal(modelAllocated, modelCleared); assert.equal(capturesLive.size, 0); assert.equal(weak.length, 2);
    assert.equal(workerRetained, false); assert.equal(worker.workerStarts - workerBefore.workerStarts, 1); assert.equal(worker.loaded, false); assert.equal(worker.pending, 0);
    assert.ok(worker.calls - workerBefore.calls <= 128); assert.ok(nativeOwnerClosed && boundaryClosed && providerOwnersClosed);
    assert.equal(transformed, 1); assert.equal(browserRuntimeResolutions, 1);
    assert.equal(browserRuntime.managedBrowser, undefined); assert.equal(browserRuntime.launchPromise, undefined);
    return weak;
}
test("resolved original source dependencies allow actual installed permission and native writes with original-object cleanup evidence", async () => {
    assert.equal(typeof globalThis.gc, "function");
    const weak = await exercise();
    for (let round = 0; round < 4; round++) { await tick(); globalThis.gc(); await tick(); }
    const live = weak.filter(value => value.deref() !== undefined).length;
    console.log(JSON.stringify({ gcRounds: 4, originalReceiptTargets: weak.length, liveTargets: live }));
    assert.equal(live, 0);
});
