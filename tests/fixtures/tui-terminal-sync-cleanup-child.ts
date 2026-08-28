import { EventEmitter } from "node:events";
import { ProcessTerminal } from "../../packages/tui/src/terminal.ts";

class ControlledOutput extends EventEmitter {
	readonly callbacks: Array<(error?: Error | null) => void> = [];
	readonly data: string[] = [];
	callCount = 0;
	throwAt = Number.POSITIVE_INFINITY;

	write(data: string, callback: (error?: Error | null) => void): boolean {
		this.callCount++;
		this.data.push(data);
		if (this.callCount === this.throwAt) throw new Error(`sync-control-${this.callCount}`);
		this.callbacks.push(callback);
		return true;
	}
}

const scenario = process.argv[2] ?? "start-first";
const output = new ControlledOutput();
const terminal = new ProcessTerminal(output as never);
const stdin = process.stdin as typeof process.stdin & { setRawMode?: (enabled: boolean) => void; isRaw?: boolean };
const originalSetRawMode = stdin.setRawMode;
const rawModes: boolean[] = [];
Object.defineProperty(stdin, "setRawMode", {
	configurable: true,
	value: (enabled: boolean): void => {
		rawModes.push(enabled);
	},
});
const baselineDataListeners = stdin.listenerCount("data");
const baselineResizeListeners = process.stdout.listenerCount("resize");
let thrown = "";

try {
	if (scenario === "start-first" || scenario === "start-middle") {
		output.throwAt = scenario === "start-first" ? 1 : 2;
		try {
			terminal.start(() => {}, () => {});
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		}
	} else {
		terminal.start(() => {}, () => {});
		for (const callback of output.callbacks.splice(0)) callback();
		if (scenario === "progress-clear") {
			terminal.setProgress(true);
			output.callbacks.splice(0)[0]?.();
		}
		const state = terminal as unknown as {
			keyboardProtocolPushed: boolean;
			_modifyOtherKeysActive: boolean;
		};
		state.keyboardProtocolPushed = true;
		state._modifyOtherKeysActive = true;
		output.throwAt = output.callCount + (scenario === "stop-middle" ? 2 : 1);
		try {
			if (scenario === "dispose-stop") terminal.dispose();
			else terminal.stop();
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		}
	}

	const state = terminal as unknown as {
		started: boolean;
		disposed: boolean;
		stdinBuffer?: unknown;
		stdinDataHandler?: unknown;
		inputHandler?: unknown;
		resizeHandler?: unknown;
		progressInterval?: unknown;
	};
	process.stdout.write(`${JSON.stringify({
		scenario,
		thrown,
		started: state.started,
		disposed: state.disposed,
		stdinBufferCleared: state.stdinBuffer === undefined,
		stdinDataHandlerCleared: state.stdinDataHandler === undefined,
		inputHandlerCleared: state.inputHandler === undefined,
		resizeHandlerCleared: state.resizeHandler === undefined,
		progressTimerCleared: state.progressInterval === undefined,
		dataListeners: stdin.listenerCount("data") - baselineDataListeners,
		resizeListeners: process.stdout.listenerCount("resize") - baselineResizeListeners,
		rawModes,
		controls: output.data,
	})}\n`);
} finally {
	if (originalSetRawMode) {
		Object.defineProperty(stdin, "setRawMode", { configurable: true, value: originalSetRawMode });
	} else {
		Reflect.deleteProperty(stdin, "setRawMode");
	}
}
