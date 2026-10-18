import { getShellCwdBinding, attachShellCwdBinding, prepareShellCwd, attachBackgroundShellLaunch, attachForegroundShellLaunch, validateBackgroundShellInput, type ShellCwdBinding } from "@super-pi/coding-agent";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { shutdownManagedBrowser } from "@super-pi/chrome-devtools/browser-manager";
import { inspectBashResourceLifecycle, isBlockingLifecycleReason } from "./core.ts";
import { ShellAnalysisOwner } from "./shell-analysis.ts";
import { inspectPowerShellResourceLifecycle } from "./powershell-lifecycle.ts";
import { SessionPermissionController } from "./permission-controller.ts";
import { registerChanges } from "../mutation-guard-write/changes.ts";
import { BackgroundShellTasks } from "./background-shell.ts";

const CHROME_TOOL_PREFIX = "chrome_devtools_";
const DEFAULT_SCREENSHOT_PREFIX = "sp-chrome-devtools-screenshot-";
const DEFAULT_SCREENSHOT_SUFFIX = ".png";

const INVALIDATED = "Blocked by policy: authorized Bash request or authority changed before invocation. Submit the final request for current authorization; the protected tool was not invoked.";

/** One call owns this state. Bash carries no path/browser permission attachment. */
class BashInvocationAuthorization {
  readonly finalAuthority = true as const;
  private binding?: ShellCwdBinding;
  private transferred = false;
  constructor(
    private input: Record<string, unknown> | undefined,
    private command: unknown, private timeout: unknown, private cwd: unknown, private purpose: unknown, private background: unknown,
    private ctx: ExtensionContext | undefined,
    private permissions: SessionPermissionController | undefined,
    private readonly sessionCwd: string, private readonly sessionId: string,
    private readonly generation: number, private readonly sequence: number,
    private readonly id: string, private readonly name: string, private backgroundTasks: BackgroundShellTasks | undefined,
    private readonly foregroundEligible: boolean, binding?: ShellCwdBinding,
  ) { this.binding = binding; }
  consume(args: unknown, id: string, name: string, signal?: AbortSignal): unknown {
    try {
    const ctx = this.ctx, permissions = this.permissions;
    if (!ctx || !permissions || signal?.aborted || args !== this.input || name !== this.name || id !== this.id
      || ctx.cwd !== this.sessionCwd || ctx.sessionManager.getSessionId() !== this.sessionId
      || permissions.authorityGeneration !== this.generation || permissions.state.sequence !== this.sequence) throw new Error(INVALIDATED);
    // Refuse accessor substitution rather than invoking externally installed getters.
    const command = Object.getOwnPropertyDescriptor(args, "command");
    const timeout = Object.getOwnPropertyDescriptor(args, "timeout");
    const cwd = Object.getOwnPropertyDescriptor(args, "cwd");
    const purpose = Object.getOwnPropertyDescriptor(args, "purpose");
    const background = Object.getOwnPropertyDescriptor(args, "background");
    if (!command || !("value" in command) || command.value !== this.command
      || (timeout && !("value" in timeout)) || timeout?.value !== this.timeout
      || (cwd && !("value" in cwd)) || cwd?.value !== this.cwd
      || (purpose && !("value" in purpose)) || purpose?.value !== this.purpose
      || (background && !("value" in background)) || background?.value !== this.background) throw new Error(INVALIDATED);
    const approved = { command: this.command, timeout: this.timeout, cwd: this.cwd, purpose: this.purpose, background: this.background };
    const binding = this.binding;
    if (getShellCwdBinding(args) !== binding || binding?.isReleased || (this.cwd !== undefined && !binding)) throw new Error(INVALIDATED);
    if (binding) {
      const sessionCwd = this.sessionCwd, sessionId = this.sessionId, generation = this.generation, sequence = this.sequence;
      const transferable = this.foregroundEligible && this.background !== true && typeof this.command === "string" && typeof this.cwd === "string"
        && typeof this.timeout === "number" && Number.isFinite(this.timeout) && this.timeout > 0 && this.timeout <= 7200
        && this.backgroundTasks?.canManageForeground(ctx, this.name);
      const invocationSignal = this.background === true || transferable ? undefined : signal;
      const assertCurrent = () => {
        if (invocationSignal?.aborted || ctx.cwd !== sessionCwd || ctx.sessionManager.getSessionId() !== sessionId
          || permissions.authorityGeneration !== generation || permissions.state.sequence !== sequence) throw new Error(INVALIDATED);
      };
      binding.setAuthority(assertCurrent);
      attachShellCwdBinding(approved, binding);
      if (this.background === true) {
        if (!this.backgroundTasks || typeof this.command !== "string" || typeof this.cwd !== "string") throw new Error(INVALIDATED);
        attachBackgroundShellLaunch(approved, this.backgroundTasks.createLaunch(this.name, id, this.command, binding.canonical, ctx, assertCurrent));
      } else if (transferable) {
        attachForegroundShellLaunch(approved, this.backgroundTasks!.createForegroundLaunch(this.name, id, this.command as string, binding.canonical, ctx, assertCurrent, () => binding.beforeSpawn(binding.canonical)));
      }
    }
    this.transferred = true;
    return approved;
    } finally { this.release(); }
  }
  release(): void {
    if (!this.transferred) this.binding?.release();
    this.binding = undefined;
    this.input = undefined; this.command = undefined; this.timeout = undefined;
    this.cwd = undefined; this.purpose = undefined; this.background = undefined; this.backgroundTasks = undefined;
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
  // Resolve only on a launcher refusal. Catalog materialization is never on
  // ordinary command/progress paths; the callback belongs to this extension.
  function nativePowerShellAvailability(): "active" | "discoverable" | "unavailable" {
    // AgentSession refuses to activate this builtin on non-Windows hosts,
    // even though its definition can still appear in the configured catalog.
    if (process.platform !== "win32") return "unavailable";
    try {
      const active = pi.getActiveTools();
      const nativeActive = active.includes("powershell");
      if (nativeActive || active.includes("tool_search")) {
        for (const tool of pi.getAllTools()) if (tool.name === "powershell" && tool.available !== false) return nativeActive ? "active" : "discoverable";
      }
    } catch { /* Loading/offline contexts cannot establish tool availability. */ }
    return "unavailable";
  }
  const permissions = new SessionPermissionController(pi);
  const resources = new OwnedResourceCleaner();
  const backgroundTasks = new BackgroundShellTasks(pi);
  permissions.registerCommands();
  registerChanges(pi, permissions);

  pi.on("session_start", async (_event, ctx) => {
    await permissions.restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await permissions.restore(ctx);
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${permissions.systemGuidance()}\nBash input: bounded heredoc bodies are distinguished from executable substitutions; literal interpreter input receives script checks. Shell state or lookup uncertainty without a recognized mutation follows opaque-input permissions: full-access with never-ask allows it; workspace-write requires approval. Recognized mutations with uncertain targets require one-time approval in every mode. Known catastrophic targets and unchanged user-rejected requests remain blocked. Raw background launches are refused only when session background management is available; otherwise they follow opaque-input permissions. Docker and system-managed services follow ordinary permissions. The original command and body are executed unchanged. Timeout is seconds: 60 means one minute. For long work, background: true with explicit cwd is available on supported local shell backends in a live TUI/RPC session with the tasks tool; keep the command itself foreground and use tasks to observe completion or cancel it. Native creation/editing, execution and cleanup retain their own read, path, permission and lifecycle requirements. Changing tools or language cannot authorize forbidden behavior.`,
  }));

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName.startsWith(CHROME_TOOL_PREFIX)) resources.markChromeUsed();
    // Side-effect-free Bash denial only; acceptance still requires current permission.
    const shell = event.toolName === "bash" || event.toolName === "powershell";
    const shellName = event.toolName;
    const bashCommand = shell ? event.input.command : undefined;
    const bashTimeout = shell ? event.input.timeout : undefined;
    const bashCwd = shell ? (event.input as Record<string, unknown>).cwd : undefined;
    const bashPurpose = shell ? (event.input as Record<string, unknown>).purpose : undefined;
    const bashBackground = shell ? (event.input as Record<string, unknown>).background : undefined;
    const topLevel = event.parentToolCallId === undefined;
    if (shell) validateBackgroundShellInput(event.input);
    if (bashBackground === true) backgroundTasks.assertAvailable(ctx, shellName);
    const bash = shell;
    const id = event.toolCallId;
    const cwd = bash ? ctx.cwd : "";
    const sessionId = bash ? ctx.sessionManager.getSessionId() : "";
    const generation = permissions.authorityGeneration;
    const preparedCwd = shell ? await prepareShellCwd(event.input as { cwd?: unknown }, ctx.cwd) : undefined;
    const analysis = event.toolName === "bash" && typeof bashCommand === "string"
      ? new ShellAnalysisOwner(bashCommand, preparedCwd?.canonical ?? cwd, generation) : undefined;
    let transferred = false;
    try {
    let lifecycleReason: string | undefined;
    if (event.toolName === "bash") {
      analysis?.assertCurrent(event.input.command, preparedCwd?.canonical ?? ctx.cwd, permissions.authorityGeneration);
      lifecycleReason = inspectBashResourceLifecycle(event.input, nativePowerShellAvailability, analysis);
    }
    if (event.toolName === "powershell") {
      lifecycleReason = inspectPowerShellResourceLifecycle(event.input);
    }
    const unmanagedLifecycle = lifecycleReason !== undefined && isBlockingLifecycleReason(lifecycleReason);
    if (lifecycleReason && unmanagedLifecycle
      && (lifecycleReason.startsWith("[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED]") || backgroundTasks.canManageForeground(ctx, event.toolName))) return { block: true, reason: lifecycleReason };
    const permissionBlock = await permissions.authorizeToolCall(event, ctx, analysis, lifecycleReason !== undefined);
    if (permissionBlock) return permissionBlock;
    // Neither lifecycle acceptance nor the original approval authorizes a replacement.
    if (bash) {
      if (getShellCwdBinding(event.input) !== preparedCwd || event.toolName !== shellName || event.toolCallId !== id || event.input.command !== bashCommand
        || event.input.timeout !== bashTimeout || (event.input as Record<string, unknown>).cwd !== bashCwd
        || (event.input as Record<string, unknown>).purpose !== bashPurpose
        || (event.input as Record<string, unknown>).background !== bashBackground
        || ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== sessionId
        || permissions.authorityGeneration !== generation) return {
        block: true,
        reason: "Blocked by policy: command changed during permission handling. Submit the final exact command for current authorization; no replacement was executed.",
      };
      // Lifecycle-gated calls skip the consume-time capability check; ordinary calls read it live only in consume.
      const finalAuthorization = new BashInvocationAuthorization(event.input, bashCommand, bashTimeout, bashCwd, bashPurpose, bashBackground,
        ctx, permissions, cwd, sessionId, generation, permissions.state.sequence, id, shellName, backgroundTasks, topLevel && !unmanagedLifecycle, preparedCwd);
      transferred = true;
      return { finalAuthorization };
    }
    return undefined;
    } finally {
      analysis?.release();
      if (!transferred) preparedCwd?.release();
    }
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
