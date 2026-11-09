import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv } from "ajv";
import ts from "typescript";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "../packages/coding-agent/src/core/settings-manager.ts";

const globalUrl = new URL("../packages/coding-agent/schemas/settings.schema.json", import.meta.url);
const projectUrl = new URL("project-settings.schema.json", globalUrl);
const globalSchema = JSON.parse(readFileSync(globalUrl, "utf8"));
const projectSchema = JSON.parse(readFileSync(projectUrl, "utf8"));
// Register both local files; no remote schema loader or network access is needed.
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(globalSchema, globalUrl.href);
ajv.addSchema(projectSchema, projectUrl.href);
const validateGlobal = ajv.getSchema(globalUrl.href)!;
const validateProject = ajv.getSchema(projectUrl.href)!;

test("removed screen-mode settings stay valid in old files but are marked deprecated", () => {
	for (const key of ["tuiMode", "fullscreenExitOutput"]) {
		assert.equal(globalSchema.properties[key].deprecated, true);
		assert.equal(globalSchema.properties[key].default, undefined);
	}
	assert.equal(validateGlobal({ tuiMode: "regular", fullscreenExitOutput: "transcript" }), true);
	const manager = SettingsManager.inMemory({ tuiMode: "regular" }) as unknown as Record<string, unknown>;
	assert.equal(manager.getTuiMode, undefined);
	assert.equal(manager.getFullscreenExitOutput, undefined);
});

function storage(global: Record<string, unknown>, project: Record<string, unknown> = {}): SettingsStorage {
	const contents: Record<SettingsScope, string> = { global: JSON.stringify(global), project: JSON.stringify(project) };
	return {
		withLock(scope, callback) {
			const next = callback(contents[scope]);
			if (next !== undefined) contents[scope] = next;
		},
	};
}

test("settings schemas compile offline and cover current Settings and nested interface fields", () => {
	assert.ok(validateGlobal);
	assert.ok(validateProject);
	const text = readFileSync(new URL("../packages/coding-agent/src/core/settings-manager.ts", import.meta.url), "utf8");
	const source = ts.createSourceFile("settings-manager.ts", text, ts.ScriptTarget.Latest, true);
	const properties = globalSchema.properties;
	const coverage: Record<string, Record<string, unknown>> = {
		Settings: properties,
		CompactionSettings: properties.compaction.properties,
		BranchSummarySettings: properties.branchSummary.properties,
		RetrySettings: properties.retry.properties,
		ProviderRetrySettings: properties.retry.properties.provider.properties,
		TerminalSettings: properties.terminal.properties,
		ImageSettings: properties.images.properties,
		ToolResultPresentationSettings: properties.toolResultPresentation.properties,
		ThinkingBudgetsSettings: properties.thinkingBudgets.properties,
		MarkdownSettings: properties.markdown.properties,
		WarningSettings: properties.warnings.properties,
		PowerShellStatusSettings: properties.powershellStatus.properties,
	};
	for (const [name, schemaProperties] of Object.entries(coverage)) {
		const declaration = source.statements.find(
			(node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name,
		);
		assert.ok(declaration, name);
		const fields = declaration.members.map(member => member.name!.getText(source));
		const compatibilityFields = name === "Settings" ? ["$schema", "queueMode", "websockets"] : name === "RetrySettings" ? ["maxDelayMs"] : [];
		assert.deepEqual(Object.keys(schemaProperties).sort(), [...fields, ...compatibilityFields].sort(), name);
		for (const field of fields) assert.equal(typeof (schemaProperties[field] as { description?: unknown }).description, "string", `${name}.${field}`);
	}
});

test("settings schemas accept local features, legacy migrations and partial inherited settings", () => {
	const current = {
		$schema: projectUrl.href,
		defaultProvider: "custom", defaultModel: "custom-model", defaultThinkingLevel: "max",
		modelThinkingLevels: { "custom/model": "xhigh" }, transport: "websocket-cached",
		showHardwareCursor: false, outputPad: 0, editorPaddingX: 3, autocompleteMaxVisible: 20,
		tuiMode: "fullscreen", fullscreenExitOutput: "resume-hint", fullscreenScrollbar: "always",
		evidenceLedger: { enabled: true }, toolResultPresentation: { enabled: true, budgetTokens: 512 },
		packages: ["npm:example", { source: "./local", autoload: false, extensions: ["./extension.ts"] }],
		npmCommand: ["npm"], markdown: { mermaid: "final" }, defaultTools: ["powershell"],
	};
	const legacy = {
		queueMode: "all", websockets: true,
		skills: { enableSkillCommands: false, customDirectories: ["./skills"] },
		retry: { maxDelayMs: 1500 }, httpIdleTimeoutMs: " DISABLED ", websocketConnectTimeoutMs: "1e3",
	};
	for (const value of [{}, current, legacy, { toolResultPresentation: { enabled: true } }, { retry: { provider: { maxRetries: 0 } } }]) {
		assert.equal(validateGlobal(value), true, ajv.errorsText(validateGlobal.errors));
		assert.equal(validateProject(value), true, ajv.errorsText(validateProject.errors));
	}
	const manager = SettingsManager.fromStorage(storage(legacy));
	assert.equal(manager.getSteeringMode(), "all");
	assert.equal(manager.getTransport(), "websocket");
	assert.deepEqual(manager.getSkillPaths(), ["./skills"]);
	assert.equal(manager.getEnableSkillCommands(), false);
	assert.equal(manager.getProviderRetrySettings().maxRetryDelayMs, 1500);
	assert.equal(manager.getHttpIdleTimeoutMs(), 0);
	assert.equal(manager.getWebSocketConnectTimeoutMs(), 1000);
	const inherited = SettingsManager.fromStorage(storage(
		{ toolResultPresentation: { budgetTokens: 256 } }, { toolResultPresentation: { enabled: true } },
	));
	assert.deepEqual(inherited.getToolResultPresentationOptions(), { enabled: true, budgetTokens: 256 });
});

test("settings schemas diagnose misspelled fields and malformed local settings", () => {
	for (const value of [
		{ showHardwareCursor: "false" }, { editorPadingX: 1 }, { terminal: { showImage: true } },
		{ outputPad: 2 }, { tuiMode: "alt" }, { defaultThinkingLevel: "ultra" },
		{ packages: [{ autoload: false }] }, { packages: [{ source: "example", extension: [] }] },
		{ toolResultPresentation: { budgetTokens: 0 } }, { toolResultPresentation: { budgetTokens: 1.5 } },
		{ toolResultPresentation: { budgetTokens: Number.MAX_SAFE_INTEGER + 1 } },
		{ evidenceLedger: { enabled: "true" } }, { httpIdleTimeoutMs: -1 }, { httpIdleTimeoutMs: "invalid" },
	]) {
		assert.equal(validateGlobal(value), false, JSON.stringify(value));
		assert.equal(validateProject(value), false, JSON.stringify(value));
	}
});

test("branch summary output schema and project precedence preserve an explicit optional allowance", () => {
	for (const maxTokens of [1, 2048, 8192, Number.MAX_SAFE_INTEGER]) {
		assert.equal(validateGlobal({ branchSummary: { maxTokens } }), true);
		assert.equal(validateProject({ branchSummary: { maxTokens } }), true);
	}
	for (const maxTokens of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "4096"]) {
		assert.equal(validateGlobal({ branchSummary: { maxTokens } }), false);
		assert.equal(validateProject({ branchSummary: { maxTokens } }), false);
	}
	assert.equal(SettingsManager.inMemory().getBranchSummarySettings().maxTokens, undefined);
	const settings = SettingsManager.fromStorage(storage({ branchSummary: { reserveTokens: 32768, maxTokens: 4096 } }, { branchSummary: { maxTokens: 8192 } }));
	assert.deepEqual(settings.getBranchSummarySettings(), { reserveTokens: 32768, maxTokens: 8192, skipPrompt: false });
	assert.equal(globalSchema.properties.branchSummary.properties.maxTokens.default, 2048);
});

test("project schema warns on global-only settings without changing runtime trust and precedence", () => {
	const globalOnly = {
		powershellPath: "C:/trusted/pwsh.exe",
		sandboxToolchains: { include: ["C:/trusted/tools"], exclude: ["C:/obsolete"] },
		sandboxNetwork: "disabled",
		powershellStatus: { trustVersion: 1, available: true, verified: false, source: "configured" },
		defaultProjectTrust: "ask", httpProxy: "http://localhost:8080",
	};
	assert.equal(validateGlobal(globalOnly), true, ajv.errorsText(validateGlobal.errors));
	for (const [key, value] of Object.entries(globalOnly)) assert.equal(validateProject({ [key]: value }), false, key);
	const manager = SettingsManager.fromStorage(storage(globalOnly, {
		powershellPath: "C:/project/pwsh.exe", sandboxToolchains: { include: ["C:/project"] }, sandboxNetwork: "enabled", defaultProjectTrust: "always", showHardwareCursor: true,
	}));
	assert.equal(manager.getPowerShellPath(), "C:/trusted/pwsh.exe");
	assert.deepEqual(manager.getSandboxToolchains(), globalOnly.sandboxToolchains);
	assert.equal(manager.getSandboxNetwork(), "disabled");
	assert.equal(manager.getDefaultProjectTrust(), "ask");
	assert.equal(manager.getShowHardwareCursor(), true);
	const untrusted = SettingsManager.fromStorage(storage({ showHardwareCursor: false }, { showHardwareCursor: true }), { projectTrusted: false });
	assert.equal(untrusted.getShowHardwareCursor(), false);
});

test("sandbox networking defaults offline, validates values, and persists explicit global choices", async () => {
	assert.equal(SettingsManager.inMemory().getSandboxNetwork(), "disabled");
	for (const value of ["enabled", "disabled"] as const) {
		assert.equal(validateGlobal({ sandboxNetwork: value }), true);
		const saved = storage({}); const manager = SettingsManager.fromStorage(saved);
		manager.setSandboxNetwork(value); assert.equal(manager.getSandboxNetwork(), value);
		await manager.flush(); assert.equal(SettingsManager.fromStorage(saved).getSandboxNetwork(), value);
	}
	for (const value of [true, false, null, "Enable", "default", "", 1]) {
		assert.equal(validateGlobal({ sandboxNetwork: value }), false);
		assert.throws(() => SettingsManager.fromStorage(storage({sandboxNetwork:value})).getSandboxNetwork(), /Invalid global sandboxNetwork/);
	}
	assert.equal(SettingsManager.fromStorage(storage({}, {sandboxNetwork:"enabled"})).getSandboxNetwork(), "disabled");
});

test("editor schema annotations and diagnostics do not enable runtime validation or mutate loaded data", () => {
	const raw = { $schema: globalUrl.href, showHardwareCursor: "false", editorPadingX: 1 };
	const manager = SettingsManager.fromStorage(storage(raw));
	assert.deepEqual(manager.getGlobalSettings(), raw);
	assert.deepEqual(manager.drainErrors(), []);
	assert.equal(manager.getShowHardwareCursor() as unknown, "false");
	assert.equal(manager.getEditorPaddingX(), 0);
	assert.equal(validateGlobal(raw), false);
	assert.deepEqual(manager.getGlobalSettings(), raw);
});
