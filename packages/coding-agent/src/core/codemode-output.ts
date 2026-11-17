import type { ToolResultMessage } from "@super-pi/ai";
import { BoundedJson } from "@super-pi/codemode/bounded-json";
import { MAX_VALUE_CHARS } from "@super-pi/codemode/limits";
import { MAX_CODEMODE_RETAINED_CHARS, MAX_CODEMODE_RETAINED_RESULTS } from "./codemode-constants.ts";
import { MCP_SOURCE_BYTES, serializeMcpStructured, verifiedMcpSource, type McpTypedSource } from "./tool-result-source.ts";
import { capturedOutput, readCapturedOutput, type CapturedOutput } from "./tools/captured-output.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";
import { readShellExecution } from "./tools/shell-execution.ts";

export interface OutputReference { ref: string; format: "text" | "json"; complete: boolean | "unknown"; }
interface OutputRecord { source: CapturedOutput; reference: OutputReference; chars: number; }
const OUTPUT_CHUNK_CHARS = 16 * 1024;
const STRUCTURED_CAPTURE_OPTIONS = Object.freeze({ maxBytes: 1, maxLines: 1, maxSpillBytes: MCP_SOURCE_BYTES, captureData: true });

/** One live session branch owns bounded historical output, independent of staged store writes.
 * Only producer captures/verified structuredContent enter this map. No display-text inference.
 * Clear on branch restore/reload/disposal. Files retain the existing private temp lifetime.
 */
export class CodemodeOutputs {
	private readonly records = new Map<string, OutputRecord>();
	private readonly serializer = new BoundedJson();
	private chars = 0;
	private generation = 0;
	private closed = false;
	/** One disk/JSON buffer at a time, even when scripts request parallel data pages. */
	private reading: Promise<void> | undefined;

	clear(): void { this.generation++; this.records.clear(); this.chars = 0; }
	close(): void { this.closed = true; this.clear(); }

	async capture(result: ToolResultMessage, ref: string): Promise<{ outputs: OutputReference[]; structured: Map<McpTypedSource, string> }> {
		if (this.closed) throw new Error("[OUTPUT_EXPIRED] Output owner is disposed");
		const generation = this.generation;
		const outputs: OutputReference[] = [], structured = new Map<McpTypedSource, string>();
		const native = capturedOutput(result.content);
		if (native) outputs.push(this.keep(ref + ":output:0", native, "text", readShellExecution(result.details)?.output.complete ?? "unknown"));
		for (const block of result.content) {
			const source = (block as { mcpSource?: McpTypedSource }).mcpSource;
			if (source?.kind !== "structured") continue;
			const json = serializeMcpStructured(verifiedMcpSource(source).value);
			structured.set(source, json);
			let capture: CapturedOutput = { kind: "text", text: json };
			if (json.length > MAX_CODEMODE_RETAINED_CHARS) {
				const output = new OutputAccumulator(STRUCTURED_CAPTURE_OPTIONS);
				try {
					for (let offset = 0; offset < json.length;) {
						let end = Math.min(json.length, offset + OUTPUT_CHUNK_CHARS);
						const last = json.charCodeAt(end - 1);
						if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
						output.append(Buffer.from(json.slice(offset, end), "utf8")); offset = end;
					}
					output.finish(); await output.closeTempFile(); capture = output.capture();
				} catch (error) { await output.discardTempFile(); throw error; }
			}
			if (generation !== this.generation) throw new Error("[OUTPUT_EXPIRED] Output owner changed during capture");
			outputs.push(this.keep(`${ref}:output:${outputs.length}`, capture, "json", capture.kind !== "file" || !capture.capped));
		}
		return { outputs, structured };
	}

	private keep(ref: string, source: CapturedOutput, format: OutputReference["format"], complete: OutputReference["complete"]): OutputReference {
		const chars = source.kind === "text" ? source.text.length : 0;
		while (this.records.size && (this.records.size >= MAX_CODEMODE_RETAINED_RESULTS || this.chars + chars > MAX_CODEMODE_RETAINED_CHARS)) {
			const key = this.records.keys().next().value!;
			this.chars -= this.records.get(key)!.chars; this.records.delete(key);
		}
		const reference = { ref, format, complete: source.kind === "file" && source.capped ? false : complete };
		this.records.set(ref, { source, reference, chars }); this.chars += chars;
		return reference;
	}

	async read(ref: unknown, input: unknown, signal?: AbortSignal): Promise<object> {
		const generation = this.generation;
		while (this.reading) {
			await this.reading; signal?.throwIfAborted();
			if (generation !== this.generation) throw new Error("[OUTPUT_EXPIRED] Output owner changed while waiting");
		}
		// One deferred for this explicit data operation, never per output chunk/progress.
		let release!: () => void;
		this.reading = new Promise<void>(resolve => { release = resolve; });
		try { return await this.readInner(ref, input, signal); }
		finally { this.reading = undefined; release(); }
	}

	private async readInner(ref: unknown, input: unknown, signal?: AbortSignal): Promise<object> {
		if (typeof ref !== "string" || !this.records.has(ref)) throw new Error("[OUTPUT_EXPIRED] Unknown output reference; use the recorded Output path if available. Do not rerun completed tools.");
		if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new TypeError("readOutput options must be an object");
		const options = (input ?? {}) as { format?: string; path?: (string | number)[]; offset?: number; limit?: number };
		const record = this.records.get(ref)!, generation = this.generation;
		const format = options.format ?? record.reference.format;
		if (format !== "text" && format !== "json") throw new TypeError("readOutput format must be text or json");
		if (format === "json" && record.reference.complete !== true) throw new Error("[OUTPUT_INCOMPLETE] JSON requires a complete captured document; inspect execution facts and the saved output. Do not repeat completed commands.");
		if (options.path !== undefined && (!Array.isArray(options.path) || options.path.some(invalidPathKey))) throw new TypeError("readOutput path must contain object keys or nonnegative array indexes");
		for (const value of [options.offset, options.limit]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("readOutput offset/limit must be nonnegative safe integers");
		const text = await readCapturedOutput(record.source, signal);
		if (generation !== this.generation || this.records.get(ref) !== record) throw new Error("[OUTPUT_EXPIRED] Output owner changed during read");
		let value: unknown;
		try { value = format === "json" ? JSON.parse(text) : text; }
		catch { throw new Error("[OUTPUT_INVALID_JSON] The original complete output is not JSON. Execution status is unchanged; do not rerun completed commands."); }
		if (options.path) for (const key of options.path) {
			if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("[OUTPUT_PATH_MISSING] Requested field is absent in the captured data");
			value = (value as Record<string | number, unknown>)[key];
		}
		let nextOffset: number | null = null;
		if (options.offset !== undefined || options.limit !== undefined) {
			if (!Array.isArray(value) && typeof value !== "string") throw new TypeError("readOutput offset/limit requires an array or text field");
			const offset = options.offset ?? 0, end = Math.min(value.length, offset + (options.limit ?? value.length));
			nextOffset = end < value.length ? end : null; value = value.slice(offset, end);
		}
		try { return this.serializer.encode({ data: value, complete: record.reference.complete, nextOffset }, MAX_VALUE_CHARS); }
		catch (error) {
			if (!(error instanceof RangeError)) throw error;
			throw new Error("[OUTPUT_SELECTION_TOO_LARGE] Select a smaller path or offset/limit page within the existing CodeMode bridge budget. Do not rerun completed tools.");
		}
	}
}

function invalidPathKey(key: unknown): boolean { return typeof key !== "string" && !(Number.isSafeInteger(key) && (key as number) >= 0); }
