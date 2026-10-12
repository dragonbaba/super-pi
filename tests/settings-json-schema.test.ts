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

test("project schema warns on global-only settings without changing runtime trust and precedence", () => {
	const globalOnly = {
		powershellPath: "C:/trusted/pwsh.exe",
		powershellStatus: { trustVersion: 1, available: true, verified: false, source: "configured" },
		defaultProjectTrust: "ask", httpProxy: "http://localhost:8080",
	};
	assert.equal(validateGlobal(globalOnly), true, ajv.errorsText(validateGlobal.errors));
	for (const [key, value] of Object.entries(globalOnly)) assert.equal(validateProject({ [key]: value }), false, key);
	const manager = SettingsManager.fromStorage(storage(globalOnly, {
		powershellPath: "C:/project/pwsh.exe", defaultProjectTrust: "always", showHardwareCursor: true,
	}));
	assert.equal(manager.getPowerShellPath(), "C:/trusted/pwsh.exe");
	assert.equal(manager.getDefaultProjectTrust(), "ask");
	assert.equal(manager.getShowHardwareCursor(), true);
	const untrusted = SettingsManager.fromStorage(storage({ showHardwareCursor: false }, { showHardwareCursor: true }), { projectTrusted: false });
	assert.equal(untrusted.getShowHardwareCursor(), false);
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
