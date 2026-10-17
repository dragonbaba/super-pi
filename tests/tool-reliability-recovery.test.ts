import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { ownedTabsPrelude } from "../packages/extensions/browser-use/tab-lifecycle.ts";
import { createJiti } from "jiti";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { inspectBashResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { validateToolArguments } from "../packages/ai/src/utils/validation.ts";
import mutationExtension from "../packages/extensions/mutation-guard-write/index.ts";
import browserExtension, { browserResultText, formatFailure, withOwnedScreenshotDefault } from "../packages/extensions/browser-use/index.ts";
import { codemodeFailureReason } from "../packages/coding-agent/src/core/codemode-display.ts";
import { BrowserHarnessVersionGate, browserUrlSafetyError, buildBrowserUseEnvironment, findBrowserUseExecutable } from "../packages/extensions/browser-use/core.ts";
const { failureRecoveryHint } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/core.ts");
const { default: toolLoopGuardrails } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/index.ts");
const definitions = new Map<string, any>();
const pi: any = { on() {}, registerCommand() {}, registerTool(tool: any) { definitions.set(tool.name, tool); } };
mutationExtension(pi); browserExtension(pi);
toolLoopGuardrails(pi);

test("new error codes retain guard classification and distinguish incomplete arguments", async () => {
 const { classifyError } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/failure-classification.ts");
 for (const message of ['Validation failed for tool "edit":', '[TOOL_ARGS_INVALID] "edit" was not executed: validation failed.']) assert.equal(classifyError("edit", message).category, "input_validation");
 const incomplete = "[TOOL_ARGS_INCOMPLETE] edit was not executed: arguments were incomplete when the response ended.";
 assert.match(classifyError("edit", incomplete).cause, /未完成/);
 assert.match(classifyError("edit", '[SNAPSHOT_REQUIRED] Missing top-level "snapshot".').cause, /漏传顶层/);
 const unavailable = classifyError("edit", "[SNAPSHOT_EDIT_SYNTAX] TypeScript parser is unavailable. No change; the candidate was not checked.");
 assert.equal(unavailable.category, "runtime_error"); assert.match(unavailable.cause, /候选未检查/); assert.doesNotMatch(unavailable.cause, /引入新的/);
 assert.equal(classifyError("bash", "[SHELL_DYNAMIC_EXECUTABLE] This Bash call was not executed.").category, "policy_blocked");
});

for (const [name, command] of [
 ["quoted with unsupported arguments", "cat -n <<'EOF'\nconst pixel = value & 255; // nohup wait kill\nEOF"],
 ["double quoted", 'cat <<"EOF"\nconst pixel = value & 255;\nEOF'],
 ["tab stripped", "cat <<-'EOF'\n\tvalue & 255\n\tEOF"],
 ["unquoted data", "cat <<EOF\nvalue & 255\nEOF"],
]) test(`heredoc ${name} acceptance requires permission`, () => {
 assert.equal(inspectBashResourceLifecycle({ command }), undefined);
 assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
});

for (const command of [
 "cat <<'EOF' &\nvalue & 255\nEOF", "cat <<EOF\n$(sleep 1 &)\nEOF",
 "cat <<EOF\n'$(sleep 1 &)'\nEOF", "cat <<EOF\n`nohup sleep 1`\nEOF",
 "cat <<'EOF'\ndata\nEOF\nnohup sleep 1", "bash -c 'sleep 1 &'", "sleep 1 & wait", "sleep 1 & echo 'kill wait trap'",
]) test(`executable/detached lifecycle remains blocked: ${command.slice(0, 30)}`, () => assert.ok(inspectBashResourceLifecycle({ command })));

test("unterminated heredoc is explicitly uncertain", () => assert.equal(inspectBashPermissionScope({ command: "cat <<'EOF'\ntext" }, process.cwd())?.kind, "opaque-script"));

test("active browser schema identifies unexpected fields without values", () => {
 const tool = definitions.get("browser_exec");
 assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "schema", name: tool.name,
  arguments: { code: "SECRET_SCRIPT", unexpected: "SECRET_VALUE", "bad\nfield": "SECRET_VALUE" } }), error => {
  const text = String(error); assert.match(text, /unexpected/); assert.ok(text.includes("bad\\nfield"));
  assert.doesNotMatch(text, /SECRET_SCRIPT|SECRET_VALUE/); assert.ok(text.length < 4096); return true;
 });
});

test("registered guarded write still requires a completed prior read", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "pi-recovery-")); t.after(() => rmSync(cwd, { recursive: true }));
 writeFileSync(join(cwd, "target.txt"), "original");
 let failure = "";
 await assert.rejects(definitions.get("write").execute("blocked", { path: "target.txt", content: "replacement" }, undefined, undefined, { cwd }), error => { failure = error instanceof Error ? error.message : String(error); return /READ_REQUIRED/.test(failure); });
 assert.equal(readFileSync(join(cwd, "target.txt"), "utf8"), "original");
 const hint = await failureRecoveryHint("write", {}, failure, cwd);
 assert.match(hint!, /completed tool turn/); assert.match(hint!, /same-turn reads do not satisfy/);
});

test("unrelated Windows exit with tmp spelling is not a causal path diagnosis", { skip: process.platform !== "win32" }, async () => {
 const hint = await failureRecoveryHint("bash", { command: "python3 /tmp/controlled.py" }, "Command exited with code 49", process.cwd());
 assert.equal(hint, undefined);
});

test("browser guidance preserves helper Python and states its actual scope", () => {
 const description = definitions.get("browser_exec").description;
 assert.match(description, /new_tab/); assert.match(description, /Python variables do not/);
 assert.match(description, /os\.getcwd/); assert.match(description, /loopback/);
 assert.match(description, /browser_debug/);
 assert.doesNotMatch(description, /only be enabled explicitly by the user/);
 assert.ok(browserUrlSafetyError('new_tab("http://127.0.0.1:3000")'));
 assert.equal(browserUrlSafetyError('new_tab("https://example.com")'), undefined);
});

test("browser runtime resolution requires harness and rejects legacy executables and configuration", async t => {
 const root = mkdtempSync(join(tmpdir(), "pi-browser-runtime-"));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const bin = join(root, ".local", "bin");
 mkdirSync(bin, { recursive: true });
 const suffix = process.platform === "win32" ? ".exe" : "";
 const legacy = join(bin, `browser-use${suffix}`), harness = join(bin, `browser-harness${suffix}`);
 const env = { USERPROFILE: root, PATH: "" };
 writeFileSync(legacy, "fixture", { mode: 0o755 });
 assert.equal(await findBrowserUseExecutable(join(root, "agent"), env), undefined);
 assert.equal(await findBrowserUseExecutable(join(root, "agent"), { ...env, SP_BROWSER_USE_CLI: legacy }), undefined);
 assert.equal(await findBrowserUseExecutable(join(root, "agent"), { ...env, SP_BROWSER_HARNESS_CLI: legacy }), undefined);
 assert.equal(await findBrowserUseExecutable(join(root, "agent"), { PATH: bin }), undefined);
 mkdirSync(join(root, "agent", "bin"), { recursive: true });
 writeFileSync(join(root, "agent", "bin", `browser-use${suffix}`), "fixture", { mode: 0o755 });
 assert.equal(await findBrowserUseExecutable(join(root, "agent"), env), undefined);
 writeFileSync(harness, "fixture", { mode: 0o755 });
 assert.equal((await findBrowserUseExecutable(join(root, "agent"), env))?.command, realpathSync.native(harness));
 const configured = await findBrowserUseExecutable(join(root, "agent"), { PATH: "", SP_BROWSER_HARNESS_CLI: harness });
 assert.equal(configured?.command, realpathSync.native(harness));
 assert.equal(configured?.source, "configured");
 const runtimeEnv = buildBrowserUseEnvironment({ BROWSER_USE_HEADLESS: "true", BROWSER_USE_CONFIG_PATH: "old-config", BH_CHROME_PATH: "chosen-chrome" }, root);
 assert.equal(runtimeEnv.BROWSER_USE_HEADLESS, undefined);
 assert.equal(runtimeEnv.BROWSER_USE_CONFIG_PATH, undefined);
 assert.equal(runtimeEnv.BH_CHROME_PATH, "chosen-chrome");
});

test("browser resolver accepts uv Unix links only through executable regular targets", { skip: process.platform === "win32" }, async t => {
 const root = mkdtempSync(join(tmpdir(), "pi-browser-uv-link-"));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const bin = join(root, ".local", "bin"), target = join(root, "runtime"), link = join(bin, "browser-harness");
 mkdirSync(bin, { recursive: true }); writeFileSync(target, "fixture", { mode: 0o755 });
 symlinkSync(target, link);
 const env = { HOME: root, PATH: "" }, agentDir = join(root, "agent");
 const found = await findBrowserUseExecutable(agentDir, env);
 assert.equal(found?.command, realpathSync.native(target)); assert.equal(found?.source, "uv");
 unlinkSync(link); symlinkSync(join(root, "missing"), link);
 assert.equal(await findBrowserUseExecutable(agentDir, env), undefined);
 assert.equal(found?.command, realpathSync.native(target), "a resolved command does not follow later link replacement");
 unlinkSync(link); symlinkSync(bin, link);
 assert.equal(await findBrowserUseExecutable(agentDir, env), undefined);
 unlinkSync(link); chmodSync(target, 0o644); symlinkSync(target, link);
 assert.equal(await findBrowserUseExecutable(agentDir, env), undefined);
});

test("browser version gate rejects old or unverifiable runtimes and reuses only the verified identity", async t => {
 const root = mkdtempSync(join(tmpdir(), "pi-browser-version-")), command = join(root, "runtime");
 t.after(() => rmSync(root, { recursive: true, force: true }));
 writeFileSync(command, "fixture");
 let version = "0.1.8", probes = 0, timedOut = false;
 const gate = new BrowserHarnessVersionGate(async options => {
  probes++; assert.deepEqual(options.args, ["--version"]); assert.equal(options.code, "");
  assert.equal(options.env.UNRELATED_SECRET, undefined); assert.equal(options.env.BROWSER_USE_API_KEY, undefined);
  assert.equal(options.timeoutMs, 5000); assert.equal(options.maxBytesPerStream, 1024);
  return { stdout: version, stderr: "", exitCode: 0, killed: false, timedOut, aborted: false,
   stdoutTruncated: false, stderrTruncated: false, stdoutBytes: version.length, stderrBytes: 0 };
 });
 const executable = { command, source: "configured" as const }, options = { cwd: root, env: { UNRELATED_SECRET: "fixture", BROWSER_USE_API_KEY: "fixture" } };
 for (version of ["0.1.8", "0.1.12", "unknown", "0.1.13rc1"]) await assert.rejects(gate.check(executable, options), /BROWSER_EXEC_VERSION/);
 version = "0.1.13"; assert.equal(await gate.check(executable, options), version);
 const checked = probes;
 assert.equal(await gate.check(executable, options), version); assert.equal(probes, checked);
 writeFileSync(command, "replacement fixture"); version = "0.1.8";
 await assert.rejects(gate.check(executable, options), /BROWSER_EXEC_VERSION/); assert.equal(probes, checked + 1);
 version = "0.1.14"; assert.equal(await gate.check(executable, options), version);
 gate.clear(); timedOut = true;
 await assert.rejects(gate.check(executable, options), /BROWSER_EXEC_VERSION/);
 const controller = new AbortController(); controller.abort(new Error("version probe cancelled"));
 const beforeAbort = probes;
 await assert.rejects(gate.check(executable, { ...options, signal: controller.signal }), /version probe cancelled/);
 assert.equal(probes, beforeAbort);
});

test("browser approval failures retain actionable guidance inside the bounded model prefix", () => {
 for (const evidence of [
  "browser-harness: permission-blocked: wait for Allow",
  'browser-harness: Chrome is asking "Allow remote debugging?" — click Allow to continue.\npermission-blocked: no approval\n' + "detail ".repeat(300),
  "permission-pending: Chrome approval is pending",
 ]) {
  {
   const message = formatFailure("FAILED", evidence);
   assert.match(message, /^\[BROWSER_EXEC_PERMISSION_REQUIRED\]/);
   assert.match(message.slice(0, 400), /Do not retry, reload the daemon, or switch/);
   assert.ok(message.length <= 1000);
  }
  assert.match(formatFailure("ABORTED", evidence), /^\[BROWSER_EXEC_ABORTED\]/);
  assert.match(formatFailure("ABORTED", evidence), /BROWSER_APPROVAL_PENDING/);
 }
 const earlierHint = 'browser-harness: Chrome is asking "Allow remote debugging?" — click Allow to continue.\n';
 const timeout = formatFailure("TIMEOUT", earlierHint);
 assert.match(timeout, /^\[BROWSER_EXEC_TIMEOUT\]/);
 assert.match(timeout, /current state is unknown/);
 assert.match(timeout, /do not automatically retry or switch browsers/);
 const afterApproval = formatFailure("FAILED", earlierHint + "Traceback (most recent call last):\nAttributeError: bad script\n");
 assert.match(afterApproval, /^\[BROWSER_EXEC_FAILED\] AttributeError: bad script/);
 assert.doesNotMatch(afterApproval, /PERMISSION_REQUIRED/);
 assert.doesNotMatch(formatFailure("ABORTED", earlierHint + "Traceback (most recent call last):\nStopIteration: script failed"), /BROWSER_APPROVAL_PENDING/);
});

test("browser partial stdout survives failure and final cause survives both Codemode projections", () => {
 const content = browserResultText({ stdout: "NASA fact printed before failed navigation", stderr: "Traceback (most recent call last):\nTimeoutError: earlier failure\nTraceback (most recent call last):\nStopIteration: final cause",
  exitCode: 1, killed: false, timedOut: false, aborted: false, stdoutBytes: 48, stderrBytes: 153, stdoutTruncated: true, stderrTruncated: false });
 assert.equal(content.length, 2);
 assert.match(content[1]!.text, /Untrusted partial.*\nNASA fact.*\n… stdout truncated/);
 for (const audience of ["model", "display"] as const) assert.equal(codemodeFailureReason(content[0]!.text, audience), "StopIteration: final cause");
});

test("browser navigation accepts confirmed dual-stack Fake-IP without allowing private or literal benchmark addresses", t => {
 const python = process.env.SP_TEST_PYTHON ?? "python";
 const available = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 5000 });
 if (available.error || available.status !== 0) { t.skip("Python is unavailable; set SP_TEST_PYTHON to exercise the generated prelude"); return; }
 const source = withOwnedScreenshotDefault("new_tab(_test_url); goto_url(_test_url)", "unused-test-screenshot.png");
 const program = `
import faulthandler, json, socket, sys, types
print("Fake-IP probe runtime: " + sys.version, file=sys.stderr, flush=True)
faulthandler.dump_traceback_later(3, repeat=True)
helpers = types.ModuleType("browser_harness.helpers")
helpers.cdp = lambda *args, **kwargs: None
sys.modules["browser_harness"] = types.ModuleType("browser_harness")
sys.modules["browser_harness.helpers"] = helpers
source = json.load(sys.stdin)
public = ["8.8.8.8", "2606:4700:4700::1111"]
fake4 = ["198.18.0.90"]
fake6 = ["2001:2::56"]
mihomo6 = ["fdfe:dcba:9876::56"]
dual = fake4 + fake6
url = "https://www.remotion.dev/docs/ai/skills"
cases = [
    ("public", public, public, url, True, 0),
    ("v4-only", fake4, fake4, url, True, 1),
    ("v6-only", fake6, fake6, url, True, 1),
    ("dual-stack", dual, ["198.18.0.89", "2001:2::55"], url, True, 1),
    ("fake-with-public", dual + public, dual + public, url, True, 1),
    ("mihomo-v6", mihomo6, mihomo6, url, True, 1),
    ("mihomo-dual", fake4 + mihomo6, fake4 + mihomo6, url, True, 1),
    ("mihomo-unconfirmed", mihomo6, public, url, False, 1),
    ("mihomo-private-probe", mihomo6, mihomo6 + ["fd00::1"], url, False, 1),
    ("mihomo-neighbor", ["fdfe:dcba:9876:1::1"], mihomo6, url, False, 0),
    ("literal-mihomo", [], mihomo6, "http://[fdfe:dcba:9876::56]/", False, 0),
    ("unconfirmed", dual, public, url, False, 1),
    ("probe-failure", dual, None, url, False, 1),
    ("probe-empty", dual, [], url, False, 1),
    ("private-probe", dual, dual + ["192.168.1.1"], url, False, 1),
    ("private-target", dual + ["192.168.1.1"], dual, url, False, 1),
    ("ula-target", dual + ["fd00::1"], dual, url, False, 1),
    ("metadata", [], dual, "http://169.254.169.254/", False, 0),
    ("loopback", [], dual, "http://127.0.0.1/", False, 0),
    ("literal-v4", [], dual, "http://198.18.0.90/", False, 0),
    ("literal-v6", [], dual, "http://[2001:2::56]/", False, 0),
]
results = []
for name, target, probe, target_url, allowed, expected_probes in cases:
    counts = {"probe": 0, "target": 0, "navigation": 0}
    def resolve(host, *args, **kwargs):
        key = "probe" if host == "example.com" else "target"
        counts[key] += 1
        addresses = probe if key == "probe" else target
        if addresses is None: raise socket.gaierror("fixture DNS failure")
        return [(0, 0, 0, "", (address, 0)) for address in addresses]
    def navigate(value, *args, **kwargs): counts["navigation"] += 1
    socket.getaddrinfo = resolve
    scope = {"capture_screenshot": navigate, "new_tab": lambda url: "fixture-tab", "goto_url": navigate, "_test_url": target_url}
    error = None
    try: exec(source, scope)
    except RuntimeError as failure: error = str(failure)
    assert (error is None) == allowed, (name, error)
    assert counts["navigation"] == (2 if allowed else 0), (name, counts)
    assert counts["probe"] == expected_probes, (name, counts)
    if not allowed: assert "[BROWSER_EXEC_URL]" in error, (name, error)
    results.append({"case": name, "allowed": allowed, **counts})
print(json.dumps(results))
faulthandler.cancel_dump_traceback_later()
`;
 const result = spawnSync(python, ["-c", program], { input: JSON.stringify(source), encoding: "utf8", timeout: 10000 });
 assert.equal(result.status, 0, [result.error && String(result.error), result.stderr].filter(Boolean).join("\n"));
 const cases = JSON.parse(result.stdout);
 assert.equal(cases.length, 21);
 assert.equal(cases.filter((row: any) => row.allowed).length, 7);
 for (const url of ["http://198.18.0.90", "http://[2001:2::56]", "http://[fdfe:dcba:9876::56]", "http://127.0.0.1", "http://[fd00::1]"]) {
  assert.ok(browserUrlSafetyError(`new_tab(${JSON.stringify(url)})`));
 }
});

test("browser Python failure puts the actual exception before bounded traceback details", () => {
 for (const cause of [
  "RuntimeError: JavaScript evaluation failed: TypeError: This document requires 'TrustedHTML' assignment.",
  "RuntimeError: JavaScript evaluation failed: TypeError: Cannot read properties of null (reading 'scrollWidth')",
 ]) {
  const trace = `Traceback (most recent call last):\n${'  File "browser_harness/helpers.py", line 105, in _runtime_value\n'.repeat(40)}${cause}\n    at <anonymous>:1:26`;
  const result = formatFailure("FAILED", trace);
  assert.equal(result.split("\n", 1)[0], `[BROWSER_EXEC_FAILED] ${cause}`);
  assert.ok(result.length <= 1000);
  assert.match(result, /Traceback \(most recent call last\)/);
  assert.match(result, /traceback truncated/);
 }
});

test("browser chained exceptions prefer the last cause and keep plain failures unchanged", () => {
 const result = formatFailure("FAILED", "Traceback (most recent call last):\nValueError: earlier\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\nRuntimeError: final cause\n");
 assert.match(result, /^\[BROWSER_EXEC_FAILED\] RuntimeError: final cause\n/);
 assert.equal(formatFailure("TIMEOUT", "Browser deadline exceeded"), "[BROWSER_EXEC_TIMEOUT] Browser deadline exceeded");
 assert.equal(formatFailure("FAILED", "[BROWSER_EXEC_SYNTAX] line 2:7: 'await' outside function"), "[BROWSER_EXEC_FAILED] [BROWSER_EXEC_SYNTAX] line 2:7: 'await' outside function");
 const timeout = formatFailure("FAILED", "Traceback (most recent call last):\nTimeoutError: timed out\n\nThe above exception was the direct cause of the following exception:\n\nTraceback (most recent call last):\n" + '  File "helpers.py", line 57\n'.repeat(50) + "browser_harness.helpers._IPCResponseTimeout: Page.navigate timed out after 5s waiting for the daemon\n");
 assert.match(timeout.split("\n", 1)[0]!, /^\[BROWSER_EXEC_FAILED\] browser_harness\.helpers\._IPCResponseTimeout: Page.navigate timed out after 5s.*Outcome unconfirmed.*list_tabs\(\)/);
 assert.ok(timeout.length <= 1000);
 assert.match(timeout.slice(0, 512), /Do not automatically retry/);
});

test("browser navigation adapter extends only navigation waits and never retries a timed-out new tab", t => {
 const python = process.env.SP_TEST_PYTHON ?? "python";
 const available = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 5000 });
 if (available.error || available.status !== 0) { t.skip("Python is unavailable"); return; }
 const source = withOwnedScreenshotDefault("", "unused-test-screenshot.png");
 const short = withOwnedScreenshotDefault("", "unused-test-screenshot.png", 5000);
 const program = `
import json, sys, types
sources = json.load(sys.stdin)
for source, limit in zip(sources, [30, 5]):
    helpers = types.ModuleType("browser_harness.helpers")
    sys.modules["browser_harness"] = types.ModuleType("browser_harness")
    sys.modules["browser_harness.helpers"] = helpers
    calls, tabs = [], []
    fail = False
    def cdp(method, session_id=None, _response_timeout=5.0, **params):
        calls.append((method, _response_timeout, params))
        if fail and method == "Page.navigate": raise TimeoutError("fixture navigation timeout")
        return {"ok": True}
    helpers.cdp = cdp
    def goto(url): return helpers.cdp("Page.navigate", url=url)
    def new_tab(url):
        if url != "about:blank":
            try: goto(url); return "reused"
            except Exception: pass
        tabs.append("created")
        if url != "about:blank": goto(url)
        return "fixture-tab"
    scope = {"new_tab": new_tab, "goto_url": goto, "capture_screenshot": lambda **kw: kw}
    exec(source, scope)
    assert scope["new_tab"]("https://8.8.8.8/") == "fixture-tab"
    assert len(tabs) == 1 and len(calls) == 1
    assert limit - 1 < calls[-1][1] <= limit, calls
    helpers.cdp("Runtime.evaluate", expression="1")
    assert calls[-1][1] == 5.0
    helpers.cdp("Page.captureScreenshot", _response_timeout=60.0)
    assert calls[-1][1] == 60.0
    helpers.cdp("Page.navigate", _response_timeout=2.0, url="https://8.8.8.8/")
    assert calls[-1][1] == 2.0
    fail = True
    before = len(calls)
    try: scope["new_tab"]("https://8.8.8.8/"); raise AssertionError("swallowed timeout")
    except TimeoutError: pass
    assert len(calls) == before + 1 and len(tabs) == 2, (calls, tabs)
    before = len(calls)
    scope["_pi_browser_deadline"] = 0
    try: scope["goto_url"]("https://8.8.8.8/"); raise AssertionError("deadline ignored")
    except TimeoutError: pass
    assert len(calls) == before
print("navigation budgets, one dispatch per navigation, screenshot timeout, deadline verified")
`;
 const result = spawnSync(python, ["-c", program], { input: JSON.stringify([source, short]), encoding: "utf8", timeout: 10000 });
 assert.equal(result.status, 0, result.stderr || String(result.error));
});

test("browser task tabs reuse search inputs, retain failed navigation ownership and clean only recorded IDs", t => {
 const python = process.env.SP_TEST_PYTHON ?? "python";
 if (spawnSync(python, ["--version"], { timeout: 5000 }).status !== 0) { t.skip("Python is unavailable"); return; }
 const root = mkdtempSync(join(tmpdir(), "pi-browser-tabs-"));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const state = join(root, "tabs.json");
 const prelude = withOwnedScreenshotDefault("", join(root, "shot.png"), 120000, state);
 const program = `
import json, sys, types
source, state = json.load(sys.stdin)
helpers = types.ModuleType("browser_harness.helpers")
sys.modules["browser_harness"] = types.ModuleType("browser_harness")
sys.modules["browser_harness.helpers"] = helpers
tabs = {"user": {"targetId": "user", "url": "about:blank"}}
calls, inputs, closes = [], [], []
current, serial, fail = "user", 0, False
def cdp(method, **params):
    global serial
    calls.append(method)
    if method == "Target.createTarget":
        serial += 1
        target = "owned-" + str(serial)
        tabs[target] = {"targetId": target, "url": "about:blank"}
        return {"targetId": target}
    if method == "Target.closeTarget":
        target = params["targetId"]
        closes.append(target)
        del tabs[target]
        return {"success": True}
    if method == "Page.navigate":
        if fail: raise TimeoutError("fixture navigation timeout")
        tabs[current]["url"] = params["url"]
    return {}
def switch(target):
    global current
    current = target
def goto(url): return helpers.cdp("Page.navigate", url=url)
def fresh():
    helpers.cdp = cdp
    helpers._target_id = lambda target: target.get("targetId") if isinstance(target, dict) else target
    scope = {"capture_screenshot": lambda **kw: None, "new_tab": lambda url: None,
        "goto_url": goto, "switch_tab": switch, "list_tabs": lambda: list(tabs.values()),
        "fill_input": lambda selector, query, **kw: inputs.append((current, selector, query, kw)),
        "press_key": lambda key: inputs.append((current, key))}
    exec(source, scope)
    return scope
s = fresh()
search = s["open_tab"]("https://8.8.8.8/", role="search")
for query in ["first", "second", "third"]:
    s = fresh() # every CLI process has fresh Python globals
    assert s["open_tab"]("https://8.8.8.8/", role="search") == search
    s["search_page"](query, "input[name=q]")
    tabs[search]["url"] = "https://8.8.8.8/results?query=" + query
assert serial == 1 and calls.count("Page.navigate") == 1, calls
assert len(inputs) == 6 and all(item[0] == search for item in inputs)
assert all(item[3] == {"clear_first": True} for item in inputs[::2])
ref = s["open_tab"]("https://8.8.4.4/")
assert s["open_tab"]("https://8.8.4.4/next") == ref and serial == 2
try: s["close_tab"]("user"); raise AssertionError("closed user tab")
except RuntimeError as error: assert "NOT_OWNED" in str(error)
s["keep_tab"](ref)
fail = True
before = calls.count("Page.navigate")
try: s["new_tab"]("https://1.1.1.1/"); raise AssertionError("swallowed failure")
except TimeoutError: pass
assert calls.count("Page.navigate") == before + 1 and serial == 3
assert "owned-3" in json.load(open(state)), "persist ownership before failing navigation"
fail = False
s = fresh()
assert s["new_tab"]("https://1.1.1.1/") == "owned-3" and serial == 3, "reuse own blank, never user blank"
for number in range(6): s["new_tab"]("https://1.0.0.1/" + str(number))
before = serial
try: s["new_tab"]("https://1.0.0.1/overflow"); raise AssertionError("unbounded tabs")
except RuntimeError as error: assert "TABS_LIMIT" in str(error)
assert serial == before
del tabs[search] # user closed one owned tab; stale ID must not block cleanup
s = fresh()
s["close_owned_tabs"]()
assert set(tabs) == {"user", ref} and "user" not in closes and ref not in closes
assert json.load(open(state)) == {}
print(json.dumps({"queries": 3, "searchTabsCreated": 1, "searchNavigations": 1, "inputActions": len(inputs), "maxOwned": 8, "remainingOwned": 0, "userTabsClosed": 0}))
`;
 const result = spawnSync(python, ["-c", program], { input: JSON.stringify([prelude, state]), encoding: "utf8", timeout: 10000 });
 assert.equal(result.status, 0, result.stderr || String(result.error));
 assert.equal(JSON.parse(result.stdout).remainingOwned, 0);
 const description = definitions.get("browser_exec").description;
 assert.match(description, /Follow-up searches must use that same input/);
 assert.match(description, /never close a user tab/);
});

test("browser extension preserves failure details and bounds cleanup without connecting or racing an active run", async () => {
 const hooks = new Map<string, Function>(), tools = new Map<string, any>(), commands = new Map<string, any>(), removed: string[] = [], notices: string[] = [];
 const states = new Map<string, number>(), cleanedSessions: (string | undefined)[] = [];
 let cleanupCalls = 0, reloads = 0, failCleanup = true, resolveRun: ((value: any) => void) | undefined;
 let signalStarted: (() => void) | undefined;
 const result = { stdout: "completed extraction", stderr: "Traceback (most recent call last):\nStopIteration: failed later", exitCode: 1,
  killed: false, timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 20, stderrBytes: 65 };
 const runner = { runBrowserUse: async (options: any) => {
  if (options.args?.[0] === "--reload") { reloads++; return { ...result, exitCode: 0 }; }
  if (options.env.BH_REQUIRE_EXISTING_DAEMON === "1") {
   cleanupCalls++; assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000); assert.equal(options.maxBytesPerStream, 1024);
   cleanedSessions.push(options.env.BU_NAME);
   if (!failCleanup) states.set(options.cwd, 2);
   return { ...result, exitCode: failCleanup ? 1 : 0, stdout: "", stderr: "" };
  }
  states.set(options.cwd, 20);
  if (signalStarted) { signalStarted(); return new Promise(resolve => { resolveRun = resolve; }); }
  return result;
 } };
 const runtime = { findBrowserUseExecutable: async () => ({ command: "fixture-harness" }), browserUrlSafetyError: () => undefined,
  buildBrowserUseEnvironment: (_env: unknown, workspace: string, session?: string) => ({ BH_AGENT_WORKSPACE: workspace, BU_NAME: session }),
  BrowserHarnessVersionGate: class { async check() {} clear() {} }, loadRecentScreenshot: async () => undefined, extractScreenshotCandidates: () => [] };
 const modules: Record<string, unknown> = { "node:crypto": crypto, "node:path": path,
  "node:fs/promises": { mkdir: async () => {}, rm: async (target: string) => { removed.push(target); states.delete(target); }, stat: async (file: string) => ({ size: states.get(path.dirname(file)) ?? 2 }) },
  "@super-pi/coding-agent": { getAgentDir: () => path.resolve("fixture-agent") }, "@super-pi/tui": { Text: class {} }, typebox: { Type },
  "./tab-lifecycle.ts": { ownedTabsPrelude }, "./core.ts": runtime, "./runner.ts": runner,
  "../resource-lifecycle-guard/permission-contract.ts": { consumeBrowserExecAuthorization() {} } };
 const module = { exports: {} as any };
 const source = ts.transpileModule(readFileSync(new URL("../packages/extensions/browser-use/index.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
 runInNewContext(source, { module, exports: module.exports, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
  process: { pid: 1, env: {} }, Buffer });
 module.exports.default({ on: (name: string, callback: Function) => hooks.set(name, callback), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command) });
 const ctx = { cwd: path.resolve("fixture-work"), sessionManager: { getSessionId: () => "fixture" }, ui: { notify: (message: string) => notices.push(message) } };
 const tool = tools.get("browser_exec");
 const failed = await tool.execute("first", { code: "print('fixture')" }, undefined, undefined, ctx);
 assert.equal(failed.isError, true); assert.equal(failed.details.exitCode, 1); assert.equal(failed.details.stdoutBytes, 20);
 assert.match(failed.content[1].text, /completed extraction/);
 await hooks.get("agent_end")!({}, ctx);
 assert.equal(cleanupCalls, 1); assert.equal(removed.length, 0); assert.match(notices.at(-1)!, /不会重新连接/);
 await commands.get("browser-use").handler("release", ctx);
 assert.equal(cleanupCalls, 2); assert.equal(reloads, 0); assert.equal(removed.length, 0);
 assert.match(notices.at(-1)!, /已保留连接/);
 failCleanup = false;
 await hooks.get("agent_end")!({}, ctx);
 await hooks.get("agent_end")!({}, ctx);
 assert.equal(cleanupCalls, 3, "an empty ownership record must not launch another CLI");
 const started = new Promise<void>(resolve => { signalStarted = resolve; });
 const active = tool.execute("active", { code: "print('fixture')" }, undefined, undefined, ctx);
 await started;
 await hooks.get("agent_end")!({}, ctx);
 await hooks.get("session_shutdown")!({}, ctx);
 assert.equal(cleanupCalls, 3); assert.equal(removed.length, 0, "never remove the workspace while its process is active");
 resolveRun!(result);
 await active;
 assert.equal(cleanupCalls, 4); assert.equal(removed.length, 1);
 await hooks.get("session_shutdown")!({}, ctx);
 assert.equal(removed.length, 1, "released workspaces must not retain cleanup references");
 signalStarted = undefined;
 const local = await tool.execute("local", { code: "print('fixture')" }, undefined, undefined, ctx);
 const named = await tool.execute("named", { code: "print('fixture')", session: "default" }, undefined, undefined, ctx);
 assert.notEqual(local.details.workspace, named.details.workspace, "omitted session and named default must not share tab ownership");
 await commands.get("browser-use").handler("release", ctx);
 assert.deepEqual(cleanedSessions.slice(-2), [undefined, "default"]);
 assert.equal(removed.length, 3); assert.equal(reloads, 1); assert.equal(states.size, 0);
});


test("heredoc literal substitutions, multiple bodies and conservative unsupported folding", () => {
 assert.equal(inspectBashResourceLifecycle({ command: "cat <<'EOF'\n$(nohup sleep 1)\nEOF" }), undefined, "bounded single-quoted data has no executable substitution");
 for (const command of ["cat <<'A' <<'B'\nx & 255\nA\nnohup data\nB", "cat <<EOF\nx\\\nEOF\nEOF"]) {
  assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
 }
 assert.ok(inspectBashResourceLifecycle({ command: "x".repeat(128 * 1024 + 1) }));
});

test("cleanup must bind the actual background PID, not just mention wait", () => {
 assert.equal(inspectBashResourceLifecycle({ command: `sleep 1 & pid=$!; trap 'kill "$pid"; wait "$pid"' EXIT; wait "$pid"` }), undefined);
 assert.ok(inspectBashResourceLifecycle({ command: `sleep 1 & pid=42; trap 'kill "$pid"; wait "$pid"' EXIT; wait "$pid"` }));
 assert.ok(inspectBashResourceLifecycle({ command: `node script.js & pid=$!; trap 'kill "$pid"; wait "$pid"' EXIT; wait "$pid"` }));
});

test("field diagnostics stay bounded under escaped-name expansion", () => {
 const tool = definitions.get("browser_exec");
 const args: Record<string, unknown> = { code: "SECRET_SCRIPT" };
 for (let i = 0; i < 100; i++) args["\u0001".repeat(200) + i] = "SECRET_VALUE";
 assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "bounded", name: tool.name, arguments: args }), error => {
  const text = String(error); assert.ok(text.length < 4096); assert.doesNotMatch(text, /SECRET_SCRIPT|SECRET_VALUE/); assert.match(text, /Remove unexpected fields/); return true;
 });
});

test("policy recovery resolves the denial instead of changing language", async () => {
 assert.match(await failureRecoveryHint("bash", { command: "echo safe" }, "POLICY_BLOCKED", process.cwd()), /Do not evade|do not evade/);
});

test("Node recovery distinguishes parse failures from argv/runtime failures and keeps long -e optional", async () => {
 const longScript = "const 中文 = `quote \\\\ and \\\"`; console.log(中文);" + "\nconst value = " + "1;".repeat(600);
 assert.equal(inspectBashResourceLifecycle({ command: `node -e ${JSON.stringify(longScript)}` }), undefined);
 const scope = inspectBashPermissionScope({ command: `node -e ${JSON.stringify(longScript)}` }, process.cwd());
 assert.ok(scope);
 assert.equal(scope?.primitives.includes("oversized_uninspectable"), false);
 const syntax = await failureRecoveryHint("bash", { command: "node -e 'const = ;'" }, "SyntaxError: Unexpected token '='\n    at eval:1:7", process.cwd());
 assert.match(syntax!, /syntax\/parse error/);
 assert.match(syntax!, /valid long node -e is allowed/);
 assert.match(syntax!, /\.cjs\/.mjs file or stdin is an option/);
 assert.doesNotMatch(syntax!, /reduce the snippet|entire operation was not executed/);
 const argv = await failureRecoveryHint("bash", { command: "node -e 'console.log(1)'" }, "TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be a string", process.cwd());
 assert.equal(argv, undefined);
 const valid = await failureRecoveryHint("bash", { command: `node -e ${JSON.stringify(longScript)}` }, "Command exited with code 0", process.cwd());
 assert.equal(valid, undefined);
});

test("effective guarded Bash metadata gives one short optional Node carrier guideline", () => {
 const bash = definitions.get("bash");
 assert.match(bash.description, /max 16 command substitutions \(\$\(\) or backticks\) per script, nesting max 4; split larger batches/);
 assert.ok(Array.isArray(bash?.promptGuidelines));
 const nodeGuidelines = bash.promptGuidelines.filter((line: string) => /node -e/.test(line));
 assert.equal(nodeGuidelines.length, 1);
 assert.match(nodeGuidelines[0], /file|stdin/);
 assert.match(nodeGuidelines[0], /does not decide permission/);
 assert.match(nodeGuidelines[0], /does not bypass approval/);
});


test("review: newline comments cannot consume executable lines as heredoc data", () => {
 assert.ok(inspectBashResourceLifecycle({ command: "echo ok\n# fake <<EOF\nnohup sleep 100\nEOF" }));
});
test("review: arithmetic shifts are not heredoc operators", () => {
 assert.equal(inspectBashResourceLifecycle({ command: "echo $((1 << 2))" }), undefined);
 assert.ok(inspectBashResourceLifecycle({ command: "echo $((1 << $(nohup sleep 1)))" }));
});
test("review: owned job permits bounded use and exact PID cleanup", () => {
 assert.equal(inspectBashResourceLifecycle({ command: `server --foreground & pid=$!; trap 'kill "$pid"; wait "$pid"' EXIT; curl --fail http://127.0.0.1:8000; kill "$pid"; wait "$pid"` }), undefined);
 assert.ok(inspectBashResourceLifecycle({ command: `server --foreground & pid=$!; trap 'kill "$pid"; wait "$pid"' EXIT; pid=99; kill "$pid"; wait "$pid"` }));
});
test("review: lifecycle denial has structural recovery, not permission escalation", async () => {
 const hint = await failureRecoveryHint("bash", {}, "Blocked an unmanaged long-lived process.", process.cwd());
 assert.match(hint, /Lifecycle recovery/); assert.match(hint, /permission change cannot/);
});


test("review2: nested/evaluator heredocs never hide executable input", () => {
 for (const command of ["cat <<EOF $(\nnohup sleep 100 &\nEOF\n)\ndata\nEOF", "source /dev/stdin <<'EOF'\nnohup sleep 100 &\nEOF"]) assert.ok(inspectBashResourceLifecycle({ command }));
 assert.equal(inspectBashPermissionScope({ command: "python3.12 <<'EOF'\npass\nEOF" }, process.cwd())?.kind, "opaque-script");
});
test("review2: versioned interpreters are not owned foreground jobs", () => {
 for (const name of ["python3.12", "python3.12.exe", "nodejs"]) assert.ok(inspectBashResourceLifecycle({ command: `${name} script & pid=$!; trap 'kill "$pid"; wait "$pid"' EXIT; wait "$pid"` }));
});
test("review2: validation escapes all display controls", () => {
 const tool = definitions.get("browser_exec");
 assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "controls", name: tool.name, arguments: { code: "pass", ["bad\u007f\u009b\u2028\u2029"]: 1 } }), error => {
  assert.doesNotMatch(String(error), /[\u007f-\u009f\u2028\u2029]/); return true;
 });
});


test("review3: bare arithmetic is not a heredoc but can change shell state", () => {
 for (const command of ["((value << 2))", "for ((i=0; i < 2; i++)); do ((value << 2)); done"]) {
  const refusal = inspectBashResourceLifecycle({ command }) ?? "";
  assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
  assert.doesNotMatch(refusal, /SHELL_HEREDOC/);
 }
 assert.equal(inspectBashResourceLifecycle({ command: "echo $((1 << 2))" }), undefined);
});
test("review3: shadowed consumers and staged execution are uncertain", () => {
 for (const command of [`cat(){ eval "$(command cat)"; }\ncat <<'EOF'\nnohup sleep 100 &\nEOF`, "cat > ./runner <<'EOF'\n#!/bin/sh\nnohup sleep 100 &\nEOF\nchmod +x ./runner; ./runner"]) assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
});


test("review4: launcher prefixes do not establish owned-job identity", () => {
 for (const prefix of ["env python3", "sudo -u root python3", "env env python3", "nice python3", "timeout 10 nodejs"]) assert.ok(inspectBashResourceLifecycle({ command: `${prefix} script & pid=$!; trap 'kill "$pid"; wait "$pid"' EXIT; wait "$pid"` }));
});

test("review5: owned work cannot detach wget", () => {
 for (const options of ["-b", "--background", "-e background=on"]) assert.ok(inspectBashResourceLifecycle({ command: `server --foreground & pid=$!; trap 'kill "$pid"; wait "$pid"' EXIT; wget ${options} https://example.com; kill "$pid"; wait "$pid"` }));
});
test("review5: substitution comments cannot terminate executable inspection", () => {
 assert.ok(inspectBashResourceLifecycle({ command: "cat <<EOF\n$(# )\nnohup sleep 100 &\n)\nEOF" }));
 assert.equal(inspectBashResourceLifecycle({ command: "cat <<EOF\n$(# )\necho safe\n)\nEOF" }), undefined);
 assert.equal(inspectBashPermissionScope({ command: "cat <<EOF\n$(# )\necho safe\n)\nEOF" }, process.cwd())?.kind, "opaque-script");
});

test("owned use cannot replace the captured PID through printf", () => {
 assert.ok(inspectBashResourceLifecycle({ command: `server --foreground & pid=$!; trap 'kill "$pid"; wait "$pid"' EXIT; printf -v pid 123; kill "$pid"; wait "$pid"` }));
});

test("review6: case patterns cannot hide executable substitution suffixes", () => {
 assert.ok(inspectBashResourceLifecycle({ command: "cat <<EOF\n$(case x in x)\nnohup sleep 100 &\n;; esac)\nEOF" }));
});
test("review6: wrapper options cannot bypass script identity", () => {
 for (const command of ["dash -c 'sleep 100 &'", "fish -c 'sleep 100 &'", "ksh -c 'sleep 100 &'", "bash runner.sh -c safe", "sh runner.sh -c safe"]) assert.ok(inspectBashResourceLifecycle({ command }));
 assert.equal(inspectBashResourceLifecycle({ command: "dash -c 'echo safe'" }), undefined);
});

test("review7: builtin prefixes cannot hide shell scripts", () => {
 for (const command of ["command bash -c 'sleep 100 &'", "exec bash -c 'sleep 100 &'", "command exec dash -c 'sleep 100 &'", "env -u PATH bash -c 'sleep 100 &'"]) assert.ok(inspectBashResourceLifecycle({ command }));
 assert.equal(inspectBashResourceLifecycle({ command: "command bash -c 'echo safe'" }), undefined);
});


test("review8: assignment and redirection prefixes cannot hide shell operands", () => {
 for (const command of ["X=1 bash -c 'sleep 100 &'", "X='a b' command bash -c 'sleep 100 &'", "2>/dev/null bash -c 'sleep 100 &'", "command 2>/dev/null bash -c 'sleep 100 &'"]) assert.ok(inspectBashResourceLifecycle({ command }));
 assert.equal(inspectBashResourceLifecycle({ command: "echo bash" }), undefined);
});


test("review9: unrelated shell text does not taint another command prefix", () => {
 for (const command of ["echo bash; X=1 echo safe", "echo bash; >output echo safe", "X=1 echo bash", "echo bash; X=1 >output echo safe"]) assert.equal(inspectBashResourceLifecycle({ command }), undefined);
 assert.ok(inspectBashResourceLifecycle({ command: "X=1 >output bash -c 'sleep 100 &'" }));
});
test("review9: quoted case data is not case grammar", () => {
 for (const command of [`echo "$(printf 'case value')"`, `echo "$(echo case value)"`]) assert.equal(inspectBashResourceLifecycle({ command }), undefined);
 assert.ok(inspectBashResourceLifecycle({ command: `echo "$(case x in x) sleep 100 & ;; esac)"` }));
});


test("review9: case grouping and line continuation stay uncertain", () => {
 for (const body of ["\\\ncase x in x) sleep 100 & ;; esac", "{ case x in x) sleep 100 & ;; esac; }", "time -p case x in x) sleep 100 & ;; esac"]) assert.ok(inspectBashResourceLifecycle({ command: `echo "${"$("}${body})"` }));
});


test("review9: case inside a function cannot truncate substitution inspection", () => {
 assert.ok(inspectBashResourceLifecycle({ command: `echo "$(f(){ case x in x) sleep 100 & ;; esac; }; f)"` }));
});


test("review10: coproc cannot hide a case substitution suffix", () => {
 assert.ok(inspectBashResourceLifecycle({ command: `echo "$(coproc case x in x) : ;; esac; sleep 100 >output 2>&1 & )"` }));
 assert.equal(inspectBashResourceLifecycle({ command: `echo "$(printf 'coproc case value')"` }), undefined);
});
