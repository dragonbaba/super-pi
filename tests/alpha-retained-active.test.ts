import assert from "node:assert/strict";
import test from "node:test";
import { RetainedContainer, RetainedItem } from "../packages/tui/src/components/retained-item.ts";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../packages/tui/src/component-cache.ts";

test("active range owns references when a component reuses its array", () => {
	const lines = ["a", "b", "c"];
	const item = new RetainedItem({ render: () => lines, invalidate() {} }, { id: "active", version: 0 });
	item.render(120);
	lines[1] = "changed";
	item.advanceVersion();
	item.render(120);
	assert.equal(item.activeRenderChangedStart, 1);
	assert.equal(item.activeRenderChangedEnd, 2);
	item.render(120);
	assert.equal(item.activeRenderChangedStart, 1, "same-version render preserves the change");
	lines[0] = "earlier";
	item.render(120);
	assert.equal(item.activeRenderChangedStart, 0);
	item.advanceVersion();
	item.render(120);
	assert.equal(item.activeRenderChangedStart, item.activeRenderChangedEnd);
	item.render(80);
	assert.equal(item.activeRenderChangedStart, undefined, "width changes cannot use an old range");
	item.release();
	assert.equal(item.activeSnapshotLineCount, 0);
});

test("active reference snapshots are capped and released at every cache boundary", () => {
	let lines = ["a"];
	const item = new RetainedItem({ render: () => lines, invalidate() {} }, { id: "active", version: 0 });
	for (const oversized of [Array(4097).fill("x"), ["x".repeat(512 * 1024 + 1)]]) {
		item.render(120);
		assert.equal(item.activeSnapshotLineCount, 1);
		lines = oversized;
		item.advanceVersion();
		item.render(120);
		assert.equal(item.activeSnapshotLineCount, 0);
		assert.equal(item.activeRenderChangedStart, undefined);
		lines = ["a"];
	}
	for (const release of [() => item.invalidate(), () => item[RELEASE_COMPONENT_RENDER_CACHE]()]) {
		item.render(120);
		assert.equal(item.activeSnapshotLineCount, 1);
		release();
		assert.equal(item.activeSnapshotLineCount, 0);
	}
	item.render(120);
	item.complete();
	assert.equal(item.activeSnapshotLineCount, 1, "bounded snapshot is owned until the normal final render");
	item.render(120);
	assert.equal(item.activeSnapshotLineCount, 0, "final completed cache replaces the active snapshot");
	assert.equal(item.cachedLineCount, 1);
	item.release();
	assert.equal(item.cachedLineCount, 0);
	for (const boundary of ['invalidate', 'release', 'cache'] as const) {
		const pending = new RetainedItem({ render: () => ['pending'], invalidate() {} }, { id: boundary, version: 0 });
		pending.render(120); pending.complete();
		if (boundary === 'cache') pending[RELEASE_COMPONENT_RENDER_CACHE](); else pending[boundary]();
		assert.equal(pending.activeSnapshotLineCount, 0, 'release does not require the final render to occur');
	}
});

test("coalesced versions retain exact changed bounds, stale observers stay conservative", () => {
	let lines = ["a", "b", "c"];
	const root = new RetainedContainer();
	const active = root.addRetainedChild({ render: () => lines, invalidate() {} }, { id: "active", version: 0 });
	const initial = root.observeViewportMutation(120).token;
	lines = ["a", "b", "updated"];
	for (let update = 0; update < 100_000; update++) active.advanceVersion();
	const current = root.observeViewportMutation(120, initial);
	assert.equal(current.kind, "range");
	assert.equal(current.earliestChangedLine, 2);
	assert.equal(current.latestChangedLine, 3);
	lines = ["a", "later", "updated"];
	active.advanceVersion();
	const latest = root.observeViewportMutation(120, current.token);
	assert.equal(latest.earliestChangedLine, 1);
	const stale = root.observeViewportMutation(120, initial);
	assert.equal(stale.earliestChangedLine, 0, "latest exact range cannot stand in for several generations");
	active.advanceVersion();
	assert.equal(root.observeViewportMutation(120, latest.token).kind, "none");
	const beforeIntermediateRender = root.observeViewportMutation(120).token;
	lines = ["early", "later", "updated"];
	active.advanceVersion();
	root.render(120);
	lines = ["early", "later", "last"];
	active.advanceVersion();
	assert.equal(root.observeViewportMutation(120, beforeIntermediateRender).earliestChangedLine, 0,
		"intermediate full renders must not erase an unobserved early-line change");
	const beforeDirectRender = root.observeViewportMutation(120).token;
	lines = ["earliest", "later", "last"];
	active.advanceVersion();
	active.render(120);
	lines = ["earliest", "later", "new last"];
	active.advanceVersion();
	assert.equal(root.observeViewportMutation(120, beforeDirectRender).earliestChangedLine, 0,
		"a direct retained render between versions conservatively invalidates exact attribution");
	root.clear();
	assert.equal(active.activeSnapshotLineCount, 0);
});
