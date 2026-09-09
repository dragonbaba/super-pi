import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { inspectBashResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { validateToolArguments } from "../packages/ai/src/utils/validation.ts";
import mutationExtension from "../packages/extensions/mutation-guard-write/index.ts";
import browserExtension from "../packages/extensions/browser-use/index.ts";
import { browserUrlSafetyError } from "../packages/extensions/browser-use/core.ts";
const { failureRecoveryHint } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/core.ts");
const definitions = new Map<string, any>();
const pi: any = { on() {}, registerCommand() {}, registerTool(tool: any) { definitions.set(tool.name, tool); } };
mutationExtension(pi); browserExtension(pi);

for (const [name, command] of [
 ["quoted", "cat <<'EOF'\nconst pixel = value & 255; // nohup wait kill\nEOF"],
 ["double quoted", 'cat <<"EOF"\nconst pixel = value & 255;\nEOF'],
 ["tab stripped", "cat <<-'EOF'\n\tvalue & 255\n\tEOF"],
 ["unquoted data", "cat <<EOF\nvalue & 255\nEOF"],
]) test(`heredoc ${name} data is not a background job`, () => assert.equal(inspectBashResourceLifecycle({ command }), undefined));

for (const command of [
 "cat <<'EOF' &\nvalue & 255\nEOF", "cat <<EOF\n$(sleep 1 &)\nEOF",
 "cat <<EOF\n'$(sleep 1 &)'\nEOF", "cat <<EOF\n`nohup sleep 1`\nEOF",
 "cat <<'EOF'\ndata\nEOF\nnohup sleep 1", "bash -c 'sleep 1 &'", "sleep 1 & wait", "sleep 1 & echo 'kill wait trap'",
]) test(`executable/detached lifecycle remains blocked: ${command.slice(0, 30)}`, () => assert.ok(inspectBashResourceLifecycle({ command })));

test("unterminated heredoc is explicitly uncertain", () => assert.match(inspectBashResourceLifecycle({ command: "cat <<'EOF'\ntext" })!, /uncertain|uninspectable|unterminated/i));

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
 assert.ok(browserUrlSafetyError('new_tab("http://127.0.0.1:3000")'));
 assert.equal(browserUrlSafetyError('new_tab("https://example.com")'), undefined);
});


test("heredoc literal substitutions, multiple bodies and conservative unsupported folding", () => {
 assert.equal(inspectBashResourceLifecycle({ command: "cat <<'EOF'\n$(nohup sleep 1)\nEOF" }), undefined);
 assert.equal(inspectBashResourceLifecycle({ command: "cat <<'A' <<'B'\nx & 255\nA\nnohup data\nB" }), undefined);
 assert.ok(inspectBashResourceLifecycle({ command: "cat <<EOF\nx\\\nEOF\nEOF" }));
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
 for (const command of ["cat <<EOF $(\nnohup sleep 100 &\nEOF\n)\ndata\nEOF", "source /dev/stdin <<'EOF'\nnohup sleep 100 &\nEOF", "python3.12 <<'EOF'\npass\nEOF"]) assert.ok(inspectBashResourceLifecycle({ command }));
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


test("review3: bare arithmetic is not a heredoc", () => {
 for (const command of ["((value << 2))", "for ((i=0; i < 2; i++)); do ((value << 2)); done"]) assert.equal(inspectBashResourceLifecycle({ command }), undefined);
});
test("review3: shadowed consumers and staged execution are uncertain", () => {
 for (const command of [`cat(){ eval "$(command cat)"; }\ncat <<'EOF'\nnohup sleep 100 &\nEOF`, "cat > ./runner <<'EOF'\n#!/bin/sh\nnohup sleep 100 &\nEOF\nchmod +x ./runner; ./runner"]) assert.ok(inspectBashResourceLifecycle({ command }));
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
