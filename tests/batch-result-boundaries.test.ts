import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { mutationFixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
const { restoreMutationEvidenceFromBranch, collectStructuredMutationReceipts } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/session-evidence.ts");
function snapshot(read: any, text: string) {
  const value = read.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n"), i = value.indexOf("snapshot=") + 9;
  return { snapshot: value.slice(i, i + 27), edits: [{ kind: "replace", start: value.split("\n").find((x: string) => x.startsWith("1#"))!.split("|")[0], newLines: [text] }] };
}
for (const kind of ["create", "overwrite", "exact", "snapshot"]) for (const unknown of [false, true]) test(`result alias evidence ${kind}, unknown=${unknown}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), alias = join(cwd, "alias"), a = join(cwd, "one/inner/file"), b = join(cwd, "two/inner/file");
  mkdirSync(join(cwd, "one/inner"), { recursive: true }); mkdirSync(join(cwd, "two/inner"), { recursive: true });
  if (kind !== "create") writeFileSync(a, "before\n"); writeFileSync(b, "after\n");
  symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  const read = kind === "create" ? undefined : await f.call("read", { path: "alias/inner/file" }, "prior");
  if (unknown) await f.call("read", { path: b }, "unrelated-prior");
  f.onRecord(data => { if (data.phase === "result") { unlinkSync(alias); symlinkSync(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir"); if (unknown) throw new Error("lost result"); } });
  const item = kind === "create" || kind === "overwrite" ? { operation: "write", mode: kind, path: "@alias/inner/file", content: "after\n" }
    : { operation: "edit", path: "@alias/inner/file", ...(kind === "snapshot" ? snapshot(read, "after") : { edits: [{ oldText: "before", newText: "after" }] }) };
  const result = await f.call("file_batch", { operations: [item] }, "mutation"); f.onRecord(() => {});
  assert.equal(result.isError, unknown); assert.equal(readFileSync(a, "utf8"), "after\n"); assert.equal(readFileSync(b, "utf8"), "after\n");
  const reopened = SessionManager.open(f.session.getSessionFile()!), restored = new MutationWriteGuard();
  await restoreMutationEvidenceFromBranch(restored, cwd, reopened.getBranch());
  if (unknown) assert.equal((await restored.write(cwd, b, "kept", 99)).ok, true);
  else await assert.rejects(restored.write(cwd, b, "forbidden", 99));
  writeFileSync(b, "after\n");
  const unrelated = await f.call("write", { path: b, content: "live" }, "unrelated");
  assert.equal(unrelated.isError, !unknown, JSON.stringify(unrelated));
  if (!unknown) assert.equal((await f.call("write", { path: a, content: "legitimate" }, "original")).isError, false);
});
for (const kind of ["exact", "snapshot"]) test(`progress receipts exclude full ${kind} diff payload`, async t => {
  const f = await mutationFixture(t), path = join(f.cwd, "large.txt"), before = "A".repeat(32000), after = "B".repeat(32000);
  writeFileSync(path, before + "\n"); const read = await f.call("read", { path }, "large-read");
  let resultEntry: any;
  f.onRecord(data => { if (data.phase === "result") resultEntry = data; });
  const result = await f.call("file_batch", { operations: [{ operation: "edit", path, ...(kind === "snapshot" ? snapshot(read, after) : { edits: [{ oldText: before, newText: after }] }) }] }, "large");
  assert.equal(result.isError, false); assert.equal(readFileSync(path, "utf8"), after + "\n");
  assert.ok((result.details as any).items[0].receipt.patch.length > 32000);
  const metadataBytes = Buffer.byteLength(JSON.stringify(resultEntry)), resultBytes = Buffer.byteLength(JSON.stringify(result.details));
  t.diagnostic(JSON.stringify({ kind, metadataBytes, resultBytes }));
  assert.equal(resultEntry.receipt === undefined, true); assert.ok(metadataBytes < 4096);
  assert.equal(collectStructuredMutationReceipts(SessionManager.open(f.session.getSessionFile()!).getBranch()).filter((r: any) => r.toolCallId === "large").length, 1);
});
