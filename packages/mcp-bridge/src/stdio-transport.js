import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpCallError } from "./call.js";

// Use the pinned SDK's own command resolver, including Windows cmd/shebang quoting.
const sdkRequire = createRequire(import.meta.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const spawn = sdkRequire("cross-spawn");
const CLOSE_GRACE_MS = 1000;

function observeCloseFailure() {}
function cleanupError() {
  const error = new Error("[MCP_CLEANUP_UNCONFIRMED] The owned MCP process family has not confirmed cleanup.");
  error.stack = error.message;
  return error;
}

/** SDK 1.32.1 framing/send adapter; process ownership remains until actual cleanup. */
export class OwnedStdioTransport extends StdioClientTransport {
  #child;
  #job;
  #group;
  #started = false;
  #closed = false;
  #starting;
  #closing;
  #familyCleanup;
  #startup = new AbortController();
  #onData = chunk => {
    try { this._readBuffer.append(chunk); this.processReadBuffer(); }
    catch (error) { this.onerror?.(error); void this.close().catch(observeCloseFailure); }
  };
  #onError = error => { this.onerror?.(error); };
  #onExit = () => { void this.#stopFamily().catch(observeCloseFailure); };
  #onClose = () => {
    const child = this.#child;
    if (!child) return;
    child.stdout?.removeListener("data", this.#onData);
    child.stdout?.removeListener("error", this.#onError);
    child.stdin?.removeListener("error", this.#onError);
    child.stderr?.unpipe(this._stderrStream);
    child.removeListener("error", this.#onError);
    child.removeListener("exit", this.#onExit);
    child.removeListener("close", this.#onClose);
    this.#child = undefined;
    this._process = undefined;
    this._readBuffer.clear();
    void this.#stopFamily().catch(observeCloseFailure);
    this.onclose?.();
  };

  start() {
    if (this.#started || this.#closed) return Promise.reject(new Error("MCP transport has already started or closed."));
    if (typeof this._readBuffer?.append !== "function" || typeof spawn._parse !== "function") {
      return Promise.reject(new Error("MCP managed stdio adapter is incompatible with the installed SDK."));
    }
    this.#started = true;
    return this.#starting = this.#start();
  }

  async #start() {
    const config = this._serverParams;
    const env = { ...getDefaultEnvironment(), ...config.env };
    let child;
    if (process.platform === "win32") {
      const { WindowsShellJob } = await import("@super-pi/coding-agent/internal/windows-shell-job");
      this.#startup.signal.throwIfAborted();
      const parsed = spawn._parse(config.command, config.args ?? [], { cwd: config.cwd, env, shell: false });
      this.#job = await WindowsShellJob.spawn(parsed.command, parsed.args, config.cwd ?? process.cwd(), env, true,
        this.#startup.signal, undefined, parsed.options.windowsVerbatimArguments === true);
      child = this.#job.child;
    } else {
      this.#startup.signal.throwIfAborted();
      child = spawn(config.command, config.args ?? [], { cwd: config.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      this.#group = child.pid;
    }
    this.#child = child;
    this._process = child;
    child.stdout.on("data", this.#onData);
    child.stdout.on("error", this.#onError);
    child.stdin.on("error", this.#onError);
    child.on("error", this.#onError);
    child.once("exit", this.#onExit);
    child.once("close", this.#onClose);
    if (this._stderrStream) child.stderr.pipe(this._stderrStream);
    else child.stderr.resume();
    if (!this.#job) await new Promise((resolve, reject) => {
      const ready = () => { child.removeListener("error", failed); resolve(); };
      const failed = error => { child.removeListener("spawn", ready); reject(error); };
      child.once("spawn", ready); child.once("error", failed);
    });
    if (this.#job?.launchError) throw this.#job.launchError;
    if (this.#job?.dispatchError) throw new Error(this.#job.dispatchError);
  }

  close() {
    this.#closed = true;
    if (!this.#startup.signal.aborted) this.#startup.abort(new McpCallError("aborted"));
    return this.#closing ??= this.#close().catch(error => { this.#closing = undefined; throw error; });
  }

  async #close() {
    try {
      try { await this.#starting; } catch { /* Startup may still own a process. */ }
      const child = this.#child;
      if (child) {
        try { child.stdin.end(); } catch { /* Family termination below remains required. */ }
        await this.#waitForClose(child);
      }
      await this.#stopFamily();
      if (child && !(await this.#waitForClose(child))) throw cleanupError();
    } finally {
      this._readBuffer.clear();
      this.#starting = undefined;
      if (!this.#child) this._stderrStream?.destroy();
    }
  }

  #waitForClose(child) {
    if (this.#child !== child) return Promise.resolve(true);
    return new Promise(resolve => {
      const closed = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.removeListener("close", closed); resolve(false); }, CLOSE_GRACE_MS);
      child.once("close", closed);
    });
  }

  #stopFamily() {
    return this.#familyCleanup ??= Promise.resolve().then(() => this.#closeFamily()).catch(error => {
      // Keep the process/job identity, but do not cache a failed cleanup forever.
      this.#familyCleanup = undefined;
      throw error;
    });
  }

  async #closeFamily() {
    if (this.#job) {
      if (await this.#job.stop()) throw cleanupError();
      this.#job = undefined;
    }
    const group = this.#group;
    if (group === undefined) return;
    try { process.kill(-group, "SIGKILL"); }
    catch (error) {
      if (error.code === "ESRCH") { this.#group = undefined; return; }
      throw cleanupError();
    }
    const deadline = performance.now() + CLOSE_GRACE_MS;
    for (;;) {
      try { process.kill(-group, 0); }
      catch (error) {
        if (error.code === "ESRCH") { this.#group = undefined; return; }
        throw cleanupError();
      }
      if (performance.now() >= deadline) throw cleanupError();
      await delay(10);
    }
  }
}
