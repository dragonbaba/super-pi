import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import type { Terminal } from "../packages/tui/src/terminal.ts";
import type { Component } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../packages/tui/src/utils.ts";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require("@xterm/headless") as {
	Terminal: new (options: Record<string, unknown>) => {
		write(data: string, callback?: () => void): void;
		dispose(): void;
		buffer: { active: { length: number; getLine(index: number): { translateToString(trimRight: boolean): string } | undefined } };
	};
};

class HeadlessCaptureTerminal implements Terminal {
	columns: number;
	rows: number;
	readonly kittyProtocolActive = false;
	private readonly emulator: InstanceType<typeof HeadlessTerminal>;
	private pendingWrites = 0;
	private frameWriteCompletion: ((generation: number, error?: Error) => void) | undefined;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.emulator = new HeadlessTerminal({ columns, cols: columns, rows, scrollback: 10_000, allowProposedApi: true });
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.pendingWrites++;
		this.emulator.write(data, () => this.pendingWrites--);
	}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.frameWriteCompletion = listener;
	}
	writeFrame(data: string, generation: number): void {
		this.write(data);
		this.frameWriteCompletion?.(generation);
	}
	cancelFrameWrite(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	async flush(): Promise<void> {
		for (let attempt = 0; attempt < 1_000 && this.pendingWrites > 0; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		assert.equal(this.pendingWrites, 0, "headless terminal writes must drain");
	}

	logicalLines(): string[] {
		const result: string[] = [];
		const buffer = this.emulator.buffer.active;
		for (let index = 0; index < buffer.length; index++) result.push(buffer.getLine(index)?.translateToString(true) ?? "");
		while (result.length > 0 && result.at(-1) === "") result.pop();
		return result;
	}

	dispose(): void {
		this.emulator.dispose();
	}
}

class Item implements Component {
	private readonly id: string;
	constructor(id: string) { this.id = id; }
	render(width: number): string[] { return [`${this.id}:${width}`]; }
	invalidate(): void {}
}

function fullReference(transcript: RetainedContainer, width: number): string[] {
	const result: string[] = [];
	for (const child of transcript.children) {
		for (const line of child.render(width)) result.push(stripTerminalSequences(line).trimEnd());
	}
	return result;
}

test("fullscreen exit writes the complete retained transcript back to main scrollback", async () => {
	const transcript = new RetainedContainer();
	for (let index = 0; index < 250; index++) {
		transcript.addRetainedChild(new Item(`full-${index}`), { id: `full-${index}`, version: 1, completed: true });
	}
	const document = new ViewportContainer();
	document.addChild(transcript);
	const terminal = new HeadlessCaptureTerminal(80, 20);
	const alt = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	alt.setLayoutRoot(new ScrollView(document, { follow: "end", primary: true }));
	try {
		alt.start();
		alt.renderNow();
		await terminal.flush();
		alt.stop();
		await terminal.flush();
		assert.deepEqual(terminal.logicalLines(), fullReference(transcript, 80));
	} finally {
		terminal.dispose();
	}
});
