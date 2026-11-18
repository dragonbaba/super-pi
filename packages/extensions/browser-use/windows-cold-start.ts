import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { BrowserUseRunOptions, BrowserUseRunResult } from "./runner.ts";

const STARTED = "\x1e[super-pi:browser-script-started]\x1e";
const START_MARKER_CODE = `import os as _pi_startup_os\n_pi_startup_os.write(2, ${JSON.stringify(STARTED)}.encode("ascii"))\n`;
const DEFAULT_DAEMON_FAILURE = /^browser-harness: daemon default didn't come up -- check [^\r\n]+$/u;
// Match Browser Harness 0.1.13's Windows process names in tasklist's CSV output.
const BROWSER_PROCESS = /(?:^|\n)"(?:chrome|msedge|chromium|brave|helium)\.exe",/iu;
const TASKLIST_TIMEOUT_MS = 5_000;
const TASKLIST_MAX_BYTES = 256 * 1024;

type Run = (options: BrowserUseRunOptions) => Promise<BrowserUseRunResult>;
type Launch = (options: BrowserUseRunOptions, run: Run, assertCurrent: () => void) => Promise<boolean>;

export function needsWindowsColdStartWorkaround(version: string, env: NodeJS.ProcessEnv, platform = process.platform): boolean {
  return platform === "win32" && version === "0.1.13"
    && !env.BU_NAME && !env.BU_CDP_URL && !env.BU_CDP_WS && !env.BU_BROWSER_ID
    && !env.BH_CHROME_PATH && !env.BU_AUTOSPAWN;
}

function observedExit(result: BrowserUseRunResult): boolean {
  return result.cleanup === "complete" && result.exitObserved && !result.killed && !result.timedOut && !result.aborted;
}

function stripStartedMarker(result: BrowserUseRunResult): boolean {
  const start = result.stderr.indexOf(STARTED);
  if (start < 0) return false;
  result.stderr = result.stderr.slice(0, start) + result.stderr.slice(start + STARTED.length);
  result.stderrBytes -= STARTED.length;
  return true;
}

/** Browser Harness runs this trusted prefix only after daemon startup succeeds. */
export async function runWithWindowsColdStart(
  options: BrowserUseRunOptions, run: Run, assertCurrent: () => void, launch: Launch = launchChromeIfStopped,
): Promise<BrowserUseRunResult> {
  const deadline = performance.now() + options.timeoutMs;
  const marked = {
    ...options,
    code: START_MARKER_CODE + options.code,
    maxStderrBytes: options.maxBytesPerStream + STARTED.length,
  };
  const first = await run(marked);
  if (stripStartedMarker(first) || !observedExit(first) || first.exitCode !== 1
      || first.stdoutBytes !== 0 || first.stderrTruncated || !DEFAULT_DAEMON_FAILURE.test(first.stderr.trim())) return first;

  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0 || !await launch({ ...options, timeoutMs: remaining }, run, assertCurrent)) return first;
  const retryTime = Math.floor(deadline - performance.now());
  if (retryTime <= 0) return first;
  assertCurrent();
  options.signal?.throwIfAborted();
  const next = await run({ ...marked, timeoutMs: retryTime });
  stripStartedMarker(next);
  return next;
}

function startChrome(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise(resolve => {
    // Keep Chrome in the user's desktop session with its standard profile and lifetime.
    const chrome = spawn(command, [], { cwd: dirname(command), env, detached: true, stdio: "ignore" });
    chrome.once("error", () => resolve(false));
    chrome.once("spawn", () => { chrome.unref(); resolve(true); });
  });
}

export async function launchChromeIfStopped(
  options: BrowserUseRunOptions, run: Run, assertCurrent: () => void, env = process.env,
): Promise<boolean> {
  const deadline = performance.now() + options.timeoutMs;
  const systemRoot = env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return false;
  const processes = await run({
    command: join(systemRoot, "System32", "tasklist.exe"), args: ["/FO", "CSV", "/NH"],
    code: "", cwd: options.cwd, env: options.env, signal: options.signal,
    timeoutMs: Math.min(TASKLIST_TIMEOUT_MS, options.timeoutMs), maxBytesPerStream: TASKLIST_MAX_BYTES,
  });
  if (processes.cleanup !== "complete") {
    throw new Error("Browser process check cleanup is unconfirmed. Browser execution remains paused.");
  }
  if (!observedExit(processes) || processes.exitCode !== 0 || processes.stderrBytes !== 0 || processes.stdoutTruncated
      || !processes.stdout.startsWith('"') || BROWSER_PROCESS.test(processes.stdout)) return false;

  for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
    if (!root || !isAbsolute(root)) continue;
    const command = join(root, "Google", "Chrome", "Application", "chrome.exe");
    const file = await stat(command).catch(() => undefined);
    if (!file?.isFile()) continue;
    if (performance.now() >= deadline) return false;
    assertCurrent();
    options.signal?.throwIfAborted();
    return startChrome(command, env);
  }
  return false;
}
