import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { shutdownManagedBrowser } from "@super-pi/chrome-devtools/browser-manager";
import { inspectBashResourceLifecycle } from "./core.ts";
import { SessionPermissionController } from "./permission-controller.ts";

const CHROME_TOOL_PREFIX = "chrome_devtools_";
const DEFAULT_SCREENSHOT_PREFIX = "sp-chrome-devtools-screenshot-";
const DEFAULT_SCREENSHOT_SUFFIX = ".png";

const INVALIDATED = "Blocked by policy: authorized Bash request or authority changed before invocation. Submit the final request for current authorization; the protected tool was not invoked.";

/** One call owns this state. Bash carries no path/browser permission attachment. */
class BashInvocationAuthorization {
  constructor(
    private input: Record<string, unknown> | undefined,
    private command: unknown, private timeout: unknown,
    private ctx: ExtensionContext | undefined,
    private permissions: SessionPermissionController | undefined,
    private readonly cwd: string, private readonly sessionId: string,
    private readonly generation: number, private readonly sequence: number,
    private readonly id: string,
  ) {}
  consume(args: unknown, id: string, name: string, signal?: AbortSignal): unknown {
    const ctx = this.ctx, permissions = this.permissions;
    if (!ctx || !permissions || signal?.aborted || args !== this.input || name !== "bash" || id !== this.id
      || ctx.cwd !== this.cwd || ctx.sessionManager.getSessionId() !== this.sessionId
      || permissions.authorityGeneration !== this.generation || permissions.state.sequence !== this.sequence) throw new Error(INVALIDATED);
    // Refuse accessor substitution rather than invoking externally installed getters.
    const command = Object.getOwnPropertyDescriptor(args, "command");
    const timeout = Object.getOwnPropertyDescriptor(args, "timeout");
    if (!command || !("value" in command) || command.value !== this.command
      || (timeout && !("value" in timeout)) || timeout?.value !== this.timeout) throw new Error(INVALIDATED);
    // The runner borrows the checked primitive fields and materializes exactly
    // one invocation container after every successful check agrees.
    return this;
  }
  release(): void {
    this.input = undefined; this.command = undefined; this.timeout = undefined;
    this.ctx = undefined; this.permissions = undefined;
  }
}

function isOwnedDefaultScreenshotPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const path = resolve(value);
  const name = basename(path);
  return dirname(path) === resolve(tmpdir())
    && name.startsWith(DEFAULT_SCREENSHOT_PREFIX)
    && name.endsWith(DEFAULT_SCREENSHOT_SUFFIX);
}

class OwnedResourceCleaner {
  readonly #defaultScreenshots = new Set<string>();
  #chromeUsed = false;
  #cleanupPromise?: Promise<void>;

  markChromeUsed(): void {
    this.#chromeUsed = true;
  }

  trackScreenshot(path: string): void {
    this.#defaultScreenshots.add(path);
  }

  cleanup(): Promise<void> {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = this.#runCleanupWithReset();
    return this.#cleanupPromise;
  }

  async #runCleanupWithReset(): Promise<void> {
    try {
      await this.#runCleanup();
    } finally {
      this.#cleanupPromise = undefined;
    }
  }

  async #runCleanup(): Promise<void> {
    const failures: string[] = [];
    for (const path of this.#defaultScreenshots) {
      try {
        await rm(path, { force: true });
        this.#defaultScreenshots.delete(path);
      } catch (error) {
        failures.push(`temporary screenshot ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
		if (this.#chromeUsed) {
			try {
				await shutdownManagedBrowser();
        this.#chromeUsed = false;
      } catch (error) {
        failures.push(`managed Chrome: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) console.warn(`[resource-lifecycle-guard] Cleanup incomplete:\n- ${failures.join("\n- ")}`);
  }
}

export default function resourceLifecycleGuard(pi: ExtensionAPI): void {
  const permissions = new SessionPermissionController(pi);
  const resources = new OwnedResourceCleaner();
  permissions.registerCommands();

  pi.on("session_start", async (_event, ctx) => {
    await permissions.restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await permissions.restore(ctx);
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${permissions.systemGuidance()}`,
  }));

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName.startsWith(CHROME_TOOL_PREFIX)) resources.markChromeUsed();
    // Side-effect-free Bash denial only; acceptance still requires current permission.
    const bashCommand = event.toolName === "bash" ? event.input.command : undefined;
    const bashTimeout = event.toolName === "bash" ? event.input.timeout : undefined;
    const bash = event.toolName === "bash";
    const id = event.toolCallId;
    const cwd = bash ? ctx.cwd : "";
    const sessionId = bash ? ctx.sessionManager.getSessionId() : "";
    const generation = permissions.authorityGeneration;
    if (event.toolName === "bash") {
      const reason = inspectBashResourceLifecycle(event.input);
      if (reason) return { block: true, reason };
    }
    const permissionBlock = await permissions.authorizeToolCall(event, ctx);
    if (permissionBlock) return permissionBlock;
    // Neither lifecycle acceptance nor the original approval authorizes a replacement.
    if (bash) {
      if (event.toolName !== "bash" || event.toolCallId !== id || event.input.command !== bashCommand
        || event.input.timeout !== bashTimeout || ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== sessionId
        || permissions.authorityGeneration !== generation) return {
        block: true,
        reason: "Blocked by policy: command changed during permission handling. Submit the final exact command for current authorization; no replacement was executed.",
      };
      return { finalAuthorization: new BashInvocationAuthorization(event.input, bashCommand, bashTimeout,
        ctx, permissions, cwd, sessionId, generation, permissions.state.sequence, id) };
    }
    if (event.toolName !== "powershell") return undefined;
    const reason = inspectBashResourceLifecycle(event.input);
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "chrome_devtools_screenshot") return undefined;
    const details = event.details as { savedPath?: unknown; isDefaultPath?: unknown } | undefined;
    if (details?.isDefaultPath === true && isOwnedDefaultScreenshotPath(details.savedPath)) {
      resources.trackScreenshot(details.savedPath);
    }
    return undefined;
  });

  pi.on("agent_settled", () => resources.cleanup());
  pi.on("session_shutdown", () => resources.cleanup());
}
