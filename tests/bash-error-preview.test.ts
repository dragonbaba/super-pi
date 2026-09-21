import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { getKeybindings, RELEASE_COMPONENT_RENDER_CACHE, setKeybindings, stripTerminalSequences, visibleWidth } from "@super-pi/tui";
import { KeybindingsManager } from "../packages/coding-agent/src/core/keybindings.ts";
import { BashRenderClock, createBashRenderFixture } from "./helpers/bash-render-fixture.ts";

const { failureRecoveryHint } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/core.ts");
const recovery: string = await failureRecoveryHint("bash", { command: "node -e 'const = ;'" }, "SyntaxError: Unexpected token '='", process.cwd());
assert.ok(recovery.length > 300, "use the complete production recovery text");
const stack = Array.from({ length: 15 }, (_, index) => "    at frame" + index + " (node:internal/vm:1:2)").join("\n");
const previousKeybindings = getKeybindings();
test.before(() => setKeybindings(new KeybindingsManager()));
test.after(() => setKeybindings(previousKeybindings));
function failure(location = "[eval]:1", message = "SyntaxError: Unexpected token '='"): string {
	return [location, "const = ;", "      ^", "", message, stack, "Command exited with code 1", recovery].join("\n");
}
function view(f: ReturnType<typeof createBashRenderFixture>, width: number): string {
	return stripTerminalSequences(f.component.render(width).join("\n"));
}
function assertExpansion(rendered: string, key = "ctrl+o"): void {
	assert.equal(rendered.match(/to expand/g)?.length, 1, "one expansion hint per card");
	assert.ok(rendered.includes("more failure details, " + key + " to expand"), "configured binding is actionable");
	assert.doesNotMatch(rendered, /earlier lines/, "no fabricated skipped count for errors");
}

for (const location of ["[eval]:1", "file:///synthetic/invalid.mjs:1"]) for (const width of [80, 100, 120]) {
	test(location + " survives complete recovery with an expansion hint at " + width + " columns", t => {
		const clock = new BashRenderClock();
		const f = createBashRenderFixture(clock);
		try {
			f.result.content[0]!.text = failure(location);
			f.component.updateResult(f.result, false, true);
			const rendered = view(f, width);
			t.diagnostic(rendered.split("\n").slice(-10).map(line => line.trimEnd()).join("\n"));
			assert.match(rendered, /SyntaxError: Unexpected token/);
			assert.ok(rendered.includes(location));
			assert.match(rendered, /const = ;/);
			assert.match(rendered, /      \^/);
			assert.match(rendered, /Command exited with code 1/);
			assertExpansion(rendered);
			assert.doesNotMatch(rendered, /Do not retry unchanged source/);
			assert.equal(f.raw.resultRendererComponent.state.cachedLines.length, 5);
			f.component.setExpanded(true);
			const expanded = view(f, width);
			assert.match(expanded, /frame14/);
			assert.match(expanded, /\[Node script recovery\]/);
			assert.match(expanded.replaceAll(/\s+/gu, " "), /Do not retry unchanged source/);
			assert.doesNotMatch(expanded, /to expand|more failure details/);
			assert.equal(f.result.content[0]!.text, failure(location), "canonical content is untouched");
			f.component.setExpanded(false);
			assertExpansion(view(f, width));
		} finally { f.dispose(); clock.dispose(); }
	});
}

test("short module context remains visible and long exception/location is explicitly abbreviated", () => {
	const clock = new BashRenderClock();
	const f = createBashRenderFixture(clock);
	try {
		f.result.content[0]!.text = failure("file:///synthetic/invalid.mjs:1");
		f.component.updateResult(f.result, false, true);
		let rendered = view(f, 80);
		for (const expected of ["invalid.mjs:1", "const = ;", "^", "SyntaxError", "Command exited with code 1"]) assert.ok(rendered.includes(expected), expected);
		f.result.content[0]!.text = failure("file:///synthetic/" + "很长😀e\u0301/".repeat(1200) + "invalid.mjs:42:7", "TypeError: " + "合成😀e\u0301 failure ".repeat(1200));
		f.component.updateResult(f.result, false, true);
		for (const width of [80, 100, 120]) {
			rendered = view(f, width);
			assert.match(rendered, /TypeError:/);
			assert.match(rendered, /Command exited with code 1/);
			assert.match(rendered, /\.\.\./);
			assertExpansion(rendered);
			assert.ok(f.raw.resultRendererComponent.state.cachedLines.length <= 5);
			for (const line of f.raw.resultRendererComponent.state.cachedLines) assert.ok(visibleWidth(line) <= width - 2);
		}
	} finally { f.dispose(); clock.dispose(); }
});

test("omission reflects stack/log selection and both fragment and width limits without recovery text", () => {
	const clock = new BashRenderClock();
	const f = createBashRenderFixture(clock);
	try {
		for (const output of [
			failure().replace("\n" + recovery, ""),
			"TypeError: synthetic\n" + stack + "\nCommand exited with code 1",
			"extra log before\nTypeError: synthetic\nCommand exited with code 1\nextra diagnostic after",
		]) {
			f.result.content[0]!.text = output;
			f.component.updateResult(f.result, false, true);
			assertExpansion(view(f, 80));
			assert.doesNotMatch(output, /Node script recovery/);
		}
		// All meaningful content fits, including a full five-line parse failure.
		for (const output of [
			"TypeError: synthetic\nCommand exited with code 1",
			"TypeError: synthetic\n    at source (fixture:1:2)\nCommand exited with code 1",
			"[eval]:1\nconst = ;\n      ^\n\nSyntaxError: synthetic\nCommand exited with code 1",
			"Command aborted",
		]) {
			f.result.content[0]!.text = output;
			f.component.updateResult(f.result, false, true);
			assert.doesNotMatch(view(f, 80), /to expand|more failure details|earlier lines/);
			assert.equal(f.raw.resultRendererComponent.state.cachedFailureOmitted, false);
		}
		f.result.content[0]!.text = "TypeError: " + "message ".repeat(25) + "\nCommand exited with code 1";
		f.component.updateResult(f.result, false, true);
		const analyses = f.bashMetrics.failureAnalyses;
		assertExpansion(view(f, 80));
		assert.doesNotMatch(view(f, 400), /to expand|more failure details/);
		assertExpansion(view(f, 100));
		assert.equal(f.bashMetrics.failureAnalyses, analyses);
		f.result.content[0]!.text = "TypeError: " + "x".repeat(3000);
		f.component.updateResult(f.result, false, true);
		assertExpansion(view(f, 2200)); // Length-bounded even though the retained fragment fits.
		f.result.content[0]!.text = "done";
		f.component.updateResult(f.result, false, false);
		assert.doesNotMatch(view(f, 80), /to expand|more failure details|earlier lines/);
	} finally { f.dispose(); clock.dispose(); }
});

test("expansion hint resolves default and changed bindings without freezing them in the layout cache", () => {
	const clock = new BashRenderClock();
	const f = createBashRenderFixture(clock);
	try {
		f.result.content[0]!.text = failure();
		f.component.updateResult(f.result, false, true);
		assertExpansion(view(f, 80));
		const layouts = f.bashMetrics.previewLineRecomputations;
		const analyses = f.bashMetrics.failureAnalyses;
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
		assertExpansion(view(f, 80), "ctrl+e");
		assert.doesNotMatch(view(f, 80), /ctrl\+o to expand/);
		assert.equal(f.bashMetrics.previewLineRecomputations, layouts);
		assert.equal(f.bashMetrics.failureAnalyses, analyses);
	} finally { f.dispose(); clock.dispose(); setKeybindings(new KeybindingsManager()); }
});

test("same-body partial/success to final/error invalidates the tail cache only when needed", t => {
	const clock = new BashRenderClock();
	const f = createBashRenderFixture(clock);
	try {
		f.result.content[0]!.text = failure();
		f.component.updateResult(f.result, true, false);
		assert.doesNotMatch(view(f, 80), /SyntaxError:/, "partial keeps the old tail semantics");
		assert.doesNotMatch(view(f, 80), /more failure details/);
		assert.equal(f.bashMetrics.failureAnalyses, 0);
		const tail = f.raw.resultRendererComponent.state.cachedLines;
		f.component.updateResult(f.result, false, true);
		assert.match(view(f, 80), /SyntaxError:/);
		assertExpansion(view(f, 80));
		assert.notEqual(f.raw.resultRendererComponent.state.cachedLines, tail);
		assert.equal(f.bashMetrics.failureAnalyses, 1);
		const owner = f.raw.resultRendererComponent;
		const fragments = owner.state.preparedErrorPreview;
		const stable = owner.state.cachedLines;
		const savedLines = stable.slice();
		const layouts = f.bashMetrics.previewLineRecomputations;
		for (let index = 0; index < 100; index++) {
			view(f, 80);
		}
		assert.equal(f.bashMetrics.failureAnalyses, 1);
		assert.equal(f.bashMetrics.previewLineRecomputations, layouts);
		view(f, 100); view(f, 120);
		assertExpansion(view(f, 120));
		assert.equal(f.bashMetrics.failureAnalyses, 1);
		assert.equal(f.bashMetrics.previewLineRecomputations, layouts + 2);
		assert.equal(owner.state.preparedErrorPreview, fragments);
		assert.deepEqual(stable, savedLines, "prior returned lines do not mutate");
		assert.equal(clock.pending, 0);
		f.component.updateResult(f.result, false, false);
		assert.doesNotMatch(view(f, 80), /SyntaxError:/, "success still displays the tail");
		assert.doesNotMatch(view(f, 80), /more failure details/);
		assert.match(view(f, 80), /earlier lines/);
		assert.ok(owner.state.cachedSkipped > 0);
		assert.equal(owner.state.cachedFailureOmitted, false);
		assert.equal(owner.state.preparedErrorPreview, undefined);
		f.component.updateResult(f.result, false, true);
		assert.match(view(f, 80), /SyntaxError:/);
		const preview = owner.previewComponent;
		owner[RELEASE_COMPONENT_RENDER_CACHE]();
		assert.equal(owner.state.preparedErrorPreview, undefined);
		assert.deepEqual(preview.render(80), []);
		assert.equal(owner.state.cachedFailureOmitted, false);
		assert.ok(Object.values(owner.getBashResultRenderCacheReferenceCounts()).every(value => value === 0));
		t.diagnostic(JSON.stringify({ finalFailureAnalyses: f.bashMetrics.failureAnalyses, repeatRenderAnalyses: 0, repeatRenderLayouts: 0, resizeLayouts: 2, releasedReferences: 0 }));
	} finally { f.dispose(); clock.dispose(); }
});
