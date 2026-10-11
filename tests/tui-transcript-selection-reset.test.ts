import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { RetainedContainer, ScrollView, Text, TuiAltScreen, TuiMainScreen } from "@super-pi/tui";
import ts from "typescript";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

function fixture() {
	const terminal = new FakeTerminal(40, 6);
	const chat = new RetainedContainer();
	const text = new Text("alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta", 0, 0);
	chat.addChild(text);
	const scroll = new ScrollView(chat, { primary: true, follow: "none", scrollbar: "hidden" });
	const ui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	ui.setLayoutRoot(scroll);
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		renderer: ui, ui, chatContainer: chat,
		loadedResourcesContainer: new RetainedContainer(), pendingMessagesContainer: new RetainedContainer(),
		pendingTools: new Map(), runtimeHost: { session: {
			sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
			settingsManager: { getShowTerminalProgress: () => false },
		} },
		renderProjectTrustWarningIfNeeded() {},
		renderSessionItems() { chat.addChild(new Text("omega\nnewB\nnewC\nnewD", 0, 0)); },
	});
	ui.start();
	ui.renderNow();
	const state = ui as any;
	function mouse(sequence: string): void { state.handleViewportInput(sequence); }
	function doubleClick(): void {
		mouse("\x1b[<0;1;1M");
		// Keep this independent of machine/CI scheduling delays.
		state.lastClick.timestamp = Date.now();
		mouse("\x1b[<0;1;1M");
		assert.equal(state.selectionGranularity, "word");
		ui.renderNow();
	}
	return { terminal, chat, text, scroll, ui, mode, state, mouse, doubleClick };
}

function assertSelectionReleased(ui: TuiAltScreen): void {
	const refs = ui.getAltInteractionRetainedReferenceCounts();
	for (const [key, value] of Object.entries(refs)) {
		if (key.startsWith("selection") || key === "lastClickReferences") assert.equal(value, 0, key);
	}
	const state = ui as any;
	assert.equal(state.selectionPressActive, false);
	assert.equal(state.selectionDragged, false);
	assert.equal(state.selectionGranularity, "character");
	assert.equal(state.selectionDragPointer, undefined);
	assert.equal(state.selectionAutoScrollDirection, 0);
	assert.equal(state.pressedUrl, undefined);
	assert.equal(ui.getAltCompositionRetainedReferenceCounts().selectionPointReferences, 0);
}

test("session replacement and transcript rebuild drop selection without changing the layout owner", async () => {
	for (const boundary of ["renderCurrentSessionState", "rebuildChatFromMessages", "renderInitialMessages"]) {
		const f = fixture();
		try {
			f.doubleClick();
			assert.ok(f.state.previousScreen.some((line: string) => line.includes("\x1b[7m")));
			if (boundary === "renderInitialMessages") f.chat.clear(); // tree navigation caller
			f.mode[boundary]();
			assertSelectionReleased(f.ui);
			assert.equal(f.state.layoutRoot, f.scroll);
			f.ui.renderNow();
			assert.ok(f.state.previousScreen.every((line: string) => !line.includes("\x1b[7m")));
			f.mouse("\x1b[<0;1;1M");
			assert.equal(f.state.lastClick.count, 1, "new transcript starts a fresh click sequence");
			assert.equal(f.state.selectionGranularity, "character");
		} finally { await f.ui.dispose({ preserveScreen: true }); }
	}
});

test("rebuild stops selection auto-scroll and ignores a late drag or release", async () => {
	const f = fixture();
	try {
		f.mouse("\x1b[<0;1;2M");
		f.mouse("\x1b[<32;4;6M");
		const timer = f.state.selectionAutoScrollTimer;
		assert.ok(timer);
		f.mode.rebuildChatFromMessages();
		assertSelectionReleased(f.ui);
		assert.equal(timer._destroyed, true);
		f.ui.renderNow();
		f.terminal.writes.length = 0;
		f.mouse("\x1b[<32;4;6M");
		f.mouse("\x1b[<0;4;6m");
		assertSelectionReleased(f.ui);
		assert.ok(f.terminal.writes.every(line => !line.includes("\x1b]52;")), "old release must not copy new text");
	} finally { await f.ui.dispose({ preserveScreen: true }); }
});

test("selection owners are released before a failed rebuild and collected while the TUI stays alive", async () => {
	const f = fixture();
	try {
		f.doubleClick();
		const weak = [f.state.selectionAnchor, f.state.selectionFocus, f.state.selectionInitialRange, f.state.lastClick]
			.map(owner => new WeakRef(owner));
		f.mode.renderSessionItems = () => { throw new Error("rebuild failed"); };
		assert.throws(() => f.mode.rebuildChatFromMessages(), /rebuild failed/);
		assertSelectionReleased(f.ui);
		f.ui.resetTextSelection(); // idempotent, also safe after an empty/failed rebuild
		assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
		for (let turn = 0; turn < 8; turn++) { await nextTurn(); globalThis.gc!(); }
		assert.ok(weak.every(owner => owner.deref() === undefined));
	} finally {
		await f.ui.dispose({ preserveScreen: true });
		assertSelectionReleased(f.ui);
		for (const count of Object.values(f.ui.getAltFinalUnmountRetainedReferenceCounts())) assert.equal(count, 0);
	}
});

test("ordinary assistant updates and append-only compaction keep the current selection", async () => {
	const f = fixture();
	try {
		f.doubleClick();
		const anchor = f.state.selectionAnchor, click = f.state.lastClick;
		Object.assign(f.mode, {
			isInitialized: true, footer: { invalidate() {} }, streamingItemVersion: 0,
			streamingComponent: { updateContent() { f.text.setText("alpha\nbeta\nnew streamed content"); } },
			clearStatusIndicator() {},
			clearToolResultDiscoveriesAfterCanonicalHistoryReplacement() {},
			addMessageToChat() { f.chat.addChild(new Text("compaction summary", 0, 0)); },
			flushCompactionQueue() {}, observeLifecyclePromise() {},
		});
		f.mode.handleEvent({ type: "message_update", message: { role: "assistant" }, changedToolUpdates: [] });
		f.mode.handleEvent({ type: "compaction_end", result: { summary: "summary", tokensBefore: 10 }, willRetry: false });
		f.ui.renderNow();
		assert.equal(f.state.selectionAnchor, anchor);
		assert.equal(f.state.lastClick, click);
		assert.ok(f.state.previousScreen.some((line: string) => line.includes("\x1b[7m")));
	} finally { await f.ui.dispose({ preserveScreen: true }); }
});

test("entry rebuilding remains compatible with the regular renderer and compaction entries", async () => {
	const ui = new TuiMainScreen(new FakeTerminal(), false);
	let calls = 0;
	const options = { updateFooter: true };
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		renderer: ui,
		renderSessionItems(items: unknown[], actualOptions: unknown) { calls++; assert.deepEqual(items, []); assert.equal(actualOptions, options); },
	});
	try { mode.renderSessionEntries([{ type: "compaction" }], options); assert.equal(calls, 1); }
	finally { await ui.dispose(); }
});

test("selection reset has no allocation sites and is called only at the entry rebuild boundary", () => {
	const path = "packages/tui/src/tui-alt-screen.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	let methods = 0;
	function inspect(node: ts.Node): void {
		if (ts.isMethodDeclaration(node) && ["resetTextSelection", "stopSelectionAutoScroll"].includes(node.name.getText(source))) {
			methods++;
			function visit(child: ts.Node): void {
				assert.ok(!ts.isArrowFunction(child) && !ts.isFunctionExpression(child) && !ts.isNewExpression(child)
					&& !ts.isArrayLiteralExpression(child) && !ts.isObjectLiteralExpression(child), child.getText(source));
				ts.forEachChild(child, visit);
			}
			visit(node);
		} else ts.forEachChild(node, inspect);
	}
	inspect(source);
	assert.equal(methods, 2);
	const modeSource = readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8");
	assert.equal(modeSource.match(/\.resetTextSelection\(/g)?.length, 1);
	assert.match(modeSource, /private renderSessionEntries\([\s\S]*?this\.renderer\.resetTextSelection\(\);[\s\S]*?const items:/);
});
