import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync, openSync, closeSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

// Each scenario/implementation/round runs in its own process. Do not run other
// benchmarks concurrently. Raw logs and exact source coordinates remain separate.
const candidate = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), baseline = resolve(process.argv[2]), output = resolve(process.argv[3]);
mkdirSync(output); // Exclusive task directory: an earlier run is never overwritten.
const cases = [
  ["success", ["--test", join(candidate, "tests/next-phase-task-matrix.test.ts")]],
  ["context", ["--test", "--test-name-pattern", "context matrix|overlimit", join(candidate, "tests/next-phase-recovery-matrix.test.ts")]],
  ["io", [join(candidate, "scripts/bench/next-phase-file-io.ts")]],
  ["spill", [join(candidate, "scripts/bench/next-phase-output-spill.ts")]],
  ["tui", [join(candidate, "scripts/bench/next-phase-tui-boundaries.ts")]],
  ["full-replay", ["scripts/bench/tui-full-replay-backpressure.ts"]],
];
const coordinates = {};
for (const [label, project] of [["baseline", baseline], ["candidate", candidate]]) {
  coordinates[label] = { project, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8", windowsHide: true }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: project, encoding: "utf8", windowsHide: true }).trim(),
    status: execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8", windowsHide: true }).trim() };
  assert.equal(coordinates[label].status, "", `${label} must be clean for final comparisons`);
}
writeFileSync(join(output, "coordinates.json"), JSON.stringify({ node: process.version, platform: process.platform, rounds: 5, warmup: "each full scenario has its normal warmup; initial whole process pair discarded", coordinates }, null, 2));
function runChild(project, args, file, env, tag) {
  return new Promise((resolveResult, reject) => {
    const fd = openSync(file, "wx"), child = spawn(process.execPath, ["--expose-gc", "--experimental-strip-types", ...args], { cwd: project, env, stdio: ["ignore", fd, fd], windowsHide: true });
    appendFileSync(join(output, "owned-processes.jsonl"), JSON.stringify({ tag, pid: child.pid, file, started: Date.now() }) + "\n");
    child.once("error", reject);
    child.once("close", code => { closeSync(fd); appendFileSync(join(output, "owned-processes.jsonl"), JSON.stringify({ tag, pid: child.pid, code, closed: Date.now() }) + "\n"); code === 0 ? resolveResult() : reject(new Error(`${tag} exited ${code}; inspect ${file}`)); });
  });
}
for (let round = 0; round <= 5; round++) {
  for (const [scenario, args] of cases) for (const label of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
    const project = coordinates[label].project, tag = `${round === 0 ? "warmup" : "round" + round}-${scenario}-${label}`;
    await runChild(project, args, join(output, tag + ".log"), { ...process.env, SP_COST_PROJECT_ROOT: project, SP_COST_LABEL: label }, tag);
    console.log(tag + " PASS");
  }
}
writeFileSync(join(output, "completed.json"), JSON.stringify({ complete: true, at: Date.now(), independentMeasuredProcesses: 60, warmupProcesses: 12 }));
