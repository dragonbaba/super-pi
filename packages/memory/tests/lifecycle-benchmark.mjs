import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createExtensionHarness, emitAll } from "./extension-harness.mjs";

const agentDirectory = await mkdtemp(join(tmpdir(), "super-pi-memory-lifecycle-"));
const projectDirectory = join(agentDirectory, "project");
await mkdir(projectDirectory);
process.env.SP_CODING_AGENT_DIR = agentDirectory;

try {
  const extension = (await import("../dist/index.js")).default;
  const harness = createExtensionHarness();
  const registrationStart = performance.now();
  extension(harness.api);
  const registrationMs = performance.now() - registrationStart;

  assert.deepEqual([...harness.handlers.keys()].sort(), [
    "before_agent_start",
    "resources_discover",
    "session_shutdown",
    "session_start",
  ]);
  assert.equal(harness.commands.has("memory-index-sessions"), false);

  const startupStart = performance.now();
  await emitAll(harness, "session_start", { type: "session_start", reason: "startup" }, { cwd: projectDirectory });
  const startupMs = performance.now() - startupStart;
  const shutdownStart = performance.now();
  await emitAll(harness, "session_shutdown", { type: "session_shutdown", reason: "exit" }, { cwd: projectDirectory });
  const shutdownMs = performance.now() - shutdownStart;

  assert.ok(registrationMs < 5_000);
  assert.ok(startupMs < 5_000);
  assert.ok(shutdownMs < 5_000);
  const rootEntries = await readdir(agentDirectory, { recursive: true });
  assert.equal(rootEntries.some((name) => name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith(".lock")), false);
  console.log(JSON.stringify({ registrationMs, startupMs, shutdownMs, registeredTools: harness.tools.size }));
} finally {
  await rm(agentDirectory, { recursive: true, force: true });
}
