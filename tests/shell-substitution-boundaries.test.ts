import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { extractCommandSubstitutions } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";

const count = String.raw`$(grep -c -E '(class|function|const|var|let) GCSystem\b' pixi/pixi.js)`;
const cwd = process.cwd();

test("substitution count exhaustion has an actionable inspection-limit diagnostic", () => {
  for (const substitution of [count, "`printf 1`"]) {
    const atLimit = `printf '%s ' ${Array(16).fill(substitution).join(" ")}`;
    assert.equal(extractCommandSubstitutions(atLimit).unsupported, false);
    const command = `${atLimit} ${substitution}`;
    const scan = extractCommandSubstitutions(command);
    assert.equal(scan.scripts.length, 16);
    assert.equal(scan.unterminated, false);
    assert.equal(scan.unsupported, true);
    assert.equal(scan.limitExceeded, "count");
    const reason = inspectBashResourceLifecycle({ command });
    assert.match(reason!, /^\[SHELL_INSPECTION_LIMIT\].*16/);
    assert.match(reason!, /split.*smaller/i);
    assert.equal(reason, "[SHELL_INSPECTION_LIMIT] Bash not executed: more than 16 command substitutions per script.\nRetry: split into smaller calls (max 16 each).");
    assert.doesNotMatch(reason!, /grammar|unterminated/);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "opaque-script");
    assert.equal(inspectHighRiskBashMutation({ command: `printf data > out; ${command}` }, cwd)?.unverifiableScope, true);
  }
});

test("quoted and unquoted count substitutions remain arguments to printf", () => {
  for (const argument of [count, `"${count}"`]) {
    const command = Array(8).fill(`printf '%s:%s/%s ' GCSystem ${argument} ${argument}`).join("; ");
    assert.equal(inspectBashResourceLifecycle({ command }), undefined);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only");
  }
  for (const command of [
    "printf '%s' pre$(printf '%s' '(word)')post",
    "printf '%s' $(printf '%s' \"$(printf '%s' ')')\")",
    "printf '%s' $(# a comment containing )\nprintf 1\n)",
    "printf '%s' $(printf 1; printf 2 | cat)",
    String.raw`printf '%s' $(printf '%s' $'line\n')`,
  ]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
});

test("substitution bodies retain mutation targets and outer cwd isolation", () => {
  for (const command of [
    "printf '%s' $(printf data > .git/config)",
    "printf '%s' $(printf '%s' \"$(printf data > .git/config)\")",
    "printf '%s' $(cd nested && printf data > ../.git/config)",
  ]) {
    const scope = inspectBashPermissionScope({ command }, cwd)!;
    assert.notEqual(scope.kind, "read-only", command);
    assert.ok(scope.targets.includes(resolve(cwd, ".git/config")), command);
    assert.ok(inspectHighRiskBashMutation({ command }, cwd)?.targets.includes(resolve(cwd, ".git/config")), command);
  }
  const scope = inspectBashPermissionScope({ command: "printf '%s' $(cd nested && printf 1); printf data > .git/config" }, cwd)!;
  assert.deepEqual(scope.targets, [resolve(cwd, ".git/config")]);
});

test("executable substitutions, dynamic targets and uninspectable bodies stay conservative", () => {
  for (const command of ["$(printf echo) safe", "env $(printf echo) safe", "printf '%s' $(sleep 1 &)",
    "printf '%s' $(time printf 1)", "printf '%s' $(case x in x) printf 1;; esac)",
    "printf '%s' $(printf 1", "printf '%s' $(printf '%s' \"$(sleep 1 &)\")",
    "cd nested && printf '%s' $(printf data > .git/config)"]) {
    assert.ok(inspectBashResourceLifecycle({ command }), command);
  }
  const dynamic = inspectBashPermissionScope({ command: "printf data > $(printf target)" }, cwd)!;
  assert.equal(dynamic.kind, "opaque-script");
  assert.equal(dynamic.dynamicScope, true);
  const legacy = "printf '%s' `printf '%s' \\`printf data > target\\``";
  assert.notEqual(inspectBashPermissionScope({ command: legacy }, cwd)?.kind, "read-only");
  const atDepthLimit = "printf '%s' " + "$(printf '%s' ".repeat(4) + "1" + ")".repeat(4);
  assert.equal(inspectBashResourceLifecycle({ command: atDepthLimit }), undefined);
  const deeplyNested = "printf '%s' " + "$(printf '%s' ".repeat(5) + "1" + ")".repeat(5);
  assert.equal(extractCommandSubstitutions(deeplyNested).limitExceeded, "nesting");
  assert.equal(inspectBashResourceLifecycle({ command: deeplyNested }), "[SHELL_INSPECTION_LIMIT] Bash not executed: command substitution nesting exceeds 4 levels.\nRetry: reduce nesting.");
  const escapedQuote = String.raw`printf '%s' $(printf '%s' $'\')'; printf data > target)`;
  assert.equal(extractCommandSubstitutions(escapedQuote).unsupported, true);
  assert.match(inspectBashResourceLifecycle({ command: escapedQuote })!, /^\[SHELL_SUBSTITUTION\]/);
  assert.match(inspectBashResourceLifecycle({ command: "printf '%s' $(time printf 1)" })!, /^\[SHELL_SUBSTITUTION\]/);
  assert.match(inspectBashResourceLifecycle({ command: "printf '%s' $(printf 1" })!, /unterminated/);
});
