import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { encodingFixture } from "./helpers/image-encoding-fixtures.ts";

const distRoot = "../packages/coding-agent/dist/core/";
const SandboxTools: typeof WorkspaceSandboxTools = process.env.SUPERPI_SANDBOX_USE_DIST === "1"
  ? (await import(distRoot + "sandbox/workspace-tools.js")).WorkspaceSandboxTools : WorkspaceSandboxTools;
const enabled = process.platform === "win32" && process.env.SUPERPI_SANDBOX_LIVE === "1";
for (const mode of ["read-only", "sandbox-write"] as const) test(`live image read: ${mode}, primary + additional workspace, complete bytes and release`, { skip: !enabled, timeout: 180000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-image-live-")));
  const project = path.join(root, "项目 space"), assets = path.join(root, "素材"), artifacts = path.join(root, "owner");
  for (const directory of [project, assets, artifacts]) await fs.mkdir(directory);
  const png = Buffer.from(await encodingFixture("transparent", 256, 256)); assert.ok(png.length > 32768);
  await fs.writeFile(path.join(project, "preview.png"), png);
  await fs.writeFile(path.join(assets, "contact.dat"), png);
  const runtime = createExtensionRuntime();
  const owner = new SandboxTools(project, artifacts, mode, () => runtime, { directories: [assets], network: "disabled" });
  const ctx: any = { cwd: project, signal: runtime.executionBoundary.signal, model: { input: ["text", "image"] }, sessionManager: { getSessionId: () => "image-live" } };
  try {
    for (const file of ["preview.png", path.join(assets, "contact.dat")]) {
      const result = await owner.definition("read")!.execute("live-image", { path: file }, ctx.signal, undefined, ctx);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const image = result.content.find(block => block.type === "image"); assert.ok(image);
      assert.deepEqual(Buffer.from(image.data, "base64"), png);
      assert.equal((await fs.readdir(path.join(owner.diagnostics.root!, "exchange"))).filter(name => name.endsWith(".bin")).length, 0);
    }
    assert.equal(owner.diagnostics.starts, 1); assert.equal(owner.diagnostics.calls, 2);
    console.log("SANDBOX_IMAGE_LIVE " + JSON.stringify({ mode, dist: process.env.SUPERPI_SANDBOX_USE_DIST === "1", imageBytes: png.length, imageReads: 2, starts: 1, attachmentsRemaining: 0 }));
  } finally {
    await owner.close(); await runtime.executionBoundary.dispose();
    assert.equal(owner.diagnostics.vm, false); assert.equal(owner.diagnostics.pending, false);
    assert.equal(owner.diagnostics.ownedArtifacts, 0); assert.equal(owner.diagnostics.sourceFiles, 0);
    assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true });
  }
});
