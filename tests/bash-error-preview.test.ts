import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { RELEASE_COMPONENT_RENDER_CACHE, stripTerminalSequences, visibleWidth } from "@super-pi/tui";
import { BashRenderClock, createBashRenderFixture } from "./helpers/bash-render-fixture.ts";

const { failureRecoveryHint } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/core.ts");
const recovery: string = await failureRecoveryHint("bash", { command: "node -e 'const = ;'" }, "SyntaxError: Unexpected token '='", process.cwd());
assert.ok(recovery.length > 300, "use the complete production recovery text");
const stack = Array.from({ length: 15 }, (_, index) => "    at frame" + index + " (node:internal/vm:1:2)").join("\n");
function failure(location = "[eval]:1", message = "SyntaxError: Unexpected token '='"): string {
	return [location, "const = ;", "      ^", "", message, stack, "Command exited with code 1", recovery].join("\n");
}
function view(f: ReturnType<typeof createBashRenderFixture>, width: number): string {
	return stripTerminalSequences(f.component.render(width).join("\n"));
}

for (const width of [80, 100, 120]) {
	test("final eval error survives complete recovery at " + width + " columns", t => {
		const clock = new BashRenderClock();
		const f = createBashRenderFixture(clock);
		try {
			f.result.content[0]!.text = failure();
			f.component.updateResult(f.result, false, true);
			const rendered = view(f, width);
			t.diagnostic(rendered.split("\n").filter(line => /\[eval\]|SyntaxError|Command exited/.test(line)).join("\n"));
			assert.match(rendered, /SyntaxError: Unexpected token/);
			assert.match(rendered, /\[eval\]:1/);
			assert.match(rendered, /Command exited with code 1/);
			assert.doesNotMatch(rendered, /Do not retry unchanged source/);
			assert.ok(f.raw.resultRendererComponent.state.cachedLines.length <= 5);
			f.component.setExpanded(true);
			const expanded = view(f, width);
			assert.match(expanded, /frame14/);
			assert.match(expanded, /\[Node script recovery\]/);
			assert.match(expanded.replaceAll(/\s+/gu, " "), /Do not retry unchanged source/);
			assert.equal(f.result.content[0]!.text, failure(), "canonical content is untouched");
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
			assert.match(rendered, /…/);
			assert.ok(f.raw.resultRendererComponent.state.cachedLines.length <= 5);
			for (const line of f.raw.resultRendererComponent.state.cachedLines) assert.ok(visibleWidth(line) <= width - 2);
		}
	} finally { f.dispose(); clock.dispose(); }
});

test("same-body partial/success to final/error invalidates the tail cache only when needed", t => {
	const clock = new BashRenderClock();
	const f = createBashRenderFixture(clock);
	try {
		f.result.content[0]!.text = failure();
		f.component.updateResult(f.result, true, false);
		assert.doesNotMatch(view(f, 80), /SyntaxError:/, "partial keeps the old tail semantics");
		const tail = f.raw.resultRendererComponent.state.cachedLines;
		f.component.updateResult(f.result, false, true);
		assert.match(view(f, 80), /SyntaxError:/);
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
		assert.equal(f.bashMetrics.failureAnalyses, 1);
		assert.equal(f.bashMetrics.previewLineRecomputations, layouts + 2);
		assert.equal(owner.state.preparedErrorPreview, fragments);
		assert.deepEqual(stable, savedLines, "prior returned lines do not mutate");
		assert.equal(clock.pending, 0);
		f.component.updateResult(f.result, false, false);
		assert.doesNotMatch(view(f, 80), /SyntaxError:/, "success still displays the tail");
		assert.equal(owner.state.preparedErrorPreview, undefined);
		f.component.updateResult(f.result, false, true);
		assert.match(view(f, 80), /SyntaxError:/);
		const preview = owner.previewComponent;
		owner[RELEASE_COMPONENT_RENDER_CACHE]();
		assert.equal(owner.state.preparedErrorPreview, undefined);
		assert.deepEqual(preview.render(80), []);
		assert.ok(Object.values(owner.getBashResultRenderCacheReferenceCounts()).every(value => value === 0));
		t.diagnostic(JSON.stringify({ finalFailureAnalyses: f.bashMetrics.failureAnalyses, repeatRenderAnalyses: 0, repeatRenderLayouts: 0, resizeLayouts: 2, releasedReferences: 0 }));
	} finally { f.dispose(); clock.dispose(); }
});
