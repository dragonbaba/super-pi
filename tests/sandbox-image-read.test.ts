import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../packages/coding-agent/src/utils/image-signature.mjs";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";
import { encodingFixture } from "./helpers/image-encoding-fixtures.ts";
import { loadPhoton } from "../packages/coding-agent/src/utils/photon.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { isVmPrivateName, isVmPrivatePath, isProtectedWorkspaceName, isVmPrivateDirectory, parseSandboxPrivateDirectories } from "../packages/coding-agent/src/core/sandbox/workspace-policy.mjs";

const source = ts.createSourceFile("worker.mjs", fs.readFileSync("packages/coding-agent/src/core/sandbox/workspace-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
const guest = source.statements.filter(node => !ts.isImportDeclaration(node)
  && !(ts.isVariableStatement(node) && ["SOURCE", "WORK", "EXCHANGE"].includes(node.declarationList.declarations[0]!.name.getText(source))))
  .map(node => node.getText(source)).join("\n");
const execute = new Function("isVmPrivateName", "isVmPrivatePath", "isProtectedWorkspaceName", "isVmPrivateDirectory", "parseSandboxPrivateDirectories", "fs", "path", "createHash", "isUtf8", "spawnSync", "process", "SOURCE", "WORK", "EXCHANGE", "detectSupportedImageMimeType", "IMAGE_TYPE_SNIFF_BYTES", guest).bind(undefined, isVmPrivateName, isVmPrivatePath, isProtectedWorkspaceName, isVmPrivateDirectory, parseSandboxPrivateDirectories);
const png = Buffer.from(await encodingFixture("transparent", 256, 256));
assert.ok(png.length > 32768, "fixture must exceed shell output capacity");

function fixture(t: TestContext, mode: "read-only" | "sandbox-write" = "read-only", temporary = os.tmpdir()) {
  // Match the backend's native async realpath, including Windows temp aliases.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "sp-image-read-")));
  const input = path.join(root, "input"), work = path.join(root, "work"), exchange = path.join(root, "exchange");
  for (const dir of [input, input + "-1", exchange]) fs.mkdirSync(dir);
  const boundary = new SessionExecutionBoundary(), runtime: any = { executionBoundary: boundary, nativePermissions: { mode }, appendEntry() {} };
  const owner = new WorkspaceSandboxTools(input, root, mode, () => runtime, { directories: [input + "-1"] });
  const backend = (owner as any).backend;
  backend.root = root;
  let discarded = 0;
  t.mock.method(backend, "assertWorkspaceCurrent", async () => {});
  t.mock.method(backend, "discardSnapshot", async () => { discarded++; });
  backend.vm = { calls: [], async invoke() {
    execute(fs, path, createHash, isUtf8, () => assert.fail("image read must not spawn a shell"), { exitCode: 0 }, input, work, exchange, detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES);
  } };
  const ctx: any = { cwd: input, signal: boundary.signal, model: { input: ["text", "image"] }, sessionManager: { getSessionId: () => "image-read" } };
  t.after(async () => { await owner.close(); await boundary.dispose(); removeOwnedFixture(root); });
  return { root, input, work, exchange, owner, backend, boundary, ctx, get discarded() { return discarded; },
    read(args: any) { return owner.definition("read")!.execute("image", args, ctx.signal, undefined, ctx); } };
}

for (const mode of ["read-only", "sandbox-write"] as const) test(`sandbox ${mode} detects image bytes across both roots and preserves text windows`, async t => {
  const f = fixture(t, mode);
  fs.writeFileSync(path.join(f.input, "picture.dat"), png);
  fs.writeFileSync(path.join(f.input + "-1", "picture.txt"), png);
  fs.writeFileSync(path.join(f.input, "notes.png"), "first\nsecond\nthird");
  for (const file of ["picture.dat", path.join(f.input + "-1", "picture.txt")]) {
    const result = await f.read({ path: file, offset: 999, limit: 1 });
    const image = result.content.find(block => block.type === "image");
    assert.ok(image); assert.equal(image.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.data, "base64"), png);
    assert.equal(fs.readdirSync(f.exchange).filter(name => name.endsWith(".bin")).length, 0);
  }
  const text = await f.read({ path: "notes.png", offset: 2, limit: 1 });
  assert.equal(text.content.length, 1); assert.match((text.content[0] as any).text, /^second\n\n\[Snapshot: [a-f0-9]{64}\]$/);
  assert.equal(f.discarded, 0);
});

test("Windows temporary-directory spelling agrees with the backend's canonical artifact root", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t, "read-only", os.tmpdir().toUpperCase());
  assert.equal(f.root, await fs.promises.realpath(f.root));
  fs.writeFileSync(path.join(f.input, "preview.png"), png);
  const result = await f.read({ path: "preview.png" });
  const image = result.content.find(block => block.type === "image"); assert.ok(image);
  assert.deepEqual(Buffer.from(image.data, "base64"), png);
});

test("UTF-8-valid GIF is classified before text; unsupported binary and image capacity have actionable errors", async t => {
  const f = fixture(t);
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  // A header/palette containing only ASCII bytes is still an image, not a text window.
  const asciiGif = Buffer.from(gif); for (let i = 0; i < asciiGif.length; i++) asciiGif[i] &= 127;
  asciiGif.write("GIF89a");
  assert.ok(isUtf8(asciiGif)); fs.writeFileSync(path.join(f.input, "ascii.dat"), asciiGif);
  const read = await f.read({ path: "ascii.dat" });
  assert.match((read.content[0] as any).text, /Read image file/);
  fs.writeFileSync(path.join(f.input, "raw.bin"), Buffer.from([255, 0, 138]));
  const unsupported = await f.read({ path: "raw.bin" });
  assert.equal(unsupported.isError, true); assert.match((unsupported.content[0] as any).text, /Unsupported binary.*Convert other formats to PNG/);
  const huge = path.join(f.input, "huge.png"); fs.writeFileSync(huge, png); fs.truncateSync(huge, 16 * 1024 * 1024 + 1);
  const capacity = await f.read({ path: "huge.png" });
  assert.equal(capacity.isError, true); assert.match((capacity.content[0] as any).text, /Image bytes=16777217; limit=16777216/);
  assert.equal(f.discarded, 0, "ordinary read errors before attachment creation retain the VM");
});

test("JPEG, GIF, WebP and BMP share native image normalization", async t => {
  const f = fixture(t), photon = await loadPhoton(); assert.ok(photon);
  const decoded = photon.PhotonImage.new_from_byteslice(png);
  const bmp = Buffer.alloc(58); bmp.write("BM"); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp[56] = 255;
  const formats: [string, Uint8Array][] = [["jpeg", decoded.get_bytes_jpeg(80)], ["webp", decoded.get_bytes_webp()],
    ["gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")], ["bmp", bmp]];
  decoded.free();
  for (const [format, bytes] of formats) {
    fs.writeFileSync(path.join(f.input, "image-" + format + ".dat"), bytes);
    const result = await f.read({ path: "image-" + format + ".dat" });
    const image = result.content.find(block => block.type === "image"); assert.ok(image, format);
    assert.equal(image.mimeType, "image/" + (format === "bmp" ? "png" : format));
  }
});

const failures = {
  hash: /Artifact changed or hash mismatch/, size: /Invalid read image envelope/, mime: /Image signature mismatch/,
  name: /Invalid artifact envelope/, write: /Invalid read image envelope/, hardlink: /Redirected or resized artifact/,
  resized: /Redirected or resized artifact/, missing: /ENOENT/, release: /fixture release blocked/, abort: /EXECUTION_BOUNDARY_CHANGED/,
};
for (const fault of Object.keys(failures) as (keyof typeof failures)[]) test(`sandbox image rejects ${fault} and discards the failed owner`, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.input, "picture.png"), png);
  const original = f.backend.invoke.bind(f.backend);
  t.mock.method(f.backend, "invoke", async (...args: any[]) => {
    const reply = await original(...args);
    if (fault === "hash") reply.image.artifact.sha256 = "0".repeat(64);
    if (fault === "size") reply.image.artifact.bytes = 16 * 1024 * 1024 + 1;
    if (fault === "mime") reply.image.mimeType = "image/jpeg";
    if (fault === "name") reply.image.artifact.name = "../outside.bin";
    if (fault === "write") reply.changes = [{ path: "unrelated", before: null, content: "AA==" }];
    const artifactFile = path.join(f.exchange, reply.image.artifact.name);
    if (fault === "hardlink") fs.linkSync(artifactFile, path.join(f.root, "hardlink"));
    if (fault === "resized") fs.appendFileSync(artifactFile, "x");
    if (fault === "missing") fs.unlinkSync(artifactFile);
    return reply;
  });
  if (fault === "release") t.mock.method(f.backend, "releaseArtifact", async () => { throw new Error("fixture release blocked"); });
  // The signal captured at submission is stable; abort after byte validation separately.
  if (fault === "abort") {
    const candidate = f.backend.candidate.bind(f.backend);
    t.mock.method(f.backend, "candidate", async (...args: any[]) => { const value = await candidate(...args); await f.boundary.dispose(); return value; });
  }
  await assert.rejects(f.read({ path: "picture.png" }), failures[fault]);
  assert.equal(f.discarded, 1);
});

test("sandbox read → CodeMode show(ref) returns a complete native image block", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.input, "picture.png"), png);
  const codemode = new CodemodeController(() => {});
  const tools = [wrapToolDefinition(f.owner.definition("read")!, () => f.ctx)];
  const dispatch = new NestedToolDispatch("image-parent", () => tools, async (call, tool, signal) => {
    const result = await tool!.execute(call.id, structuredClone(call.arguments), signal);
    return { ...result, role: "toolResult", toolCallId: call.id, toolName: call.name, isError: result.isError === true, timestamp: 1 };
  }, f.ctx.signal);
  codemode.setTools(tools);
  let savedDirectory: string | undefined;
  try {
    const result = await codemode.definition.execute("image-parent", { code: "const r=await tools.read({path:'picture.png'}); await show(r.ref);" }, f.ctx.signal, undefined, f.ctx, dispatch);
    savedDirectory = (result.details as any)?.codemode?.imageFiles?.directory;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const image = result.content.find(block => block.type === "image"); assert.ok(image);
    assert.deepEqual(Buffer.from(image.data, "base64"), png);
    assert.equal(fs.readdirSync(f.exchange).filter(name => name.endsWith(".bin")).length, 0);
  } finally {
    await codemode.close(); await dispatch.close();
    if (savedDirectory) removeOwnedFixture(savedDirectory);
  }
});
