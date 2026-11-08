import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

process.env.SP_CHROME_DEVTOOLS_AUTO_LAUNCH = "0";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { default: chromeDevtools } = await jiti.import<any>("../packages/chrome-devtools/src/chrome-devtools.ts");
// Mock the already-loaded dependency: a second Windows import can create a
// distinct cache entry for slash/backslash spellings of the same source file.
const { screenshotTool } = jiti.cache[fileURLToPath(new URL("../packages/chrome-devtools/src/tools.ts", import.meta.url))]!.exports;
const { saveScreenshot } = jiti.cache[fileURLToPath(new URL("../packages/chrome-devtools/src/screenshot.ts", import.meta.url))]!.exports;

function host() {
  const tools = new Map<string, any>(), handlers = new Map<string, any>();
  const warnings: string[] = [];
  chromeDevtools({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on: (name: string, handler: any) => handlers.set(name, handler) });
  const ctx = { cwd: tmpdir(), ui: { setStatus() {}, notify(message: string) { warnings.push(message); } } };
  return { warnings, async capture(savePath?: string) { return tools.get("chrome_devtools_screenshot").execute("fixture", { savePath }, undefined, undefined, ctx); },
    async emit(event: string) { await handlers.get(event)?.({ type: event }, ctx); } };
}

test("Chrome owns default screenshots without the legacy guard and isolates extension instances", async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "sp-chrome-owned-"));
  const old = [process.env.TMP, process.env.TEMP, process.env.TMPDIR];
  process.env.TMP = process.env.TEMP = process.env.TMPDIR = root;
  const capture = t.mock.method(screenshotTool, "execute", async (_id: string, params: any, _signal: unknown, _update: unknown, ctx: any) => ({
    content: [], details: await saveScreenshot(Buffer.from("synthetic PNG bytes").toString("base64"), params.savePath, ctx.cwd),
  }));
  const first = host(), second = host();
  try {
    const firstShot = (await first.capture()).details.savedPath;
    const secondShot = (await second.capture()).details.savedPath;
    const custom = (await first.capture("keep.png")).details.savedPath;
    assert.equal(capture.mock.callCount(), 3, "Only the synthetic producer may run");
    const unrelated = path.join(root, "sp-chrome-devtools-screenshot-unrelated.png"); await fs.writeFile(unrelated, "keep");
    await first.emit("agent_settled");
    await assert.rejects(fs.stat(firstShot), { code: "ENOENT" });
    await fs.stat(secondShot);
    await second.emit("session_shutdown");
    await assert.rejects(fs.stat(secondShot), { code: "ENOENT" });
    assert.equal(await fs.readFile(custom, "utf8"), "synthetic PNG bytes");
    assert.equal(await fs.readFile(unrelated, "utf8"), "keep");
    assert.deepEqual(first.warnings, []); assert.deepEqual(second.warnings, []);
  } finally {
    await first.emit("session_shutdown"); await second.emit("session_shutdown");
    for (const [index, key] of ["TMP", "TEMP", "TMPDIR"].entries()) { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed screenshot cleanup reports the file, continues, and retries only retained paths", async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "sp-chrome-retry-"));
  const old = [process.env.TMP, process.env.TEMP, process.env.TMPDIR];
  process.env.TMP = process.env.TEMP = process.env.TMPDIR = root;
  t.mock.method(screenshotTool, "execute", async (_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: any) => ({
    content: [], details: await saveScreenshot(Buffer.from("synthetic").toString("base64"), undefined, ctx.cwd),
  }));
  const owner = host();
  try {
    const blocked = (await owner.capture()).details.savedPath;
    const other = (await owner.capture()).details.savedPath;
    // A directory at the recorded file path causes a real non-recursive removal
    // failure on every supported platform, without OS-specific open-file mocks.
    await fs.unlink(blocked); await fs.mkdir(blocked);
    await owner.emit("agent_settled");
    assert.equal(owner.warnings.length, 1); assert.ok(owner.warnings[0]!.includes(blocked));
    await fs.stat(blocked); await assert.rejects(fs.stat(other), { code: "ENOENT" });
    await fs.rmdir(blocked); await fs.writeFile(blocked, "retry");
    await owner.emit("session_shutdown");
    await assert.rejects(fs.stat(blocked), { code: "ENOENT" });
    await fs.writeFile(blocked, "new owner");
    await owner.emit("session_shutdown");
    assert.equal(await fs.readFile(blocked, "utf8"), "new owner", "Successful cleanup releases its path reference");
    assert.equal(owner.warnings.length, 1);
  } finally {
    for (const [index, key] of ["TMP", "TEMP", "TMPDIR"].entries()) { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
