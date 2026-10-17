import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
export const { inspectBashResourceLifecycle, inspectHighRiskBashMutation } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/core.ts")>("../../packages/extensions/resource-lifecycle-guard/core.ts");
export const { inspectPowerShellResourceLifecycle } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/powershell-lifecycle.ts")>("../../packages/extensions/resource-lifecycle-guard/powershell-lifecycle.ts");
export const { inspectBashPermissionScope } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/permission-bash.ts")>("../../packages/extensions/resource-lifecycle-guard/permission-bash.ts");
export const { SessionPermissionController } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/permission-controller.ts")>("../../packages/extensions/resource-lifecycle-guard/permission-controller.ts");
export const guard = await jiti.import<typeof import("../../packages/extensions/tool-loop-guardrails/core.ts")>("../../packages/extensions/tool-loop-guardrails/core.ts");
export const { default: guardExtension } = await jiti.import<typeof import("../../packages/extensions/tool-loop-guardrails/index.ts")>("../../packages/extensions/tool-loop-guardrails/index.ts");

export const commands = [
  ["Python heredoc", "python - <<'EOF'\nprint(1)\nEOF"],
  ["redirected heredoc", "cat > f <<'EOF'\nhello\nEOF"],
  ["git commit stdin", "git commit -F - <<'EOF'\nfixture message\nEOF"],
  ["variable executable", '"$FFMPEG" -version'],
  ["substitution", "x=$(git rev-parse HEAD)"],
  ["PATH assignment", "export PATH=/usr/bin:$PATH; node -v"],
  ["environment activation", "source .venv/bin/activate && python --version"],
  ["subshell cwd", "( cd sub && make )"],
  ["Python -c control", 'python -c "print(1)"'],
  ["Node heredoc control", "node <<'EOF'\nconsole.log(1)\nEOF"],
] as const;

export function workspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "sp-r0-permissions-"));
  mkdirSync(join(root, "sub"));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  return root;
}

export async function permission(cwd: string, mode: "full-access" | "workspace-write", decision = "仅允许本次") {
  let dialogs = 0;
  const audit: unknown[] = [];
  const controller = new SessionPermissionController({ appendEntry: (_kind: string, data: unknown) => audit.push(data) } as never);
  const ctx = { cwd, hasUI: true, sessionManager: { getBranch: () => [], getSessionId: () => `r0-${mode}` },
    ui: { setStatus() {}, select: async (_title: string, choices: string[]) => {
      dialogs++; assert.ok(choices.includes("仅允许本次")); return decision;
    } } };
  await controller.restore(ctx as never);
  controller.state.setMode(mode); controller.state.setApprovalPolicy(mode === "full-access" ? "never-ask" : "ask");
  return { dialogs: () => dialogs, audit, async authorize(command: string, toolName = "bash"): Promise<{ block: true; reason: string; details?: unknown } | undefined> {
    return controller.authorizeToolCall({ type: "tool_call", toolName, toolCallId: "fixture", input: { command } } as never, ctx as never);
  } };
}
