import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../coding-agent/dist/modes/rpc/rpc-client.js";

const packageDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(packageDirectory, "../..");
const agentDirectory = await mkdtemp(join(tmpdir(), "super-pi-memory-rpc-"));
const projectDirectory = join(agentDirectory, "project");
await mkdir(projectDirectory);
const client = new RpcClient({
  cliPath: join(repositoryRoot, "packages", "coding-agent", "dist", "cli.js"),
  cwd: projectDirectory,
  // This smoke only queries state/commands; a synthetic key enables model discovery without a network request.
  env: { SP_CODING_AGENT_DIR: agentDirectory, OPENAI_API_KEY: "test-only-no-network",
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
  args: [
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--extension",
    join(packageDirectory, "dist", "index.js"),
  ],
});

try {
  await client.start();
  const state = await client.getState();
  assert.equal(state.isStreaming, false);
  const commands = await client.getCommands();
  const names = new Set(commands.map((command) => command.name));
  assert.equal(names.has("memory"), true);
  for (const retired of ["memory-review", "memory-cleanup", "memory-skills", "memory-sync-markdown"]) {
    assert.equal(names.has(retired), false);
  }
  assert.equal(names.has("memory-index-sessions"), false);
  console.log(JSON.stringify({ sessionId: state.sessionId, memoryCommands: [...names].filter((name) => name.startsWith("memory")) }));
} finally {
  await client.stop();
  await rm(agentDirectory, { recursive: true, force: true });
}
