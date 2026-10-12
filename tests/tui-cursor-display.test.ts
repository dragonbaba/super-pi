import assert from "node:assert/strict";
import test from "node:test";
import { Editor, type EditorTheme } from "../packages/tui/src/components/editor.ts";
import { Input } from "../packages/tui/src/components/input.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { CURSOR_MARKER, renderFakeCursor } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "../packages/tui/src/utils.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

function identity(value: string): string { return value; }
const theme: EditorTheme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	for (const kind of ["Input", "Editor"]) {
		test(`${Renderer.name} ${kind}: hardware toggle preserves text, columns and IME without a second cursor`, async () => {
			const terminal = new FakeTerminal(14, 8);
			const tui = new Renderer(terminal, false);
			const input = kind === "Input" ? new Input() : new Editor(tui, theme, { paddingX: 1 });
			tui.addChild(input);
			tui.setFocus(input);
			try {
				tui.start();
				for (const text of ["", "中e\u0301🙂xyz", "0123456789abcdefghijkl"]) {
					if (input instanceof Input) input.setValue(text);
					else input.setText(text);
					input.handleInput("\x01");
					if (text) { input.handleInput("\x1b[C"); input.handleInput("\x1b[C"); }
					for (const position of ["middle", "end"]) {
						if (position === "end") input.handleInput("\x05");
						const raw = input.render(terminal.columns);
						const row = raw.findIndex(line => line.includes(CURSOR_MARKER));
						assert.ok(row >= 0);
						const col = visibleWidth(raw[row]!.slice(0, raw[row]!.indexOf(CURSOR_MARKER)));
						for (const enabled of [true, false]) {
							terminal.writes.length = 0;
							tui.setShowHardwareCursor(enabled);
							tui.renderNow();
							const writes = terminal.writes.join("");
							assert.equal(writes.includes("\x1b[7m"), !enabled, JSON.stringify({ text, position, enabled, writes }));
							assert.ok(writes.includes(enabled ? "\x1b[?25h" : "\x1b[?25l"));
							assert.ok(writes.includes(tui instanceof TuiMainScreen ? `\x1b[${col + 1}G` : `\x1b[${row + 1};${col + 1}H`), JSON.stringify({ row, col, writes }));
							assert.ok(!writes.includes("\x1b_pi:"), "internal cursor markers must not reach the terminal");
							assert.deepEqual(input.render(terminal.columns).map(stripTerminalSequences), raw.map(stripTerminalSequences));
						}
					}
				}
				tui.setShowHardwareCursor(true);
				tui.setFocus(null);
				terminal.writes.length = 0;
				tui.renderNow(true);
				assert.ok(terminal.writes.join("").includes("\x1b[7m"), "unfocused fake cursors remain visible");
				assert.ok(!terminal.writes.join("").includes("\x1b[?25h"));
			} finally { await tui.dispose({ preserveScreen: true }); }
		});
	}

	test(`${Renderer.name}: nested overlay input uses current policy without mutating its cached lines`, async () => {
		const terminal = new FakeTerminal(20, 8);
		const tui = new Renderer(terminal, false);
		const input = new Input();
		input.setValue("abc");
		let cached: string[] | undefined;
		const overlay = {
			get focused(): boolean { return input.focused; },
			set focused(value: boolean) { input.focused = value; cached = undefined; },
			render(width: number): string[] { return cached ??= Object.freeze(input.render(width)) as unknown as string[]; },
			invalidate() {},
		};
		const background = { render: () => ["background"], invalidate() {} };
		tui.addChild(background);
		tui.setFocus(background);
		try {
			tui.showOverlay(overlay, { row: 1, col: 3, width: 12 });
			tui.start();
			for (const enabled of [false, true, false]) {
				terminal.writes.length = 0;
				tui.setShowHardwareCursor(enabled);
				tui.renderNow();
				const writes = terminal.writes.join("");
				assert.equal(writes.includes("\x1b[7m"), !enabled);
				assert.ok(writes.includes(tui instanceof TuiMainScreen ? "\x1b[6G" : "\x1b[2;6H"), JSON.stringify(writes));
				assert.ok(cached?.[0]?.includes(CURSOR_MARKER));
				assert.ok(!writes.includes("\x1b_pi:"));
			}
			tui.hideOverlay();
			assert.equal(input.focused, false);
			assert.equal(tui.getFocusedComponent(), background);
		} finally { await tui.dispose({ preserveScreen: true }); }
	});

	test(`${Renderer.name}: an overlay ending left of the cursor preserves its IME position`, async () => {
		const terminal = new FakeTerminal(20, 4);
		const tui = new Renderer(terminal, true);
		const lines = Object.freeze([`abc${CURSOR_MARKER}${renderFakeCursor("中")}def`]) as unknown as string[];
		tui.addChild({ render: () => lines, invalidate() {} });
		try {
			tui.showOverlay({ render: () => ["XXX"], invalidate() {} }, { row: 0, col: 0, width: 3, nonCapturing: true });
			tui.start(); tui.renderNow();
			const writes = terminal.writes.join("");
			assert.ok(writes.includes("XXX"));
			assert.ok(writes.includes("中def"));
			assert.ok(writes.includes("\x1b[?25h"));
			assert.ok(writes.includes(tui instanceof TuiMainScreen ? "\x1b[4G" : "\x1b[1;4H"), JSON.stringify(writes));
			assert.ok(!writes.includes("\x1b[7m"));
		} finally { await tui.dispose({ preserveScreen: true }); }
	});

	test(`${Renderer.name}: clipped cursor markers do not remove ordinary inverse video`, async () => {
		const terminal = new FakeTerminal(20, 4);
		const tui = new Renderer(terminal, true);
		const clipped = sliceByColumn(`ab${CURSOR_MARKER}${renderFakeCursor("c")}def`, 0, 3, true);
		const lines = Object.freeze(["\x1b[7mselected\x1b[27m", clipped]) as unknown as string[];
		tui.addChild({ render: () => lines, invalidate() {} });
		try {
			tui.start(); tui.renderNow();
			const writes = terminal.writes.join("");
			assert.ok(writes.includes("\x1b[7mselected\x1b[27m"));
			assert.ok(!writes.includes("\x1b[7mc"));
			assert.ok(!writes.includes("\x1b_pi:"));
			assert.ok(writes.includes("\x1b[?25h"));
		} finally { await tui.dispose({ preserveScreen: true }); }
	});
}

test("Main bounded viewport resolves cached cursors after changing hardware visibility", async () => {
	const terminal = new FakeTerminal(20, 4);
	const tui = new TuiMainScreen(terminal, false);
	const metrics = new TuiRenderInstrumentation();
	const document = new ViewportContainer();
	const lines = Object.freeze(["history", "history", "history", "history", `ab${CURSOR_MARKER}${renderFakeCursor("c")}`]) as unknown as string[];
	for (const line of lines) {
		const childLines = Object.freeze([line]) as unknown as string[];
		document.addChild({ render: () => childLines, invalidate() {} });
	}
	tui.addChild(document); tui.setRenderInstrumentation(metrics);
	try {
		tui.start(); tui.renderNow();
		metrics.reset(); terminal.writes.length = 0;
		tui.setShowHardwareCursor(true); tui.renderNow();
		assert.equal(metrics.snapshot().fullHistoryFallbacks, 0);
		assert.equal(tui.captureRenderState().viewportWindowStart, 1);
		assert.ok(!terminal.writes.join("").includes("\x1b[7m"));
		assert.ok(terminal.writes.join("").includes("\x1b[3G\x1b[?25h"), JSON.stringify(terminal.writes));
		assert.ok(lines[4]!.includes(CURSOR_MARKER));
	} finally { await tui.dispose({ preserveScreen: true }); }
});

test("Alt resolves fake cursors before selection and before normal-stop document replay", async () => {
	const terminal = new FakeTerminal(20, 4);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const input = new Input(); input.setValue("abcd");
	tui.addChild(input); tui.setFocus(input);
	const selection = tui as unknown as {
		selectionAnchor?: { row: number; col: number };
		selectionFocus?: { row: number; col: number; boundary: boolean };
	};
	try {
		tui.start(); tui.renderNow();
		selection.selectionAnchor = { row: 0, col: 2 };
		selection.selectionFocus = { row: 0, col: 6, boundary: true };
		terminal.writes.length = 0; tui.renderNow(true);
		assert.ok(terminal.writes.join("").includes("\x1b[27m\x1b[7mbcd"), "selection stays inverse after the fake cursor");
		tui.setShowHardwareCursor(true);
		for (const [start, end] of [[0, 1], [2, 6], [4, 6]]) {
			selection.selectionAnchor = { row: 0, col: start! };
			selection.selectionFocus = { row: 0, col: end!, boundary: true };
			terminal.writes.length = 0; tui.renderNow(true);
			const selected = terminal.writes.join("");
			assert.ok(selected.includes("\x1b[1;3H\x1b[?25h"));
			assert.ok(!selected.includes("\x1b_pi:"), "selection must not replay positional markers as styles");
		}
		terminal.writes.length = 0;
		await tui.stop();
		const writes = terminal.writes.join("");
		assert.ok(writes.includes("abcd"));
		assert.ok(!writes.includes("\x1b_pi:"), JSON.stringify(writes));
		assert.deepEqual(tui.getAltCompositionRetainedReferenceCounts(), { overlayLineReferences: 0, selectionPointReferences: 0 });
	} finally { await tui.dispose({ preserveScreen: true }); }
});
