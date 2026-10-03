import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolExecutionContext, AgentToolResult } from "@super-pi/agent-core";
import type { Message, ToolResultMessage, TextContent, ImageContent } from "@super-pi/ai";
import type { CodemodeSandbox, CodemodeTool, CodemodeResult, CodemodeStoreWrites } from "@super-pi/codemode";
import { assignCodemodeIdentifiers, renderToolSignature } from "@super-pi/codemode/declarations";
import { parseCodemodeSource } from "@super-pi/codemode/source";
import { BoundedJson } from "@super-pi/codemode/bounded-json";
import type { ToolDefinition, CodemodeReadEvent } from "./extensions/types.ts";
import { CODEMODE_DESCRIPTION, CODEMODE_NAME, CODEMODE_PARAMETERS, CODEMODE_SAMPLING,
	MAX_CODEMODE_DESCRIPTION_CHARS, MAX_CODEMODE_RETAINED_CHARS } from "./codemode-constants.ts";
import { CODEMODE_MUTATION_NAMES } from "./codemode-constants.ts";
import { CodemodeStore } from "./codemode-store.ts";
import { boundCodemodeResult, capCodemodeOutput, codemodeContentChars, codemodeImageChars } from "./codemode-result.ts";
import { MUTATION_READ_SOURCE } from "./tools/read-window.ts";
import { readShellExecution } from "./tools/shell-execution.ts";
import { codemodeInputSummary, codemodeOutputDigests, codemodeTextDigest, CODEMODE_DISPLAY_PREVIEW_CHARS, type CodemodeChildDisplay } from "./codemode-display.ts";

interface ChildRecord { result: ToolResultMessage; input: Record<string, unknown>; chars: number; imageChars: number; }
/** Durable mutation outcome; `observationError` is kept outside the receipt-bearing result. */
interface CodemodeResultEntry { version: 1; parentToolCallId: string; result: ToolResultMessage; observationError?: string; }
type ChildFact = CodemodeChildDisplay;
interface Invocation {
	context: AgentToolExecutionContext;
	signal?: AbortSignal;
	prefix: string;
	issued: number;
	started: number;
	records: Map<string, ChildRecord>;
	retainedChars: number;
	retainedImageChars: number;
	shownChars: number;
	shownImageChars: number;
	shown: (TextContent | ImageContent)[];
	reads: CodemodeReadEvent[];
	facts: ChildFact[];
	failed: boolean;
	pending: number;
	resolveIdle: (() => void) | undefined;
}
const EMPTY_TOOLS: readonly AgentTool<any>[] = Object.freeze([]);
const MAX_SHOWN_READS = 64;
/** Codemode calls in one assistant batch whose shown reads await the shared projection. */
const MAX_PENDING_READ_PARENTS = 16;
const MAX_SHOWN_CHARS = 256 * 1024;
/** Images are budgeted apart from text: a native screenshot may be several MiB and is shown whole. */
const MAX_RETAINED_IMAGE_CHARS = 16 * 1024 * 1024;
const MAX_SHOWN_IMAGE_CHARS = 16 * 1024 * 1024;
/** Image data handed to the script per result; larger images stay host-side behind show(ref). */
const MAX_SCRIPT_IMAGE_CHARS = 256 * 1024;
const TOOL_SIGNATURE_OPTIONS = Object.freeze({ inputMaxChars: 2048 });
const DEFERRED_DECLARATIONS = "\nMCP declarations are deferred. Filter ALL_TOOLS and use await describeTools([names]) for their current schemas.\n";

function nestedAllowed(tool: AgentTool<any>): boolean {
	return !tool.orchestration && !tool.modelOnly && !tool.interactionBoundary;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "Codemode execution failed"; }
function preview(result: ToolResultMessage): string {
	for (const block of result.content) if (block.type === "text") return block.text.slice(0, 512);
	return "";
}
function descriptorName(tool: CodemodeTool): string { return tool.name; }
/** Script copy of a result with large images: their data stays host-side and is attached whole by show(ref). */
function scriptContent(content: readonly (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	const copy: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		copy.push(block.type === "image"
			? { type: "text", text: `[image ${block.mimeType} (${block.data.length} base64 chars) held by the host; attach it with await show(result.ref)]` }
			: block);
	}
	return copy;
}
function compareChildSequence(a: ChildFact, b: ChildFact): number { return (a.sequence ?? 0) - (b.sequence ?? 0); }
/** The read survived only if its exact blocks occupy their own positions; equal text elsewhere is not this read. */
function readSurvived(read: CodemodeReadEvent, visible: readonly (TextContent | ImageContent)[]): boolean {
	const start = read.parentContentIndex, count = read.content.length;
	if (count === 0 || start < 0 || start + count > visible.length) return false;
	for (let offset = 0; offset < count; offset++) {
		const block = read.content[offset]!, shown = visible[start + offset]!;
		if (block.type !== "text" || shown.type !== "text" || block.text !== shown.text) return false;
	}
	return true;
}
/** Tool call IDs should be unique; a repeated ID in the same batch is matched once, at its newest result. */
function hasNewerResult(messages: readonly Message[], index: number, end: number, toolCallId: string): boolean {
	for (let later = index + 1; later <= end; later++) {
		const message = messages[later]!;
		if (message.role === "toolResult" && message.toolCallId === toolCallId) return true;
	}
	return false;
}

/** Session owner. Runtime is imported only at first execution; no VM on the startup path. */
export class CodemodeController {
	readonly definition: ToolDefinition;
	private tools: readonly AgentTool<any>[] = EMPTY_TOOLS;
	private descriptors: CodemodeTool[] = [];
	/** Same mapping the sandbox derives from the registered names; see assignCodemodeIdentifiers. */
	private identifiers = new Map<string, string>();
	private sandbox: CodemodeSandbox | undefined;
	private current: Invocation | undefined;
	private readonly store = new CodemodeStore();
	private readonly serializer = new BoundedJson();
	private readonly displayedReads = new Map<string, CodemodeReadEvent[]>();
	private visibleReads: CodemodeReadEvent[] = [];
	/** A projection closed the batch whose reads are in displayedReads; the next script starts a new batch. */
	private readsProjected = false;
	private pendingStore: { id: string; writes: CodemodeStoreWrites } | undefined;
	private restoreError: string | undefined;
	private closed = false;
	private readonly saveStore: (values: Readonly<Record<string, unknown>>) => void;
	private readonly saveCall: ((entry: unknown) => void) | undefined;
	private readonly saveResult: ((entry: unknown) => void) | undefined;

	constructor(saveStore: (values: Readonly<Record<string, unknown>>) => void, saveCall?: (entry: unknown) => void, saveResult?: (entry: unknown) => void) {
		this.saveStore = saveStore;
		this.saveCall = saveCall;
		this.saveResult = saveResult;
		this.definition = { name: CODEMODE_NAME, label: "Codemode", description: CODEMODE_DESCRIPTION,
			promptSnippet: "Run JavaScript to call ordinary tools via tools.NAME(args) or callTool(name,args)",
			promptGuidelines: ["Call ordinary tools only inside codemode scripts; ask_user and other declared control tools are called directly. Use await show(result.ref) to display a native read for guarded edits in a later completed turn."],
			parameters: CODEMODE_PARAMETERS, constrainedSampling: CODEMODE_SAMPLING, orchestration: true, executionMode: "sequential",
			prepareArguments: args => typeof args === "string" ? { code: args } : args as { code: string },
			execute: (_id, args, signal, _update, _ctx, context) => this.execute((args as { code: string }).code, context, signal) };
	}
	recordInvocation(parent: string | undefined, id: string, name: string, args: unknown): void {
		if (!parent || parent !== this.current?.context.parentToolCallId || !CODEMODE_MUTATION_NAMES.has(name)) return;
		const json = this.serializer.stringify(args, 256 * 1024);
		if (!json) throw new Error("Nested mutation arguments cannot be persisted");
		this.saveCall?.({ version: 1, parentToolCallId: parent, call: { type: "toolCall", id, name, arguments: JSON.parse(json) } });
	}

	setTools(tools: readonly AgentTool<any>[]): void {
		if (this.tools === tools) return;
		this.tools = tools;
		const descriptors: CodemodeTool[] = [];
		let description = CODEMODE_DESCRIPTION + DEFERRED_DECLARATIONS + "\nCurrent local tool declarations (each result is {content,details,isError,ref}):\n";
		let omitted = 0;
		for (const tool of tools) {
			if (!nestedAllowed(tool)) continue;
			const name = tool.name;
			descriptors.push({ name, description: tool.description.slice(0, 1024), inputSchema: tool.parameters as never,
				execute: args => this.invoke(name, args) });
		}
		const identifiers = assignCodemodeIdentifiers(descriptors.map(descriptorName));
		for (const descriptor of descriptors) {
			if (descriptor.name.startsWith("mcp__")) continue;
			if (description.length >= MAX_CODEMODE_DESCRIPTION_CHARS - 256) { omitted++; continue; }
			const signature = renderToolSignature(descriptor, { ...TOOL_SIGNATURE_OPTIONS, identifier: identifiers.get(descriptor.name) });
			if (description.length + signature.length + 1 < MAX_CODEMODE_DESCRIPTION_CHARS - 256) description += signature + "\n";
			else omitted++;
		}
		if (omitted) description += `\n${omitted} local declarations omitted by the inline budget. Filter ALL_TOOLS for names; await describeTools([names]) for schemas.\n`;
		if (this.sandbox) {
			for (const previous of this.descriptors) this.sandbox.unregisterTool(previous.name);
			for (const descriptor of descriptors) this.sandbox.registerTool(descriptor);
		}
		this.descriptors = descriptors;
		this.identifiers = identifiers;
		this.definition.description = description;
	}

	restoreStore(value?: unknown): void { this.pendingStore = undefined; this.store.restore(value); this.restoreError = undefined; this.clearReadEvidence(); }
	failStoreRestore(error: unknown): void {
		this.pendingStore = undefined;
		this.store.reset();
		this.clearReadEvidence();
		this.restoreError = message(error).slice(0, 512);
	}
	finalizeStore(id: string, failed: boolean): void {
		const pending = this.pendingStore;
		if (pending?.id !== id) return;
		this.pendingStore = undefined;
		if (failed || this.closed) return;
		const previous = this.store.snapshot;
		if (this.store.apply(pending.writes)) {
			try { this.saveStore(this.store.snapshot); }
			catch (error) { this.store.restore(previous); throw error; }
		}
	}
	/** Completion hook boundary: never leave an OK summary after store/observer failure. */
	observationFailed(result: AgentToolResult<any>, error: unknown): AgentToolResult<any> {
		const content: (TextContent | ImageContent)[] = [];
		const display = result.details?.codemode;
		let digest = display?.summaryDigest;
		for (const block of result.content) {
			if (block.type === "text" && block.text.startsWith("[CODEMODE_OK]") && codemodeTextDigest(block.text) === digest) {
				const text = "[CODEMODE_FAILED]" + block.text.slice("[CODEMODE_OK]".length);
				digest = codemodeTextDigest(text);
				content.push({ type: "text", text });
			} else content.push(block);
		}
		content.push({ type: "text", text: `[CODEMODE_OBSERVATION_FAILED] ${message(error).slice(0, 1000)}. Completed side effects are not rolled back; do not repeat mutations.` });
		return { ...result, content, isError: true, details: display ? { ...result.details, codemode: { ...display, summaryDigest: digest } } : result.details };
	}
	clearReadEvidence(): void { this.displayedReads.clear(); this.visibleReads.length = 0; this.readsProjected = false; }
	discardVisibleReads(): void { this.visibleReads.length = 0; }

	/** Called only on the actual model projection, never previews; exact native blocks must survive. */
	recordProjection(messages: readonly Message[]): void {
		this.visibleReads.length = 0;
		this.readsProjected = true;
		if (this.displayedReads.size === 0) return;
		// Pending reads belong to the latest tool batch: its contiguous results. Never search
		// an older batch to compensate for truncation of the current one.
		let end = messages.length - 1;
		while (end >= 0 && messages[end]!.role !== "toolResult") end--;
		for (let index = end; index >= 0; index--) {
			const result = messages[index]!;
			if (result.role !== "toolResult") break;
			if (result.toolName !== CODEMODE_NAME) continue;
			const reads = this.displayedReads.get(result.toolCallId);
			if (!reads || hasNewerResult(messages, index, end, result.toolCallId)) continue;
			for (const read of reads) {
				if (this.visibleReads.length >= MAX_SHOWN_READS) return;
				if (readSurvived(read, result.content)) this.visibleReads.push(read);
			}
		}
	}
	async admitVisibleReads(emit: (event: CodemodeReadEvent) => Promise<void>): Promise<void> {
		if (this.visibleReads.length === 0) return;
		const reads = this.visibleReads;
		this.visibleReads = [];
		this.displayedReads.clear();
		for (const read of reads) await emit(read);
	}

	private requireInvocation(): Invocation {
		if (!this.current || this.current.signal?.aborted) throw new Error("Codemode invocation ended or was cancelled");
		return this.current;
	}
	private async invoke(name: string, args: unknown): Promise<unknown> {
		const invocation = this.requireInvocation();
		invocation.pending++;
		try { return await this.runChild(invocation, name, args); }
		catch (error) { invocation.failed = true; throw error; }
		finally {
			if (--invocation.pending === 0) { invocation.resolveIdle?.(); invocation.resolveIdle = undefined; }
		}
	}
	private async runChild(invocation: Invocation, name: string, args: unknown): Promise<unknown> {
		if (!args || typeof args !== "object" || Array.isArray(args)) { invocation.failed = true; throw new Error("Tool arguments must be an object"); }
		const input = args as Record<string, unknown>;
		// Validate/count arguments before any tool side effect. Reuse this length below.
		const inputChars = this.serializer.stringify(input, 256 * 1024)!.length;
		const sequence = ++invocation.started;
		const startedAt = Date.now();
		const raw = await invocation.context.callTool(name, input);
		const fact: ChildFact = { toolCallId: raw.toolCallId, toolName: raw.toolName, isError: raw.isError, preview: preview(raw), inputSummary: codemodeInputSummary(input), sequence, durationMs: Date.now() - startedAt };
		if (name === "bash" || name === "powershell") {
			const execution = readShellExecution(raw.details);
			if (execution) { fact.executionStatus = execution.executionStatus; fact.exitCode = execution.exitCode; }
		}
		invocation.facts.push(fact);
		invocation.failed ||= raw.isError;
		if (CODEMODE_MUTATION_NAMES.has(name) && this.saveResult) {
			// Receipts carry the tool's own outcome. An end-event observation failure, set only by the
			// agent loop, still fails this script but is recorded beside the receipt, not inside it.
			const observation = raw.observationFailure;
			const isError = observation ? observation.executionIsError : raw.isError;
			let details: string | undefined;
			try { details = this.serializer.stringify(raw.details, 1024 * 1024); }
			catch (error) {
				invocation.failed = true;
				// Preserve the observed outcome even when optional metadata cannot be saved.
				// This is not a mutation receipt and must never authorize replay or claim rollback.
				const entry: CodemodeResultEntry = { version: 1, parentToolCallId: invocation.context.parentToolCallId,
					result: { role: "toolResult", toolCallId: raw.toolCallId, toolName: name, isError, timestamp: raw.timestamp,
						content: [], details: { codemodeResultError: message(error).slice(0, 512), requiresVerification: true } } };
				if (observation) entry.observationError = observation.error;
				this.saveResult(entry);
				throw new Error("[CODEMODE_RESULT_PROCESSING_FAILED] The tool returned, but its details could not be persisted. Its observed status was recorded; verify current state without repeating completed mutations.");
			}
			const entry: CodemodeResultEntry = { version: 1, parentToolCallId: invocation.context.parentToolCallId,
				result: { role: "toolResult", toolCallId: raw.toolCallId, toolName: name, isError, timestamp: raw.timestamp,
					content: [], details: details === undefined ? undefined : JSON.parse(details) } };
			if (observation) entry.observationError = observation.error;
			this.saveResult(entry);
		}
		let result: ToolResultMessage;
		try { result = await boundCodemodeResult(raw, this.serializer); }
		catch (error) { invocation.failed = true; throw error; }
		for (const block of result.content) if (block.type === "text") {
			fact.preview = block.text.slice(0, CODEMODE_DISPLAY_PREVIEW_CHARS);
			fact.previewTruncated = block.text.length > CODEMODE_DISPLAY_PREVIEW_CHARS;
			break;
		}
		fact.outputDigests = codemodeOutputDigests(result.content);
		fact.outputPath = result.details?.codemodeOutput?.path ?? result.details?.fullOutputPath;
		const chars = codemodeContentChars(result) + (this.serializer.stringify(result.details, 128 * 1024)?.length ?? 0)
			+ inputChars;
		const imageChars = codemodeImageChars(result.content);
		while ((invocation.retainedChars + chars > MAX_CODEMODE_RETAINED_CHARS
			|| invocation.retainedImageChars + imageChars > MAX_RETAINED_IMAGE_CHARS) && invocation.records.size) {
			const oldest = invocation.records.keys().next().value!;
			const evicted = invocation.records.get(oldest)!;
			invocation.retainedChars -= evicted.chars;
			invocation.retainedImageChars -= evicted.imageChars;
			invocation.records.delete(oldest);
		}
		const ref = `${invocation.prefix}:${++invocation.issued}`;
		invocation.records.set(ref, { result, input, chars, imageChars });
		invocation.retainedChars += chars;
		invocation.retainedImageChars += imageChars;
		if (result.isError) throw new Error(`[${ref}] ${preview(result)}`);
		const content = imageChars > MAX_SCRIPT_IMAGE_CHARS ? scriptContent(result.content) : result.content;
		return { content, details: result.details, isError: false, ref };
	}
	private show(ref: unknown): void {
		const invocation = this.requireInvocation();
		const record = typeof ref === "string" ? invocation.records.get(ref) : undefined;
		if (!record) { invocation.failed = true; throw new Error("Unknown or expired result reference; references belong to the current script"); }
		if (invocation.shownChars + record.chars > MAX_SHOWN_CHARS || invocation.shown.length + record.result.content.length > 256) {
			invocation.failed = true; throw new Error("Shown results exceed the display budget; read smaller ranges");
		}
		if (invocation.shownImageChars + record.imageChars > MAX_SHOWN_IMAGE_CHARS) {
			invocation.failed = true; throw new Error("Shown images exceed the display budget; show fewer or smaller images");
		}
		invocation.shownChars += record.chars;
		invocation.shownImageChars += record.imageChars;
		const shownIndex = invocation.shown.length;
		for (const block of record.result.content) invocation.shown.push(block);
		if (record.result.toolName === "read" && !record.result.isError &&
			(record.result.content as unknown as Record<symbol, unknown>)[MUTATION_READ_SOURCE] && invocation.reads.length < MAX_SHOWN_READS) {
			// Offset within shown blocks; execute() adds the final position of the first shown block.
			invocation.reads.push({ type: "codemode_read", toolCallId: record.result.toolCallId, parentToolCallId: invocation.context.parentToolCallId,
				input: record.input, content: record.result.content, details: record.result.details, parentContentIndex: shownIndex });
		}
	}
	private describe(names: unknown): string {
		const invocation = this.requireInvocation();
		if (!Array.isArray(names) || names.length > 16) throw new Error("describeTools expects up to 16 names");
		let text = "";
		for (const tool of invocation.context.getTools()) {
			if (!nestedAllowed(tool)) continue;
			// ALL_TOOLS lists script identifiers; accept them as well as registered names.
			const identifier = this.identifiers.get(tool.name);
			if (names.includes(tool.name) || (identifier !== undefined && names.includes(identifier))) {
				text += tool.description.slice(0, 1024) + "\n" + renderToolSignature({ name: tool.name, inputSchema: tool.parameters as never }, { ...TOOL_SIGNATURE_OPTIONS, identifier }) + "\n";
			}
		}
		return text;
	}
	private async ensureSandbox(): Promise<CodemodeSandbox> {
		if (this.sandbox) return this.sandbox;
		const { CodemodeSandbox } = await import("@super-pi/codemode");
		if (this.closed) throw new Error("Codemode session is disposed");
		this.sandbox = new CodemodeSandbox({ tools: this.descriptors, globals: [
			{ name: "callTool", spread: true, execute: args => {
				const [name, input] = args as unknown[];
				if (typeof name !== "string") { this.requireInvocation().failed = true; throw new Error("callTool requires a tool name"); }
				return this.invoke(name, input);
			} },
			{ name: "show", execute: ref => this.show(ref) },
			{ name: "describeTools", execute: names => this.describe(names) },
		] });
		return this.sandbox;
	}
	private async execute(code: string, context: AgentToolExecutionContext | undefined, signal?: AbortSignal) {
		if (!context || this.current || this.closed) throw new Error("Codemode requires an idle live orchestration context");
		if (this.restoreError) {
			const reason = this.restoreError;
			this.restoreError = undefined;
			return { content: [{ type: "text" as const, text: `[CODEMODE_STORE_RESTORE_FAILED] ${reason}. No tools were executed. Saved history is unchanged; this branch will continue with an empty store.` }], isError: true, details: undefined };
		}
		const parsed = parseCodemodeSource(code);
		const outputTokens = parsed.options.maxOutputTokens ?? 8000;
		if (outputTokens < 256 || outputTokens > 16384) throw new Error("Codemode max_output_tokens must be 256..16384; no tools were executed");
		const invocation: Invocation = { context, signal, prefix: randomUUID(), issued: 0, started: 0, records: new Map(), retainedChars: 0, retainedImageChars: 0,
			shownChars: 0, shownImageChars: 0, shown: [], reads: [], facts: [], failed: false, pending: 0, resolveIdle: undefined };
		this.current = invocation;
		let result: CodemodeResult;
		try {
			const sandbox = await this.ensureSandbox();
			result = await sandbox.execute(parsed.code, { signal, timeoutMs: parsed.options.timeoutMs, store: this.store.snapshot });
			const childFailed = await context.finish();
			if (invocation.pending) await new Promise<void>(resolve => { invocation.resolveIdle = resolve; });
			invocation.facts.sort(compareChildSequence);
			let failed = invocation.failed || !result.ok || childFailed;
			for (const call of result.calls) if (call.status !== "ok") failed = true;
			const content: (TextContent | ImageContent)[] = result.output;
			if (result.ok && result.value !== undefined) content.push({ type: "text", text: typeof result.value === "string" ? result.value : JSON.stringify(result.value) });
			if (!result.ok) content.push({ type: "text", text: `[CODEMODE_${result.error.kind.toUpperCase()}] ${result.error.message}` });
			// The summary is unshifted below; capping keeps a prefix, so retained blocks keep these positions.
			const shownOffset = content.length + 1;
			for (const block of invocation.shown) content.push(block);
			let summary = `[CODEMODE_${failed ? "FAILED" : "OK"}] Child calls: ${invocation.facts.length}.`;
			for (const fact of invocation.facts) summary += `\n${fact.toolName.slice(0, 80)}: ${fact.executionStatus ?? (fact.isError ? "failed" : "completed")}${fact.executionStatus ? "; exit=" + (fact.exitCode ?? "unknown") : ""}${fact.isError ? " — " + fact.preview.slice(0, 512) : ""}${fact.outputPath ? " Output: " + fact.outputPath : ""}`;
			if (failed) summary += "\nCompleted tool side effects are not rolled back. Do not automatically retry mutations.";
			content.unshift({ type: "text", text: summary });
			const projected = await capCodemodeOutput(content, outputTokens);
			const first = projected[0];
			const displayedSummary = first?.type === "text" && summary.startsWith(first.text) ? first.text : summary;
			if (result.ok && !failed) {
				this.pendingStore = { id: context.parentToolCallId, writes: result.storeWrites };
			}
			if (this.readsProjected) { this.displayedReads.clear(); this.readsProjected = false; }
			if (invocation.reads.length) {
				for (const read of invocation.reads) read.parentContentIndex += shownOffset;
				if (this.displayedReads.size >= MAX_PENDING_READ_PARENTS) this.displayedReads.delete(this.displayedReads.keys().next().value!);
				this.displayedReads.set(context.parentToolCallId, invocation.reads);
			}
			return { content: projected, isError: failed, details: { codemode: { version: 1, scriptOk: result.ok, summaryDigest: codemodeTextDigest(displayedSummary), calls: invocation.facts, runtimeCalls: result.calls } } };
		} catch (error) {
			await context.finish();
			if (invocation.pending) await new Promise<void>(resolve => { invocation.resolveIdle = resolve; });
			invocation.facts.sort(compareChildSequence);
			return { content: [{ type: "text" as const, text: `[CODEMODE_FAILED] ${message(error)}. Completed tool side effects are not rolled back.` }],
				isError: true, details: { codemode: { version: 1, scriptOk: false, calls: invocation.facts } } };
		} finally {
			invocation.records.clear();
			invocation.shown.length = 0;
			this.current = undefined;
		}
	}
	async close(): Promise<void> {
		this.closed = true;
		this.pendingStore = undefined;
		this.restoreError = undefined;
		await this.sandbox?.close();
		this.sandbox = undefined;
		this.tools = EMPTY_TOOLS;
		this.descriptors.length = 0;
		this.store.reset();
		this.clearReadEvidence();
	}
}
