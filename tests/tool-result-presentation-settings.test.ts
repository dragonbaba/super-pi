import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";

interface ToolResultPresentationSettingReader {
	getToolResultPresentationOptions(): { enabled: true; budgetTokens: number } | undefined;
}

function presentationOptions(settings: Record<string, unknown> = {}) {
	const manager = SettingsManager.inMemory(settings);
	return (manager as unknown as ToolResultPresentationSettingReader).getToolResultPresentationOptions();
}

test("production tool-result presentation stays disabled unless explicitly enabled", () => {
	assert.equal(presentationOptions(), undefined);
	assert.equal(
		presentationOptions({ toolResultPresentation: { enabled: false, budgetTokens: 0 } }),
		undefined,
	);
	assert.equal(
		presentationOptions({ toolResultPresentation: { budgetTokens: 128 } }),
		undefined,
	);
	assert.equal(
		presentationOptions({ toolResultPresentation: { enabled: "true", budgetTokens: 128 } }),
		undefined,
	);
});

test("production tool-result presentation accepts only an enabled positive safe-integer budget", () => {
	assert.deepEqual(
		presentationOptions({ toolResultPresentation: { enabled: true, budgetTokens: 128 } }),
		{ enabled: true, budgetTokens: 128 },
	);
	for (const budgetTokens of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "128"]) {
		assert.throws(
			() => presentationOptions({ toolResultPresentation: { enabled: true, budgetTokens } }),
			/toolResultPresentation\.budgetTokens/,
		);
	}
});

test("CLI runtime creation passes the validated production setting through the existing service boundary", () => {
	const main = readFileSync(new URL("../packages/coding-agent/src/main.ts", import.meta.url), "utf8");
	assert.match(
		main,
		/toolResultPresentation:\s*settingsManager\.getToolResultPresentationOptions\(\)/,
	);
});
