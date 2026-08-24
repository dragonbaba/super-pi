import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@super-pi/coding-agent";
import { shutdownManagedBrowser } from "@super-pi/chrome-devtools/browser-manager";
import { inspectBashResourceLifecycle } from "./core.ts";
import { SessionPermissionController } from "./permission-controller.ts";

const CHROME_TOOL_PREFIX = "chrome_devtools_";
const DEFAULT_SCREENSHOT_PREFIX = "sp-chrome-devtools-screenshot-";
const DEFAULT_SCREENSHOT_SUFFIX = ".png";

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
    const permissionBlock = await permissions.authorizeToolCall(event, ctx);
    if (permissionBlock) return permissionBlock;
    if (event.toolName !== "bash") return undefined;
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
