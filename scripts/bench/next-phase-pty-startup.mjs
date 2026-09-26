// Launch this harness inside a real PTY. Its child inherits that PTY and enters
// the formal source launcher. Send "n4-probe\r", then "/quit\r" after tool-ready.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const project = resolve(process.argv[2]), report = resolve(process.argv[3]);
assert.equal(process.stdin.isTTY, true); assert.equal(process.stdout.isTTY, true);
writeFileSync(report, "", { flag: "wx" });
const root = mkdtempSync(join(tmpdir(), "sp-n4-pty-")), work = join(root, "work"), agent = join(root, "agent"), home = join(root, "home");
appendFileSync(report, JSON.stringify({ phase: "owned-root", root }) + "\n");
mkdirSync(work); mkdirSync(agent); mkdirSync(home);
writeFileSync(join(work, "ready.txt"), "N4_PTY_ACTUAL_READ_中文\n");
writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, compaction: { enabled: false }, retry: { enabled: false }, theme: "dark" }));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8", windowsHide: true }).trim();
const source = fileURLToPath(new URL("../../tests/fixtures/next-phase-pty-provider.mjs", import.meta.url));
const preload = pathToFileURL(fileURLToPath(new URL("../../tests/fixtures/next-phase-pty-preload.mjs", import.meta.url))).href;
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: process.env.TEMP, TMP: process.env.TMP,
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, SP_CODING_AGENT_DIR: agent, SP_CODING_AGENT_SESSION_DIR: join(agent, "sessions"),
  SP_OFFLINE: "1", SP_TUI_WRITE_LOG: "", N4_PTY_PROJECT: project, N4_PTY_REPORT: report, TERM: "xterm-256color" };
let stage = "cold";
function launch() {
  appendFileSync(report, JSON.stringify({ phase: "launch", timestamp: Date.now(), head, project, node: process.version, root, stdinTTY: true, stdoutTTY: true, label: process.argv[4] ?? "initial", stage }) + "\n");
  const child = spawn(process.execPath, ["--import", preload, join(project, "scripts/superpi.mjs"), "--offline", "--no-session",
    "--provider", "n4-pty-fixture", "--model", "fixture", "--extension", source], { cwd: work, env, windowsHide: true, stdio: "inherit" });
  appendFileSync(report, JSON.stringify({ phase: "owned-child", pid: child.pid, timestamp: Date.now(), stage }) + "\n");
  child.once("close", finish);
  child.once("error", launchFailed);
}
function launchFailed(error) { appendFileSync(report, JSON.stringify({ phase: "launch-error", code: error.code }) + "\n"); }
function finish(code, signal) {
  try {
    const entries = readFileSync(report, "utf8").trim().split("\n").map(JSON.parse);
    const end = entries.findLast(entry => entry.phase === "process-exit"), shutdown = entries.findLast(entry => entry.phase === "session-shutdown");
    assert.equal(code, 0); assert.equal(end?.networkAttempts, 0); assert.equal(shutdown?.requests, 2); assert.equal(shutdown?.executions, 1);
    appendFileSync(report, JSON.stringify({ phase: "child-verified", stage, timestamp: Date.now() }) + "\n");
    if (stage === "cold" && process.argv[5] === "pair") { stage = "warm"; launch(); return; }
  } catch (error) { code = 1; appendFileSync(report, JSON.stringify({ phase: "verification-failed", message: error.message }) + "\n"); }
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
  appendFileSync(report, JSON.stringify({ phase: "released", timestamp: Date.now(), code, signal, removedRoot: root }) + "\n"); process.exitCode = code ?? 1;
}
launch();
