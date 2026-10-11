import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../packages/coding-agent/src/cli/args.ts";
import { matchesToolPattern, ToolSelection } from "../packages/coding-agent/src/core/tool-selection.ts";

test("tool patterns match whole case-sensitive names with literal punctuation", () => {
	for (const [name, pattern, expected] of [
		["read", "rea?", true], ["read", "rea", false], ["Read", "rea*", false],
		["mcp_a_lookup", "mcp_*_look*", true], ["ababa", "*aba", true],
		["abc", "a**?c", true], ["", "*", true], ["", "?", false],
		["foo.bar", "foo.bar", true], ["fooXbar", "foo.bar", false], ["read", "[read]", false],
	] as const) assert.equal(matchesToolPattern(name, pattern), expected, `${name}: ${pattern}`);
});

test("tool expression precedence is order-independent and empty selection stays empty", () => {
	for (const tools of [["rea*", "+write", "-w*"], ["-w*", "+write", "rea*"]]) {
		const policy = new ToolSelection({ tools, excludeTools: ["read_private"] });
		assert.equal(policy.usesDefaults, false);
		assert.equal(policy.allows("read"), true);
		for (const name of ["write", "read_private", "bash"]) assert.equal(policy.allows(name), false);
		assert.equal(policy.allows("codemode"), true);
	}
	assert.equal(new ToolSelection({ tools: ["-write"] }).allows("read"), true);
	assert.equal(new ToolSelection({ tools: ["+read"] }, true).allows("write"), false);
	assert.equal(new ToolSelection({ tools: [] }).allows("codemode"), false);
	const tools = ["read"];
	const snapshot = new ToolSelection({ tools }); tools[0] = "write";
	assert.equal(snapshot.allows("read"), true); assert.equal(snapshot.allows("write"), false);
});

test("CLI accepts expression lists and rejects invalid or oversized policy before startup", () => {
	const args = parseArgs(["--tools", "rea*,+grep,-write", "--exclude-tools", "mcp_*", "--", "--tools", "*"]);
	assert.deepEqual(args.tools, ["rea*", "+grep", "-write"]);
	assert.deepEqual(args.excludeTools, ["mcp_*"]);
	assert.deepEqual(args.messages, ["--tools", "*"]);
	assert.deepEqual(args.diagnostics, []);
	for (const tools of ["+", "-", "-code*", "r".repeat(1025), Array(257).fill("r").join(","), Array(17).fill("r".repeat(1024)).join(",")]) {
		assert.equal(parseArgs(["--tools", tools]).diagnostics.some(d => d.type === "error"), true);
	}
	assert.equal(parseArgs(["--exclude-tools", "*"]).diagnostics.some(d => d.type === "error"), true);
});

test("built offline CLI forwards expression policy through session services", () => {
	const root = mkdtempSync(join(tmpdir(), "sp-tool-selection-cli-"));
	try {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("../packages/coding-agent/dist/cli.js", import.meta.url)),
			"--offline", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
			"--extension", fileURLToPath(new URL("./fixtures/tool-selection.mjs", import.meta.url)),
			"--provider", "selection-fixture", "--model", "fixture", "--print", "--mode", "text",
			"--tools", "rea*,+grep,+write", "--exclude-tools", "writ?", "list tools"], {
			cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
				SP_CODING_AGENT_DIR: join(root, "agent"), SP_CODING_AGENT_SESSION_DIR: join(root, "sessions"), SP_OFFLINE: "1" },
			encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /SELECTION:codemode,grep,read/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
