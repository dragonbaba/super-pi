import { openSync, closeSync, appendFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";

/** One benchmark-owned child. Deadlines apply to this recorded PID/tree only. */
export function runMeasuredChild({ executable, args, project, file, ledger, env, tag, deadlineMs, signal }) {
  return new Promise((resolve, reject) => {
    const fd = openSync(file, "wx");
    let child, timer, cleanupTimer, failure, recordFailure, settled = false;
    function record(fields) {
      try { appendFileSync(ledger, JSON.stringify({ tag, pid: child?.pid, file, ...fields }) + "\n"); }
      catch (error) { recordFailure ??= error; }
    }
    function finish(code, signalCode, cleanupIncomplete = false) {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener("abort", aborted);
      try { closeSync(fd); } catch (error) { recordFailure ??= error; }
      record({ code, signal: signalCode, closed: Date.now(), cleanupIncomplete });
      if (!failure && !recordFailure && code === 0 && !cleanupIncomplete) resolve();
      else reject(failure ?? recordFailure ?? new Error(`${tag} exited ${code}; inspect ${file}`));
    }
    function terminate(reason) {
      if (settled || failure) return;
      failure = reason; record({ terminationRequested: Date.now(), reason: reason.message });
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {
          if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "pipe", timeout: 5000 });
          else process.kill(-child.pid, "SIGKILL"); // Our detached child owns this group.
        } catch (error) {
          record({ terminationError: error.message });
          try { child.kill("SIGKILL"); } catch (fallbackError) { record({ terminationFallbackError: fallbackError.message }); }
        }
      }
      // A failed OS kill is reported as incomplete cleanup, never as successful
      // release. Bound the harness too; retain the recorded identity for diagnosis.
      cleanupTimer = setTimeout(() => { child?.unref(); finish(null, null, true); }, 5000);
    }
    function aborted() { terminate(new Error(`${tag} comparison aborted`)); }
    try {
      child = spawn(executable, args, { cwd: project, env, stdio: ["ignore", fd, fd], windowsHide: true, detached: process.platform !== "win32" });
      child.once("error", error => { failure = error; });
      child.once("close", finish);
      record({ started: Date.now(), deadlineMs });
      timer = setTimeout(() => terminate(new Error(`${tag} exceeded ${deadlineMs}ms deadline`)), deadlineMs);
      signal?.addEventListener("abort", aborted, { once: true }); if (signal?.aborted) aborted();
      if (recordFailure) terminate(recordFailure);
    } catch (error) { failure = error; finish(null, null); }
  });
}
