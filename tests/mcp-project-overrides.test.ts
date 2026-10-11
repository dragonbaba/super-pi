import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FileAuthStorageBackend } from "../packages/coding-agent/src/core/auth-storage.ts";
// @ts-expect-error JavaScript extension package.
import { loadMcpConfig } from "../packages/mcp-bridge/src/config.js";
// @ts-expect-error JavaScript extension package.
import { McpOAuth } from "../packages/mcp-bridge/src/oauth.js";
// @ts-expect-error JavaScript extension package.
import { McpSchemaCache } from "../packages/mcp-bridge/src/schema-cache.js";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "sp-mcp-overrides-"));
	const previous = process.env.SP_CODING_AGENT_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR;
		else process.env.SP_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const agent = join(root, "agent"), workspace = join(root, "work");
	mkdirSync(join(agent, "config"), { recursive: true }); mkdirSync(join(workspace, ".sp", "config"), { recursive: true });
	process.env.SP_CODING_AGENT_DIR = agent;
	const globalPath = join(agent, "config", "mcp.json"), projectPath = join(workspace, ".sp", "config", "mcp.json");
	function global(servers: object, allow = true) { writeFileSync(globalPath, JSON.stringify({ version: 1, allowProjectConfig: allow, servers })); }
	function project(servers: object) { writeFileSync(projectPath, JSON.stringify({ version: 1, servers })); }
	return { root, agent, workspace, globalPath, projectPath, global, project, load: (trusted = true) => loadMcpConfig(workspace, trusted).servers };
}

const HTTP = { transport: "http", url: "https://fixture.invalid/mcp", toolTimeoutMs: 3000 };

test("project overrides require both gates before even reading project configuration", t => {
	const f = fixture(t); f.global({ fixture: HTTP }); writeFileSync(f.projectPath, "malformed project");
	assert.equal(f.load(false)[0].source, "global");
	f.global({ fixture: HTTP }, false); assert.equal(f.load()[0].source, "global");
	f.global({ fixture: HTTP }); assert.throws(() => f.load(), SyntaxError);
	f.project({ fixture: { enabled: false } }); assert.equal(f.load()[0].enabled, false);
	assert.equal(f.load(false)[0].enabled, true, "revoking trust restores only global configuration");
});

test("same-ID project fields override before normalization without rewriting either file", t => {
	const f = fixture(t);
	f.global({ fixture: { ...HTTP, headers: { "X-Old": "old" }, oauth: { scope: "read", callbackPort: 1234 } } });
	f.project({ fixture: { enabled: false, toolTimeoutMs: 2000, headers: {}, oauth: { scope: "write" } }, extra: HTTP });
	const before = [readFileSync(f.globalPath), readFileSync(f.projectPath)];
	const [server, extra] = f.load();
	assert.equal(server.url, HTTP.url); assert.equal(server.enabled, false); assert.equal(server.toolTimeoutMs, 2000);
	assert.deepEqual(Object.keys(server.headers), []); assert.deepEqual(server.oauth, { scope: "write" });
	assert.equal(server.source, "project"); assert.equal(server.projectScope, realpathSync.native(f.workspace));
	assert.equal(extra.source, "project");
	assert.deepEqual([readFileSync(f.globalPath), readFileSync(f.projectPath)], before);
	// Validate the effective definition: a project can replace an invalid global field.
	f.global({ fixture: { ...HTTP, toolTimeoutMs: 1 } }); f.project({ fixture: { toolTimeoutMs: 2000 } });
	assert.equal(f.load()[0].toolTimeoutMs, 2000);
});

test("changed project targets do not inherit global headers, OAuth or process secrets", t => {
	const f = fixture(t);
	f.global({ fixture: { ...HTTP, headers: { Authorization: "fixture-secret" } } });
	f.project({ fixture: { url: "https://other.invalid/mcp" } }); assert.deepEqual(Object.keys(f.load()[0].headers), []);
	f.global({ fixture: { ...HTTP, oauth: true } });
	assert.equal(f.load()[0].oauth, undefined);
	f.project({ fixture: { url: "https://other.invalid/mcp", headers: { "X-Project": "explicit" }, oauth: { scope: "new" } } });
	assert.equal(f.load()[0].headers["X-Project"], "explicit"); assert.deepEqual(f.load()[0].oauth, { scope: "new" });
	f.global({ fixture: { transport: "stdio", command: process.execPath, args: ["old.js"], env: { PRIVATE_FIXTURE: "secret" }, envFrom: ["PATH"] } });
	f.project({ fixture: { args: ["new.js"] } });
	assert.deepEqual(f.load()[0].args, ["new.js"]); assert.equal(f.load()[0].env.PRIVATE_FIXTURE, undefined);
	f.project({ fixture: { env: { PROJECT_FIXTURE: "local" }, envFrom: [] } });
	const inherited = f.load()[0]; assert.deepEqual(inherited.args, ["old.js"]);
	assert.equal(inherited.env.PRIVATE_FIXTURE, undefined); assert.equal(inherited.env.PROJECT_FIXTURE, "local");
	f.global({ fixture: { ...HTTP, args: ["global-secret-argument"] } });
	f.project({ fixture: { transport: "stdio", command: process.execPath } });
	assert.deepEqual(f.load()[0].args, []);
});

test("effective project definitions retain validation and the total server bound", t => {
	const f = fixture(t); f.global({ fixture: HTTP });
	for (const patch of [{ toolTimeoutMs: 1 }, { headers: [] }, { url: "http://remote.invalid/mcp" }, { oauth: { clientId: "fixed" } }, { enabled: null }]) {
		f.project({ fixture: patch }); assert.throws(() => f.load());
	}
	f.project({ newServer: { toolTimeoutMs: 2000 } }); assert.throws(() => f.load(), /command/);
	const servers = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`server${i}`, HTTP]));
	f.global(servers); f.project({ server0: { maxTools: 1 } }); assert.equal(f.load().length, 16);
	f.project({ extra: HTTP }); assert.throws(() => f.load(), /exceeds 16 servers/);
});

test("project OAuth and schema identities isolate global, legacy and other workspace credentials", async t => {
	const f = fixture(t); f.global({ fixture: { ...HTTP, oauth: true } }); f.project({ fixture: { toolTimeoutMs: 2000 } });
	const global = f.load(false)[0], projectA = f.load()[0];
	const workspaceB = join(f.root, "other"); mkdirSync(join(workspaceB, ".sp", "config"), { recursive: true });
	writeFileSync(join(workspaceB, ".sp", "config", "mcp.json"), readFileSync(f.projectPath));
	const projectB = loadMcpConfig(workspaceB, true).servers[0];
	const authPath = join(f.agent, "fixture-auth.json"), backend = new FileAuthStorageBackend(authPath);
	let requests = 0;
	const fetchImpl = async () => { requests++; throw new Error("unexpected auth request"); };
	const owners = [global, projectA, projectB].map(config => new McpOAuth(config, backend, fetchImpl));
	try {
		const legacyKey = createHash("sha256").update(JSON.stringify([projectA.id, projectA.url, projectA.source, projectA.oauth])).digest("hex");
		assert.equal(owners[0].key, createHash("sha256").update(JSON.stringify([global.id, global.url, global.source, global.oauth])).digest("hex"));
		assert.equal(new Set([...owners.map(owner => owner.key), legacyKey]).size, 4);
		const issuer = "https://issuer.fixture.invalid";
		const entry = (token: string) => ({ discovery: { authorizationServerUrl: issuer }, client: { client_id: "fixture", issuer }, tokens: { access_token: token, issuer } });
		writeFileSync(authPath, JSON.stringify({ [owners[0].key]: entry("global"), [owners[1].key]: entry("project-A"), [legacyKey]: entry("legacy-project") }));
		const before = readFileSync(authPath);
		assert.equal(await owners[0].token(), "global"); assert.equal(await owners[1].token(), "project-A"); assert.equal(await owners[2].token(), undefined);
		assert.equal(requests, 0); assert.deepEqual(readFileSync(authPath), before);
		const cache = new McpSchemaCache();
		assert.equal(cache.put(global, f.workspace, [{ name: "lookup", inputSchema: { type: "object" } }], null), true);
		assert.equal(cache.get(projectA, f.workspace), null);
		assert.equal(cache.put(projectA, f.workspace, [{ name: "lookup", inputSchema: { type: "object" } }], null), true);
		assert.equal(cache.get(projectB, f.workspace), null, "scope remains isolated even with the same caller workspace argument");
	} finally { await Promise.all(owners.map(owner => owner.close())); }
});
