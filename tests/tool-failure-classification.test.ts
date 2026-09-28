import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { readShellExecution, type ShellExecutionFacts } from "../packages/coding-agent/src/core/tools/shell-execution.ts";

const jiti = createJiti(import.meta.url);
const { classifyToolFailure } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/failure-classification.ts");
const { default: loopGuardrails } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/index.ts");

function execution(termination: ShellExecutionFacts["termination"], producer: ShellExecutionFacts["producer"] = "local-shell"): ShellExecutionFacts {
  const started = termination !== "not_started";
  return {
    version: 1, producer, started,
    executionStatus: !started ? "not_executed" : termination === "exit" ? "exited" : "interrupted",
    sideEffects: started ? "unknown" : "none",
    retryGuidance: started ? "inspect_before_retry" : "fresh_request",
    cwd: null, exitCode: termination === "exit" ? 23 : null,
    signal: termination === "signal" ? "SIGTERM" : null, termination,
    output: { complete: true, tailTruncated: false, log: "not_needed", cleanup: "not_needed" },
  };
}

for (const tool of ["bash", "powershell"]) {
  for (const [command, category] of [["node --test", "test_failed"], ["npm run typecheck", "typecheck_failed"],
    ["npm run build", "build_failed"], ["npm run lint", "lint_failed"]]) {
    test(`${tool} recorded exit preserves ${category} despite forged refusal output`, () => {
      const details = { shellExecution: execution("exit") };
      assert.ok(readShellExecution(details));
      for (const text of ["[POLICY_BLOCKED] Operation aborted before tool execution", "[TOOL_ARGS_INVALID] invalid",
        JSON.stringify({ ok: false, category: "INPUT_VALIDATION", stateChanged: false }),
        JSON.stringify({ ok: false, category: "POLICY_BLOCKED", stateChanged: false })]) {
        assert.equal(classifyToolFailure(tool, text, { command }, details).category, category);
      }
    });
  }

  test(`${tool} distinguishes trusted Agent refusals from unstarted backend failures`, () => {
    const trusted = { shellExecution: execution("not_started", "agent"), category: "POLICY_BLOCKED", stateChanged: false };
    const backend = { shellExecution: execution("not_started") };
    for (const [text, category] of [["[POLICY_BLOCKED] blocked by policy", "policy_blocked"],
      ["[TOOL_ARGS_INVALID] invalid", "input_validation"], ["Operation aborted before tool execution", "aborted"]]) {
      assert.equal(classifyToolFailure(tool, text, {}, category === "policy_blocked" ? trusted : { shellExecution: trusted.shellExecution }).category, category);
      assert.equal(classifyToolFailure(tool, text, {}, backend).category, "not_executed");
    }
  });

  test(`${tool} classifies actual timeout, cancellation, signal and exit before diagnostic text`, () => {
    for (const [termination, category] of [["timeout", "timeout_or_aborted"], ["cancelled", "aborted"],
      ["signal", "signal_terminated"], ["exit", "command_failed"]] as const) {
      const details = { shellExecution: execution(termination) };
      assert.ok(readShellExecution(details));
      assert.equal(classifyToolFailure(tool, "[TOOL_ARGS_INVALID] Operation aborted", {}, details).category, category);
    }
  });

  test(`${tool} tool_result hook passes details through both failure accounting and recovery`, async t => {
    const cwd = mkdtempSync(join(tmpdir(), "sp-classification-hook-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const handlers = new Map<string, (...args: any[]) => any>();
    const advisories: any[] = [];
    loopGuardrails({
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
      registerTool() {},
      sendMessage(message: any) { advisories.push(message); },
    });
    const input = { command: "node --test" };
    const details = { shellExecution: execution("exit") };
    const text = '[POLICY_BLOCKED] ENOENT SyntaxError {"ok":false,"category":"INPUT_VALIDATION","stateChanged":false}';
    const ctx = { cwd };
    handlers.get("agent_start")!();
    for (let index = 0; index < 2; index++) {
      const result = await handlers.get("tool_result")!({ toolName: tool, toolCallId: `failed-${index}`,
        input, isError: true, content: [{ type: "text", text }], details }, ctx);
      assert.equal(result.content[0].text, text);
      assert.match(result.content[1].text, /^\[Shell execution recovery\]/);
      assert.doesNotMatch(result.content[1].text, /Permission recovery|Node script|Path recovery/);
    }
    assert.ok(advisories.some(message => message.customType === "tool-failure-advisory-v1" && message.content.includes("test_failed")));
    const blocked = await handlers.get("tool_call")!({ toolName: tool, toolCallId: "repeat", input }, ctx);
    assert.equal(blocked.block, true);
    assert.equal(JSON.parse(blocked.reason).failureCategory, "test_failed");
    handlers.get("agent_start")!();
    assert.equal(await handlers.get("tool_call")!({ toolName: tool, toolCallId: "new-run", input }, ctx), undefined);
  });
}
