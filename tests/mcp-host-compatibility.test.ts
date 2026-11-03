import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { AgentSessionRuntime } from "../packages/coding-agent/src/core/agent-session-runtime.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { getSessionLeaseDir } from "../packages/coding-agent/src/core/session-lease.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { captureBundledArguments } from "./helpers/bundled-launcher.ts";
import { VERSION } from "../packages/coding-agent/src/config.ts";
// @ts-expect-error JavaScript extension package.
import { checkRuntimeCompatibility } from "../packages/mcp-bridge/src/runtime-compat.js";

test("host version without typed-source export is rejected before runtime load", () => {
	for (const version of ["0.84.1", VERSION]) {
		const result = checkRuntimeCompatibility(version, false);
		assert.equal(result.compatible, false);
		assert.match(result.reason, /adapter/i);
		assert.equal(checkRuntimeCompatibility(version, true).compatible, true);
		assert.equal(checkRuntimeCompatibility(version).compatible, true, "supported host must pass the actual capability probe");
	}
	assert.equal(checkRuntimeCompatibility("2.0.0", true).compatible, false);
});

async function serviceFixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mcp-sdk-host-"));
	const previousDir = process.env.SP_CODING_AGENT_DIR, previousEntry = process.argv[1];
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let resources: ResourceLoader | undefined, host: AgentSessionRuntime | undefined;
	let requests = 0, spawns = 0;
	const errors: unknown[] = [];
	async function close() {
		const runtime = resources?.getExtensions().runtime;
		if (host) await host.dispose();
		else if (session) { session.dispose(); await session.waitForSessionLeaseRelease(); }
		else if (runtime) {
			await runtime.executionBoundary.dispose();
			await runtime.nativeFiles?.dispose(); await runtime.nativeTasks?.dispose(); runtime.invalidate();
		}
		if (runtime) {
			assert.equal(runtime.executionBoundary.participantCount, 0);
			assert.equal(runtime.executionBoundary.hasDeadline, false);
		}
		if (session) assert.deepEqual(readdirSync(getSessionLeaseDir(root)), []);
		host = undefined; session = undefined; resources = undefined;
	}
	t.after(async () => {
		try {
			await close();
			assert.equal(requests, 0); assert.equal(spawns, 0); assert.deepEqual(errors, []);
			assert.deepEqual(readdirSync(getSessionLeaseDir(root)), []);
			assert.equal(existsSync(join(root, "mcp-activation.key")), false);
		} finally {
			t.mock.restoreAll(); syncBuiltinESMExports(); process.argv[1] = previousEntry;
			if (previousDir === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previousDir;
			const target = resolve(root);
			assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("mcp-sdk-host-"));
			rmSync(target, { recursive: true, force: true }); assert.equal(existsSync(target), false);
		}
	});
	process.env.SP_CODING_AGENT_DIR = root;
	process.argv[1] = join(root, "sdk-app.mjs");
	writeFileSync(process.argv[1], "// ordinary SDK application fixture\n");
	mkdirSync(join(root, "config"));
	writeFileSync(join(root, "config", "mcp.json"), JSON.stringify({ version: 1, servers: {} }));
	const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
	const packages = ["mcp-bridge", "lsp"].map(name => join(repositoryRoot, "packages", name));
	const manifestEntries = packages.flatMap(packageRoot => JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
		.pi.extensions.map((path: string) => resolve(packageRoot, path))) as string[];
	const args = captureBundledArguments(repositoryRoot, root, [["--help"]])[0]!;
	const entries = args.filter((path, index) => args[index - 1] === "--extension" && manifestEntries.includes(path));
	assert.deepEqual(entries, manifestEntries, "consume both actual default manifest entries, in launcher order");
	// The bounded launcher capture above is the only permitted child. Actual service
	// assembly below must remain lazy, including indirect CommonJS and ESM spawns.
	for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
		t.mock.method(childProcess, method, () => { spawns++; throw new Error(`Unexpected service process: ${method}`); });
	}
	syncBuiltinESMExports();
	t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Fixture must remain offline"); });
	return { root, entries, packages, close,
		async open(settings: SettingsManager, options: { noExtensions?: boolean; additionalExtensionPaths?: string[]; noMcp?: boolean; sdkDefaults?: boolean } = {}) {
			await close();
			if (!options.sdkDefaults) {
				resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
					noExtensions: options.noExtensions, additionalExtensionPaths: options.additionalExtensionPaths,
					noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
				await resources.reload();
			}
			({ session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings,
				sessionManager: SessionManager.inMemory(root), resourceLoader: resources, model: ALPHA_MODEL,
				modelRuntime: alphaModelRuntime(), noTools: "builtin", noMcp: options.noMcp }));
			host = new AgentSessionRuntime(session, { cwd: root, agentDir: root } as never, async () => { throw new Error("unexpected replacement"); });
			resources = session.resourceLoader; assert.deepEqual(resources.getExtensions().errors, []);
			await session.bindExtensions({ onError: error => { errors.push(error); } });
			return { session, resources };
		},
	};
}

const lspTools = ["lsp_diagnostics", "lsp_fix", "lsp_navigate"];
function assertServiceAssembly(resources: ResourceLoader, entries: string[]) {
	const { extensions, errors, runtime } = resources.getExtensions();
	assert.deepEqual(errors, []);
	assert.deepEqual(extensions.map(extension => extension.path), entries);
	assert.deepEqual(extensions.flatMap(extension => [...extension.tools.keys()]), ["mcp_search_tools", ...lspTools]);
	const commands = extensions.flatMap(extension => [...extension.commands.keys()]);
	assert.equal(new Set(commands).size, commands.length); assert.ok(commands.includes("lsp"));
	const owners = [...(runtime.executionBoundary as any).participants.keys()].filter((key: string) => key.startsWith("extension:"));
	assert.deepEqual(owners, [`extension:${entries[0]}:mcp`, `extension:${entries[1]}:lsp`]);
}

test("default MCP/LSP entries explicitly consumed by SDK deduplicate and release reload owners", { timeout: 5000 }, async t => {
	const fixture = await serviceFixture(t);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, packages: fixture.packages });
	const packageOnly = await fixture.open(settings);
	assertServiceAssembly(packageOnly.resources, fixture.entries);
	const { session, resources } = await fixture.open(settings, { additionalExtensionPaths: [...fixture.entries, ...fixture.entries] });
	assertServiceAssembly(resources, fixture.entries);
	assert.deepEqual(session.getAllTools().filter(tool => tool.sourceInfo.source !== "builtin").map(tool => tool.name), ["mcp_search_tools", ...lspTools]);
	const boundary = resources.getExtensions().runtime.executionBoundary, participantCount = boundary.participantCount;
	const runSearch = async () => {
		const tool = (session as any)._toolRegistry.get("mcp_search_tools");
		const result = await tool.execute("empty-search", { query: "fixture" });
		assert.deepEqual(result.details, { status: "unconfigured", matches: [] });
	};
	await runSearch();
	await session.reload();
	assert.equal(boundary.participantCount, 0); assert.equal(boundary.hasDeadline, false);
	const reloaded = resources.getExtensions().runtime.executionBoundary;
	assert.notEqual(reloaded, boundary); assert.equal(reloaded.participantCount, participantCount);
	assertServiceAssembly(resources, fixture.entries);
	await runSearch();
	await fixture.close();
});

test("MCP/LSP automatic-source filters preserve explicit entries and noMcp preserves LSP", { timeout: 5000 }, async t => {
	const fixture = await serviceFixture(t);
	const defaults = { compaction: { enabled: false } };
	const configured = SettingsManager.inMemory({ ...defaults, packages: fixture.packages });
	const filtered = SettingsManager.inMemory({ ...defaults, packages: fixture.packages.map(source => ({ source, extensions: [] })) });
	// Exercise createAgentSession's own default loader, not a supplied empty loader.
	const plainSdk = await fixture.open(SettingsManager.inMemory(defaults), { sdkDefaults: true });
	assert.deepEqual(plainSdk.resources.getExtensions().extensions, []);
	assert.deepEqual(plainSdk.session.getAllTools().filter(tool => tool.sourceInfo.source !== "builtin").map(tool => tool.name), []);
	// These are distinct source-selection rules, not a cross-product of settings.
	for (const [settings, noExtensions] of [[configured, true], [filtered, false]] as const) {
		const { session, resources } = await fixture.open(settings, { noExtensions });
		assert.deepEqual(resources.getExtensions().extensions, []);
		assert.deepEqual(session.getAllTools().filter(tool => tool.sourceInfo.source !== "builtin").map(tool => tool.name), []);
	}
	for (const [settings, noExtensions] of [[configured, true], [filtered, false]] as const) {
		const { session, resources } = await fixture.open(settings, {
			noExtensions, additionalExtensionPaths: [...fixture.entries, ...fixture.entries], noMcp: true,
		});
		assertServiceAssembly(resources, fixture.entries);
		assert.deepEqual(session.getAllTools().filter(tool => tool.sourceInfo.source !== "builtin").map(tool => tool.name), lspTools);
		assert.deepEqual(session.getActiveToolNames().filter(name => name !== "codemode"), lspTools);
		assert.equal((session as any)._toolRegistry.has("mcp_search_tools"), false);
	}
	await fixture.close();
});

test("unsupported hosts load the entry, warn and stop before tool or owner registration", async () => {
	const root = mkdtempSync(join(tmpdir(), "mcp-host-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
		for (const [name, exports, reason] of [
			["missing-version", "export {};", /unsupported or unavailable/],
			["unsupported-version", 'export const VERSION = "0.83.1";', /unsupported or unavailable/],
			["missing-adapter", 'export const VERSION = "0.84.1";', /typed-source adapter/],
		] as const) {
			const fixture = join(root, name), host = join(fixture, "node_modules", "@super-pi", "coding-agent");
			mkdirSync(host, { recursive: true });
			writeFileSync(join(host, "package.json"), JSON.stringify({ name: "@super-pi/coding-agent", version: "0.84.1", type: "module", exports: { ".": "./index.js" } }));
			writeFileSync(join(host, "index.js"), exports);
			const extension = join(fixture, "extension");
			mkdirSync(extension);
			// Deliberately omit bridge.js: unsupported hosts must never import the runtime.
			for (const file of ["index.js", "config.js", "runtime-compat.js", "security.js", "lifecycle.js", "manager.js", "regex.js"]) {
				copyFileSync(new URL(`../packages/mcp-bridge/src/${file}`, import.meta.url), join(extension, file));
			}
			const entry = await import(pathToFileURL(join(extension, "index.js")).href);
			assert.equal(typeof entry.default, "function");
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			const warnings: string[] = [];
			let tools = 0, owners = 0;
			assert.equal(entry.default({
				on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
				registerTool: () => { tools++; }, registerExecutionOwner: () => { owners++; },
			}), undefined, "extension factory stays synchronous");
			assert.deepEqual([...handlers.keys()], ["session_start"]);
			await handlers.get("session_start")!({}, { hasUI: true, ui: { notify: (message: string, level: string) => {
				assert.equal(level, "warning"); warnings.push(message);
			} } });
			assert.equal(warnings.length, 1); assert.match(warnings[0]!, reason);
			assert.equal(tools, 0); assert.equal(owners, 0);
		}
	} finally {
		const target = resolve(root);
		assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("mcp-host-"));
		rmSync(target, { recursive: true, force: true });
		assert.equal(existsSync(target), false);
	}
});
