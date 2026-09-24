import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool, createLocalBashOperations, createShellToolDefinition } from "../packages/coding-agent/src/core/tools/bash.ts";
import { createLocalPowerShellOperations, createPowerShellTool } from "../packages/coding-agent/src/core/tools/powershell.ts";
import { OutputAccumulator } from "../packages/coding-agent/src/core/tools/output-accumulator.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { createJiti } from "jiti";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { classifyError, collectSessionErrors } from "../packages/extensions/session-tool-errors/core.ts";

const cwd = process.cwd();

test("Bash output hot methods retain zero per-append callbacks, promises or abort controllers", () => {
  const path = "packages/coding-agent/src/core/tools/output-accumulator.ts";
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const methods = new Set(["append", "appendDecodedData", "appendDecodedText", "trimTail", "getSnapshotText", "shouldUseTempFile", "writeTempData", "snapshot"]);
  const seen = new Set<string>();
  let inlineCallbacks = 0, promises = 0, abortControllers = 0, promiseTails = 0, objectLiterals = 0, arrayLiterals = 0;
  function audit(node: ts.Node): void {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) inlineCallbacks++;
    if (ts.isObjectLiteralExpression(node)) objectLiterals++;
    if (ts.isArrayLiteralExpression(node)) arrayLiterals++;
    if (ts.isNewExpression(node)) {
      const name = node.expression.getText(source);
      if (name === "Promise") promises++;
      if (name === "AbortController") abortControllers++;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["then", "catch", "finally"].includes(node.expression.name.text)) promiseTails++;
    ts.forEachChild(node, audit);
  }
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== "OutputAccumulator") continue;
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.body || !methods.has(member.name.getText(source))) continue;
      seen.add(member.name.getText(source));
      audit(member.body);
    }
  }
  assert.deepEqual(seen, methods);
  const bashPath = "packages/coding-agent/src/core/tools/bash.ts";
  const bashSource = ts.createSourceFile(bashPath, readFileSync(bashPath, "utf8"), ts.ScriptTarget.Latest, true);
  let dataHandlerCount = 0;
  function findDataHandler(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(bashSource) === "handleData" && node.initializer && ts.isArrowFunction(node.initializer)) {
      dataHandlerCount++;
      audit(node.initializer.body);
    } else ts.forEachChild(node, findDataHandler);
  }
  findDataHandler(bashSource);
  assert.equal(dataHandlerCount, 1);
  assert.deepEqual({ inlineCallbacks, promises, abortControllers, promiseTails, objectLiterals, arrayLiterals },
    { inlineCallbacks: 0, promises: 0, abortControllers: 0, promiseTails: 0, objectLiterals: 4, arrayLiterals: 0 });
});

test("Bash output allocation gate measures append cost and releases spill owners", () => {
  const stdout = execFileSync(process.execPath,
    ["--expose-gc", "--experimental-strip-types", "scripts/bench/shell-common-compatibility.ts", "--allocation-gate"],
    { cwd, encoding: "utf8", timeout: 30_000 });
  const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  assert.equal(report.mode, "allocation-gate");
  assert.equal(report.counters.appendCalls, 96);
  assert.equal(report.counters.snapshotCalls, 96);
  assert.equal(report.counters.spillFilesCreated, 1);
  assert.equal(report.counters.spillFileCapped, true);
  assert.ok(report.counters.spillFileBytes <= 5 * 1024 * 1024);
  assert.equal(report.counters.spillErrors, 0);
  assert.equal(report.counters.releasedLifecycles, 20);
  assert.equal(report.counters.liveOwnersAfterGc, 0);
  assert.ok(Number.isFinite(report.sampledBytesPerAppend));
  assert.ok(report.sampledBytesPerAppend < 128_000);
  assert.ok(Array.isArray(report.topAllocationSites));
});

function findTestBash(): string | undefined {
  if (process.env.SP_TEST_BASH) return process.env.SP_TEST_BASH;
  if (process.platform !== "win32") return "/bin/bash";
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    const installed = join(programFiles, "Git", "bin", "bash.exe");
    if (existsSync(installed)) return installed;
  }
  const local = "D:\\Git\\bin\\bash.exe";
  return existsSync(local) ? local : undefined;
}

test("command -v/-V query names and variables without treating them as executables", () => {
  for (const command of [
    'command -v bash',
    'command -V "$candidate"',
    'command -v 2>/dev/null "${candidate}"',
    "command -v '${CDPATH:=..}'",
    'for candidate in printf cat; do command -v "$candidate"; done',
    'printf "%s" "$(command -v "$candidate")"',
  ]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    const scope = inspectBashPermissionScope({ command }, cwd);
    assert.ok(scope, command);
    assert.equal(scope.unverifiableScope, false, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
  }
  assert.match(inspectBashResourceLifecycle({ command: 'command "$candidate" --help' }) ?? "", /SHELL_DYNAMIC_EXECUTABLE/);
  assert.match(inspectBashResourceLifecycle({ command: 'exec "$candidate" --help' }) ?? "", /SHELL_DYNAMIC_EXECUTABLE/);
  assert.ok(inspectHighRiskBashMutation({ command: 'command rm -rf synthetic' }, cwd)?.primitives.includes("rm_recursive"));
  assert.ok(inspectHighRiskBashMutation({ command: 'exec rm -rf synthetic' }, cwd)?.primitives.includes("rm_recursive"));
  assert.ok(inspectHighRiskBashMutation({ command: 'for t in synthetic; do rm -rf "$t"; done' }, cwd)?.primitives.includes("rm_recursive"));
  for (const command of [
    "command -v ${CDPATH:=..}; cd synthetic; printf data >.git/config",
    "command -V \"$((CDPATH=1))\"; cd synthetic; printf data >.git/config",
    "command -v 2>/dev/null ${CDPATH:=..}; cd synthetic; printf data >.git/config",
    "command -v \"${CDPATH:=..}\"; cd synthetic; printf data >.git/config",
  ]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
});

test("Bash test arithmetic and state-changing operands stay unverifiable", () => {
  for (const command of [
    "[[ -v 'x[$(printf data >.git/config)]' ]]",
    "[[ -v 'x[CDPATH=1]' ]]",
    "[[ -n ${CDPATH:=..} ]]; cd synthetic; printf data >.git/config",
    ...["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].map(operator => `[[ 0 ${operator} 'x[$(printf data >.git/config)]' ]]`),
  ]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  for (const command of ["[[ 1 -eq 1 ]]", '[[ -n "$candidate" ]]']) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
  const quotedData = "[[ foo == 'x[$(printf data >.git/config)]' ]]";
  assert.equal(inspectBashResourceLifecycle({ command: quotedData }), undefined);
  assert.equal(inspectHighRiskBashMutation({ command: quotedData }, cwd), undefined);
  assert.equal(inspectBashPermissionScope({ command: quotedData }, cwd)?.kind, "read-only");
});

test("else introduces an inspectable Bash string comparison", () => {
  const command = "if false; then :; else [[ a < b ]]; fi";
  assert.equal(inspectBashResourceLifecycle({ command }), undefined);
  assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined);
  assert.equal(inspectBashPermissionScope({ command }, cwd)?.primitives.includes("unverifiable_redirection"), false);
});

test("path and quoted control-word names remain executable commands", () => {
  for (const command of ["./for", "'for'", "'for'; cat", "'for'<fixture.bin", "./done", "'do' printf synthetic", "env for", "./cat", "./git status", "./env cat", "./timeout 5 cat", "CAT", "command ./cat", "env PATH=. cat"]) {
    const scope = inspectBashPermissionScope({ command }, cwd);
    assert.equal(scope?.unverifiableScope, true, command);
    assert.equal(scope?.kind, "opaque-script", command);
  }
  assert.equal(inspectBashPermissionScope({ command: "for t in cat; do command -v $t; done" }, cwd)?.unverifiableScope, false);
});

test("lookup-sensitive Bash for variables cannot make later command lookup read-only", () => {
  for (const command of [
    "for PATH in .; do printf ok; done; cat",
    "! for PATH in .; do printf ok; done; cat",
    "time for PATH in .; do printf ok; done; cat",
    "time -p for PATH in .; do printf ok; done; cat",
    "for BASH_ENV in ./profile; do printf ok; done; bash -c 'printf ok'",
    "for EXECIGNORE in /usr/bin/cat; do echo ok; done; cat",
  ]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    const high = inspectHighRiskBashMutation({ command }, cwd);
    assert.equal(high?.unverifiableScope, true, command);
    assert.ok(high?.primitives.includes("stateful_loop_variable_assignment"), command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  const ordinary = "for candidate in printf cat; do command -v $candidate; done";
  assert.equal(inspectBashResourceLifecycle({ command: ordinary }), undefined);
  assert.equal(inspectHighRiskBashMutation({ command: ordinary }, cwd), undefined);
  assert.equal(inspectBashPermissionScope({ command: ordinary }, cwd)?.kind, "read-only");
  assert.equal(inspectHighRiskBashMutation({ command: "printf '%s' 'for PATH in .'" }, cwd), undefined);
});

test("C-style Bash for headers cannot make later command lookup read-only", () => {
  for (const command of [
    "for (( PATH=0; 0; )); do printf ok; done; cat",
    "for((PATH=0;0;)); do printf ok; done; cat",
    "time -p for (( CDPATH=1; 0; )); do printf ok; done; cd workspace",
    "for (( i=0; i<1; BASH_ENV=1 )); do printf ok; done; bash -c 'printf ok'",
    "for (( EXECIGNORE=0; 0; )); do printf ok; done; cat",
  ]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    const high = inspectHighRiskBashMutation({ command }, cwd);
    assert.equal(high?.unverifiableScope, true, command);
    assert.ok(high?.primitives.includes("stateful_loop_variable_assignment"), command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  // Referenced values are evaluated recursively, so permission scope cannot prove any arithmetic header read-only.
  for (const command of ["for ((i=0; i < 2; i++)); do printf ok; done", "for((i=0;i<2;i++)); do printf ok; done", "v=PATH=0; for (( v; 0; )); do printf ok; done; cat"]) {
    const scope = inspectBashPermissionScope({ command }, cwd);
    assert.equal(scope?.unverifiableScope, true, command);
    assert.ok(scope?.primitives.includes("opaque_arithmetic_loop_header"), command);
  }
  assert.equal(inspectBashResourceLifecycle({ command: "for ((i=0; i < 2; i++)); do printf ok; done" }), undefined);
  assert.equal(inspectBashPermissionScope({ command: "printf '%s' 'for ((PATH=0;0;))'" }, cwd)?.kind, "read-only");
});

test("expansions that assign shell variables cannot make later commands read-only", () => {
  for (const command of [
    "printf %s $((PATH=0)); cat",
    "printf %s \"$((PATH=0))\"; cat",
    ": $[CDPATH=1]; cd workspace && printf data >.git/config",
    ": ${CDPATH:=..}; cd workspace && printf data >.git/config",
    "echo ${CDPATH=..}; cd workspace && printf data >.git/config",
    "x=(a); printf %s ${x[PATH=0]}; cat",
    "printf %s ${#x[PATH=0]}; cat",
    "printf %s ${x:PATH=0}; cat",
    "printf %s $((1)+PATH=0)); cat",
    "printf %s $((++n)); cat",
    "echo ${ cd ..; }; printf data >.git/config",
  ]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    const high = inspectHighRiskBashMutation({ command }, cwd);
    assert.equal(high?.unverifiableScope, true, command);
    assert.ok(high?.primitives.includes("stateful_shell_expansion"), command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  // A referenced value is evaluated recursively (`v=PATH=0; $((v))`), so these need
  // permission review but stay executable instead of being refused outright.
  for (const command of ["printf %s ${!ref}; cat", "for v in PATH=0; do printf %s $((v)); done; cat", "echo ${arr[$i]}", "for i in 1 2; do echo $((i*2)); done"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.ok(inspectHighRiskBashMutation({ command }, cwd)?.primitives.includes("stateful_shell_expansion"), command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  for (const command of ["printf %s $x ${y} $1 $@ ${#z} ${!}", "echo $((1 + (2 * 3) >= 4))", "printf %s ${HOME:-/tmp} ${f%.txt} ${g/a/b} ${h:1:2} ${arr[0]} ${arr[@]}", "printf %s '$((PATH=0))'",
    "echo $((RANDOM % 10)) $(($# - 1)) $((0x1F + 16#ff))", "echo ${var:-$HOME} ${arr[1+1]}"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
});

test("indirect or redefined cd cannot authorize the scanned cwd", () => {
  for (const command of [
    "command cd sub; printf data >.git/config",
    "builtin cd sub; printf data >.git/config",
    "command -p cd sub; printf data >.git/config",
    "builtin -- cd sub; printf data >.git/config",
    "pushd sub; printf data >.git/config",
    "pushd sub >/dev/null && printf data >.git/config",
    "popd; printf data >.git/config",
    "enable -n cd; cd sub; printf data >.git/config",
    "function cd { :; }; cd sub; printf data >.git/config",
    "shopt -s cdable_vars; sub=..; cd sub; printf data >.git/config",
    "shopt -s expand_aliases\nalias cd=:\ncd sub\nprintf data >.git/config",
    "set -P; cd link/..; printf data >.git/config",
    "set -o physical; cd link/..; printf data >.git/config",
  ]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  for (const command of ["set -e; cd sub && printf data >.git/config", "set -euo pipefail; cd sub && printf data >.git/config"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.ok(inspectHighRiskBashMutation({ command }, cwd)?.targets.some(target => target.endsWith("sub\\.git\\config") ||target.endsWith("sub/.git/config")), command);
  }
});

test("negated and timed prefixes before Bash tests keep comparisons out of redirection parsing", () => {
  for (const command of ["time ! [[ a < b ]]", "! time [[ a < b ]]", "! time -p [[ a < b ]]"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
  for (const command of ["if ! [[ a < b ]]; then :; fi", "while ! [[ a < b ]]; do break; done", "if time ! [[ a < b ]]; then :; fi"]) {
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.primitives.includes("unverifiable_redirection"), false, command);
  }
  for (const command of ["\\! [[ a > .git/config ]]", "if \\! [[ a > .git/config ]]; then :; fi", "time \\-p [[ a > .git/config ]]", "time ! \\time [[ a > .git/config ]]"]) {
    assert.ok(inspectHighRiskBashMutation({ command }, cwd)?.targets.some(target => target.endsWith(".git\\config") ||target.endsWith(".git/config")), command);
  }
});

test("length-modified printf %n conversions stay stateful", () => {
  for (const command of ["printf '%ln' PATH; cat", "printf '%hn' PATH; cat", "printf '%zn' PATH; cat", "printf 'x%lln' PATH; cat", "printf '%-3jn' PATH; cat", "printf -- '%Ltn' PATH; cat"]) {
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  for (const command of ["printf '%ld\n' 1", "printf '%q' PATH", "printf '%%ln' PATH"]) {
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
});

test("Bash network-device input redirections are not read-only file inputs", () => {
  for (const command of ["cat </dev/tcp/127.0.0.1/1234", "cat 0</dev/udp/example.invalid/53", "cd sub && cat </dev/tcp/127.0.0.1/1234"]) {
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
  }
  assert.equal(inspectBashPermissionScope({ command: "cat <fixture.bin" }, cwd)?.kind, "read-only");
});

test("cd success is required before an independent target, even with an infallible redirect", () => {
  for (const command of ["9>&8 cd sub; printf data >.git/config", "cd sub 9>&8; printf data >.git/config", "cd sub <missing.txt; printf data >.git/config", "cd sub >out/log; printf data >.git/config", "cd sub 2>&9; printf data >.git/config", "99999>/dev/null cd sub; printf data >.git/config", "cd sub 10>/dev/null; printf data >.git/config", "01>/dev/null cd sub; printf data >.git/config", "cd sub 2>/dev/null; printf data >.git/config", ">/dev/null cd sub; printf data >.git/config", "9>/dev/null cd sub; printf data >.git/config", "cd sub 2>&1; printf data >.git/config"]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  for (const command of ["9>&8 cd sub && printf data >.git/config", "cd sub 2>/dev/null && printf data >.git/config", ">/dev/null cd sub && printf data >.git/config", "9>/dev/null cd sub && printf data >.git/config", "cd sub 2>&1 && printf data >.git/config"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.ok(inspectHighRiskBashMutation({ command }, cwd)?.targets.some(target => target.endsWith("sub\\.git\\config") || target.endsWith("sub/.git/config")), command);
  }
});

test("cd guarded by || exit keeps the requested cwd for the rest of the script", () => {
  for (const command of ["cd sub 2>/dev/null || exit 1; printf data >.git/config", "cd sub || exit\nprintf data >.git/config"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.ok(inspectHighRiskBashMutation({ command }, cwd)?.targets.some(target => target.endsWith("sub\\.git\\config") || target.endsWith("sub/.git/config")), command);
  }
  for (const command of [
    "cd sub || echo failed; printf data >.git/config",
    "cd sub || exit 1 && printf ok; printf data >.git/config",
    "cd sub || (exit 1); printf data >.git/config",
    "cd sub || exit $code; printf data >.git/config",
    "exit() { :; }; cd sub || exit 1; printf data >.git/config",
    "function exit { :; }; cd sub || exit 1; printf data >.git/config",
    "(cd sub || exit 1); printf data >.git/config",
  ]) {
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
  }
});

test("only the bare unlaunched cd builtin moves the scanned cwd", () => {
  const root = (target: string) => target.endsWith("ws\\.git\\config") || target.endsWith("ws/.git/config");
  const workspace = "D:/ws";
  // External programs named cd cannot change this shell's directory, so writes stay at the original cwd.
  for (const command of ["./cd sub; printf data >.git/config", "/opt/tools/cd sub; printf data >.git/config", "CD sub; printf data >.git/config",
    "env cd sub; printf data >.git/config", "sudo cd sub; printf data >.git/config", "timeout 5 cd sub; printf data >.git/config"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.deepEqual(inspectHighRiskBashMutation({ command }, workspace)?.targets.filter(target => target.endsWith("config")).map(root), [true], command);
    assert.ok(inspectBashPermissionScope({ command }, workspace)?.targets.some(root), command);
    assert.equal(inspectBashPermissionScope({ command }, workspace)?.targets.some(target => /sub[\\/]\.git/.test(target)), false, command);
  }
  for (const command of ["./cd subdir && printf ok", "./pushd sub; printf ok", "./enable -n cd; cd sub && printf ok"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
  }
  for (const command of ["cd sub && printf data >.git/config", "'cd' sub && printf data >.git/config"]) {
    assert.ok(inspectHighRiskBashMutation({ command }, workspace)?.targets.some(target => /sub[\\/]\.git[\\/]config$/.test(target)), command);
  }
});

test("simple ANSI-C quoted path operands resolve to the decoded name", () => {
  // Bash writes a file whose name holds a real newline or tab, not the escaped spelling.
  for (const [command, name, spelled] of [["printf data >$'safe\\nfile'", "safe\nfile", "safe\\nfile"], ["printf data >$'t\\tx'", "t\tx", "t\\tx"], ["printf data >$'cr\\rx'", "cr\rx", "cr\\rx"]]) {
    for (const targets of [inspectHighRiskBashMutation({ command }, cwd)?.targets, inspectBashPermissionScope({ command }, cwd)?.targets]) {
      assert.ok(targets?.some(target => target.endsWith(name)), command);
      assert.equal(targets?.some(target => target.endsWith(spelled)), false, command);
    }
  }
  assert.ok(inspectHighRiskBashMutation({ command: "printf data >'safe\\nfile'" }, cwd)?.targets.some(target => target.endsWith("safe\\nfile")));
  assert.equal(inspectBashPermissionScope({ command: "printf $'%s\\n' x" }, cwd)?.kind, "read-only");
  assert.equal(inspectBashPermissionScope({ command: "printf data >$'a\\x41'" }, cwd)?.unverifiableScope, true);
});

test("cd reached through an OR edge cannot authorize dependent commands", () => {
  // Bash groups left to right: `(true || cd sub) && next` skips cd but still runs next.
  for (const command of ["true || cd sub && printf data >.git/config", "(true) || cd sub && printf data >.git/config",
    "{ true; } || cd sub && printf data >.git/config", "true || cd sub || exit 1; printf data >.git/config"]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  // An incoming `&&` skips cd and its `&&` dependents together.
  for (const command of ["true && cd sub && printf data >.git/config", "true && cd sub || exit 1; printf data >.git/config"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.ok(inspectHighRiskBashMutation({ command }, cwd)?.targets.some(target => /sub[\\/]\.git[\\/]config$/.test(target)), command);
  }
});

test("cd with extra operands cannot authorize the requested cwd", () => {
  for (const command of ["cd sub extra; printf data >.git/config", "cd sub 2>/dev/null extra; printf data >.git/config", "cd sub extra && printf data >.git/config", "cd . extra; printf data >.git/config"]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  for (const command of ["cd 2>/dev/null sub && printf data >.git/config", "cd sub 2>/dev/null && printf data >.git/config"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.ok(inspectHighRiskBashMutation({ command }, cwd)?.targets.some(target => target.endsWith("sub\\.git\\config") || target.endsWith("sub/.git/config")), command);
  }
});

test("prompt transformations and PS4 loop values cannot run hidden command substitutions", () => {
  for (const command of [
    "for X in '$(printf data >.git/config)'; do echo \"${X@P}\"; done",
    "echo ${X@P}",
    "echo ${arr[0]@P}",
    "echo ${X@Z}",
  ]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  const ps4 = "for PS4 in '$(printf data >.git/config)'; do set -x; :; done";
  assert.match(inspectBashResourceLifecycle({ command: ps4 }) ?? "", /SHELL_UNINSPECTABLE/);
  assert.equal(inspectBashPermissionScope({ command: ps4 }, cwd)?.unverifiableScope, true);
  for (const command of ["echo ${X@Q} ${X@E} ${X@A} ${X@U} ${X@L} ${X@a} ${arr[@]@K}"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
});

test("negated Bash string comparisons remain read-only", () => {
  for (const command of ["! [[ a < b ]]", "! [[ b > a ]]", "! [[ a < b ]] && printf ok"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
  const redirected = "! [[ a < b ]] >.git/config";
  assert.ok(inspectHighRiskBashMutation({ command: redirected }, cwd)?.targets.some(target => target.endsWith("config")));
  assert.equal(inspectBashPermissionScope({ command: redirected }, cwd)?.kind, "known-mutation");
  assert.match(inspectBashResourceLifecycle({ command: "! [[ -v 'x[CDPATH=1]' ]]" }) ?? "", /SHELL_UNINSPECTABLE/);
  assert.equal(inspectBashPermissionScope({ command: "! '[[' a b ]]" }, cwd)?.unverifiableScope, true);
});

test("printf variable assignment remains stateful through command prefix", () => {
  for (const command of ["printf -v PATH .; cat", "command printf -v PATH .; cat", "command printf -vPATH .; cat", "printf '%n' PATH; cat", "command printf '%1$n' PATH; cat", "printf \"$format\" PATH; cat"]) {
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  assert.equal(inspectBashPermissionScope({ command: "command printf '%s' synthetic" }, cwd)?.kind, "read-only");
});

test("simple ANSI-C quoted printf formats stay literal while encoded conversions remain guarded", () => {
  for (const command of ["printf $'%s\\n' ansi-ok", "command printf $'%s\\n' ansi-ok"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
  for (const command of ["printf $'%n' PATH; cat", "printf $'%\\x6e' PATH; cat"]) {
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
});

test("a list separator after a closed subshell ends conditional cwd dependence", () => {
  for (const command of [
    "cd missing-synthetic && ( echo x ); printf data >.git/config",
    "cd missing-synthetic && ( echo x )\nprintf data >.git/config",
    "cd missing-synthetic && ( echo x ) || printf data >.git/config",
  ]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  assert.notEqual(inspectHighRiskBashMutation({ command: "cd missing-synthetic && ( echo x ) && cat" }, cwd)?.unverifiableScope, true);
});

test("static descriptor and input-file redirections preserve bounded targets and order", () => {
  for (const command of [
    'printf "%s\\n" out 2>&1 | cat',
    '(printf "%s\\n" out 1>&2) | cat',
    '{ printf "%s\\n" out; } >merged.log 2>&1',
    '{ printf "%s\\n" out; } 2>&1 >split.log | cat',
    'printf "%s\\n" out 2>errors.log 1>&2',
    'printf "%s\\n" out 2>&1>compact.log',
    'printf "%s\\n" out 3<&0',
  ]) {
    const high = inspectHighRiskBashMutation({ command }, cwd);
    assert.notEqual(high?.unverifiableScope, true, command);
    assert.equal(high?.diagnostic?.diagnostic.code, undefined, command);
    const scope = inspectBashPermissionScope({ command }, cwd);
    assert.equal(scope?.unverifiableScope, false, command);
  }
  for (const command of ["2>&$fd", "2>&-", "{fd}>&1", "2>&1-"]) {
    const high = inspectHighRiskBashMutation({ command: `printf x ${command}` }, cwd);
    assert.equal(high?.unverifiableScope, true, command);
  }
  const compact = inspectHighRiskBashMutation({ command: 'printf out 2>&1>compact.log' }, cwd);
  assert.ok(compact?.targets.some(target => target.endsWith("compact.log")));
  for (const command of ["cat < fixture.bin", "cat <fixture.bin", "cat 3<fixture.bin"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
  assert.equal(inspectHighRiskBashMutation({ command: "cd subdir && cat <fixture.bin" }, cwd), undefined);
  for (const command of ["cat <$path", "cat <", "cat <>fixture.bin", "cat <&-"]) {
    assert.equal(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true, command);
  }
  assert.ok(inspectHighRiskBashMutation({ command: "cat < fixture.bin >.git/config" }, cwd)?.targets.some(target => target.endsWith(".git\\config") || target.endsWith(".git/config")));
  for (const command of ["[[ a < b ]]", "[[ b > a ]]", "[[ a < b && c > d ]]", "[[\na < b\n]]", "[[\na < b\n]] && printf ok"]) {
    assert.notEqual(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    const scope = inspectBashPermissionScope({ command }, cwd);
    assert.equal(scope?.unverifiableScope, false, command);
    assert.equal(scope?.kind, "read-only", command);
  }
  for (const command of ["time [[ a < b ]]", "time -p [[ a < b ]]", "time -- [[ a < b ]]", "time -p -- [[ a < b ]]", "printf ok # compare a < b"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only", command);
  }
  assert.equal(inspectHighRiskBashMutation({ command: "printf ok#literal <fixture.bin" }, cwd), undefined);
  assert.equal(inspectBashPermissionScope({ command: "printf ok#literal <fixture.bin" }, cwd)?.kind, "read-only");
  assert.ok(inspectHighRiskBashMutation({ command: "printf ok#literal >.git/config" }, cwd)?.targets.some(target => target.endsWith(".git\\config") || target.endsWith(".git/config")));
  for (const command of ["'time' [[ a < b ]]", "time '-p' [[ a < b ]]", "time '--' [[ a < b ]]", "time -p '--' [[ a < b ]]"]) {
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableScope, true);
  }
  assert.ok(inspectHighRiskBashMutation({ command: "time [[ a < b ]] >.git/config" }, cwd)?.targets.some(target => target.endsWith(".git\\config") || target.endsWith(".git/config")));
  assert.ok(inspectHighRiskBashMutation({ command: "printf ok # comment < ignored\nprintf data >.git/config" }, cwd)?.targets.some(target => target.endsWith(".git\\config") || target.endsWith(".git/config")));
  assert.ok(inspectHighRiskBashMutation({ command: "[[ a < b ]] >.git/config" }, cwd)?.targets.some(target => target.endsWith(".git\\config") || target.endsWith(".git/config")));
  assert.equal(inspectBashPermissionScope({ command: "[[ a < b ]] >.git/config" }, cwd)?.kind, "known-mutation");
  assert.ok(inspectHighRiskBashMutation({ command: "[[\na < b\n]] >.git/config" }, cwd)?.targets.some(target => target.endsWith(".git\\config") || target.endsWith(".git/config")));
  assert.equal(inspectBashPermissionScope({ command: "[[\na < b\n]] >.git/config" }, cwd)?.kind, "known-mutation");
  assert.equal(inspectBashPermissionScope({ command: "'[[' a < b ]]" }, cwd)?.unverifiableScope, true);
  assert.equal(inspectBashPermissionScope({ command: "[[ a < b ']]'" }, cwd)?.unverifiableScope, true);
  for (const command of ["[[ '<(printf data >.git/config)' == literal ]]", '[[ "<(printf data >.git/config)" == literal ]]']) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined);
    assert.equal(inspectBashPermissionScope({ command }, cwd)?.kind, "read-only");
  }
  assert.equal(inspectHighRiskBashMutation({ command: "printf '%s' '2>&1'" }, cwd), undefined);
  assert.ok(inspectHighRiskBashMutation({ command: 'printf "%s" "$(rm -rf synthetic)"' }, cwd)?.primitives.includes("rm_recursive"));
  for (const command of [
    "for t in cd; do printf '%s' 'cd'; done",
    "if true; then printf '%s' 'cd'; fi",
    "printf '%s' 'cd' | cat",
  ]) assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
});

test("stale owned Bash and PowerShell spills are reclaimed while unowned or recent files stay", () => {
  const directory = mkdtempSync(join(tmpdir(), "sp-spill-cleanup-"));
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const write = (name: string, owned: boolean, stale: boolean) => {
    const path = join(directory, name);
    writeFileSync(path, "synthetic spill");
    if (owned) writeFileSync(path + ".sp-owned", "super-pi-output-spill-v2\n");
    if (stale) {
      fs.utimesSync(path, old, old);
      if (owned) fs.utimesSync(path + ".sp-owned", old, old);
    }
    return path;
  };
  const reclaimed = [write("sp-powershell-stale.log", true, true), write("sp-bash-stale.log", true, true)];
  const kept = [write("sp-powershell-unowned.log", false, true), write("sp-powershell-recent.log", true, false), write("sp-other-stale.log", true, true)];
  try {
    // Cleanup runs once per process on the first spill, so use a fresh process with this temp directory.
    const accumulator = new URL("../packages/coding-agent/src/core/tools/output-accumulator.ts", import.meta.url).href;
    const script = `const { OutputAccumulator } = await import(${JSON.stringify(accumulator)});
const output = new OutputAccumulator({ tempFilePrefix: "sp-spill-cleanup-trigger" });
output.append(Buffer.alloc(64 * 1024, 0x61));
output.snapshot({ persistIfTruncated: true });
await output.discardTempFile();`;
    execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, TMP: directory, TEMP: directory, TMPDIR: directory },
      stdio: "pipe",
    });
    for (const path of reclaimed) {
      assert.equal(existsSync(path), false, path);
      assert.equal(existsSync(path + ".sp-owned"), false, path);
    }
    for (const path of kept) assert.equal(existsSync(path), true, path);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("asynchronous spill write failure releases only its owned file", async () => {
  const abort = new AbortController();
  const output = new OutputAccumulator({
    tempFilePrefix: "sp-shell-write-failure",
    onSpillError: (error: Error) => abort.abort(error),
  });
  output.append(Buffer.alloc(64 * 1024, 0x61));
  const path = output.snapshot({ persistIfTruncated: true }).fullOutputPath;
  assert.ok(path);
  try {
    (output as any).tempFileStream.destroy(new Error("synthetic write failure"));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(abort.signal.aborted, true, "an asynchronous log failure must interrupt a quiet command");
    await assert.rejects(output.closeTempFile(), /synthetic write failure/);
    await output.discardTempFile();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(path + ".sp-owned"), false);
  } finally {
    await output.discardTempFile();
  }
});

test("an asynchronous spill stream failure aborts a quiet Bash execution", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-async-error-"));
  const original = fs.createWriteStream;
  let aborted = false;
  fs.createWriteStream = ((...args: Parameters<typeof fs.createWriteStream>) => {
    const stream = original(...args);
    setImmediate(() => stream.destroy(new Error("synthetic asynchronous spill failure")));
    return stream;
  }) as typeof fs.createWriteStream;
  syncBuiltinESMExports();
  try {
    const tool = createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
      async exec(_command, _cwd, options) {
        options.onData(Buffer.alloc(64 * 1024, 0x61));
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error("spill failure did not interrupt the quiet command")), 2000);
          const onAbort = () => { clearTimeout(deadline); aborted = true; resolve(); };
          if (options.signal?.aborted) onAbort();
          else options.signal?.addEventListener("abort", onAbort, { once: true });
        });
        throw new Error("aborted");
      },
    } });
    await assert.rejects(tool.execute("async-spill", { command: "printf synthetic" }), /SHELL_LOG_FAILED.*synthetic asynchronous spill failure/);
    assert.equal(aborted, true);
  } finally {
    fs.createWriteStream = original;
    syncBuiltinESMExports();
    rmSync(fixture, { recursive: true });
  }
});

test("blocked shell calls preserve custom non-record refusal details and no elapsed time", async () => {
  for (const toolName of ["bash", "powershell"] as const) for (const originalDetails of ["custom detail", ["custom", "detail"]]) {
    let executions = 0;
    const agent = new Agent({
      streamFn: () => { throw new Error("offline provider must not be called"); },
      beforeToolCall: async () => ({ block: true, reason: "synthetic refusal", details: originalDetails }),
    });
    const operations = { async exec() { executions++; return { exitCode: 0 }; } };
    agent.state.tools = [toolName === "bash" ? createBashTool(cwd, { operations }) : createPowerShellTool(cwd, { operations })];
    try {
      const result = await agent.dispatchHostTool({ type: "toolCall", id: "custom-refusal", name: toolName, arguments: { command: "printf synthetic" } });
      assert.equal(result.isError, true);
      assert.equal((result.details as any).executionStatus, "not_executed");
      assert.deepEqual((result.details as any).originalDetails, originalDetails);
      assert.equal(executions, 0);
      initTheme("dark");
      const component = new ToolExecutionComponent(toolName, "shell-status", { command: "printf synthetic" }, { showImages: false }, undefined, { requestRender() {} } as never, cwd);
      component.markExecutionStarted();
      component.setArgsComplete();
      component.updateResult(result, false, true);
      assert.doesNotMatch(component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, ""), /Took 0\.0s|Took \d/);
    } finally { agent.abort(); }
  }
});

test("caller cancellation from custom shell backends remains interrupted", async () => {
  for (const toolName of ["bash", "powershell"] as const) {
    const caller = new AbortController();
    const operations = { async exec(_command: string, _cwd: string, options: { signal?: AbortSignal }) {
      caller.abort();
      options.signal?.throwIfAborted();
      return { exitCode: 0 };
    } };
    const tool = toolName === "bash" ? createBashTool(cwd, { operations }) : createPowerShellTool(cwd, { operations });
    await assert.rejects(tool.execute(`abort-${toolName}`, { command: "printf synthetic" }, caller.signal), /\[SHELL_INTERRUPTED\]/);
  }
});

test("unavailable PowerShell is classified as a start failure", async () => {
  const operations = createLocalPowerShellOperations({ resolveCandidate: () => {
    throw Object.assign(new Error("synthetic missing executable"), { code: "ENOENT" });
  } });
  const agent = new Agent({ streamFn: () => { throw new Error("offline provider must not be called"); } });
  agent.state.tools = [createPowerShellTool(cwd, { operations })];
  try {
    const result = await agent.dispatchHostTool({ type: "toolCall", id: "powershell-missing", name: "powershell", arguments: { command: "Write-Output synthetic" } });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /^\[SHELL_START_FAILED\] PowerShell is unavailable:/);
  } finally { agent.abort(); }
});

test("a missing configured Bash executable is classified as a start failure", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-missing-"));
  const missingShell = join(fixture, "missing-bash");
  const agent = new Agent({ streamFn: () => { throw new Error("offline provider must not be called"); } });
  agent.state.tools = [createBashTool(fixture, { operations: createLocalBashOperations({ shellPath: missingShell }) })];
  try {
    const result = await agent.dispatchHostTool({ type: "toolCall", id: "bash-missing", name: "bash", arguments: { command: "printf synthetic" } });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /^\[SHELL_START_FAILED\] Custom shell path not found:/);
  } finally {
    agent.abort();
    rmSync(fixture, { recursive: true });
  }
});

test("an invalid timeout is classified as a start failure before shell discovery", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-timeout-"));
  const agent = new Agent({ streamFn: () => { throw new Error("offline provider must not be called"); } });
  agent.state.tools = [createBashTool(fixture, { operations: createLocalBashOperations({ shellPath: join(fixture, "missing-bash") }) })];
  try {
    for (const timeout of [0, -1, 3_000_000]) {
      const result = await agent.dispatchHostTool({ type: "toolCall", id: `bash-timeout-${timeout}`, name: "bash", arguments: { command: "printf synthetic", timeout } });
      assert.equal(result.isError, true, String(timeout));
      assert.match((result.content[0] as { text: string }).text, /^\[SHELL_START_FAILED\] Invalid timeout:/, String(timeout));
    }
  } finally {
    agent.abort();
    rmSync(fixture, { recursive: true });
  }
});

test("inherited cd-semantic and startup variables do not reach the spawned shell", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-env-"));
  const keys = ["CDPATH", "BASHOPTS", "SHELLOPTS", "BASH_ENV", "ENV", "BASH_FUNC_cd%%"];
  const original = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = key === "BASH_FUNC_cd%%" ? "() { :; }" : "inherited";
  const captured: NodeJS.ProcessEnv[] = [];
  const agent = new Agent({ streamFn: () => { throw new Error("offline provider must not be called"); } });
  const operations = { exec: async (_command: string, _cwd: string, options: { env?: NodeJS.ProcessEnv }) => { captured.push(options.env ?? {}); return { exitCode: 0 }; } };
  try {
    agent.state.tools = [createBashTool(fixture, { operations })];
    await agent.dispatchHostTool({ type: "toolCall", id: "bash-env", name: "bash", arguments: { command: "printf synthetic" } });
    for (const key of keys) assert.equal(Object.hasOwn(captured[0]!, key), false, key);
    assert.ok(captured[0]!.PATH ?? captured[0]!.Path, "ordinary inherited variables are kept");
    agent.state.tools = [createBashTool(fixture, { operations, spawnHook: context => ({ ...context, env: { ...context.env, CDPATH: "hooked" } }) })];
    await agent.dispatchHostTool({ type: "toolCall", id: "bash-env-hook", name: "bash", arguments: { command: "printf synthetic" } });
    assert.equal(captured[1]!.CDPATH, "hooked", "a spawn hook may still set the value deliberately");
    // The values only change Bash startup and cd; PowerShell keeps them as ordinary data.
    agent.state.tools = [createPowerShellTool(fixture, { operations })];
    await agent.dispatchHostTool({ type: "toolCall", id: "powershell-env", name: "powershell", arguments: { command: "Write-Output synthetic" } });
    for (const key of keys) assert.equal(captured[2]![key], process.env[key], key);
  } finally {
    agent.abort();
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fixture, { recursive: true });
  }
});

test("an inherited CDPATH cannot move a scanned cd in real Bash", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const parent = mkdtempSync(join(tmpdir(), "sp-shell-inherited-cdpath-"));
  const nested = join(parent, "workspace", "nested");
  mkdirSync(join(nested, "workspace"), { recursive: true });
  const originalCdpath = process.env.CDPATH;
  process.env.CDPATH = "../..";
  const agent = new Agent({ streamFn: () => { throw new Error("offline provider must not be called"); } });
  agent.state.tools = [createBashTool(nested, { operations: createLocalBashOperations({ shellPath }) })];
  try {
    const result = await agent.dispatchHostTool({ type: "toolCall", id: "bash-cdpath", name: "bash", arguments: { command: "cd workspace && printf marker >marker.txt" } });
    assert.equal(result.isError, false, (result.content[0] as { text: string }).text);
    assert.equal(readFileSync(join(nested, "workspace", "marker.txt"), "utf8"), "marker");
    assert.equal(existsSync(join(parent, "workspace", "marker.txt")), false);
  } finally {
    agent.abort();
    if (originalCdpath === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = originalCdpath;
    rmSync(parent, { recursive: true });
  }
});

test("a standalone ripgrep no-match stays an expected empty result after the runtime status prefix", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-rg-empty-"));
  const agent = new Agent({ streamFn: () => { throw new Error("offline provider must not be called"); } });
  agent.state.tools = [createBashTool(fixture, { operations: { async exec() { return { exitCode: 1 }; } } })];
  try {
    const command = "rg -n absent fixture.bin";
    const result = await agent.dispatchHostTool({ type: "toolCall", id: "rg-empty", name: "bash", arguments: { command } });
    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^\[SHELL_RUNTIME_FAILED\]/);
    assert.equal(classifyError("bash", text).category, "empty_nonzero_exit");
    const session = SessionManager.inMemory(fixture);
    session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "rg-empty", name: "bash", arguments: { command } }], stopReason: "toolUse", timestamp: Date.now() } as never);
    session.appendMessage(result);
    assert.deepEqual(collectSessionErrors(session.getBranch()), []);
    session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "rg-error", name: "bash", arguments: { command } }], stopReason: "toolUse", timestamp: Date.now() } as never);
    session.appendMessage({ ...result, toolCallId: "rg-error", content: [{ type: "text", text: "[SHELL_RUNTIME_FAILED] synthetic error\n\nCommand exited with code 1" }] });
    assert.equal(collectSessionErrors(session.getBranch()).length, 1, "a real ripgrep error must not be suppressed as no-match");
  } finally {
    agent.abort();
    rmSync(fixture, { recursive: true });
  }
});

test("runtime status keeps a leading script exception visible to error classification", async () => {
  const agent = new Agent({ streamFn: () => { throw new Error("offline provider must not be called"); } });
  agent.state.tools = [createBashTool(cwd, { operations: {
    async exec(_command, _cwd, options) { options.onData(Buffer.from("TypeError: synthetic\n")); return { exitCode: 1 }; },
  } })];
  try {
    const result = await agent.dispatchHostTool({ type: "toolCall", id: "script-runtime", name: "bash", arguments: { command: "printf synthetic" } });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /^\[SHELL_RUNTIME_FAILED\]\nTypeError: synthetic/);
    assert.equal(classifyError("bash", (result.content[0] as { text: string }).text).category, "script_runtime_error");
  } finally { agent.abort(); }
});

async function guardedCwdBoundaryFixture(workspace: string, shellPath: string, shellOperation: "bash" | "powershell" = "bash") {
  const jiti = createJiti(import.meta.url);
  const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
  const runtime = createExtensionRuntime();
  const sessionManager = SessionManager.inMemory(workspace);
  const runner = new ExtensionRunner(
    [await loadExtensionFromFactory((pi: any) => lifecycle(pi), workspace, createEventBus(), runtime)],
    runtime, workspace, sessionManager, {} as never,
  );
  let executions = 0;
  let decision = "仅允许本次";
  const approvals: string[] = [];
  const agent = new Agent({
    streamFn: () => { throw new Error("offline provider must not be called"); },
    beforeToolCall: async ({ toolCall, args }) => runner.emitToolCall({
      type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown>,
    } as never),
  });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => ["bash"],
    appendEntry: (type: string, data: unknown) => { sessionManager.appendCustomEntry(type, data); },
  } as never, {
    getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
    isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
  } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async (_title: any, _choices: any, options: any) => {
    approvals.push(options?.details ?? "");
    return decision;
  } }, "tui");
  const local = shellOperation === "bash" ? createLocalBashOperations({ shellPath }) : createLocalPowerShellOperations();
  const operations = { exec: (command: string, executionCwd: string, options: Parameters<typeof local.exec>[2]) => {
    executions++;
    return local.exec(command, executionCwd, options);
  } };
  agent.state.tools = [shellOperation === "bash"
    ? createBashTool(workspace, { exposeSessionEnvironment: false, operations })
    : createPowerShellTool(workspace, { exposeSessionEnvironment: false, operations })];
  await runner.emit({ type: "session_start" } as never);
  return {
    agent, approvals,
    get executions() { return executions; },
    setDecision(choice: string) { decision = choice; },
    async setMode(mode: "read-only" | "workspace-write") {
      await runner.getCommand("permissions")!.handler(mode, runner.createContext() as never);
    },
    async close() {
      agent.abort();
      runner.invalidate();
      await runner.emit({ type: "session_shutdown" } as never);
    },
  };
}

async function assertBoundaryRefusedBeforeSpawn(
  fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>>,
  workspace: string, id: string, command: string, paths: readonly string[],
) {
  const executions = fixture.executions;
  const approvals = fixture.approvals.length;
  const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command } });
  assert.equal(fixture.executions, executions, JSON.stringify({ result, approvals: fixture.approvals, predicted: inspectHighRiskBashMutation({ command }, workspace) }));
  assert.equal(fixture.approvals.length, approvals, "unsafe cwd must be refused before authorization choices");
  assert.equal(result.isError, true);
  assert.equal((result.details as any).executionStatus, "not_executed");
  for (const path of paths) assert.equal(existsSync(path), false, path);
  return result;
}

test("cwd recovery uses one verified same-shell call, not a grouped or later call", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-cwd-recovery-"));
  mkdirSync(join(workspace, "sub"));
  writeFileSync(join(workspace, "outer-fixture.txt"), "synthetic");
  writeFileSync(join(workspace, "sub", "recovery-fixture.txt"), "synthetic");
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    await fixture.setMode("read-only");
    const grouped = await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "grouped-recovery",
      "(cd sub && ls)", []);
    assert.match((grouped.content[0] as { text: string }).text, /working directory.*cannot be (?:established|tracked)/);
    const listed = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "same-shell-recovery", name: "bash", arguments: {
      command: "cd sub && ls",
    } });
    assert.equal(listed.isError, false, JSON.stringify(listed));
    assert.match((listed.content[0] as { text: string }).text, /recovery-fixture\.txt/);
    assert.doesNotMatch((listed.content[0] as { text: string }).text, /outer-fixture\.txt/);
    const cdOnly = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "cd-only", name: "bash", arguments: { command: "cd sub" } });
    assert.equal(cdOnly.isError, false, JSON.stringify(cdOnly));
    const later = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "later-call", name: "bash", arguments: { command: "ls" } });
    assert.equal(later.isError, false, JSON.stringify(later));
    assert.match((later.content[0] as { text: string }).text, /outer-fixture\.txt/);
    assert.doesNotMatch((later.content[0] as { text: string }).text, /recovery-fixture\.txt/);
    assert.equal(fixture.executions, 3);
    assert.equal(fixture.approvals.length, 0);
    assert.doesNotMatch((grouped.content[0] as { text: string }).text, /separately inspectable commands/);
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("real Bash guard keeps ordinary data and unbounded recursive expansions distinct", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-expansion-tiers-"));
  mkdirSync(join(workspace, "sub"));
  mkdirSync(join(workspace, ".git"));
  mkdirSync(join(workspace, "sub", ".git"));
  const protectedTarget = join(workspace, ".git", "config");
  const wrongTarget = join(workspace, "sub", ".git", "config");
  const originalReviewValue = process.env.SP_TEST_ARITH_REVIEW;
  process.env.SP_TEST_ARITH_REVIEW = "2";
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    await fixture.setMode("read-only");
    const ordinary = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "ordinary-expansion", name: "bash", arguments: {
      command: "echo $((1+2))",
    } });
    assert.equal(ordinary.isError, false, JSON.stringify(ordinary));
    assert.match((ordinary.content[0] as { text: string }).text, /3/);
    assert.equal(fixture.approvals.length, 0);

    for (const mode of ["read-only", "workspace-write"] as const) {
      await fixture.setMode(mode);
      for (const [id, unsafe] of [
        ["recursive-unbounded", "echo $((SP_TEST_ARITH_REVIEW*2))"],
        ["recursive-before-cd", "echo $((SP_TEST_ARITH_REVIEW*2)); cd sub; printf data >.git/config"],
        ["recursive-redirect", "echo $((SP_TEST_ARITH_REVIEW*2)) >.git/config"],
      ]) {
        await assertBoundaryRefusedBeforeSpawn(fixture, workspace, `${mode}-${id}`, unsafe, [protectedTarget, wrongTarget]);
      }
    }
    const blocked = await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "stateful-expansion",
      ": ${CDPATH:=..}; printf ok", [protectedTarget, wrongTarget]);
    assert.match((blocked.content[0] as { text: string }).text, /cannot|assigns|uninspectable/);
    assert.equal(fixture.executions, 1);
    assert.equal(fixture.approvals.length, 0);
  } finally {
    await fixture?.close();
    if (originalReviewValue === undefined) delete process.env.SP_TEST_ARITH_REVIEW;
    else process.env.SP_TEST_ARITH_REVIEW = originalReviewValue;
    rmSync(workspace, { recursive: true });
  }
});

test("inherited recursive arithmetic cannot approve a hidden protected write", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-recursive-target-"));
  mkdirSync(join(workspace, ".git"));
  const target = join(workspace, ".git", "config");
  const command = "echo $((SP_SHELL_RECURSIVE_VALUE))";
  const originalValue = process.env.SP_SHELL_RECURSIVE_VALUE;
  process.env.SP_SHELL_RECURSIVE_VALUE = "a[$(printf payload >.git/config)]";
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    try { execFileSync(shellPath, ["-c", command], { cwd: workspace, encoding: "utf8" }); } catch { /* Bash may exit after performing the substitution. */ }
    assert.equal(readFileSync(target, "utf8"), "payload", "direct Bash proves the inherited value can write the protected target");
    unlinkSync(target);

    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    for (const mode of ["read-only", "workspace-write"] as const) {
      await fixture.setMode(mode);
      const executions: number = fixture.executions;
      const approvals: number = fixture.approvals.length;
      const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id: `recursive-hidden-${mode}`, name: "bash", arguments: { command } });
      assert.equal(existsSync(target), false, JSON.stringify({ result, actual: existsSync(target) ? readFileSync(target, "utf8") : undefined }));
      assert.equal(fixture.executions, executions);
      assert.equal(fixture.approvals.length, approvals);
      assert.equal(result.isError, true);
      assert.equal((result.details as any).executionStatus, "not_executed");
    }
  } finally {
    await fixture?.close();
    if (originalValue === undefined) delete process.env.SP_SHELL_RECURSIVE_VALUE;
    else process.env.SP_SHELL_RECURSIVE_VALUE = originalValue;
    rmSync(workspace, { recursive: true });
  }
});

test("Bash wrapper and reserved prefixes cannot hide inherited recursive evaluation", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const previousValue = process.env.SP_SHELL_RECURSIVE_VALUE;
  process.env.SP_SHELL_RECURSIVE_VALUE = "a[$(printf payload >.git/config)]";
  try {
    for (const [id, command] of [
      ["bash-c-separator", "bash -c -- 'echo $((SP_SHELL_RECURSIVE_VALUE))'"],
      ["timed-bash-wrapper", "time -p -- bash -c 'echo $((SP_SHELL_RECURSIVE_VALUE))'"],
      ["combined-reserved-prefix", "! time -p -- bash -c 'echo $((SP_SHELL_RECURSIVE_VALUE))'"],
      ["negated-eval", "! eval 'echo $((SP_SHELL_RECURSIVE_VALUE))'"],
      ["builtin-eval", "builtin eval 'echo $((SP_SHELL_RECURSIVE_VALUE))'"],
      ["builtin-double-dash-eval", "builtin -- eval 'echo $((SP_SHELL_RECURSIVE_VALUE))'"],
    ] as const) await t.test(id, async () => {
      const workspace = mkdtempSync(join(tmpdir(), `sp-shell-recursive-${id}-`));
      mkdirSync(join(workspace, ".git"));
      const target = join(workspace, ".git", "config");
      let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
      try {
        try { execFileSync(shellPath, ["-c", command], { cwd: workspace, encoding: "utf8" }); }
        catch { /* A failed arithmetic expression or negation may return nonzero after its substitution. */ }
        assert.equal(readFileSync(target, "utf8"), "payload", "direct Bash proves the hidden protected write");
        unlinkSync(target);
        fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
        for (const mode of ["read-only", "workspace-write"] as const) {
          await fixture.setMode(mode);
          await assertBoundaryRefusedBeforeSpawn(fixture, workspace, `${mode}-${id}`, command, [target]);
          assert.equal(inspectHighRiskBashMutation({ command }, workspace)?.unverifiableScope, true);
        }
      } finally {
        await fixture?.close();
        rmSync(workspace, { recursive: true });
      }
    });
  } finally {
    if (previousValue === undefined) delete process.env.SP_SHELL_RECURSIVE_VALUE;
    else process.env.SP_SHELL_RECURSIVE_VALUE = previousValue;
  }
});

test("bounded Bash wrapper and reserved prefixes still execute literal harmless scripts", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-safe-wrappers-"));
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    await fixture.setMode("read-only");
    for (const [id, command, expected] of [
      ["bash-c-separator", "bash -c -- 'printf wrapper-ok'", "wrapper-ok"],
      ["timed-bash-wrapper", "time -p -- bash -c 'printf timed-wrapper-ok'", "timed-wrapper-ok"],
      ["negated-eval", "! eval 'false' && printf eval-ok", "eval-ok"],
      ["builtin-double-dash-eval", "builtin -- eval 'printf builtin-ok'", "builtin-ok"],
      ["quoted-arithmetic-data", "printf '%s' '(( PATH=0 ))'", "(( PATH=0 ))"],
      ["unrelated-export", "export CANDIDATE=..; cd . && printf unrelated-ok", "unrelated-ok"],
      ["hash-list", "hash; printf hash-list-ok", "hash-list-ok"],
      ["hash-list-redirect", "hash >hash-list.txt; printf hash-redirect-ok", "hash-redirect-ok"],
    ] as const) {
      const executions: number = fixture.executions;
      const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command } });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.match((result.content[0] as { text: string }).text, new RegExp(expected));
      assert.equal(fixture.executions, executions + 1);
      assert.notEqual(inspectHighRiskBashMutation({ command }, workspace)?.unverifiableScope, true);
    }
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("Bash stateful commands cannot hide a changed executable lookup", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-arithmetic-lookup-"));
  const target = join(workspace, ".git", "config");
  mkdirSync(join(workspace, ".git"));
  mkdirSync(join(workspace, "0"));
  const executable = join(workspace, "0", "cat");
  writeFileSync(executable, "#!/bin/sh\nprintf payload >.git/config\n");
  chmodSync(executable, 0o755);
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    for (const [id, command] of [
      ["standalone", "(( PATH=0 )); cat"],
      ["loop-body", "for candidate in one; do (( PATH=0 )); done; cat"],
      ["hash-override", "hash -p ./0/cat cat; cat"],
      ["builtin-hash-override", "builtin hash -p ./0/cat cat; cat"],
      ["builtin-double-dash-hash", "builtin -- hash -p ./0/cat cat; cat"],
      ["command-hash-override", "command hash -p ./0/cat cat; cat"],
    ] as const) {
      execFileSync(shellPath, ["-c", command], { cwd: workspace, encoding: "utf8" });
      assert.equal(readFileSync(target, "utf8"), "payload", `${id}: direct Bash selects the synthetic executable`);
      unlinkSync(target);
      fixture ??= await guardedCwdBoundaryFixture(workspace, shellPath);
      for (const mode of ["read-only", "workspace-write"] as const) {
        await fixture.setMode(mode);
        await assertBoundaryRefusedBeforeSpawn(fixture, workspace, `${mode}-${id}-arithmetic-lookup`, command, [target]);
      }
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/, id);
      assert.equal(inspectHighRiskBashMutation({ command }, workspace)?.unverifiableScope, true, id);
      assert.equal(inspectBashPermissionScope({ command }, workspace)?.unverifiableScope, true, id);
    }
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("PowerShell high-risk scan preserves the inner Bash boundary", () => {
  assert.equal(inspectHighRiskBashMutation({ command: "echo $((1 + $null))" }, cwd, "powershell"), undefined);
  assert.equal(inspectHighRiskBashMutation({ command: "bash -c 'echo $((SP_SHELL_RECURSIVE_VALUE))'" }, cwd, "powershell")?.unverifiableScope, true);
  assert.equal(inspectHighRiskBashMutation({ command: "bash -c -- 'echo $((SP_SHELL_RECURSIVE_VALUE))'" }, cwd, "powershell")?.unverifiableScope, true);
});

test("PowerShell arithmetic subexpressions use PowerShell approval rather than Bash expansion refusal", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell tool execution is Windows-only");
    return;
  }
  try { execFileSync("pwsh", ["-NoProfile", "-Command", "echo $((1 + $null))"], { encoding: "utf8" }); }
  catch {
    if (process.env.CI && process.platform === "win32") assert.fail("Required Windows PowerShell integration test could not start pwsh");
    t.skip("pwsh unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-powershell-arithmetic-"));
  const protectedTarget = join(workspace, ".git", "config");
  mkdirSync(join(workspace, ".git"));
  writeFileSync(protectedTarget, "synthetic");
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    fixture = await guardedCwdBoundaryFixture(workspace, "", "powershell");
    await fixture.setMode("read-only");
    const command = "echo $((1 + $null))";
    const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "powershell-arithmetic", name: "powershell", arguments: { command } });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match((result.content[0] as { text: string }).text, /1/);
    assert.equal(fixture.executions, 1);
    assert.equal(fixture.approvals.length, 1, "dynamic PowerShell syntax follows ordinary opaque-script approval");
    assert.doesNotMatch(fixture.approvals[0]!, /stateful_shell_expansion/);

    for (const [id, nestedBash] of [
      ["powershell-nested-bash", "bash -c 'echo $((SP_SHELL_RECURSIVE_VALUE))'"],
      ["powershell-nested-bash-separator", "bash -c -- 'echo $((SP_SHELL_RECURSIVE_VALUE))'"],
    ] as const) {
      assert.equal(inspectHighRiskBashMutation({ command: nestedBash }, workspace, "powershell")?.unverifiableScope, true);
      const nested = await fixture.agent.dispatchHostTool({ type: "toolCall", id, name: "powershell", arguments: { command: nestedBash } });
      assert.equal(nested.isError, true);
      assert.equal((nested.details as any).executionStatus, "not_executed");
      assert.equal(fixture.executions, 1);
      assert.equal(fixture.approvals.length, 1);
    }

    fixture.setDecision("拒绝");
    const beforeExecutions: number = fixture.executions;
    const denied = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "powershell-recursive-delete", name: "powershell", arguments: {
      command: "Remove-Item -Recurse -LiteralPath .git/config",
    } });
    assert.equal(denied.isError, true);
    assert.equal((denied.details as any).executionStatus, "not_executed");
    assert.equal(fixture.executions, beforeExecutions);
    assert.equal(fixture.approvals.length, 2);
    assert.match(fixture.approvals[1]!, /powershell_remove_recursive/);
    assert.equal(readFileSync(protectedTarget, "utf8"), "synthetic");
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("subshell cwd never authorizes a later parent-shell write at the child path", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-subshell-cwd-"));
  mkdirSync(join(workspace, "subdir"));
  mkdirSync(join(workspace, ".git"));
  mkdirSync(join(workspace, "subdir", ".git"));
  const command = "(cd subdir && printf inner) && printf marker >cwd-marker.txt";
  const marker = join(workspace, "cwd-marker.txt");
  const wrongMarker = join(workspace, "subdir", "cwd-marker.txt");
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    execFileSync(shellPath, ["-c", command], { cwd: workspace, encoding: "utf8" });
    assert.equal(readFileSync(marker, "utf8"), "marker", "direct Bash writes in the parent shell cwd");
    assert.equal(existsSync(wrongMarker), false);
    unlinkSync(marker);

    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    await fixture.setMode("read-only");
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/);
    assert.equal(inspectHighRiskBashMutation({ command }, workspace)?.unverifiableScope, true);
    assert.equal(inspectBashPermissionScope({ command }, workspace)?.unverifiableScope, true);
    const blocked = await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "subshell-cwd", command, [marker, wrongMarker]);
    const protectedRoot = join(workspace, ".git", "config");
    const fakeProtected = join(workspace, "subdir", ".git", "config");
    await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "subshell-protected-read-only",
      "(cd subdir && printf inner) && printf marker >.git/config", [protectedRoot, fakeProtected]);
    for (const [id, nested] of [
      ["closed-subshell", "(cd subdir); printf marker >closed-marker.txt"],
      ["nested-subshell", "( ( cd subdir && printf inner ) ) && printf marker >nested-marker.txt"],
      ["pipeline-subshell", "(cd subdir && printf inner) | cat && printf marker >pipeline-marker.txt"],
      ["loop-subshell", "for candidate in one; do (cd subdir && printf inner); done; printf marker >looped-marker.txt"],
    ]) {
      const name = id === "closed-subshell" ? "closed-marker.txt" : id === "nested-subshell" ? "nested-marker.txt"
        : id === "pipeline-subshell" ? "pipeline-marker.txt" : "looped-marker.txt";
      await assertBoundaryRefusedBeforeSpawn(fixture, workspace, id, nested,
        [join(workspace, name), join(workspace, "subdir", name)]);
    }

    fixture.setDecision("拒绝");
    const deniedCommand = "cd subdir && printf marker >denied-same-shell.txt";
    const beforeDenied = fixture.executions;
    const denied = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "same-shell-denied", name: "bash", arguments: { command: deniedCommand } });
    assert.equal(denied.isError, true);
    assert.equal(fixture.executions, beforeDenied);
    assert.equal(existsSync(join(workspace, "subdir", "denied-same-shell.txt")), false);

    fixture.setDecision("仅允许本次");
    const allowed = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "same-shell-allowed", name: "bash", arguments: { command: "cd subdir && printf marker >same-shell-marker.txt" } });
    assert.equal(allowed.isError, false, JSON.stringify(allowed));
    assert.equal(readFileSync(join(workspace, "subdir", "same-shell-marker.txt"), "utf8"), "marker");
    assert.equal(existsSync(join(workspace, "same-shell-marker.txt")), false);
    assert.match(fixture.approvals.at(-1)!, /subdir[\\/]same-shell-marker\.txt/);

    await fixture.setMode("workspace-write");
    const beforeAutoApprovals = fixture.approvals.length;
    await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "subshell-protected-workspace",
      "(cd subdir && printf inner) && printf marker >.git/config", [protectedRoot, fakeProtected]);
    await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "subshell-marker-workspace", command, [marker, wrongMarker]);
    const auto = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "same-shell-workspace", name: "bash", arguments: { command: "cd subdir && printf marker >same-shell-auto.txt" } });
    assert.equal(auto.isError, false, JSON.stringify(auto));
    assert.equal(readFileSync(join(workspace, "subdir", "same-shell-auto.txt"), "utf8"), "marker");
    assert.ok(fixture.approvals.length === beforeAutoApprovals || fixture.approvals.length === beforeAutoApprovals + 1);
    if (fixture.approvals.length > beforeAutoApprovals) assert.match(fixture.approvals.at(-1)!, /subdir[\\/]same-shell-auto\.txt/);

    const saved = SessionManager.create(workspace, join(workspace, "sessions"));
    saved.appendMessage(blocked);
    saved.ensureOperationStorage();
    const beforeReopen = fixture.executions;
    assert.equal((SessionManager.open(saved.getSessionFile()!).getBranch().find(entry => entry.type === "message") as any).message.details.executionStatus, "not_executed");
    assert.equal(fixture.executions, beforeReopen, "session reopen must not replay a refused command");
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("reviewed cwd state changes never approve a different protected target", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-reviewed-cwd-"));
  const nested = join(workspace, "nested");
  mkdirSync(nested);
  mkdirSync(join(workspace, ".git"));
  mkdirSync(join(nested, ".git"));
  mkdirSync(join(nested, "sub"));
  writeFileSync(join(nested, "override.sh"), "cd() { builtin cd ..; }\n");
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    fixture = await guardedCwdBoundaryFixture(nested, shellPath);
    for (const [id, command, actual, predicted] of [
      ["failed-cd", "cd missing-synthetic; printf data >.git/config", join(nested, ".git", "config"), join(nested, "missing-synthetic", ".git", "config")],
      ["quoted-substitution", "cd .. && echo \"$(printf data >.git/config)\"", join(workspace, ".git", "config"), join(nested, ".git", "config")],
      ["builtin-cd", "builtin cd .. && printf data >.git/config", join(workspace, ".git", "config"), join(nested, ".git", "config")],
      ["command-p-cd", "command -p cd .. && printf data >.git/config", join(workspace, ".git", "config"), join(nested, ".git", "config")],
      ["conditional-cd", "if cd ..; then :; fi; printf data >.git/config", join(workspace, ".git", "config"), join(nested, ".git", "config")],
      ["eval-redefines-cd", "eval 'cd() { builtin cd ..; }'; cd sub && printf data >.git/config", join(workspace, ".git", "config"), join(nested, "sub", ".git", "config")],
      ["source-redefines-cd", "source ./override.sh; cd sub && printf data >.git/config", join(workspace, ".git", "config"), join(nested, "sub", ".git", "config")],
    ] as const) await t.test(id, async () => {
      try {
        execFileSync(shellPath, ["-c", command], { cwd: nested, encoding: "utf8", env: { ...process.env, CDPATH: "" } });
        assert.equal(readFileSync(actual, "utf8"), "data", `${id}: direct Bash target`);
        assert.equal(existsSync(predicted), false, `${id}: scanner's other target`);
        unlinkSync(actual);
        for (const mode of ["read-only", "workspace-write"] as const) {
          await fixture!.setMode(mode);
          await assertBoundaryRefusedBeforeSpawn(fixture!, nested, `${mode}-${id}`, command, [actual, predicted]);
        }
      } finally {
        if (existsSync(actual)) unlinkSync(actual);
      }
    });
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("for-list assignment expansion cannot authorize the wrong cwd", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const parent = mkdtempSync(join(tmpdir(), "sp-shell-for-cwd-"));
  const workspace = join(parent, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "workspace"));
  const command = "for candidate in ${CDPATH:=..}; do printf ok; done; cd workspace; printf marker >loop-marker.txt";
  const marker = join(workspace, "loop-marker.txt");
  const wrongMarker = join(workspace, "workspace", "loop-marker.txt");
  const originalCdpath = process.env.CDPATH;
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  delete process.env.CDPATH;
  try {
    execFileSync(shellPath, ["-c", command], { cwd: workspace, encoding: "utf8" });
    assert.equal(readFileSync(marker, "utf8"), "marker", "direct Bash resolves CDPATH to the outer workspace");
    assert.equal(existsSync(wrongMarker), false);
    unlinkSync(marker);

    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    await fixture.setMode("read-only");
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/);
    assert.equal(inspectHighRiskBashMutation({ command }, workspace)?.unverifiableScope, true);
    assert.equal(inspectBashPermissionScope({ command }, workspace)?.unverifiableScope, true);
    const blocked = await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "for-list-cwd", command, [marker, wrongMarker]);
    const quoted = "for candidate in \"${CDPATH:=..}\"; do printf ok; done; cd workspace; printf marker >double-marker.txt";
    await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "for-list-double-quoted", quoted,
      [join(workspace, "double-marker.txt"), join(workspace, "workspace", "double-marker.txt")]);
    for (const [id, list] of [
      ["for-list-arithmetic", "$((CDPATH=1))"],
      ["for-list-substitution", "$(printf ..)"],
    ]) {
      const unsafe = `for candidate in ${list}; do printf ok; done; cd workspace; printf marker >${id}.txt`;
      assert.equal(inspectHighRiskBashMutation({ command: unsafe }, workspace)?.unverifiableScope, true);
      assert.equal(inspectBashPermissionScope({ command: unsafe }, workspace)?.unverifiableScope, true);
      await assertBoundaryRefusedBeforeSpawn(fixture, workspace, id, unsafe,
        [join(workspace, `${id}.txt`), join(workspace, "workspace", `${id}.txt`)]);
    }
    const protectedRoot = join(workspace, ".git", "config");
    const fakeProtected = join(workspace, "workspace", ".git", "config");
    mkdirSync(join(workspace, ".git"));
    mkdirSync(join(workspace, "workspace", ".git"));
    const protectedCommand = "for candidate in ${CDPATH:=..}; do printf ok; done; cd workspace; printf marker >.git/config";
    await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "for-list-protected-read-only", protectedCommand,
      [protectedRoot, fakeProtected]);

    const literalCommand = "for candidate in one two; do printf ok; done; cd workspace && printf marker >literal-marker.txt";
    const literal = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "for-list-literal", name: "bash", arguments: { command: literalCommand } });
    assert.equal(literal.isError, false, JSON.stringify(literal));
    assert.equal(readFileSync(join(workspace, "workspace", "literal-marker.txt"), "utf8"), "marker");
    assert.equal(existsSync(join(workspace, "literal-marker.txt")), false);
    assert.match(fixture.approvals.at(-1)!, /workspace[\\/]workspace[\\/]literal-marker\.txt/);

    await fixture.setMode("workspace-write");
    const beforeAutoApprovals = fixture.approvals.length;
    await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "for-list-workspace", command, [marker, wrongMarker]);
    await assertBoundaryRefusedBeforeSpawn(fixture, workspace, "for-list-protected-workspace", protectedCommand,
      [protectedRoot, fakeProtected]);
    const singleQuoted = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "for-list-single-quoted", name: "bash", arguments: {
      command: "for candidate in '${CDPATH:=..}'; do printf ok; done; cd workspace && printf marker >single-marker.txt",
    } });
    assert.equal(singleQuoted.isError, false, JSON.stringify(singleQuoted));
    assert.equal(readFileSync(join(workspace, "workspace", "single-marker.txt"), "utf8"), "marker");
    assert.equal(existsSync(join(workspace, "single-marker.txt")), false);
    assert.ok(fixture.approvals.length === beforeAutoApprovals || fixture.approvals.length === beforeAutoApprovals + 1);
    if (fixture.approvals.length > beforeAutoApprovals) assert.match(fixture.approvals.at(-1)!, /workspace[\\/]workspace[\\/]single-marker\.txt/);
    await fixture.setMode("read-only");
    const beforeQueryApprovals = fixture.approvals.length;
    const query = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "for-list-simple-query", name: "bash", arguments: {
      command: 'for candidate in "$HOME"; do command -v printf; done',
    } });
    assert.equal(query.isError, false, JSON.stringify(query));
    assert.equal(fixture.approvals.length, beforeQueryApprovals);

    const saved = SessionManager.create(workspace, join(workspace, "sessions"));
    saved.appendMessage(blocked);
    saved.ensureOperationStorage();
    const beforeReopen = fixture.executions;
    assert.equal((SessionManager.open(saved.getSessionFile()!).getBranch().find(entry => entry.type === "message") as any).message.details.executionStatus, "not_executed");
    assert.equal(fixture.executions, beforeReopen, "session reopen must not replay a refused command");
  } finally {
    await fixture?.close();
    if (originalCdpath === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = originalCdpath;
    rmSync(parent, { recursive: true });
  }
});

test("reviewed cwd and loop-header variants refuse before authorizing a different path", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const variants = [
    {
      name: "multiline-for-list",
      command: "for candidate\nin ${CDPATH:=..}\ndo :; done\ncd workspace\nprintf marker >.git/config",
      actual: ".git/config", wrong: "workspace/.git/config", mode: "read-only",
    },
    {
      name: "multiline-for-list-double-quoted",
      command: "for candidate\nin \"${CDPATH:=..}\"\ndo :; done\ncd workspace\nprintf marker >.git/config",
      actual: ".git/config", wrong: "workspace/.git/config", mode: "read-only",
    },
    {
      name: "leading-redirection-subshell-cd",
      command: "(>/dev/null cd subdir) && printf marker >.git/config",
      actual: ".git/config", wrong: "subdir/.git/config", mode: "read-only",
    },
    {
      name: "cd-double-dash",
      command: "cd -- subdir && printf marker >.git/config",
      actual: "subdir/.git/config", wrong: "--/.git/config", mode: "workspace-write",
    },
    {
      name: "cd-physical-option",
      command: "cd -P subdir && printf marker >.git/config",
      actual: "subdir/.git/config", wrong: "-P/.git/config", mode: "workspace-write",
    },
    {
      name: "select-list-assignment",
      command: "select candidate in ${CDPATH:=..}; do :; done </dev/null; cd workspace; printf marker >.git/config",
      actual: ".git/config", wrong: "workspace/.git/config", mode: "read-only",
    },
    {
      name: "select-list-double-quoted",
      command: "select candidate in \"${CDPATH:=..}\"; do :; done </dev/null; cd workspace; printf marker >.git/config",
      actual: ".git/config", wrong: "workspace/.git/config", mode: "read-only",
    },
    {
      name: "multiline-select-list",
      command: "select candidate\nin ${CDPATH:=..}\ndo :; done </dev/null\ncd workspace\nprintf marker >.git/config",
      actual: ".git/config", wrong: "workspace/.git/config", mode: "read-only",
    },
    {
      name: "timed-for-list-assignment",
      command: "time -- for candidate in ${CDPATH:=..}; do :; done; cd workspace; printf marker >.git/config",
      actual: ".git/config", wrong: "workspace/.git/config", mode: "read-only",
    },
    {
      name: "timed-select-list-assignment",
      command: "time -p -- select candidate in ${CDPATH:=..}; do :; done </dev/null; cd workspace; printf marker >.git/config",
      actual: ".git/config", wrong: "workspace/.git/config", mode: "read-only",
    },
  ] as const;
  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const parent = mkdtempSync(join(tmpdir(), `sp-shell-review-${variant.name}-`));
      const workspace = join(parent, "workspace");
      mkdirSync(join(workspace, ".git"), { recursive: true });
      mkdirSync(join(workspace, "workspace", ".git"), { recursive: true });
      mkdirSync(join(workspace, "subdir", ".git"), { recursive: true });
      mkdirSync(join(workspace, "--", ".git"), { recursive: true });
      const actual = join(workspace, variant.actual);
      const wrong = join(workspace, variant.wrong);
      const originalCdpath = process.env.CDPATH;
      let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
      delete process.env.CDPATH;
      try {
        execFileSync(shellPath, ["-c", variant.command], { cwd: workspace, encoding: "utf8" });
        assert.equal(readFileSync(actual, "utf8"), "marker", "direct Bash establishes the actual target");
        assert.equal(existsSync(wrong), false);
        unlinkSync(actual);

        fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
        await fixture.setMode(variant.mode);
        const blocked = await assertBoundaryRefusedBeforeSpawn(fixture, workspace, variant.name, variant.command, [actual, wrong]);
        assert.equal(inspectHighRiskBashMutation({ command: variant.command }, workspace)?.unverifiableScope, true);
        assert.equal(inspectBashPermissionScope({ command: variant.command }, workspace)?.unverifiableScope, true);
        await fixture.setMode(variant.mode === "read-only" ? "workspace-write" : "read-only");
        await assertBoundaryRefusedBeforeSpawn(fixture, workspace, `${variant.name}-other-mode`, variant.command, [actual, wrong]);
        const saved = SessionManager.create(workspace, join(workspace, "sessions"));
        saved.appendMessage(blocked);
        saved.ensureOperationStorage();
        const beforeReopen = fixture.executions;
        assert.equal((SessionManager.open(saved.getSessionFile()!).getBranch().find(entry => entry.type === "message") as any).message.details.executionStatus, "not_executed");
        assert.equal(fixture.executions, beforeReopen, "session reopen must not replay the refused command");
      } finally {
        await fixture?.close();
        if (originalCdpath === undefined) delete process.env.CDPATH;
        else process.env.CDPATH = originalCdpath;
        rmSync(parent, { recursive: true });
      }
    });
  }
});

test("literal multiline for and select lists keep the actual workspace target", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const parent = mkdtempSync(join(tmpdir(), "sp-shell-loop-literal-"));
  const workspace = join(parent, "workspace");
  mkdirSync(join(workspace, "workspace"), { recursive: true });
  const originalCdpath = process.env.CDPATH;
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  delete process.env.CDPATH;
  try {
    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    await fixture.setMode("read-only");
    for (const [id, command] of [
      ["multiline-literal", "for candidate\nin one two\ndo printf ok; done\ncd workspace && printf marker >multiline-literal.txt"],
      ["multiline-single-quoted", "for candidate\nin '${CDPATH:=..}'\ndo printf ok; done\ncd workspace && printf marker >multiline-single-quoted.txt"],
      ["select-literal", "select candidate in one two; do :; done </dev/null; cd workspace && printf marker >select-literal.txt"],
      ["select-single-quoted", "select candidate in '${CDPATH:=..}'; do :; done </dev/null; cd workspace && printf marker >select-single-quoted.txt"],
      ["timed-for-literal", "time -- for candidate in one two; do printf ok; done; cd workspace && printf marker >timed-for-literal.txt"],
      ["timed-select-literal", "time -p -- select candidate in one two; do :; done </dev/null; cd workspace && printf marker >timed-select-literal.txt"],
    ] as const) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, id);
      assert.equal(inspectHighRiskBashMutation({ command }, workspace)?.primitives.includes("stateful_loop_list_expansion"), false, id);
      assert.equal(inspectBashPermissionScope({ command }, workspace)?.primitives.includes("stateful_loop_list_expansion"), false, id);
      const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command } });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(readFileSync(join(workspace, "workspace", `${id}.txt`), "utf8"), "marker");
      assert.equal(existsSync(join(workspace, `${id}.txt`)), false);
      assert.match(fixture.approvals.at(-1)!, new RegExp(`workspace[\\\\/]workspace[\\\\/]${id}\\.txt`));
    }
  } finally {
    await fixture?.close();
    if (originalCdpath === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = originalCdpath;
    rmSync(parent, { recursive: true });
  }
});

test("leading redirection before same-shell cd retains the dependent write target", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-leading-cd-positive-"));
  mkdirSync(join(workspace, "subdir"));
  const command = ">/dev/null cd subdir && printf marker >leading-marker.txt";
  const actual = join(workspace, "subdir", "leading-marker.txt");
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    execFileSync(shellPath, ["-c", command], { cwd: workspace, encoding: "utf8" });
    assert.equal(readFileSync(actual, "utf8"), "marker");
    unlinkSync(actual);
    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    await fixture.setMode("read-only");
    const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "leading-cd-same-shell", name: "bash", arguments: { command } });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(inspectBashResourceLifecycle({ command }), undefined);
    assert.equal(fixture.executions, 1);
    assert.equal(readFileSync(actual, "utf8"), "marker");
    assert.equal(existsSync(join(workspace, "leading-marker.txt")), false);
    assert.match(fixture.approvals.at(-1)!, /subdir[\\/]leading-marker\.txt/);
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("assignment-prefixed cd cannot authorize a different protected cwd", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const parent = mkdtempSync(join(tmpdir(), "sp-shell-assigned-cd-"));
  const outer = join(parent, "workspace");
  const workspace = join(outer, "workspace");
  mkdirSync(join(outer, ".git"), { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(workspace, "workspace", ".git"), { recursive: true });
  const actual = join(outer, ".git", "config");
  const wrong = join(workspace, ".git", "config");
  const originalCdpath = process.env.CDPATH;
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  delete process.env.CDPATH;
  try {
    for (const [id, command] of [
      ["redirected-assigned-cd", ">/dev/null CDPATH=../.. cd workspace && printf marker >.git/config"],
      ["assigned-cd", "CDPATH=../.. cd workspace && printf marker >.git/config"],
      ["standalone-cdpath", "CDPATH=../..; cd workspace && printf marker >.git/config"],
      ["export-cdpath", "export CDPATH=../..; cd workspace && printf marker >.git/config"],
      ["prefixed-export-cdpath", "CDPATH=../.. export CDPATH; cd workspace && printf marker >.git/config"],
      ["prefixed-readonly-cdpath", "CDPATH=../.. readonly CDPATH; cd workspace && printf marker >.git/config"],
      ["declare-cdpath", "declare CDPATH=../..; cd workspace && printf marker >.git/config"],
      ["typeset-cdpath", "typeset CDPATH=../..; cd workspace && printf marker >.git/config"],
      ["readonly-cdpath", "readonly CDPATH=../..; cd workspace && printf marker >.git/config"],
      ["nested-command-assigned-cd", ">/dev/null CDPATH=../.. command command cd workspace && printf marker >.git/config"],
      ["nested-builtin-assigned-cd", "CDPATH=../.. builtin command builtin cd workspace && printf marker >.git/config"],
      ["expansion-assigned-cdpath", ": ${CDPATH:=../..}; cd workspace && printf marker >.git/config"],
      ["assigned-pushd", "CDPATH=../.. pushd workspace >/dev/null && printf marker >.git/config"],
      ["assigned-command-p-cd", "CDPATH=../.. command -p cd workspace && printf marker >.git/config"],
    ] as const) {
      execFileSync(shellPath, ["-c", command], { cwd: workspace, encoding: "utf8" });
      assert.equal(readFileSync(actual, "utf8"), "marker", `${id}: direct Bash writes the protected outer target`);
      assert.equal(existsSync(wrong), false);
      unlinkSync(actual);
      fixture ??= await guardedCwdBoundaryFixture(workspace, shellPath);
      await fixture.setMode("read-only");
      const blocked = await assertBoundaryRefusedBeforeSpawn(fixture, workspace, id, command, [actual, wrong]);
      assert.equal((blocked.details as any).executionStatus, "not_executed");
      assert.equal(inspectHighRiskBashMutation({ command }, workspace)?.unverifiableScope, true);
      assert.equal(inspectBashPermissionScope({ command }, workspace)?.unverifiableScope, true);
      await fixture.setMode("workspace-write");
      await assertBoundaryRefusedBeforeSpawn(fixture, workspace, `${id}-workspace`, command, [actual, wrong]);
    }
    for (const [id, benign, expected] of [
      ["cdpath-without-cd", "CDPATH=../..; printf no-cd-ok", "no-cd-ok"],
      ["prefixed-export-without-cd", "CDPATH=../.. export CDPATH; printf no-cd-export-ok", "no-cd-export-ok"],
    ] as const) {
      assert.equal(inspectBashResourceLifecycle({ command: benign }), undefined);
      const beforeBenign: number = fixture!.executions;
      const allowed = await fixture!.agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command: benign } });
      assert.equal(allowed.isError, false, JSON.stringify(allowed));
      assert.match((allowed.content[0] as { text: string }).text, new RegExp(expected));
      assert.equal(fixture!.executions, beforeBenign + 1);
    }
  } finally {
    await fixture?.close();
    if (originalCdpath === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = originalCdpath;
    rmSync(parent, { recursive: true });
  }
});

test("bounded command prefixes and timed Bash tests retain guard and authorization checks", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-timed-test-"));
  const protectedTarget = join(workspace, ".git", "config");
  const timedTarget = join(workspace, "timed-marker.txt");
  mkdirSync(join(workspace, ".git"));
  function assertDisplayedTarget(approval: string, target: string) {
    const displayPath = approval.match(/目标范围:\r?\n([^\r\n]+)/)?.[1];
    assert.ok(displayPath, approval);
    assert.equal(basename(displayPath), basename(target));
    const displayedParent = statSync(dirname(displayPath));
    const targetParent = statSync(dirname(target));
    assert.deepEqual([displayedParent.dev, displayedParent.ino], [targetParent.dev, targetParent.ino]);
  }
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    for (const mode of ["read-only", "workspace-write"] as const) {
      await fixture.setMode(mode);
      for (const [id, command, expected] of [
        ["nested-command", "command command printf nested-command-ok", "nested-command-ok"],
        ["nested-builtin", "builtin command builtin printf nested-builtin-ok", "nested-builtin-ok"],
        ["time-double-bracket", "time -- [[ a < b ]] && printf timed-ok", "timed-ok"],
        ["time-portable-double-bracket", "time -p -- [[ a < b ]] && printf portable-ok", "portable-ok"],
      ] as const) {
        const beforeExecutions: number = fixture.executions;
        const beforeApprovals: number = fixture.approvals.length;
        const distinctCommand = mode === "workspace-write" ? `${command} # workspace-write` : command;
        const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id: `${mode}-${id}`, name: "bash", arguments: { command: distinctCommand } });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.match((result.content[0] as { text: string }).text, new RegExp(expected));
        assert.equal(fixture.executions, beforeExecutions + 1);
        if (id.startsWith("time-")) assert.equal(fixture.approvals.length, beforeApprovals, `${command} is a read-only test`);
      }
      fixture.setDecision("拒绝");
      for (const [id, command] of [
        ["time-protected-output", "time -- [[ a < b ]] >.git/config"],
        ["time-portable-protected-output", "time -p -- [[ a < b ]] >.git/config"],
      ] as const) {
        const beforeExecutions: number = fixture.executions;
        const beforeApprovals: number = fixture.approvals.length;
        const distinctCommand = mode === "workspace-write" ? `${command} # workspace-write` : command;
        const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id: `${mode}-${id}`, name: "bash", arguments: { command: distinctCommand } });
        assert.equal(result.isError, true);
        assert.equal((result.details as any).executionStatus, "not_executed");
        assert.equal(fixture.executions, beforeExecutions);
        assert.equal(fixture.approvals.length, beforeApprovals + 1, JSON.stringify({ id, mode, result, approvals: fixture.approvals }));
        assertDisplayedTarget(fixture.approvals.at(-1)!, protectedTarget);
        assert.equal(existsSync(protectedTarget), false);
      }
      fixture.setDecision("仅允许本次");
      for (const [id, command] of [
        ["time-process-substitution", "time -- [[ -e <(printf payload >.git/config) ]]"],
        ["time-stateful-expansion", "time -p -- [[ -n ${CDPATH:=..} ]]"],
      ] as const) {
        const distinctCommand = mode === "workspace-write" ? `${command} # workspace-write` : command;
        const blocked = await assertBoundaryRefusedBeforeSpawn(fixture, workspace, `${mode}-${id}`, distinctCommand, [protectedTarget, timedTarget]);
        assert.doesNotMatch((blocked.content[0] as { text: string }).text, /UNCHANGED_REJECTED_REQUEST/);
      }
    }
    await fixture.setMode("read-only");
    const beforeExecutions = fixture.executions;
    const beforeApprovals = fixture.approvals.length;
    const command = "time -- [[ a < b ]] && printf marker >timed-marker.txt";
    const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id: "time-authorized-output", name: "bash", arguments: { command } });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(fixture.executions, beforeExecutions + 1);
    assert.equal(fixture.approvals.length, beforeApprovals + 1);
    assertDisplayedTarget(fixture.approvals.at(-1)!, timedTarget);
    assert.equal(readFileSync(timedTarget, "utf8"), "marker");
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("read-only positional loop lists remain executable through the guard", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip("Bash unavailable");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "sp-shell-positional-list-"));
  let fixture: Awaited<ReturnType<typeof guardedCwdBoundaryFixture>> | undefined;
  try {
    fixture = await guardedCwdBoundaryFixture(workspace, shellPath);
    await fixture.setMode("read-only");
    for (const [id, command] of [
      ["for-positional-list", 'for candidate\nin "$@"\ndo command -v "$candidate"; done'],
      ["select-positional-list", 'select candidate in "$@"; do command -v "$candidate"; done </dev/null'],
      ["braced-positional-list", 'for candidate in "${@}"; do command -v "$candidate"; done'],
      ["timed-positional-list", 'time -- for candidate in "$@"; do command -v "$candidate"; done'],
    ] as const) {
      const beforeApprovals = fixture.approvals.length;
      const beforeExecutions: number = fixture.executions;
      const result = await fixture.agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command } });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, id);
      assert.notEqual(inspectHighRiskBashMutation({ command }, workspace)?.unverifiableScope, true, id);
      assert.notEqual(inspectBashPermissionScope({ command }, workspace)?.primitives.includes("stateful_loop_list_expansion"), true, id);
      assert.equal(fixture.executions, beforeExecutions + 1);
      assert.ok(fixture.approvals.length === beforeApprovals || fixture.approvals.length === beforeApprovals + 1);
    }
  } finally {
    await fixture?.close();
    rmSync(workspace, { recursive: true });
  }
});

test("real guard, authorization, Bash and tool-result path handle three feedback command shapes", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip(`Bash unavailable at ${shellPath ?? "known locations"}`);
    return;
  }
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-compat-"));
  mkdirSync(join(fixture, ".git"));
  mkdirSync(join(fixture, "subdir"));
  writeFileSync(join(fixture, "fixture.bin"), Buffer.from([0x50, 0x49, 0x01, 0x02]));
  writeFileSync(join(fixture, "subdir", "fixture.bin"), Buffer.from([0x50, 0x49, 0x01, 0x02]));
  const jiti = createJiti(import.meta.url);
  const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
  const runtime = createExtensionRuntime();
  const runner = new ExtensionRunner(
    [await loadExtensionFromFactory((pi: any) => lifecycle(pi), fixture, createEventBus(), runtime)],
    runtime, fixture, SessionManager.inMemory(fixture), {} as never,
  );
  let decision = "仅允许本次";
  let approvals = 0;
  let executions = 0;
  const agent = new Agent({
    streamFn: () => { throw new Error("offline provider must not be called"); },
    beforeToolCall: async ({ toolCall, args }) => runner.emitToolCall({
      type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown>,
    } as never),
  });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => ["bash"] } as never, {
    getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
    isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
  } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async () => { approvals++; return decision; } }, "tui");
  const local = createLocalBashOperations({ shellPath });
  let spill: string | undefined;
  agent.state.tools = [createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
    exec: (command, executionCwd, options) => { executions++; return local.exec(command, executionCwd, options); },
  } })];
  try {
    await runner.emit({ type: "session_start" } as never);
    const commands = [
      `cd subdir && f="fixture.bin" && ls -l "$f" && (command -v cat && cat "$f" | head -c 3) 2>&1 | head -20; echo "---query---"; command -v printf cat; command -V printf`,
      `for t in printf cat; do printf "%-12s " "$t"; command -v $t || echo "-"; done; echo "---search---"; ls . 2>/dev/null; ls missing-synthetic 2>/dev/null`,
      `cd subdir && python -c "
import struct
d=open('fixture.bin','rb').read()
print(struct.unpack_from('<H', d, 0)[0])
" 2>&1 | head -60`,
    ];
    for (let index = 0; index < commands.length; index++) {
      const result = await agent.dispatchHostTool({ type: "toolCall", id: `feedback-${index}`, name: "bash", arguments: { command: commands[index] } });
      assert.equal(result.isError, index === 1, JSON.stringify(result.content));
      if (index === 1) assert.match((result.content[0] as any).text, /Command exited with code 2/);
      assert.doesNotMatch((result.content[0] as any).text, /FD_DUP_UNSUPPORTED|SHELL_WRAPPER/);
    }
    assert.equal(executions, 3, "each authorized call executes once");
    const quoted = await agent.dispatchHostTool({ type: "toolCall", id: "quoted", name: "bash", arguments: { command: `printf '%s' '2>&1'` } });
    assert.equal(quoted.isError, false);
    assert.match((quoted.content[0] as any).text, /2>&1/);
    assert.equal(executions, 4);

    const joined = await agent.dispatchHostTool({ type: "toolCall", id: "joined", name: "bash", arguments: { command: "{ printf out; printf err >&2; } >joined.log 2>&1; cat joined.log" } });
    const split = await agent.dispatchHostTool({ type: "toolCall", id: "split", name: "bash", arguments: { command: "{ printf out; printf err >&2; } 2>&1 >split.log | cat; cat split.log" } });
    assert.equal(joined.isError, false, JSON.stringify(joined.content));
    assert.equal(split.isError, false, JSON.stringify(split.content));
    assert.equal(readFileSync(join(fixture, "joined.log"), "utf8"), "outerr");
    assert.equal(readFileSync(join(fixture, "split.log"), "utf8"), "out");
    assert.equal(executions, 6);

    decision = "拒绝";
    const denied = await agent.dispatchHostTool({ type: "toolCall", id: "denied", name: "bash", arguments: { command: "printf data >denied.log 2>&1" } });
    assert.equal(denied.isError, true);
    assert.match((denied.content[0] as any).text, /USER_REJECTED|CONFIRMATION_CANCELLED/);
    assert.equal(executions, 6);
    assert.equal(existsSync(join(fixture, "denied.log")), false);
    const protectedResult = await agent.dispatchHostTool({ type: "toolCall", id: "protected", name: "bash", arguments: { command: "printf data >.git/config 2>&1" } });
    assert.equal(protectedResult.isError, true);
    assert.equal(executions, 6);
    assert.equal(existsSync(join(fixture, ".git", "config")), false);
    const dynamic = await agent.dispatchHostTool({ type: "toolCall", id: "dynamic-fd", name: "bash", arguments: { command: "printf data 2>&$fd" } });
    assert.equal(dynamic.isError, true);
    assert.equal(executions, 6);
    const nested = await agent.dispatchHostTool({ type: "toolCall", id: "nested-protected", name: "bash", arguments: { command: 'printf "%s" "$(rm -rf .git)"' } });
    assert.equal(nested.isError, true);
    assert.equal(executions, 6);
    assert.equal(existsSync(join(fixture, ".git")), true);
    for (const [id, command] of [["path-control", "./for"], ["stateful-command", "command printf -v PATH .; cat"], ["stateful-format", "printf '%n' PATH; cat"]]) {
      const result = await agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command } });
      assert.equal(result.isError, true, command);
      assert.equal((result.details as any).executionStatus, "not_executed", command);
      assert.equal(executions, 6, command);
    }
    for (const [id, command] of [
      ["zero-iteration-cd", "for x in; do cd subdir; done; printf data >.git/config"],
      ["negated-loop-cd", "! for x in; do cd subdir; done; printf data >.git/config"],
      ["timed-loop-cd", "time for x in; do cd subdir; done; printf data >.git/config"],
      ["timed-posix-loop-cd", "time -p for x in; do cd subdir; done; printf data >.git/config"],
      ["timed-conditional-cd", "time if false; then cd subdir; fi; printf data >.git/config"],
      ["timed-cd", "time cd subdir; printf data >.git/config"],
      ["negated-cd", "! cd subdir; printf data >.git/config"],
      ["loop-negated-cd", "for x in; do ! cd subdir; done; printf data >.git/config"],
      ["escaped-cd", "for x in; do c\\d subdir; done; printf data >.git/config"],
      ["quoted-cd", "for x in; do 'c'd subdir; done; printf data >.git/config"],
      ["select-empty-cd", "select x in; do cd subdir; done; printf data >.git/config"],
      ["conditional-cd", "if false; then cd subdir; fi; printf data >.git/config"],
      ["case-cd", "case no in yes) cd subdir;; esac; printf data >.git/config"],
      ["short-circuit-cd", "false && cd subdir; printf data >.git/config"],
      ["failed-left-and-cd", "cd missing-synthetic && :; printf data >.git/config"],
      ["failed-left-or-cd", "cd missing-synthetic || :; printf data >.git/config"],
      ["failed-left-and-delete", "cd missing-synthetic && :; find . -delete"],
      ["failed-left-command-write", "cd missing-synthetic && :; command printf data >.git/config"],
      ["failed-left-printf-v", "cd missing-synthetic && echo; command printf -v PATH .; cat"],
      ["failed-left-printf-n", "cd missing-synthetic && echo; command printf '%n' PATH; cat"],
      ["loop-path-lookup", "for PATH in .; do printf ok; done; cat"],
      ["subshell-list-separator", "cd missing-synthetic && ( echo x ); printf data >.git/config"],
      ["subshell-or-separator", "cd missing-synthetic && ( echo x ) || printf data >.git/config"],
      ["query-cdpath", "command -v ${CDPATH:=..}; cd " + basename(fixture) + "; printf data >.git/config"],
      ["pipeline-group-cd", "{ cd subdir; } | cat; printf data >.git/config"],
      ["pipeline-cd", "cd subdir | cat; printf data >.git/config"],
      ["subshell-cd", "(cd subdir); printf data >.git/config"],
      ["wrapped-loop-cd", "bash -c 'for x in; do cd subdir; done; printf data >.git/config'"],
      ["wrapped-escaped-cd", "bash -c 'for x in; do c\\d subdir; done; printf data >.git/config'"],
    ]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/);
      assert.equal(inspectHighRiskBashMutation({ command }, fixture)?.unverifiableScope, true);
      assert.equal(inspectBashPermissionScope({ command }, fixture)?.unverifiableScope, true);
      const result = await agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command } });
      assert.equal(result.isError, true);
      assert.equal((result.details as any).executionStatus, "not_executed");
      assert.equal(executions, 6);
      assert.equal(existsSync(join(fixture, ".git", "config")), false);
    }
    const lifecycleRefusal = await agent.dispatchHostTool({ type: "toolCall", id: "lifecycle", name: "bash", arguments: { command: 'command "$candidate" --help' } });
    assert.equal(lifecycleRefusal.isError, true);
    assert.equal((lifecycleRefusal.details as any).executionStatus, "not_executed");
    assert.equal(executions, 6);
    initTheme("dark");
    const show = (result: any) => {
      const component = new ToolExecutionComponent("bash", "shell-status", { command: "synthetic" }, { showImages: false }, undefined, { requestRender() {} } as never, fixture);
      component.markExecutionStarted();
      component.setArgsComplete();
      component.updateResult(result, false, result.isError);
      return component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "");
    };
    assert.doesNotMatch(show(lifecycleRefusal), /Took 0\.0s|Took \d/);

    const large = Buffer.alloc(6 * 1024 * 1024, 0x78);
    agent.state.tools = [createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
      async exec(_command, _cwd, options) { executions++; options.onData(large); return { exitCode: 0 }; },
    } })];
    const capped = await agent.dispatchHostTool({ type: "toolCall", id: "capped", name: "bash", arguments: { command: "printf synthetic" } });
    assert.equal(capped.isError, false, JSON.stringify(capped.content));
    assert.equal((capped.details as any).spillFileCapped, true);
    assert.match((capped.content[0] as any).text, /Capped output file \(5 MiB; later output unavailable\)/);
    assert.doesNotMatch((capped.content[0] as any).text, /Full output:/);
    spill = (capped.details as any).fullOutputPath as string;
    assert.ok(spill && existsSync(spill));
    assert.ok(statSync(spill).size <= 5 * 1024 * 1024);
    assert.match(readFileSync(spill).subarray(-100).toString(), /later output was not persisted/);
    assert.match(show(capped), /Capped output file \(5 MiB; later output unavailable\)/);
    assert.doesNotMatch(show(capped), /Full output:/);

    const saved = SessionManager.create(fixture, join(fixture, "sessions"));
    saved.appendMessage(lifecycleRefusal);
    saved.appendMessage(capped);
    saved.ensureOperationStorage();
    const file = saved.getSessionFile();
    assert.ok(file);
    const reopened = SessionManager.open(file);
    const messages = reopened.getBranch().filter(entry => entry.type === "message").map(entry => (entry as any).message);
    assert.equal(messages[0].details.executionStatus, "not_executed");
    assert.equal(messages[1].details.spillFileCapped, true);
    assert.match(show(messages[1]), /Capped output file/);
    assert.equal(executions, 7, "reopening and rendering never replays a command");
    unlinkSync(spill);
    unlinkSync(spill + ".sp-owned");
    spill = undefined;

    const failureCases = [
      ["launch", async () => { throw Object.assign(new Error("synthetic launch failure"), { code: "ENOENT" }); }, "SHELL_START_FAILED"],
      ["runtime", async (_command: string, _cwd: string, options: any) => { options.onData(Buffer.from("stderr fixture")); return { exitCode: 7 }; }, "SHELL_RUNTIME_FAILED"],
      ["abort", async () => { throw new Error("aborted"); }, "SHELL_INTERRUPTED"],
      ["timeout", async () => { throw new Error("timeout:1"); }, "SHELL_INTERRUPTED"],
    ] as const;
    for (const [name, injected, code] of failureCases) {
      agent.state.tools = [createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
        exec: (command, executionCwd, options) => { executions++; return injected(command, executionCwd, options); },
      } })];
      const result = await agent.dispatchHostTool({ type: "toolCall", id: name, name: "bash", arguments: { command: "printf synthetic" } });
      assert.equal(result.isError, true);
      assert.match((result.content[0] as any).text, new RegExp(`^\\[${code}\\]`));
    }
    const failedDefinition = createShellToolDefinition(fixture, {
      name: "bash", label: "bash", shellName: "bash", prompt: "$", promptSnippet: "fixture", tempFilePrefix: "missing/subdir",
    }, { exposeSessionEnvironment: false, operations: {
      async exec(_command, _cwd, options) { executions++; options.onData(Buffer.alloc(64 * 1024, 0x61)); return { exitCode: 0 }; },
    } });
    agent.state.tools = [wrapToolDefinition(failedDefinition)];
    const logFailed = await agent.dispatchHostTool({ type: "toolCall", id: "log-failed", name: "bash", arguments: { command: "printf synthetic" } });
    assert.equal(logFailed.isError, true);
    assert.match((logFailed.content[0] as any).text, /^\[SHELL_LOG_FAILED\]/);
    assert.doesNotMatch((logFailed.content[0] as any).text, /Full output:/);
    assert.equal(executions, 12);
    assert.ok(approvals >= 2);
    assert.equal(readFileSync(join(fixture, "fixture.bin")).length, 4);

    decision = "仅允许本次";
    agent.state.tools = [createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
      exec: (command, executionCwd, options) => { executions++; return local.exec(command, executionCwd, options); },
    } })];
    const bracket = await agent.dispatchHostTool({ type: "toolCall", id: "bracket-compare", name: "bash", arguments: { command: "[[ a < b ]] && printf bracket-ok" } });
    assert.equal(bracket.isError, false, JSON.stringify(bracket.content));
    assert.match((bracket.content[0] as { text: string }).text, /bracket-ok/);
    assert.equal(executions, 13);
    decision = "拒绝";
    const bracketWrite = await agent.dispatchHostTool({ type: "toolCall", id: "bracket-write", name: "bash", arguments: { command: "[[ a < b ]] >.git/config" } });
    assert.equal(bracketWrite.isError, true, JSON.stringify(bracketWrite));
    assert.equal(executions, 13);
    assert.equal(existsSync(join(fixture, ".git", "config")), false);
    const negatedWrite = await agent.dispatchHostTool({ type: "toolCall", id: "negated-bracket-write", name: "bash", arguments: { command: "! [[ a < b ]] >.git/config" } });
    assert.equal(negatedWrite.isError, true, JSON.stringify(negatedWrite));
    assert.equal(executions, 13);
    assert.equal(existsSync(join(fixture, ".git", "config")), false);
    decision = "仅允许本次";
    for (const name of ["command", "exec"]) {
      writeFileSync(join(fixture, name), "#!/usr/bin/env bash\nprintf synthetic >.git/config\n");
      const command = `./${name} -v harmless`;
      assert.equal(inspectBashResourceLifecycle({ command }), undefined);
      assert.equal(inspectHighRiskBashMutation({ command }, fixture)?.unverifiableScope, true);
      const scope = inspectBashPermissionScope({ command }, fixture);
      assert.equal(scope?.unverifiableScope, true);
      assert.notEqual(scope?.kind, "read-only");
      const result = await agent.dispatchHostTool({ type: "toolCall", id: `external-${name}`, name: "bash", arguments: { command } });
      assert.equal(result.isError, true);
      assert.equal((result.details as any).executionStatus, "not_executed");
      assert.equal(executions, 13);
      assert.equal(existsSync(join(fixture, ".git", "config")), false);
    }
    const safeChain = await agent.dispatchHostTool({ type: "toolCall", id: "safe-conditional-cd", name: "bash", arguments: {
      command: "cd subdir && printf synthetic >local.log; echo after",
    } });
    assert.equal(safeChain.isError, false, JSON.stringify(safeChain.content));
    assert.equal(readFileSync(join(fixture, "subdir", "local.log"), "utf8"), "synthetic");
    assert.match((safeChain.content[0] as { text: string }).text, /after/);
    assert.equal(executions, 14);
    const multilineTest = await agent.dispatchHostTool({ type: "toolCall", id: "multiline-bracket", name: "bash", arguments: {
      command: "[[\na < b\n]] && printf newline-ok",
    } });
    assert.equal(multilineTest.isError, false, JSON.stringify(multilineTest.content));
    assert.match((multilineTest.content[0] as { text: string }).text, /newline-ok/);
    assert.equal(executions, 15);
    for (const [index, command] of [
      "[[ -e <(printf data >.git/config) ]]",
      "[[ -e >(printf data >.git/config) ]]",
      "[[\n-e <(printf data >.git/config)\n]]",
      "[[ -v 'x[$(printf data >.git/config)]' ]]",
      "[[ 0 -eq 'x[$(printf data >.git/config)]' ]]",
      "[[ -n ${CDPATH:=..} ]]; cd " + basename(fixture) + "; printf data >.git/config",
    ].entries()) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/);
      assert.equal(inspectHighRiskBashMutation({ command }, fixture)?.unverifiableScope, true);
      assert.equal(inspectBashPermissionScope({ command }, fixture)?.unverifiableScope, true);
      const result = await agent.dispatchHostTool({ type: "toolCall", id: `process-substitution-${index}`, name: "bash", arguments: { command } });
      assert.equal(result.isError, true);
      assert.equal((result.details as any).executionStatus, "not_executed");
      assert.equal(executions, 15);
      assert.equal(existsSync(join(fixture, ".git", "config")), false);
    }
    for (const [id, command, expected] of [
      ["time-bracket", "time -p [[ a < b ]] && printf timed-ok", "timed-ok"],
      ["comment-comparison", "printf comment-ok # compare a < b", "comment-ok"],
      ["command-prefix", "command printf 'prefix-ok' 2>&1 | cat", "prefix-ok"],
      ["else-bracket", "if false; then :; else [[ a < b ]]; fi && printf else-ok", "else-ok"],
      ["input-file", "cat < fixture.bin | head -c 2", "PI"],
      ["conditional-input", "cd subdir && cat < fixture.bin | head -c 2", "PI"],
      ["ansi-c-format", "printf $'%s\\n' ansi-ok", "ansi-ok"],
      ["negated-bracket", "! [[ b < a ]] && printf negated-ok", "negated-ok"],
    ]) {
      const result = await agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command } });
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.ok((result.content[0] as { text: string }).text.includes(expected));
    }
    assert.equal(executions, 23);
  } finally {
    agent.abort();
    runner.invalidate();
    await runner.emit({ type: "session_shutdown" } as never);
    if (spill && existsSync(spill)) unlinkSync(spill);
    if (spill && existsSync(spill + ".sp-owned")) unlinkSync(spill + ".sp-owned");
    rmSync(fixture, { recursive: true });
  }
});
