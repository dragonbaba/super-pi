import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ajv } from "ajv";
import { createJiti } from "jiti";
import ts from "typescript";

// Use the current source definitions even when the local dist predates them.
const jiti = createJiti(import.meta.url, {
	alias: { "@super-pi/tui": fileURLToPath(new URL("../packages/tui/src/keybindings.ts", import.meta.url)) },
});
const { KEYBINDINGS, KeybindingsManager, migrateKeybindingsConfig } = await jiti.import<
	typeof import("../packages/coding-agent/src/core/keybindings.ts")
>("../packages/coding-agent/src/core/keybindings.ts");
const schemaUrl = new URL("../packages/coding-agent/schemas/keybindings.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
// Compilation has no remote loader; every reference stays inside this file.
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

test("keybindings schema compiles offline and covers all built-in actions and legacy aliases", () => {
	const sourceUrl = new URL("../packages/coding-agent/src/core/keybindings.ts", import.meta.url);
	const source = ts.createSourceFile("keybindings.ts", readFileSync(sourceUrl, "utf8"), ts.ScriptTarget.Latest, true);
	const declaration = source.statements.filter(ts.isVariableStatement)
		.flatMap(statement => [...statement.declarationList.declarations])
		.find(item => item.name.getText(source) === "KEYBINDING_NAME_MIGRATIONS");
	assert.ok(declaration?.initializer);
	let value = declaration.initializer;
	while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
	assert.ok(ts.isObjectLiteralExpression(value));
	const legacyNames: string[] = [];
	for (const property of value.properties) {
		assert.ok(ts.isPropertyAssignment(property));
		assert.ok(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name));
		assert.ok(ts.isStringLiteral(property.initializer));
		const legacy = property.name.text;
		const current = property.initializer.text;
		legacyNames.push(legacy);
		assert.ok(Object.hasOwn(KEYBINDINGS, current), current);
		assert.ok(schema.properties[legacy].description.includes(current), legacy);
		assert.equal(validate({ [legacy]: [] }), true, legacy);
		assert.deepEqual(migrateKeybindingsConfig({ [legacy]: [] }).config, { [current]: [] });
	}
	assert.deepEqual(Object.keys(schema.properties).sort(), ["$schema", ...Object.keys(KEYBINDINGS), ...legacyNames].sort());
	for (const [action, definition] of Object.entries(KEYBINDINGS)) {
		assert.equal(schema.properties[action].description, definition.description, action);
		assert.equal(validate({ [action]: definition.defaultKeys }), true, action);
		assert.equal(validate({ [action]: [] }), true, action);
	}
});

test("keybindings schema accepts alternatives, unbinding and existing key spellings without imposing a new grammar", () => {
	for (const config of [
		{},
		{ $schema: schemaUrl.href, "tui.altScreen.top": ["Ctrl+Home", "CTRL+UP"], "tui.altScreen.bottom": [] },
		{ "app.model.cycleBackward": "shift+ctrl+p", "app.interrupt": "ESC", "tui.input.submit": "Return" },
		{ "tui.editor.jumpBackward": "alt+ctrl+]", "tui.editor.undo": "ctrl+-", "app.session.new": "super+n" },
		{ interrupt: "escape", "app.interrupt": ["ctrl+c"] },
		{ "app.interrupt": "unrecognized-key-notation" },
	]) assert.equal(validate(config), true, ajv.errorsText(validate.errors));
});

test("keybindings schema diagnoses misspelled actions and malformed value types", () => {
	for (const config of [
		null, [], "ctrl+x", { $schema: [] },
		{ "tui.altScreen.tpo": "ctrl+home" }, { interupt: "escape" },
		{ "app.interrupt": false }, { "app.interrupt": null }, { "app.interrupt": 1 },
		{ "app.interrupt": { key: "escape" } }, { "app.interrupt": ["escape", false] },
		{ interrupt: [["escape"]] },
	]) assert.equal(validate(config), false, JSON.stringify(config));
});

test("schema metadata preserves global loading, legacy precedence and permissive runtime behavior without rewriting the file", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "sp-keybindings-schema-"));
	try {
		mkdirSync(join(agentDir, "config"));
		const path = join(agentDir, "config", "keybindings.json");
		const raw = {
			$schema: schemaUrl.href,
			interrupt: "escape", "app.interrupt": "ctrl+q",
			"tui.altScreen.top": [], cursorLineStart: "home",
			"app.message.copy": false, "app.message.coyp": "ctrl+w",
		};
		const contents = "\uFEFF" + JSON.stringify(raw, null, 2) + "\n";
		writeFileSync(path, contents);
		assert.equal(validate(raw), false, "editor diagnoses malformed/unknown entries");
		const manager = KeybindingsManager.create(agentDir);
		assert.deepEqual(manager.getKeys("app.interrupt"), ["ctrl+q"], "current name overrides the legacy alias");
		assert.deepEqual(manager.getKeys("tui.altScreen.top"), [], "empty array disables defaults");
		assert.deepEqual(manager.getKeys("tui.editor.cursorLineStart"), ["home"], "legacy name still loads");
		assert.deepEqual(manager.getKeys("app.message.copy"), ["ctrl+x"], "malformed value retains the default");
		assert.deepEqual(manager.getKeys("tui.altScreen.bottom"), ["ctrl+end", "ctrl+down"], "omitted action retains current defaults");
		assert.equal(manager.getUserBindings().$schema, schemaUrl.href);
		assert.equal(Object.hasOwn(manager.getEffectiveConfig(), "app.message.coyp"), false);
		assert.equal(readFileSync(path, "utf8"), contents, "loading/migration leaves the file unchanged");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
