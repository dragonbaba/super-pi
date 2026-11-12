import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { mkdtempSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FileResultReader, FileResultWriter } from "../packages/coding-agent/src/core/files/file-result-store.ts";
import { FILE_RESULT_ENTRY, FILE_RESULT_PAGE_BYTES, FILE_RESULT_PAYLOAD_BYTES, resultEnvelopeHash, fileResultReference } from "../packages/coding-agent/src/core/files/file-result-protocol.ts";
import { mutationRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";

function fixture(count = 1, session = SessionManager.inMemory()) {
  const input = { paths: [] as string[], recursive: true };
  for (let index = 0; index < count; index++) input.paths.push(`dir/路径-${index}`);
  const callEntryId = session.appendMessage({ role: "assistant", content: [{ type: "toolCall", name: "delete", id: "call-1", arguments: input }], timestamp: 0 } as any);
  const writer = new FileResultWriter({ callEntryId, toolCallId: "call-1", operation: "delete", requestHash: mutationRequestHash("delete", input), itemCount: count },
    (kind, data) => session.appendCustomEntry(kind, data), session);
  const reader = new FileResultReader(session);
  return { session, writer, reader, input, callEntryId };
}
function publish(f: ReturnType<typeof fixture>, padding = "") {
  const ids = [];
  for (let index = 0; index < f.input.paths.length; index++) ids.push(f.writer.prepare(index, prepared(f, index, padding)));
  f.writer.ready();
  for (let index = 0; index < ids.length; index++) {
    f.writer.intent(index, ids[index]);
    f.writer.result(index, { operation: "delete", target: resolve(f.input.paths[index]), status: "succeeded", stateChanged: true });
  }
  return f.writer.finish();
}
function prepared(f: ReturnType<typeof fixture>, index: number, metadata = "") {
  return { operation: "delete" as const, target: resolve(f.input.paths[index]),
    inputHash: mutationRequestHash("delete", { path: f.input.paths[index], recursive: true }), metadata };
}

test("v3 terminal hashes must match committed facts and cannot publish a failed successor", () => {
  for (const fault of ["commit-hash", "snapshot", "malformed-hash", "failed-snapshot"]) {
    const session = SessionManager.inMemory(), input = { path: "written", content: "one" }, target = resolve(input.path);
    const callEntryId = session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "written", name: "write", arguments: input }], timestamp: 0 } as any);
    const writer = new FileResultWriter({ callEntryId, toolCallId: "written", operation: "write", requestHash: mutationRequestHash("write", input), itemCount: 1 },
      (kind, data) => session.appendCustomEntry(kind, data), session), reader = new FileResultReader(session);
    try {
      const id = writer.prepare(0, { operation: "write", target, inputHash: mutationRequestHash("write", input) }); writer.ready(); writer.intent(0, id);
      writer.commit({ operation: "write", target, status: "succeeded", stateChanged: true, sha256: "a".repeat(64) });
      writer.result(0, { operation: "write", target, status: fault === "failed-snapshot" ? "state_unknown" : "succeeded",
        stateChanged: fault === "failed-snapshot" ? "unknown" : true, requiresVerification: fault === "failed-snapshot" ? true : undefined,
        sha256: fault === "commit-hash" ? "b".repeat(64) : fault === "malformed-hash" ? "not-a-hash" : "a".repeat(64),
        snapshot: fault === "snapshot" ? "b".repeat(64) : "a".repeat(64) });
      assert.throws(() => reader.read(writer.finish()), /FILE_RESULT_INVALID/, fault);
    } finally { writer.dispose(); reader.dispose(); }
  }
});

test("v3 reads all 2,000 outcomes with bounded pages, including entries beyond 17 and 513", () => {
  const f = fixture(2000), ref = publish(f, "汉字\\\"\n".repeat(300));
  assert(f.writer.diagnostics.serializedBytes > 2 * 1024 * 1024);
  assert.equal(f.writer.diagnostics.appendCallbackRetained, false);
  assert.equal(f.writer.diagnostics.retainedManifestHashes, 0);
  let cursor: string | undefined, pages = 0, outcomes = 0;
  const seen = new Set<number>();
  do {
    const page = f.reader.read(ref, cursor, 128);
    assert(Buffer.byteLength(JSON.stringify(page)) <= FILE_RESULT_PAGE_BYTES);
    for (const row of page.records) if (row.record.phase === "result") { seen.add(row.record.index!); outcomes++; }
    assert.equal(page.callComplete, true);
    cursor = page.nextCursor ?? undefined; pages++;
  } while (cursor);
  assert(pages > 1); assert.equal(outcomes, 2000);
  for (const index of [0, 16, 17, 512, 513, 1999]) assert(seen.has(index));
  assert.equal(f.reader.diagnostics.returnedRecords, f.writer.diagnostics.records);
  f.reader.dispose(); f.writer.dispose();
  assert.equal(f.reader.diagnostics.sessionRetained, false);
  assert.equal(f.reader.diagnostics.sourceCallRetained, false);
  assert.equal(f.reader.diagnostics.retainedPages, 0);
});

test("v3 cursors reject altered positions, another owner and branch generations", () => {
  const f = fixture(4), ref = publish(f), first = f.reader.read(ref, undefined, 1), cursor = first.nextCursor!;
  assert(cursor);
  const [encoded, signature] = cursor.split(".");
  const position = JSON.parse(Buffer.from(encoded, "base64url").toString());
  position.sequence = 0;
  assert.throws(() => f.reader.read(ref, Buffer.from(JSON.stringify(position)).toString("base64url") + "." + signature), /CURSOR/);
  assert.throws(() => new FileResultReader(f.session).read(ref, cursor), /CURSOR/);
  f.session.branch(f.callEntryId);
  assert.throws(() => f.reader.read(ref, cursor), /BRANCH/);
});

test("v3 rejects broken chains, changed original arguments and foreign calls", () => {
  const f = fixture(), ref = publish(f);
  f.input.recursive = false;
  assert.throws(() => f.reader.read(ref), /Original call/);
  f.input.recursive = true;
  const entries = f.session.getEntries();
  const result = entries.find(entry => entry.type === "custom" && entry.customType === FILE_RESULT_ENTRY && JSON.parse((entry.data as any).payload).phase === "result")!;
  (result as any).data.payload += " ";
  assert.throws(() => f.reader.read(ref), /digest mismatch/);
  const other = fixture();
  assert.throws(() => other.reader.read(ref), /BRANCH/);
});

test("journal append failures poison and release the writer without manufacturing a result", () => {
  const f = fixture();
  const writer = new FileResultWriter(f.writer.binding, () => { throw new Error("disk unavailable"); }, f.session);
  assert.throws(() => writer.prepare(0, { target: "x" }), /disk unavailable/);
  assert.equal(writer.diagnostics.poisoned, true);
  assert.equal(writer.diagnostics.appendCallbackRetained, false);
  assert.equal(writer.diagnostics.sessionRetained, false);
  assert.throws(() => writer.ready(), /ORDER/);
  assert.throws(() => writer.reference(), /No published/);
});

test("journal requires complete preparation, ordered intents and explicit outcomes", () => {
  const f = fixture(2);
  assert.throws(() => f.writer.ready(), /ORDER/);
  const id = f.writer.prepare(0, prepared(f, 0));
  assert.throws(() => f.writer.intent(0, id), /ORDER/);
  f.writer.prepare(1, prepared(f, 1)); f.writer.ready(); f.writer.intent(0, id);
  assert.throws(() => f.writer.intent(1, id), /ORDER/);
  assert.throws(() => f.writer.finish(), /explicit outcome/);
  assert.throws(() => f.writer.result(0, { status: "succeeded", stateChanged: false }), /outcome/);
  f.writer.result(0, { operation: "delete", target: resolve(f.input.paths[0]), status: "failed_no_change", stateChanged: false });
  const page = f.reader.read(f.writer.finish("stopped"));
  assert.equal(page.records[0].record.notStarted, 1);
});

test("one worst-sized Unicode record still fits a complete encoded page", () => {
  const f = fixture();
  const preparedId = f.writer.prepare(0, prepared(f, 0, "汉".repeat(15500)));
  f.writer.ready(); f.writer.intent(0, preparedId);
  f.writer.result(0, { operation: "delete", target: resolve(f.input.paths[0]), status: "succeeded", stateChanged: true });
  const ref = f.writer.finish();
  let cursor: string | undefined;
  do {
    const page = f.reader.read(ref, cursor);
    assert(Buffer.byteLength(JSON.stringify(page)) <= FILE_RESULT_PAGE_BYTES);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const bad = fixture();
  assert.throws(() => bad.writer.prepare(0, { metadata: "a".repeat(FILE_RESULT_PAYLOAD_BYTES) }), /BUDGET/);
});

test("a recomputed digest cannot hide a forged result target or contradictory totals", () => {
  for (const fault of ["target", "counts"]) {
    const f = fixture(); publish(f);
    const records = f.session.getEntries().filter((entry: any) => entry.customType === FILE_RESULT_ENTRY) as any[];
    const result = records[records.length - 2].data, complete = records[records.length - 1].data;
    if (fault === "target") {
      const payload = JSON.parse(result.payload); payload.target = resolve("forged");
      result.payload = JSON.stringify(payload); result.payloadBytes = Buffer.byteLength(result.payload); result.hash = resultEnvelopeHash(result);
      complete.previousHash = result.hash;
    } else {
      const payload = JSON.parse(complete.payload); payload.succeeded = 0; payload.failed = 1;
      complete.payload = JSON.stringify(payload); complete.payloadBytes = Buffer.byteLength(complete.payload);
    }
    complete.hash = resultEnvelopeHash(complete);
    const ref = fileResultReference(records[records.length - 1].id, complete, complete.hash);
    assert.throws(() => f.reader.read(ref), /Inconsistent|counts do not match/);
  }
});

test("later duplicate call activity invalidates an already cached result anchor", () => {
  const f = fixture(), ref = publish(f); f.reader.read(ref);
  const complete = f.session.getLeafEntry() as any;
  f.session.appendCustomEntry(FILE_RESULT_ENTRY, complete.data);
  assert.throws(() => f.reader.read(ref), /superseded/);
});

test("an intent without a terminal outcome is explicitly unknown and never complete", () => {
  const f = fixture(), id = f.writer.prepare(0, prepared(f, 0)); f.writer.ready(); f.writer.intent(0, id);
  const ref = f.writer.reference(); f.writer.dispose();
  const page = f.reader.read(ref);
  assert.equal(page.callComplete, false); assert.equal(page.coverageComplete, false);
  assert.deepEqual(page.incompleteItem, { index: 0, status: "state_unknown", stateChanged: "unknown", requiresVerification: true });
});

test("persistent forks keep a >2 MiB journal after deleting the original, and reject old cursors", t => {
  const root = mkdtempSync(join(tmpdir(), "sp-result-fork-")); t.after(() => removeOwnedFixture(root));
  const session = SessionManager.create(root, join(root, "sessions")), f = fixture(2000, session), ref = publish(f, "汉".repeat(400));
  const original = session.getSessionFile()!; assert(statSync(original).size > 2 * 1024 * 1024);
  const cursor = f.reader.read(ref, undefined, 1).nextCursor!;
  const branched = session.createBranchedSession(session.getLeafId()!)!;
  assert.throws(() => f.reader.read(ref, cursor), /CURSOR/);
  unlinkSync(original);
  const reopened = SessionManager.open(branched), reader = new FileResultReader(reopened);
  let next: string | undefined, results = 0;
  do {
    const page = reader.read(ref, next, 128);
    assert(Buffer.byteLength(JSON.stringify(page)) <= FILE_RESULT_PAGE_BYTES);
    for (const row of page.records) if (row.record.phase === "result") results++;
    next = page.nextCursor ?? undefined;
  } while (next);
  assert.equal(results, 2000); assert.equal(readdirSync(join(root, "sessions")).length, 1);
  reader.dispose(); f.reader.dispose();
});

test("journal chains use returned publication IDs even when other entries advance the leaf", () => {
  const f = fixture();
  const writer = new FileResultWriter(f.writer.binding, (kind, data) => {
    const id = f.session.appendCustomEntry(kind, data);
    f.session.appendCustomEntry("unrelated-observer-entry", { observed: id });
    return id;
  }, f.session);
  const id = writer.prepare(0, prepared(f, 0)); writer.ready(); writer.intent(0, id);
  writer.result(0, { operation: "delete", target: resolve(f.input.paths[0]), status: "succeeded", stateChanged: true });
  const page = f.reader.read(writer.finish());
  assert.equal(page.callComplete, true); assert.equal(page.coverageComplete, true); assert.equal(page.records.length, 5);
  assert.equal((f.session.getLeafEntry() as any).customType, "unrelated-observer-entry");
});

test("even an identical prepared row from another branch cannot replace ready's published item", () => {
  for (const changedTarget of [false, true]) {
    const f = fixture(); publish(f);
    const records = f.session.getEntries().filter((entry: any) => entry.customType === FILE_RESULT_ENTRY) as any[];
    const original = records[0], intent = records[2], result = records[3], complete = records[4];
    f.session.branch(f.callEntryId);
    const foreignData = { ...original.data }, payload = JSON.parse(foreignData.payload);
    if (changedTarget) payload.target = resolve("forged-foreign-target");
    foreignData.payload = JSON.stringify(payload); foreignData.payloadBytes = Buffer.byteLength(foreignData.payload); foreignData.hash = resultEnvelopeHash(foreignData);
    const foreignId = f.session.appendCustomEntry(FILE_RESULT_ENTRY, foreignData);
    f.session.branch(complete.id);
    for (const entry of [intent, result]) {
      const value = JSON.parse(entry.data.payload); value.preparedId = foreignId;
      if (entry === result) value.target = payload.target;
      entry.data.payload = JSON.stringify(value); entry.data.payloadBytes = Buffer.byteLength(entry.data.payload);
      if (entry === result) entry.data.previousHash = intent.data.hash;
      entry.data.hash = resultEnvelopeHash(entry.data);
    }
    complete.data.previousHash = result.data.hash; complete.data.hash = resultEnvelopeHash(complete.data);
    assert.throws(() => f.reader.read(fileResultReference(complete.id, complete.data, complete.data.hash), undefined, 2), /ready manifest/);
  }
});

test("ready-generation changes reject intents and ready write failures release every manifest hash", () => {
  const f = fixture(), id = f.writer.prepare(0, prepared(f, 0)); f.writer.ready(5);
  assert.throws(() => f.writer.intent(0, id, 6), /permission generation/);
  f.writer.intent(0, id, 5); f.writer.result(0, { operation: "delete", target: resolve(f.input.paths[0]), status: "succeeded", stateChanged: true });
  assert.equal(f.reader.read(f.writer.finish()).callComplete, true);
  const other = fixture(4), writer = new FileResultWriter(other.writer.binding, (kind, data) => {
    if (JSON.parse(data.payload).phase === "ready") throw new Error("ready journal failure");
    return other.session.appendCustomEntry(kind, data);
  }, other.session);
  for (let index = 0; index < 4; index++) writer.prepare(index, prepared(other, index));
  assert.equal(writer.diagnostics.retainedManifestHashes, 4);
  assert.throws(() => writer.ready(), /ready journal failure/);
  assert.equal(writer.diagnostics.retainedManifestHashes, 0); assert.equal(writer.diagnostics.sessionRetained, false);
  assert.equal(writer.diagnostics.appendCallbackRetained, false); assert.equal(writer.diagnostics.poisoned, true);
});
