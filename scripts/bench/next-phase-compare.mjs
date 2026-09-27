import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runMeasuredChild } from "./next-phase-child.mjs";
import { captureBuiltArtifacts } from "./next-phase-build.mjs";

// Each scenario/implementation/round runs in its own process. Do not run other
// benchmarks concurrently. Raw logs and exact source coordinates remain separate.
const candidate = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), baseline = resolve(process.argv[2]), output = resolve(process.argv[3]);
mkdirSync(output); // Exclusive task directory: an earlier run is never overwritten.
const cases = [
  ["success", ["--test", join(candidate, "tests/next-phase-task-matrix.test.ts")], 600000],
  ["context", ["--test", "--test-name-pattern", "context matrix|overlimit", join(candidate, "tests/next-phase-recovery-matrix.test.ts")], 300000],
  ["io", [join(candidate, "scripts/bench/next-phase-file-io.ts")], 1200000],
  ["spill", [join(candidate, "scripts/bench/next-phase-output-spill.ts")], 300000],
  ["tui", [join(candidate, "scripts/bench/next-phase-tui-boundaries.ts")], 300000],
  ["full-replay", ["scripts/bench/tui-full-replay-backpressure.ts"], 1200000],
];
const coordinates = {};
for (const [label, project] of [["baseline", baseline], ["candidate", candidate]]) {
  coordinates[label] = { project, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8", windowsHide: true }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: project, encoding: "utf8", windowsHide: true }).trim(),
    status: execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8", windowsHide: true }).trim() };
  assert.equal(coordinates[label].status, "", `${label} must be clean for final comparisons`);
}
writeFileSync(join(output, "coordinates.json"), JSON.stringify({ node: process.version, platform: process.platform, rounds: 5, warmup: "each full scenario has its normal warmup; initial whole process pair discarded", coordinates }, null, 2));
const controller = new AbortController();
function interrupt() { controller.abort(); }
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
try {
const npm = process.env.npm_execpath;
assert.ok(npm && existsSync(npm), "Run via npm or set npm_execpath to the installed npm CLI; builds do not download dependencies.");
for (const label of ["baseline", "candidate"]) {
  const coordinate = coordinates[label], project = coordinate.project;
  await runMeasuredChild({ executable: process.execPath, args: [npm, "run", "build:offline"], project,
    file: join(output, label + "-build.log"), ledger: join(output, "owned-processes.jsonl"), env: process.env,
    tag: label + "-build", deadlineMs: 300000, signal: controller.signal });
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8", windowsHide: true }).trim(), coordinate.head);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8", windowsHide: true }).trim(), "");
  const manifest = captureBuiltArtifacts(project); coordinate.buildSha256 = manifest.sha256; coordinate.lockfileSha256 = manifest.lockfileSha256;
  writeFileSync(join(output, label + "-built-artifacts.json"), JSON.stringify(manifest, null, 2));
}
writeFileSync(join(output, "coordinates.json"), JSON.stringify({ node: process.version, platform: process.platform, rounds: 5,
  warmup: "one full scenario process pair discarded before five measured pairs", offlineBuilds: 2, coordinates }, null, 2));
for (let round = 0; round <= 5; round++) {
  for (const [scenario, args, deadlineMs] of cases) for (const label of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
    const project = coordinates[label].project, tag = `${round === 0 ? "warmup" : "round" + round}-${scenario}-${label}`;
    await runMeasuredChild({ executable: process.execPath, args: ["--expose-gc", "--experimental-strip-types", ...args], project, file: join(output, tag + ".log"),
      ledger: join(output, "owned-processes.jsonl"), env: { ...process.env, SP_COST_PROJECT_ROOT: project, SP_COST_LABEL: label }, tag, deadlineMs, signal: controller.signal });
    console.log(tag + " PASS");
  }
}
for (const label of ["baseline", "candidate"]) {
  const coordinate = coordinates[label], manifest = captureBuiltArtifacts(coordinate.project);
  assert.equal(manifest.sha256, coordinate.buildSha256, `${label} built artifacts changed during measurement`);
  assert.equal(manifest.lockfileSha256, coordinate.lockfileSha256);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: coordinate.project, encoding: "utf8", windowsHide: true }).trim(), coordinate.head);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: coordinate.project, encoding: "utf8", windowsHide: true }).trim(), "");
}
writeFileSync(join(output, "completed.json"), JSON.stringify({ complete: true, at: Date.now(), independentMeasuredProcesses: 60, warmupProcesses: 12 }));
} finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
