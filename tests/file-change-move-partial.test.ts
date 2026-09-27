import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createJiti } from "jiti";

test("N1 merge regression: actual partial moves cannot gain aggregate-only identity", async t => {
  let target = "";
  const unlink = fsPromises.unlink;
  // Install before the extension module is loaded: jiti snapshots builtin exports.
  t.mock.method(fsPromises, "unlink", async function(path: any) {
    if (String(path) === target) throw Object.assign(new Error("fixture unlink refused after link"), { code: "EACCES" });
    return unlink(path);
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { mutationFixture } = await import("./helpers/mutation-fixture.ts");
  const { SessionManager } = await import("../packages/coding-agent/src/core/session-manager.ts");
  const { collectChanges, verifyChange } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/changes.ts");
  const f = await mutationFixture(t);
  for (const batch of [false, true]) {
    target = join(realpathSync.native(f.cwd), `partial-source-${batch}`);
    const destination = join(realpathSync.native(f.cwd), `partial-destination-${batch}`), id = `partial-identity-${batch}`;
    writeFileSync(target, "both names survive"); await f.call("read", { path: target }, `${id}-read`);
    const input = { path: target, destination };
    const result = await f.call(batch ? "file_batch" : "move", batch ? { operations: [{ operation: "move", ...input }] } : input, id);
    assert.equal(result.isError, true); assert.equal(readFileSync(target, "utf8"), "both names survive");
    assert.equal(readFileSync(destination, "utf8"), "both names survive");
    const branch = JSON.parse(JSON.stringify(SessionManager.open(f.session.getSessionFile()!).getBranch()));
    const record = collectChanges(branch, f.cwd).find((item: any) => item.toolCallId === id);
    assert.equal(record.status, "partial"); assert.equal(record.unavailable, undefined);
    assert.equal((await verifyChange(record, async () => {})).destinationIdentityMatches, undefined);
    const aggregate = branch.find((entry: any) => entry.message?.toolCallId === id && entry.message?.role === "toolResult").message.details;
    const receipt = batch ? aggregate.items[0].receipt : aggregate, identity = await fsPromises.stat(destination, { bigint: true });
    receipt.sourceIdentity = { device: String(identity.dev), inode: String(identity.ino) };
    const invalid = collectChanges(branch, f.cwd).find((item: any) => item.toolCallId === id);
    assert.ok(invalid.unavailable); assert.equal(invalid.sourceIdentity, undefined);
    await assert.rejects(verifyChange(invalid, async () => { assert.fail("forged partial identity cannot observe disk"); }));
  }
});
