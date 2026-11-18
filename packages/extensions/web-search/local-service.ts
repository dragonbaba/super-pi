import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LOCAL_SEARCH_BASE, LOCAL_SEARCH_ENDPOINT, localInstallRoot } from "./local-config.ts";
import { reserveLocalSearchJob, SERVICE_BOOTSTRAP, serviceEnvironment } from "./local-lifetime.ts";

const MANAGED_SOURCE = "https://github.com/searxng/searxng";
const STARTUP_TIMEOUT_MS = 8_000;
const HEALTH_POLL_MS = 200;
const REVISION = /^[a-f0-9]{40}$/u;
let pendingStart: Promise<void> | undefined;
let startingChild: ChildProcess | undefined;

function connectionRefused(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = error.cause;
  return !!cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED";
}

async function localHealthy(signal: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(LOCAL_SEARCH_BASE + "/healthz", { signal, redirect: "manual" });
  } catch (error) {
    if (connectionRefused(error)) return false;
    throw error;
  }
  if (response.status === 200 && response.headers.get("content-length") === "2") {
    if (await response.text() === "OK") return true;
  } else await response.body?.cancel();
  throw new Error("The local SearXNG health endpoint returned an unexpected response.");
}

async function launchInstalledService(signal: AbortSignal): Promise<ChildProcess> {
  const root = localInstallRoot();
  if (!root) throw new Error("Could not locate the managed Windows SearXNG installation.");
  const python = join(root, "venv", "Scripts", "python.exe");
  const entry = join(root, "serve.py");
  try {
    const manifest = JSON.parse(await readFile(join(root, "install.json"), "utf8"));
    const [runtime, script] = await Promise.all([stat(python), stat(entry)]);
    if (manifest?.endpoint !== LOCAL_SEARCH_BASE || manifest.source !== MANAGED_SOURCE
      || typeof manifest.upstream !== "string" || !REVISION.test(manifest.upstream)
      || !runtime.isFile() || !script.isFile()) throw new Error("Invalid installation.");
  } catch {
    throw new Error("The managed Windows SearXNG installation is missing or incomplete. Check SuperPi/SearXNG under LOCALAPPDATA.");
  }
  signal.throwIfAborted();
  const marker = reserveLocalSearchJob(root);
  const log = openSync(join(root, "stderr.log"), "a");
  try {
    // The service outlives this CLI session, including its temporary files.
    const child = spawn(python, ["-u", "-X", "utf8", SERVICE_BOOTSTRAP, "serve", entry, marker], {
      cwd: root, env: serviceEnvironment(root),
      detached: true, windowsHide: true, stdio: ["ignore", "ignore", log],
    });
    child.unref();
    await once(child, "spawn");
    return child;
  } finally {
    closeSync(log);
  }
}

async function startLocalService(): Promise<void> {
  const signal = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
  try {
    if (await localHealthy(signal)) {
      startingChild = undefined;
      return;
    }
    if (!startingChild || startingChild.exitCode !== null || startingChild.signalCode !== null) {
      startingChild = await launchInstalledService(signal);
    }
    for (;;) {
      if (await localHealthy(signal)) {
        startingChild = undefined;
        return;
      }
      if (startingChild.exitCode !== null || startingChild.signalCode !== null) {
        startingChild = undefined;
        throw new Error("Local SearXNG exited before it was ready. Check its stderr.log.");
      }
      await delay(HEALTH_POLL_MS, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) throw new Error("Local SearXNG did not become ready in time. Check its stderr.log.");
    throw error;
  }
}

function clearPendingStart(): void {
  pendingStart = undefined;
}

/** Recovery is limited to a request refused before a connection could be established. */
export async function recoverLocalSearxng(endpoint: URL, error: unknown, signal: AbortSignal): Promise<boolean> {
  if (endpoint.href !== LOCAL_SEARCH_ENDPOINT || !connectionRefused(error)) return false;
  signal.throwIfAborted();
  const operation = pendingStart ??= startLocalService().finally(clearPendingStart);
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([operation, cancellation]);
    signal.throwIfAborted();
    return true;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
