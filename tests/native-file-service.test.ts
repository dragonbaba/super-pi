import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { FileService, type FileExecutionHooks } from "../packages/coding-agent/src/core/files/file-service.ts";
import { issueSnapshotForRead } from "../packages/coding-agent/src/core/files/snapshot-line-edit.ts";
import { createReadToolDefinition } from "../packages/coding-agent/src/core/tools/read.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { getSessionFiles, NATIVE_FILE_REVISION } from "../packages/coding-agent/src/core/files/file-host.ts";
import { attachPermissionPathApproval, mutationRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import type { ExtensionContext, ToolDefinition, ToolCallEvent } from "../packages/coding-agent/src/core/extensions/types.ts";

test("committed postimage buffers are released on clear, failed observation and disposal", async t => {
  const inspector = new InspectorSession(); inspector.connect(); t.after(() => inspector.disconnect());
  async function exercise() {
    const f = await fixture(t), references: WeakRef<Buffer>[] = [];
    for (const mode of ["clear", "failed-observation", "dispose"]) {
      const receipt = await f.service.execute(await f.service.prepare("write", {
        path: mode, content: "x".repeat(128 * 1024),
      }), mode, f.hooks);
      assert.equal(receipt.revisionContinuation, "available");
      const revision = f.service.revisions.get(receipt.revision as string)!;
      assert.equal(revision.mode, "full");
      if (revision.mode === "full") references.push(new WeakRef(revision.bytes));
      if (mode === "clear") f.service.revisions.clear();
      else if (mode === "failed-observation") f.service.revisions.forgetContinuations(mode);
      else f.service.dispose();
      assert.equal(f.service.revisions.size, 0);
      assert.equal(f.service.revisions.residentBytes, 0);
    }
    return references;
  }
  const references = await exercise();
  for (let index = 0; index < 4; index++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
  assert.equal(references.filter(reference => reference.deref()).length, 0);
  t.diagnostic(JSON.stringify({ ownedPostimages: references.length, liveAfterClearFailureDisposal: 0 }));
});

async function fixture(t: test.TestContext) {
  const parent = await realpath(tmpdir()), cwd = await mkdtemp(join(parent, "sp-file-service-"));
  const service = new FileService(cwd, "session");
  t.after(async () => { service.dispose(); await disposeNativeFileWorker(); assert.equal(dirname(cwd), parent); await rm(cwd, { recursive: true }); });
  const entries: Record<string, unknown>[] = [];
  const hooks: FileExecutionHooks = { assertCurrent() {}, record(entry) { entries.push(entry); } };
  async function capture(path: string) {
    const result = await createReadToolDefinition(cwd).execute("read", { path }, undefined, undefined, {} as never);
    const annotation = await issueSnapshotForRead("session", cwd, { path }, result, service.revisions);
    assert.ok(annotation);
    const snapshot = /snapshot=(snap_[\w-]+)/u.exec(annotation)![1];
    const first = result.content[0]; assert.equal(first.type, "text");
    return { snapshot, anchor: /^(1#[A-F0-9]{4})\|/u.exec(first.text)?.[1] };
  }
  return { service, cwd, entries, hooks, capture };
}

test("native file owner releases prepared, approved, revoked and resetting invocations", { timeout: 15_000 }, async t => {
  const inspector = new InspectorSession(); inspector.connect(); t.after(() => inspector.disconnect());
  const parent = await realpath(tmpdir()), cwd = await mkdtemp(join(parent, "sp-file-owner-"));
  t.after(async () => { await disposeNativeFileWorker(); assert.equal(dirname(cwd), parent); await rm(cwd, { recursive: true }); });
  async function exercise() {
    const runtime = createExtensionRuntime(), events = createEventBus();
    const manager = SessionManager.inMemory(cwd);
    let records = 0; runtime.appendEntry = () => { records++; };
    runtime.appendFileEntry = (kind, data) => { records++; return manager.appendCustomEntry(kind, data); };
    const owner = runtime.nativeFiles = new SessionFiles(runtime, events);
    const ctx = { cwd, sessionManager: manager } as unknown as ExtensionContext;
    const tools: Record<string, ToolDefinition<any, any>> = { read: createReadToolDefinition(cwd) };
    owner.install(tools);
    const refs: WeakRef<object>[] = [new WeakRef(owner), new WeakRef(runtime), new WeakRef(ctx), new WeakRef(tools), new WeakRef(events)];
    assert.equal(getSessionFiles({ events }), owner);
    assert.equal(owner.hasHandlers("tool_result"), false, "cleanup must not disable immutable Evidence Ledger admission");
    assert.equal(owner.ownsDefinition(tools.write), true);
    assert.equal(owner.ownsDefinition({ ...tools.write }), false, "custom definitions do not inherit native authority");
    async function prepare(id: string, input: Record<string, unknown>, name = "write") {
      const invocation = (await owner.prepareInvocation({ type: "tool_call", toolCallId: id, toolName: name, input } as ToolCallEvent, ctx))!;
      refs.push(new WeakRef(invocation), new WeakRef(input)); return invocation;
    }
    async function run(id: string, input: Record<string, unknown>, name = "write") {
      manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], timestamp: 0 } as any);
      const invocation = await prepare(id, input, name), approved = invocation.consume(input, id, name);
      const result = await tools[name].execute(id, approved, undefined, undefined, ctx);
      refs.push(new WeakRef(approved as object), new WeakRef(result)); return result;
    }
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    try {
      assert.equal((await run("create", { path: "a.txt", content: "source\n" })).isError, false);
      const read = await tools.read.execute("read", { path: "a.txt" }, undefined, undefined, ctx);
      const revision = (read as unknown as { [NATIVE_FILE_REVISION]: string })[NATIVE_FILE_REVISION];
      const canonical = await realpath(join(cwd, "a.txt"));
      assert.equal(owner.hasRevision(revision, canonical, manager.getSessionId()), true);
      assert.equal(owner.getDiagnostics().revisions, 1);
      assert.equal((await run("edit", { path: "a.txt", edits: [{ oldText: "source", newText: "changed" }] }, "edit")).isError, false);
      assert.equal(owner.hasRevision(revision, canonical, manager.getSessionId()), false, "a cached display cannot outlive its native file revision");
      const changed = { path: "tampered.txt", content: "before" }, pending = await prepare("tamper", changed);
      changed.content = "after"; assert.throws(() => pending.consume(changed, "tamper", "write"), /STALE_STATE/);
      const abandoned = { path: "abandoned.txt", content: "x" }, abandonedCall = await prepare("abandon", abandoned);
      abandonedCall.release(); assert.throws(() => abandonedCall.consume(abandoned, "abandon", "write"), /STALE_STATE/);
      const aborted = { path: "abort.txt", content: "x" }, abortCall = await prepare("abort", aborted), controller = new AbortController();
      controller.abort(); assert.throws(() => abortCall.consume(aborted, "abort", "write", controller.signal));
      owner.setCompatibilityBoundary({ authorizeFileObservation: async () => Object.assign(async () => {}, { assertCurrent() {} }) });
      const denied = { path: "denied.txt", content: "x" }, deniedCall = await prepare("denied", denied);
      assert.throws(() => deniedCall.consume(denied, "denied", "write"), /POLICY_BLOCKED/);
      const revoked = { path: "revoked.txt", content: "x" }, revokedCall = await prepare("revoked", revoked);
      let valid = true;
      attachPermissionPathApproval(revoked, { schemaVersion: 1, sequence: 1, toolCallId: "revoked", operation: "write", requestHash: mutationRequestHash("write", revoked), canonicalTarget: join(cwd, "revoked.txt"), protectedRoots: [], assertCurrent() { if (!valid) throw new Error("revoked boundary"); } });
      const approved = revokedCall.consume(revoked, "revoked", "write"); valid = false;
      await assert.rejects(tools.write.execute("revoked", approved, undefined, undefined, ctx), /revoked boundary/);
      assert.deepEqual(owner.getDiagnostics(), { pending: 0, inFlight: 0, revisions: 1, closed: false });
      let resume!: () => void;
      const gatedRead = createReadToolDefinition(cwd);
      gatedRead.execute = async () => { await new Promise<void>(resolve => { resume = resolve; }); return { content: [], details: undefined }; };
      const gated: Record<string, ToolDefinition<any, any>> = { read: gatedRead };
      owner.install(gated);
      for (const kind of ["session", "boundary"]) {
        const reading = gated.read.execute("gated", { path: "a.txt" }, undefined, undefined, ctx);
        const rejected = assert.rejects(reading, /STALE_STATE|EXECUTION_BOUNDARY_CHANGED/);
        if (kind === "session") {
          const reset = owner.emit({ type: "session_before_switch" }), concurrent = owner.emit({ type: "session_before_tree" });
          resume(); await Promise.all([reset, concurrent, rejected]);
        } else {
          const input = { path: "obsolete.txt", content: "x" }, obsolete = await prepare("obsolete", input);
          let published = false;
          const transition = runtime.executionBoundary.transition(() => { published = true; });
          assert.throws(() => obsolete.consume(input, "obsolete", "write"), /EXECUTION_BOUNDARY_CHANGED/);
          await assert.rejects(gated.read.execute("blocked", { path: "a.txt" }, undefined, undefined, ctx), /EXECUTION_BOUNDARY_CHANGED/);
          assert.equal(published, false, "publication must wait for the actual read owner");
          resume(); await Promise.all([transition, rejected]); assert.equal(published, true);
          assert.deepEqual(owner.getDiagnostics(), { pending: 0, inFlight: 0, revisions: 0, closed: false });
        }
      }
      const readOnly: Record<string, ToolDefinition<any, any>> = { read: createReadToolDefinition(cwd) }; owner.install(readOnly, false);
      const plain = await readOnly.read.execute("plain", { path: "a.txt" }, undefined, undefined, ctx);
      assert.equal(plain.content.length, 1); assert.equal(owner.getDiagnostics().revisions, 0);
      assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "changed\n");
      for (const path of ["tampered", "abandoned", "abort", "denied", "revoked", "obsolete"]) await assert.rejects(stat(join(cwd, `${path}.txt`)), { code: "ENOENT" });
      await owner.dispose(); runtime.invalidate();
      await runtime.executionBoundary.dispose();
      assert.equal(runtime.executionBoundary.participantCount, 0);
      assert.equal(getSessionFiles({ events }), undefined);
      assert.deepEqual(owner.getDiagnostics(), { pending: 0, inFlight: 0, revisions: 0, closed: true });
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      let sampled = 0; const nodes = [profile.head];
      while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
      return { refs, sampled, records };
    } finally { await owner.dispose(); runtime.invalidate(); }
  }
  const { refs, sampled, records } = await exercise();
  assert.ok(sampled <= 16 * 1024 * 1024, "bounded owner allocation for eight invocations and five read attempts");
  for (let index = 0; index < 4; index++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
  assert.equal(refs.filter(ref => ref.deref()).length, 0);
  t.diagnostic(JSON.stringify({ invocations: 8, completed: 2, readAttempts: 5, transitions: 1, records, references: refs.length, live: 0, sampledMainThreadBytes: sampled, pending: 0, inFlight: 0 }));
});

test("native file service uses one versioned commit path for create, exact, anchors, overwrite, move and delete", { timeout: 10_000 }, async t => {
  const f = await fixture(t), path = join(f.cwd, "nested", "@source.txt");
  const create = await f.service.prepare("write", { path, content: "one\r\ntwo\r\n" });
  const created = await f.service.execute(create, "create", f.hooks);
  assert.equal(created.status, "succeeded"); assert.equal(created.created, true);
  assert.equal(created.revisionContinuation, "available");
  const exact = await f.service.prepare("edit", { path, edits: [{ oldText: "one", newText: "ONE" }] });
  assert.equal((await f.service.execute(exact, "exact", f.hooks)).status, "succeeded");
  const source = await f.capture(path);
  const anchored = await f.service.prepare("edit", { path, snapshot: source.snapshot, edits: [{ kind: "replace", start: source.anchor, newLines: ["First"] }] });
  assert.equal((await f.service.execute(anchored, "anchor", f.hooks)).status, "succeeded");
  await f.capture(path);
  const overwrite = await f.service.prepare("write", { path, content: "replacement\n" });
  assert.equal((await f.service.execute(overwrite, "overwrite", f.hooks)).status, "succeeded");
  const destination = join(f.cwd, "@moved.txt");
  const moved = await f.service.execute(await f.service.prepare("move", { path, destination }), "move", f.hooks);
  assert.equal(moved.status, "succeeded"); assert.equal(await readFile(destination, "utf8"), "replacement\n");
  // Leading @ is a literal for move/delete, including a relative path.
  assert.equal((await f.service.execute(await f.service.prepare("delete", { path: "@moved.txt" }), "delete", f.hooks)).status, "succeeded");
  assert.equal(f.entries.filter(entry => entry.phase === "result").length, 6);
  assert.equal(f.service.revisions.size, 0);
  assert.equal(exact.snapshot!.byteEdits.length, 0);
  assert.throws(() => f.service.assertPrepared(exact), /released/u);
});

test("native prepared inputs, lifecycle revocation and version conflicts cannot become unplanned writes", { timeout: 10_000 }, async t => {
  const f = await fixture(t), path = join(f.cwd, "file.txt");
  const input = { path, content: "original\n" }, create = await f.service.prepare("write", input);
  input.content = "mutated argument\n";
  assert.equal((await f.service.execute(create, "create", f.hooks)).status, "succeeded");
  assert.equal(await readFile(path, "utf8"), "original\n");
  await f.capture(path);
  const overwrite = await f.service.prepare("write", { path, content: "new\n" });
  await rm(path);
  const missing = await f.service.execute(overwrite, "missing", f.hooks);
  assert.equal(missing.stateChanged, false); await assert.rejects(stat(path), { code: "ENOENT" });
  const revoked = await f.service.prepare("write", { path, content: "denied" });
  const denied = await f.service.execute(revoked, "revoked", { ...f.hooks, assertCurrent() { throw new Error("revoked"); } });
  assert.equal(denied.stateChanged, false);
  const obsolete = await f.service.prepare("write", { path, content: "obsolete" });
  f.service.clear();
  assert.equal((await f.service.execute(obsolete, "clear", f.hooks)).stateChanged, false);
  await assert.rejects(stat(path), { code: "ENOENT" });
  await writeFile(path, "present");
  await assert.rejects(f.service.prepare("write", { path, content: "create-only" }, undefined, "create"), /TARGET_APPEARED/u);
  const absent = join(f.cwd, "absent");
  await assert.rejects(f.service.prepare("write", { path: absent, content: "overwrite-only" }, undefined, "overwrite"), /TARGET_MISSING/u);
});

test("native file service keeps confirmed effects when result recording fails", { timeout: 10_000 }, async t => {
  const f = await fixture(t), path = join(f.cwd, "confirmed.txt");
  const plan = await f.service.prepare("write", { path, content: "kept\n" });
  const result = await f.service.execute(plan, "write", { assertCurrent() {}, record(entry) {
    if (entry.phase === "result") throw new Error("record unavailable");
    f.entries.push(entry);
  } });
  assert.equal(result.status, "partial"); assert.equal(result.stateChanged, true);
  assert.equal(result.requiresVerification, true); assert.equal(result.ok, false);
  assert.equal(await readFile(path, "utf8"), "kept\n");
  assert.ok(f.entries.some(entry => entry.phase === "intent"));
});

test("copy preserves the unchanged source read version and invalidates an overwritten destination", async t => {
  const f = await fixture(t), sourcePath = join(f.cwd, "copy-source"), destination = join(f.cwd, "copy-target");
  await writeFile(sourcePath, "source"); await writeFile(destination, "old");
  const source = await f.capture(sourcePath), previous = await f.capture(destination);
  assert(f.service.revisions.get(source.snapshot)); assert(f.service.revisions.get(previous.snapshot));
  const plan = await f.service.prepareV3("copy", { path: sourcePath, destination, overwrite: true }); await f.service.revalidate(plan, f.hooks);
  const receipt = await f.service.execute(plan, "copy", f.hooks);
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt)); assert.equal(await readFile(destination, "utf8"), "source");
  assert(f.service.revisions.get(source.snapshot)); assert.equal(f.service.revisions.get(previous.snapshot), undefined);
});
