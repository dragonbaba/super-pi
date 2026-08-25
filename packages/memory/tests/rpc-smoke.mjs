import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  env: { SP_CODING_AGENT_DIR: agentDirectory },
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
  assert.equal(names.has("memory-review"), true);
  assert.equal(names.has("memory-cleanup"), true);
  assert.equal(names.has("memory-sync-markdown"), true);
  assert.equal(names.has("memory-index-sessions"), false);
  console.log(JSON.stringify({ sessionId: state.sessionId, memoryCommands: [...names].filter((name) => name.startsWith("memory")) }));
} finally {
  await client.stop();
  await rm(agentDirectory, { recursive: true, force: true });
}
