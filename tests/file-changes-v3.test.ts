import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FileResultWriter } from "../packages/coding-agent/src/core/files/file-result-store.ts";
import { FileChangesV3 } from "../packages/coding-agent/src/core/files/file-changes-v3.ts";
import { remainingDraft, remainingDraftPageV3, registerChanges } from "../packages/coding-agent/src/core/files/changes.ts";
import { mutationRequestHash, nativeItemRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";

function fixture(count = 2000) {
  const session = SessionManager.inMemory(), items = [];
  for (let index = 0; index < count; index++) items.push({ path: "source-" + index, destination: "destination-" + index });
  const input = { items, overwrite: true }, id = "copy-many";
  const callEntryId = session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: "copy", arguments: input }], timestamp: 0 } as any);
  const writer = new FileResultWriter({ callEntryId, toolCallId: id, operation: "copy", requestHash: mutationRequestHash("copy", input), itemCount: count },
    (kind, data) => session.appendCustomEntry(kind, data), session);
  const prepared = [];
  for (let index = 0; index < count; index++) prepared.push(writer.prepare(index, {
    operation: "copy", inputHash: nativeItemRequestHash("copy", input, index), target: resolve(items[index].path), destination: resolve(items[index].destination), overwrite: true,
  }));
  writer.ready(); return { session, writer, prepared, callEntryId };
}

test("v3 changes pages and drafts reach targets 17, 513 and 2000 without old history/count windows", async t => {
  const f = fixture(), ref = f.writer.finish("cancelled before first intent"), owner = new FileChangesV3(f.session);
  t.after(() => owner.dispose());
  (f.session as any).getBranch = () => { throw new Error("changes must not copy the branch"); };
  const calls = await owner.calls(); assert.equal(calls.length, 1); assert.equal(calls[0].ref, ref);
  owner.open(ref); const wanted = new Set([16, 512, 1999]); let seen = 0, last;
  do {
    const page = owner.nextItems(); last = page;
    assert(page.records.length <= 16);
    for (const record of page.records) {
      assert.equal(record.status, "not_started"); assert.equal(record.original.overwrite, true); seen++;
      const index = Number(record.itemId.slice(record.itemId.lastIndexOf(":") + 1));
      if (wanted.has(index)) {
        const draft = remainingDraftPageV3({ ...page, records: [record] }, new Set());
        assert(draft.includes("source-" + index)); assert(draft.includes('"overwrite": true')); assert.match(draft, /Selected page only/); wanted.delete(index);
      }
    }
  } while (last.hasMore);
  assert.equal(seen, 2000); assert.equal(wanted.size, 0); assert(last.coverageComplete);
  assert.equal(owner.diagnostics.retainedReaderPages, 1);
  owner.dispose(); assert.equal(owner.diagnostics.retainedReaderPages, 0); assert.equal(owner.diagnostics.seenCalls, 0);
});

test("incomplete intent is unknown once; prepared suffix remains available without unsafe replay", () => {
  const f = fixture(3); f.writer.intent(0, f.prepared[0]);
  const owner = new FileChangesV3(f.session); owner.open(f.writer.reference());
  const page = owner.nextItems(); assert.equal(page.records.length, 3); assert.equal(page.hasMore, false);
  assert.equal(page.records[0].status, "state_unknown"); assert.equal(page.records[0].requiresVerification, true);
  assert.deepEqual(page.records.slice(1).map(record => record.status), ["not_started", "not_started"]);
  assert.throws(() => remainingDraftPageV3(page, new Set()), /verify partial\/unknown/);
  const draft = remainingDraftPageV3(page, new Set(["copy-many:0"]));
  assert(!draft.includes('"source-0"')); assert(draft.includes("source-1")); assert.equal(page.coverageComplete, false);
  owner.dispose(); f.writer.dispose();
});

test("changes discovery preserves interleaved calls from the same assistant entry", async () => {
  const session = SessionManager.inMemory(), input = { paths: ["a"] };
  const callEntryId = session.appendMessage({ role: "assistant", content: [
    { type: "toolCall", id: "first", name: "delete", arguments: input }, { type: "toolCall", id: "second", name: "delete", arguments: input },
  ], timestamp: 0 } as any);
  const writers = [];
  for (const id of ["first", "second"]) {
    const writer = new FileResultWriter({ callEntryId, toolCallId: id, operation: "delete", requestHash: mutationRequestHash("delete", input), itemCount: 1 },
      (kind, data) => session.appendCustomEntry(kind, data), session);
    writer.prepare(0, { operation: "delete", inputHash: nativeItemRequestHash("delete", input, 0), target: resolve("a") }); writers.push(writer);
  }
  writers[0].ready(); writers[1].ready(); writers[0].finish(); writers[1].finish();
  const owner = new FileChangesV3(session), calls = await owner.calls();
  assert.deepEqual(calls.map(call => call.toolCallId), ["second", "first"]);
  assert.equal(owner.hasMoreCalls, false);
  for (const call of calls) { owner.open(call.ref); assert.equal(owner.nextItems().records.length, 1); }
  session.branch(callEntryId); assert.throws(() => owner.open(calls[0].ref), /changed session or branch/);
  assert.equal(owner.diagnostics.sessionRetained, false);
});

test("v3 drafts preserve recursive flags while legacy safety bounds and body budgets stay active", () => {
  const f = fixture(1); f.writer.finish();
  const owner = new FileChangesV3(f.session); owner.open(f.writer.reference()); const page = owner.nextItems();
  const record = { ...page.records[0], operation: "delete", destination: undefined, original: { path: "a", recursive: true } };
  assert.match(remainingDraftPageV3({ ...page, records: [record] }, new Set()), /"recursive": true/);
  const many: typeof record[] = []; for (let index = 0; index < 17; index++) many.push({ ...record, itemId: "item-" + index });
  assert.throws(() => remainingDraft(many, new Set()), /bounded window/);
  assert.doesNotThrow(() => remainingDraftPageV3({ ...page, records: many }, new Set()));
  const large = { ...record, operation: "write", original: { content: "x".repeat(8193) } };
  assert.throws(() => remainingDraftPageV3({ ...page, records: [large] }, new Set()), /draft bound/);
  owner.dispose();
});

test("/changes opens resultRef and places a later-page draft without reading user files", async () => {
  const f = fixture(), ref = f.writer.finish(), warnings: string[] = [];
  let command: any, editor = "", drafted = false, targetPages = 0;
  registerChanges({ registerCommand(_name, options) { command = options; }, appendEntry() { throw new Error("draft is metadata-only"); } }, {
    async authorizeFileObservation() { throw new Error("draft cannot observe host files"); },
  });
  await command.handler(ref, {
    hasUI: true, isIdle: () => true, cwd: process.cwd(), sessionManager: f.session,
    ui: { notify(message: string) { warnings.push(message); }, getEditorText: () => editor, setEditorText(text: string) { editor = text; drafted = true; },
      async select(title: string, choices: string[]) {
        assert.match(title, /File changes/); targetPages++;
        if (drafted) return "Back to calls";
        return choices.some(choice => choice.includes("source-512")) ? "Draft remaining work on this page" : "Next target page";
      } },
  });
  assert.equal(warnings.length, 0, warnings.join("\n")); assert(drafted); assert(targetPages > 16);
  assert(editor.includes("source-512")); assert(editor.includes("More pages remain")); assert(!editor.includes('"source-1999"'));
});

test("sandbox verification refuses an absent backend instead of falling back to host observation", async () => {
  const f = fixture(1), ref = f.writer.finish(), warnings: string[] = [];
  let command: any, selected = false;
  registerChanges({ registerCommand(_name, options) { command = options; }, appendEntry() { throw new Error("no observation may be published"); } }, {
    fileObservationEnvironment: "sandbox", async authorizeFileObservation() { throw new Error("host path must not be observed"); },
  });
  await command.handler(ref, {
    hasUI: true, isIdle: () => true, cwd: process.cwd(), sessionManager: f.session,
    ui: { notify(message: string) { warnings.push(message); },
      async select(_title: string, choices: string[]) { if (!selected) { selected = true; return choices[0]; } return "Verify current state"; } },
  });
  assert.equal(warnings.length, 1); assert.match(warnings[0], /SANDBOX_UNSUPPORTED/);
});
