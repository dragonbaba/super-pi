import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceSandboxBackend } from "../../packages/coding-agent/dist/core/sandbox/workspace-backend.js";
import type { MxcProcess } from "../../packages/coding-agent/src/core/sandbox/mxc-process.ts";
import { windowsShellJobDiagnostics } from "../../packages/coding-agent/dist/utils/windows-shell-job.js";
import { removeOwnedFixture } from "../../tests/helpers/owned-fixture-cleanup.ts";
import { currentCommit } from "./benchmark.ts";

const BASELINE = "b9843f859441d9aa00a88c694cbd8f8a13f5ea56";
const COMMIT_ID = /^[a-f0-9]{40}$/i;
const WORKER = "packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs";
const PAIRS = 4;

// This benchmark exercises the production raw native transport. It deliberately
// bypasses the new host fact validator, which the baseline worker predates.
interface NativeTransport {
  mode: "read-only" | "sandbox-write";
  tools: string;
  exchange: string;
  roots: string[];
  executable: string;
  runner: Pick<MxcProcess, "run">;
  start(signal: AbortSignal): Promise<void>;
  policy(cwd: string, signal: AbortSignal): Promise<string>;
  executorEnvironment(): NodeJS.ProcessEnv;
}
const repository = fileURLToPath(new URL("../../", import.meta.url));
const baselineRef = process.argv[2] ?? BASELINE;
assert.match(baselineRef, COMMIT_ID, "Pass a full baseline commit SHA");
assert.equal(process.platform, "win32", "Native MXC comparison requires Windows");
const taskParent = await fs.realpath(os.tmpdir());
const commonGitDirectory = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: repository, windowsHide: true, encoding: "utf8",
}).trim();
const relative = path.relative(path.join(path.dirname(commonGitDirectory), ".task-tmp"), taskParent);
assert.ok(relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
  "Set child TMP/TEMP/TMPDIR to an owned directory under .task-tmp");
const root = await fs.mkdtemp(path.join(taskParent, "mxc-native-compare-"));
const identity = await fs.lstat(root, { bigint: true });
const project = path.join(root, "project");
const signal = new AbortController().signal;
const measurements: object[] = [];
let retainedOwners = 0;
let ownersReleased = true;
const initialJobCount = windowsShellJobDiagnostics().created;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function invoke(backend: WorkspaceSandboxBackend, outputMode = "content") {
  const transport = backend as unknown as NativeTransport;
  const id = randomUUID().replaceAll("-", "");
  const started = performance.now();
  const policy = await transport.policy(backend.workspace(), signal);
  const request = path.join(transport.tools, "request.json");
  await fs.writeFile(request, JSON.stringify({
    id, mode: transport.mode, workspaces: transport.roots, operation: "grep",
    input: { pattern: "needle", outputMode }, exchange: transport.exchange,
  }));
  const result = await transport.runner.run(transport.executable,
    [policy, "--", process.execPath, path.join(transport.tools, "worker.mjs"), request],
    backend.workspace(), transport.executorEnvironment(), signal, 30_000, 256 * 1024);
  const milliseconds = performance.now() - started;
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.id, id);
  assert.equal(reply.ok, true);
  return { reply, milliseconds, wireBytes: Buffer.byteLength(result.stdout) };
}
try {
  await fs.mkdir(project);
  const baselineWorker = execFileSync("git", ["show", baselineRef + ":" + WORKER], {
    cwd: repository, windowsHide: true,
    env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root },
  });
  const candidateWorker = await fs.readFile(new URL("../../packages/coding-agent/dist/core/sandbox/mxc-file-worker.mjs", import.meta.url));
  const corpusHash = createHash("sha256");
  const expectedRows: string[] = [], expectedPaths: string[] = [], expectedCounts: string[] = [];
  for (let file = 0; file < 6; file++) {
    const name = "file-" + file + ".txt", line = "needle needle: fixture " + file;
    const contents = (line + "\n").repeat(20);
    await fs.writeFile(path.join(project, name), contents);
    corpusHash.update(name + "\0" + contents + "\0");
    expectedPaths.push(name); expectedCounts.push(name + ":20");
    for (let row = 1; row <= 20; row++) expectedRows.push(name + ":" + row + ":" + line);
  }
  expectedRows.sort();
  for (const mode of ["read-only", "sandbox-write"] as const) {
    const baseline = new WorkspaceSandboxBackend(project, root, mode, { network: "disabled" });
    const candidate = new WorkspaceSandboxBackend(project, root, mode, { network: "disabled" });
    ownersReleased = false;
    try {
      const startupOrder = mode === "read-only" ? [baseline, candidate] : [candidate, baseline];
      for (const backend of startupOrder) await (backend as unknown as NativeTransport).start(signal);
      await fs.writeFile(path.join((baseline as unknown as NativeTransport).tools, "worker.mjs"), baselineWorker);
      const shell = await candidate.invoke("powershell", { command: "$PSVersionTable.PSVersion.ToString()" });
      assert.equal(shell.execution?.exitCode, 0);
      const samples: object[] = [];
      for (let pair = 0; pair < PAIRS; pair++) {
        const order = (pair + Number(mode === "sandbox-write")) % 2 ? [candidate, baseline] : [baseline, candidate];
        const sample: Record<string, { milliseconds: number; wireBytes: number }> = {};
        for (const backend of order) {
          const result = await invoke(backend);
          assert.deepEqual(result.reply.text.split("\n").sort(), expectedRows);
          if (backend === candidate) {
            assert.equal(result.reply.search.coverageComplete, true);
            assert.equal(result.reply.search.returnedRecords, 120);
          }
          sample[backend === candidate ? "candidate" : "baseline"] = {
            milliseconds: result.milliseconds, wireBytes: result.wireBytes,
          };
        }
        samples.push(sample);
      }
      const projections: Record<string, { milliseconds: number; wireBytes: number }> = {};
      for (const [outputMode, expected] of [["files", expectedPaths], ["count", expectedCounts]] as const) {
        const result = await invoke(candidate, outputMode);
        assert.equal(result.reply.search.coverageComplete, true);
        assert.deepEqual(result.reply.text.split("\n").sort(), expected);
        projections[outputMode] = { milliseconds: result.milliseconds, wireBytes: result.wireBytes };
      }
      measurements.push({ mode, powershell: shell.execution!.stdout.trim(), samples, projections });
    } finally {
      try { await baseline.close(); } finally { await candidate.close(); }
      for (const backend of [baseline, candidate]) {
        assert.equal(backend.diagnostics.root, undefined);
        assert.equal(backend.diagnostics.process.active, false);
        assert.equal(backend.diagnostics.process.retainedStreams, 0);
        retainedOwners += Number(backend.diagnostics.pending);
      }
      assert.equal(windowsShellJobDiagnostics().handles, 0);
      ownersReleased = true;
    }
  }
  assert.equal(retainedOwners, 0);
  assert.equal(windowsShellJobDiagnostics().handles, 0);
  assert.equal(windowsShellJobDiagnostics().processHandles, 0);
  const jobsCreated = windowsShellJobDiagnostics().created - initialJobCount;
  assert.ok(jobsCreated > 0, "Observe the same packaged Job owner used by the backend");
  console.log(JSON.stringify({
    baselineRef, candidateCommit: currentCommit(), baselineWorkerSha256: sha256(baselineWorker),
    candidateWorkerSha256: sha256(candidateWorker), corpusSha256: corpusHash.digest("hex"),
    windows: os.release(), node: process.version, mxcSdk: "1.0.1 (validated by backend)", measurements, retainedOwners, jobsCreated,
    note: "Warm native transport with reused owners. Process launch, policy and request writing are measured. Startup and provider projection are excluded.",
  }));
} finally {
  const current = await fs.lstat(root, { bigint: true });
  assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
  assert.equal(await fs.realpath(root), root);
  if (ownersReleased) removeOwnedFixture(root);
  else console.error("Native comparison retained its task root after incomplete owner cleanup: " + root);
}
