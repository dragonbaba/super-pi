import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("built CLI --no-mcp prevents stdio startup even with an explicit MCP allowlist", () => {
	const root = mkdtempSync(join(tmpdir(), "sp-no-mcp-cli-"));
	try {
		const agent = join(root, "agent"), marker = join(root, "spawned");
		mkdirSync(join(agent, "config"), { recursive: true });
		const configPath = join(agent, "config", "mcp.json");
		const config = JSON.stringify({ version: 1, servers: { fixture: { enabled: true, transport: "stdio", command: process.execPath,
			args: ["-e", 'require("node:fs").writeFileSync(process.argv[1], "started")', marker] } } });
		writeFileSync(configPath, config);
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("../packages/coding-agent/dist/cli.js", import.meta.url)),
			"--offline", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-mcp",
			"--extension", fileURLToPath(new URL("./fixtures/mcp-disabled-provider.mjs", import.meta.url)),
			"--extension", fileURLToPath(new URL("../packages/mcp-bridge/src/index.js", import.meta.url)),
			"--provider", "disabled-fixture", "--model", "fixture", "--print", "--mode", "text",
			"--tools", "read,mcp_search_tools,mcp__local__helper", "list tools"], {
			cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
				SP_CODING_AGENT_DIR: agent, SP_CODING_AGENT_SESSION_DIR: join(root, "sessions"), SP_OFFLINE: "1" },
			encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
		});
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /MCP_ENABLED:false;TOOLS:codemode,mcp__local__helper,read/);
		assert.equal(existsSync(marker), false);
		assert.equal(existsSync(join(agent, "cache", "mcp-schemas-v1.json")), false);
		assert.equal(existsSync(join(agent, "mcp-activation.key")), false);
		assert.equal(readFileSync(configPath, "utf8"), config);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
