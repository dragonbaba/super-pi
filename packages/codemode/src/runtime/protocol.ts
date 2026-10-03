import type { CodemodeOutputItem } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";
import { MAX_ARGUMENT_CHARS, MAX_BRIDGE_CHARS, MAX_CALLS, MAX_ERROR_CHARS, MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS, MAX_VALUE_CHARS } from "../limits.ts";

/**
 * Messages between the host (main thread) and the worker. Tool arguments,
 * results, and values cross as JSON strings: the worker passes them into and
 * out of the QuickJS VM as strings and never builds structured values itself.
 */

export interface WorkerData {
	code: string;
	/** `jsName` is the identifier the script uses; `description` is listed in `ALL_TOOLS`. */
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	/** Compiled `quickjs-wasi` module. Structured clone shares the compiled code with the worker. */
	wasm: CodemodeWasmModule;
	memoryLimitBytes: number | undefined;
	/** Snapshot for `load()`: key to JSON text. */
	store: Record<string, string>;
	/**
	 * One Int32 the host sets to non-zero before terminating the worker. The VM's interrupt handler
	 * polls it, because Bun's `worker.terminate()` cannot stop a thread that is spinning in wasm.
	 */
	interrupt: SharedArrayBuffer;
}

/** JSON-encoded `{ name?, message, stack? }` of an error thrown by the script. */
export type ScriptErrorJson = string;

export type WorkerToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string | undefined }
	| { type: "output"; item: CodemodeOutputItem }
	/** `writes` is a JSON array of `[key, json]` for `store()` and `[key]` for deletions. */
	| { type: "done"; ok: true; value: string | undefined; writes: string }
	| { type: "done"; ok: false; error: ScriptErrorJson }
	/** The VM failed outside the script's control, for example a wasm trap. */
	| { type: "crash"; message: string };

export type HostToWorkerMessage =
	/** `payload` is the JSON result when `ok`, otherwise the error message. */
	{ type: "result"; id: number; ok: boolean; payload: string | undefined };

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	switch (message.type) {
		case "call": return Number.isSafeInteger(message.id) && (message.id as number) > 0 &&
			(message.target === "tool" || message.target === "global") && typeof message.name === "string" &&
			(message.args === undefined || typeof message.args === "string");
		case "output": {
			const item = message.item as Record<string, unknown> | undefined;
			return typeof item === "object" && item !== null && (item.type === "text" ? typeof item.text === "string" :
				item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string");
		}
		case "done": return message.ok === true ? typeof message.writes === "string" &&
			(message.value === undefined || typeof message.value === "string") : message.ok === false && typeof message.error === "string";
		case "crash": return typeof message.message === "string";
		default: return false;
	}
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return message.type === "result" && Number.isSafeInteger(message.id) && typeof message.ok === "boolean" &&
		(message.payload === undefined || typeof message.payload === "string" && message.payload.length <= MAX_VALUE_CHARS);
}

/** The worker checks before postMessage; the host independently checks before retention. */
export class BridgeBudget {
	private chars = 0;
	private outputs = 0;
	private outputChars = 0;
	private calls = 0;
	private done = false;
	consume(message: WorkerToHostMessage): boolean {
		if (this.done) return false;
		let chars = 0;
		switch (message.type) {
			case "call":
				if (++this.calls > MAX_CALLS || message.id !== this.calls || message.name.length > 1024) return false;
				chars = (message.args?.length ?? 0) + message.name.length;
				if (chars > MAX_ARGUMENT_CHARS) return false;
				break;
			case "output":
				chars = message.item.type === "text" ? message.item.text.length : message.item.data.length + message.item.mimeType.length;
				if (++this.outputs > MAX_OUTPUT_ITEMS || chars > MAX_OUTPUT_CHARS - this.outputChars) return false;
				this.outputChars += chars;
				break;
			case "done":
				this.done = true;
				if (message.ok) {
					if ((message.value?.length ?? 0) > MAX_VALUE_CHARS) return false;
					chars = (message.value?.length ?? 0) + message.writes.length;
				} else {
					chars = message.error.length;
					if (chars > MAX_ERROR_CHARS * 4) return false;
				}
				break;
			case "crash": this.done = true; chars = message.message.length; break;
		}
		this.chars += chars;
		return this.chars <= MAX_BRIDGE_CHARS;
	}
}
