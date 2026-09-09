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
 await assert.rejects(definitions.get("write").execute("blocked", { path: "target.txt", content: "replacement" }, undefined, undefined, { cwd }), error => { failure = String(error); return /READ_REQUIRED/.test(failure); });
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
