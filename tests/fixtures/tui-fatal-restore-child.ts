import { TuiAltScreen, type Terminal } from "../../packages/tui/src/index.ts";

class FatalRestoreTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	frameWrites = 0;
	frameAborts = 0;
	readonly evidence: string[] = [];
	private frameWriteCompletion: ((generation: number, error?: Error) => void) | undefined;

	start(): void { this.evidence.push("raw-mode:on", "keyboard:on"); }
	stop(): void { this.evidence.push("keyboard:restore", "raw-mode:restore"); }
	async drainInput(): Promise<void> {}
	write(data: string): void { this.evidence.push(`control:${JSON.stringify(data)}`); }
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.frameWriteCompletion = listener;
	}
	writeFrame(_data: string, _generation: number): void {
		this.frameWrites++;
	}
	cancelFrameWrite(): void { this.frameAborts++; }
	moveBy(): void {}
	hideCursor(): void { this.evidence.push("cursor:hide"); }
	showCursor(): void { this.evidence.push("cursor:show"); }
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

const terminal = new FatalRestoreTerminal();
const tui = new TuiAltScreen(terminal, false, undefined, {
	mouse: true,
	terminalBoundaryTimeoutMs: 20,
});
tui.addChild({ render: () => ["fatal-frame"], invalidate: () => {} });
tui.start();
tui.renderNow();
await tui.stop({ preserveScreen: true });
tui.renderNow();

process.stdout.write(`${JSON.stringify({
	frameWrites: terminal.frameWrites,
	frameAborts: terminal.frameAborts,
	evidence: terminal.evidence,
})}\n`);
process.exitCode = 1;
