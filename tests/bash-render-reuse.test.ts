import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { RELEASE_COMPONENT_RENDER_CACHE, Text } from "@super-pi/tui";
import { createBashToolDefinition } from "../packages/coding-agent/src/core/tools/bash.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { BashRenderClock, createBashRenderFixture } from "./helpers/bash-render-fixture.ts";

for (const scenario of ["quiet", "collapsed", "expanded"] as const) {
	test(`Bash ${scenario}: 100 timer ticks preserve call layout and derived identities`, () => {
		const clock = new BashRenderClock();
		try {
			const f = createBashRenderFixture(clock, scenario === "expanded", scenario === "quiet");
			f.run(2); // warm timer and layouts before increment accounting
			const counts = f.run(100);
			for (const key of ["callRendererCalls", "callSetText", "callLayouts", "preparedReplacements", "lineReplacements", "outputReplacements", "timeReplacements"] as const) assert.equal(counts[key], 0, key);
			assert.equal(counts.notifications, 100);
			assert.equal(counts.callRenderCalls, 100, "cached render calls are distinct from layout work");
			assert.match(f.component.render(120).join("\n"), /Elapsed 102\.0s/);
			assert.equal(f.bashMetrics.timeTextUpdates, 102);
			assert.equal(f.bashMetrics.previewComponentsCreated, 0);
			assert.equal(f.bashMetrics.timeComponentsCreated, 0);
			const final = f.dispose();
			assert.ok(Object.values(final).every(value => value === 0));
			assert.equal(clock.pending, 0);
		} finally { clock.dispose(); }
	});
}

test("same-reference output mutation updates the tail without rebuilding preview/time or resetting unchanged time", () => {
	const clock = new BashRenderClock();
	try {
		const f = createBashRenderFixture(clock);
		const counts = f.run(100, true);
		assert.equal(counts.preparedReplacements, 100);
		assert.equal(counts.lineReplacements, 100);
		assert.equal(counts.outputReplacements, 0);
		assert.equal(counts.timeReplacements, 0);
		assert.equal(counts.callRendererCalls, 0);
		assert.equal(f.bashMetrics.preparedOutputRecomputations, 100);
		assert.equal(f.bashMetrics.previewLineRecomputations, 100);
		assert.equal(f.bashMetrics.timeTextUpdates, 0);
		assert.match(f.component.render(120).join("\n"), /version:99/);
		f.dispose();
	} finally { clock.dispose(); }
});

test("expanded timer refresh preserves the output Text layout, not just its identity", () => {
	const clock = new BashRenderClock();
	try {
		const f = createBashRenderFixture(clock, true);
		const output = f.raw.resultRendererComponent.state.expandedOutputComponent;
		let sets = 0, layouts = 0;
		const setText = output.setText, render = output.render;
		output.setText = function (text: string) { sets++; return setText.call(this, text); };
		output.render = function (width: number) {
			if (!this.cachedLines || this.cachedText !== this.text || this.cachedWidth !== width) layouts++;
			return render.call(this, width);
		};
		f.run(100);
		assert.equal(sets, 0); assert.equal(layouts, 0);
		f.dispose();
	} finally { clock.dispose(); }
});

test("narrow result refresh respects dynamic custom calls and explicit args-only invalidation", () => {
	const clock = new BashRenderClock();
	try {
		const f = createBashRenderFixture(clock);
		let calls = 0;
		f.raw.toolDefinition = { renderCall() { calls++; return new Text(`dynamic-${calls}`, 0, 0); } };
		clock.tick(); clock.tick();
		assert.equal(calls, 2, "custom calls are dynamic by default");
		f.raw.toolDefinition.renderCallStability = "args-only";
		clock.tick();
		assert.equal(calls, 2);
		f.component.invalidate();
		assert.equal(calls, 3);
		clock.tick();
		assert.equal(calls, 3);
		f.dispose();
	} finally { clock.dispose(); }
});

test("truncation warning stays stable through timer refresh and updates/removes on dependency changes", () => {
	const clock = new BashRenderClock();
	try {
		const f = createBashRenderFixture(clock);
		f.result.details = { fullOutputPath: "fixture.log" };
		f.component.updateResult(f.result, true);
		const r = f.raw.resultRendererComponent, warning = r.warningComponent;
		f.run(100);
		assert.equal(r.warningComponent, warning);
		assert.equal(f.bashMetrics.warningComponentsCreated, 1);
		assert.equal(f.bashMetrics.warningTextUpdates, 0);
		f.result.details.fullOutputPath = "updated.log";
		f.component.updateResult(f.result, true);
		assert.equal(r.warningComponent, warning);
		assert.equal(f.bashMetrics.warningTextUpdates, 1);
		assert.match(f.component.render(120).join("\n"), /updated.log/);
		f.result.details = undefined;
		f.component.updateResult(f.result, true);
		assert.equal(r.warningComponent, undefined);
		assert.equal(r.warningText, undefined);
		f.dispose();
	} finally { clock.dispose(); }
});

test("width, theme, argument dirtiness and explicit invalidate survive interleaved result refresh", () => {
	const clock = new BashRenderClock();
	try {
		const f = createBashRenderFixture(clock);
		const r = f.raw.resultRendererComponent;
		const lines = r.state.cachedLines;
		f.component.render(60);
		assert.notEqual(r.state.cachedLines, lines);
		const before = f.metrics.callRendererCalls;
		f.raw.callRendererDirty = true; // represent an already pending invalidation, not a clean call
		f.getContext().refreshResult();
		assert.equal(f.metrics.callRendererCalls, before + 1);
		f.component.updateArgs({ command: "new command 中文" });
		clock.tick();
		assert.match(f.component.render(120).join("\n"), /new command 中文/);
		initTheme("light");
		f.component.invalidate();
		const calls = f.metrics.callRendererCalls;
		clock.tick();
		assert.equal(f.metrics.callRendererCalls, calls);
		assert.equal(f.raw.callRendererDirty, false);
		f.dispose();
	} finally { clock.dispose(); initTheme("dark"); }
});

for (const end of ["success", "failure", "abort"] as const) {
	test(`Bash ${end} freezes Took and rejects a queued timer after completion`, () => {
		const clock = new BashRenderClock();
		try {
			const f = createBashRenderFixture(clock);
			clock.tick();
			const late = clock.lastCallback!, owner = f.raw.rendererState.elapsedTimer;
			f.result.isError = end !== "success";
			f.result.content[0]!.text = end === "abort" ? "Command aborted" : end;
			f.component.updateResult(f.result, false, end !== "success");
			const final = f.component.render(120).join("\n");
			assert.match(final, /Took 1\.0s/);
			const calls = f.metrics.updateDisplayCalls;
			clock.time += 10_000;
			late();
			assert.equal(f.metrics.updateDisplayCalls, calls);
			assert.equal(f.component.render(120).join("\n"), final);
			assert.equal(clock.pending, 0);
			assert.deepEqual(owner.getReferenceCounts(), { handles: 0, states: 0, refreshReferences: 0 });
			owner.stop(); owner.stop();
			f.raw.resultRendererComponent[RELEASE_COMPONENT_RENDER_CACHE]();
			f.component[RELEASE_COMPONENT_RENDER_CACHE]();
			f.component.invalidate();
			assert.match(f.component.render(120).join("\n"), /Took 1\.0s/, "cache release preserves final duration");
			f.dispose();
		} finally { clock.dispose(); }
	});
}

test("fold/unfold, repeated release, remount and multiple owners do not retain stale state", () => {
	const clock = new BashRenderClock();
	try {
		const a = createBashRenderFixture(clock), b = createBashRenderFixture(clock);
		const r = a.raw.resultRendererComponent, preview = r.previewComponent;
		for (let i = 0; i < 5; i++) {
			a.component.setExpanded(true); a.component.render(120);
			a.component.setExpanded(false); a.component.render(120);
			assert.equal(r.previewComponent, preview);
			assert.equal(r.children.length, 2);
			assert.equal(r.state.expandedOutputComponent, undefined);
		}
		assert.equal(a.bashMetrics.expandedComponentsCreated, 5, "structural transitions counted separately");
		const late = clock.lastCallback!; // belongs to b
		const owner = b.raw.rendererState.elapsedTimer;
		b.raw.resultRendererComponent[RELEASE_COMPONENT_RENDER_CACHE]();
		b.component[RELEASE_COMPONENT_RENDER_CACHE]();
		b.component[RELEASE_COMPONENT_RENDER_CACHE]();
		assert.deepEqual(owner.getReferenceCounts(), { handles: 0, states: 0, refreshReferences: 0 });
		b.component.invalidate(); // same row, new render lifecycle
		const pending = clock.pending, calls = b.metrics.updateDisplayCalls;
		late();
		assert.equal(clock.pending, pending);
		assert.equal(b.metrics.updateDisplayCalls, calls);
		assert.notEqual(r.previewComponent, b.raw.resultRendererComponent.previewComponent);
		clock.tick();
		assert.match(b.component.render(120).join("\n"), /Elapsed 1\.0s/);
		for (const f of [a, b]) assert.ok(Object.values(f.dispose()).every(v => v === 0));
		assert.equal(clock.pending, 0);
		assert.deepEqual(preview.render(120), [], "externally retained old preview no longer reaches output state");
	} finally { clock.dispose(); }
});

test("older render contexts retain timer behavior through invalidate fallback", () => {
	const clock = new BashRenderClock();
	try {
		initTheme("dark");
		const definition = createBashToolDefinition(process.cwd());
		let calls = 0;
		const context: any = { args: {}, state: {}, executionStarted: true, isError: false, showImages: false, invalidate() { calls++; } };
		definition.renderResult!({ content: [], details: undefined }, { isPartial: true, expanded: false }, undefined as never, context);
		clock.tick();
		assert.equal(calls, 1);
		definition.renderResult!({ content: [], details: undefined }, { isPartial: false, expanded: false }, undefined as never, context);
		assert.equal(clock.pending, 0);
	} finally { clock.dispose(); }
});

test("Bash hot helpers and narrow refresh have no inline closures or Promise construction", () => {
	const targets = new Set(["snapshotBashResultContent", "bashResultContentMatches", "getPreparedBashOutput", "rebuildBashResultRenderComponent", "renderContextRefreshResult", "appendBashFailureLine"]);
	const seen = new Set<string>();
	for (const path of ["packages/coding-agent/src/core/tools/bash.ts", "packages/coding-agent/src/modes/interactive/components/tool-execution.ts"]) {
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		function audit(node: ts.Node): void {
			if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) assert.fail(`inline callback in ${node.getText(source).slice(0, 80)}`);
			if (ts.isNewExpression(node)) assert.notEqual(node.expression.getText(source), "Promise");
			ts.forEachChild(node, audit);
		}
		function visit(node: ts.Node): void {
			if (ts.isFunctionDeclaration(node) && node.name && targets.has(node.name.text)) { seen.add(node.name.text); audit(node.body!); }
			if (ts.isPropertyDeclaration(node) && targets.has(node.name.getText(source))) {
				seen.add(node.name.getText(source));
				assert.ok(node.initializer && ts.isArrowFunction(node.initializer));
				audit(node.initializer.body); // stable instance initializer is allocated only once
			}
			if (ts.isClassDeclaration(node) && (node.name?.text === "BashPreviewComponent" || node.name?.text === "BashElapsedTimer")) {
				for (const member of node.members) {
					if (ts.isMethodDeclaration(member) && member.body) audit(member.body);
					if (ts.isPropertyDeclaration(member) && member.initializer && ts.isArrowFunction(member.initializer)) audit(member.initializer.body);
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	assert.deepEqual(seen, targets);
});
