import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, readFile, chmod, lstat, rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { selectCommitMetadata } from "../packages/extensions/mutation-guard-write/file-commit-metadata.ts";
import { commitPreparedFile } from "../packages/extensions/mutation-guard-write/file-commit.ts";
import { capturePathIdentity } from "../packages/extensions/mutation-guard-write/native-file-core.ts";
import { disposeNativeFileWorker, nativeFileDiagnostics, nativeFileRequest } from "../packages/extensions/mutation-guard-write/native-file-client.ts";

const supported = process.arch === "x64" && (process.platform === "win32" || process.platform === "linux");
async function fixture(t: any, long = false) {
  const temporary = await realpath(tmpdir()), root = await mkdtemp(join(temporary, "sp-n2-native-"));
  t.diagnostic(`ownedFixture=${root}`);
  t.after(async () => { await disposeNativeFileWorker(); assert.equal(dirname(root), temporary); await rm(root, { recursive: true, force: true }); });
  const directory = long ? join(root, "中文目录".repeat(20), "wide".repeat(30)) : root;
  await mkdir(directory, { recursive: true });
  const target = join(directory, "测试.txt"), before = "before\r\n", after = Buffer.from("\ufeffafter\r\n中文\r\n");
  await writeFile(target, before);
  return { root, target, before, after };
}

test("N2 importing commit metadata does not load a native worker", () => { assert.equal(nativeFileDiagnostics().loaded, false); });

for (const long of [false, true]) test(`N2 actual native normal-file replacement preserves observed metadata, long=${long}`, { skip: !supported }, async t => {
  const f = await fixture(t, long);
  if (process.platform === "win32") await writeFile(f.target + ":n2-fixture", "named stream retained");
  else await chmod(f.target, 0o751);
  const original = await lstat(f.target, { bigint: true });
  const target = await capturePathIdentity(f.target), parent = await capturePathIdentity(dirname(f.target));
  const metadata = await selectCommitMetadata(target);
  assert.equal(metadata.strategy, "staged_replace", metadata.reason);
  const receipt = await commitPreparedFile({ target, parent, metadata, previousSha256: createHash("sha256").update(f.before).digest("hex") }, f.after, { assertPathAllowed: async () => target.canonical });
  assert.equal(receipt.outcome, "committed"); assert.equal(receipt.fileSynced, true);
  assert.deepEqual(await readFile(f.target), f.after);
  const current = await lstat(f.target, { bigint: true });
  assert.notEqual(current.ino, original.ino);
  if (process.platform === "win32") assert.equal(await readFile(f.target + ":n2-fixture", "utf8"), "named stream retained");
  else { assert.equal(current.mode, original.mode); assert.equal(current.uid, original.uid); assert.equal(current.gid, original.gid); }
  assert.equal((await nativeFileRequest("stats")).activeHandles, 0);
  assert.equal(nativeFileDiagnostics().pending, 0);
});
