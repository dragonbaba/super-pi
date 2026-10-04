import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../packages/coding-agent/src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";

function owner(t: TestContext) {
	const runtime = createExtensionRuntime();
	t.after(() => runtime.invalidate());
	return { runtime, bus: createEventBus() };
}

for (const [label, name] of [["empty", ""], ["undefined", undefined], ["null", null], ["number", 7], ["object", {}]] as const) {
	test(`command registration rejects ${label} names at the loader boundary`, async t => {
		const { runtime, bus } = owner(t);
		await assert.rejects(loadExtensionFromFactory(pi => {
			pi.registerCommand(name as string, { handler: async () => {} });
		}, process.cwd(), bus, runtime, "fixture-invalid-name"), /fixture-invalid-name.*non-empty string name/);
	});
}

for (const [label, options] of [["missing options", undefined], ["null options", null], ["missing handler", {}],
	["string handler", { handler: "not callable" }], ["object handler", { handler: {} }]] as const) {
	test(`command registration rejects ${label} at the loader boundary`, async t => {
		const { runtime, bus } = owner(t);
		await assert.rejects(loadExtensionFromFactory(pi => {
			pi.registerCommand("broken", options as Parameters<ExtensionAPI["registerCommand"]>[1]);
		}, process.cwd(), bus, runtime, "fixture-invalid-handler"), /\/broken.*fixture-invalid-handler.*handler/);
	});
}

test("valid command registration retains its handler, completions and loader-owned identity", async t => {
	const { runtime, bus } = owner(t);
	const called: string[] = [];
	const handler = async (args: string) => { called.push(args); };
	const getArgumentCompletions = () => [{ value: "one", label: "one" }];
	const extension = await loadExtensionFromFactory(pi => {
		pi.registerCommand("valid", { description: "fixture", handler, getArgumentCompletions,
			name: 42, sourceInfo: { source: "forged" } } as Parameters<ExtensionAPI["registerCommand"]>[1]);
	}, process.cwd(), bus, runtime, "fixture-valid");
	const command = extension.commands.get("valid")!;
	assert.equal(command.name, "valid");
	assert.equal(command.sourceInfo, extension.sourceInfo);
	await command.handler("argument", {} as never);
	assert.equal(command.handler, handler);
	assert.equal(command.getArgumentCompletions, getArgumentCompletions);
	assert.equal(command.description, "fixture");
	assert.deepEqual(called, ["argument"]);
});

test("invalid replacement leaves the existing command callable", async t => {
	const { runtime, bus } = owner(t);
	const handler = async () => {};
	const extension = await loadExtensionFromFactory(pi => {
		pi.registerCommand("valid", { handler });
		assert.throws(() => pi.registerCommand("valid", {} as never), /handler/);
	}, process.cwd(), bus, runtime);
	assert.equal(extension.commands.size, 1);
	assert.equal(extension.commands.get("valid")?.handler, handler);
});

test("failed command registration discards staged flags and event subscriptions", async t => {
	const { runtime, bus } = owner(t);
	let events = 0;
	await assert.rejects(loadExtensionFromFactory(pi => {
		pi.registerFlag("uncommitted", { type: "boolean", default: true });
		pi.events.on("probe", () => { events++; });
		pi.registerCommand("broken", {} as never);
	}, process.cwd(), bus, runtime), /handler/);
	assert.equal(runtime.flagValues.has("uncommitted"), false);
	bus.emit("probe", undefined);
	assert.equal(events, 0);
});

test("a malformed command file is diagnosed without blocking another extension", async t => {
	const { runtime, bus } = owner(t);
	const root = mkdtempSync(join(tmpdir(), "sp-extension-command-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	const bad = join(root, "bad.ts"), good = join(root, "good.ts");
	writeFileSync(bad, 'export default pi => pi.registerCommand("broken", { description: "missing handler" });');
	writeFileSync(good, 'export default pi => pi.registerCommand("healthy", { handler: async () => {} });');
	const result = await loadExtensions([bad, good], root, bus, runtime);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0]?.path, bad);
	assert.match(result.errors[0]?.error ?? "", /\/broken.*handler/);
	assert.equal(result.extensions.length, 1);
	assert.equal(result.extensions[0]?.commands.has("healthy"), true);
});
