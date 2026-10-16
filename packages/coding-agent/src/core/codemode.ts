import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolExecutionContext, AgentToolResult } from "@super-pi/agent-core";
import type { Message, ToolResultMessage, TextContent, ImageContent } from "@super-pi/ai";
import type { CodemodeSandbox, CodemodeTool, CodemodeResult, CodemodeStoreWrites } from "@super-pi/codemode";
import { assignCodemodeIdentifiers, renderToolSignature } from "@super-pi/codemode/declarations";
import { parseCodemodeSource } from "@super-pi/codemode/source";
import { BoundedJson } from "@super-pi/codemode/bounded-json";
import type { ToolDefinition, CodemodeReadEvent } from "./extensions/types.ts";
import type { ToolResultPresentationContent } from "./tool-result-presentation.ts";
import { CODEMODE_DESCRIPTION, CODEMODE_NAME, CODEMODE_PARAMETERS, CODEMODE_SAMPLING,
	MAX_CODEMODE_DESCRIPTION_CHARS, MAX_CODEMODE_RETAINED_CHARS } from "./codemode-constants.ts";
import { CODEMODE_MUTATION_NAMES } from "./codemode-constants.ts";
import { CodemodeStore } from "./codemode-store.ts";
import { saveCodemodeImages } from "./codemode-images.ts";
import { boundCodemodeResult, capCodemodeOutput, codemodeContentChars, codemodeImageChars, persistCodemodeResult } from "./codemode-result.ts";
import { MUTATION_READ_SOURCE } from "./tools/read-window.ts";
import { readShellExecution } from "./tools/shell-execution.ts";
import { truncateTail } from "./tools/truncate.ts";
import { codemodeFailureReason, codemodeFailureWindow, codemodeInputSummary, codemodeOutputDigests, codemodeTextDigest, CODEMODE_DISPLAY_PREVIEW_CHARS, type CodemodeChildDisplay } from "./codemode-display.ts";

/** Result quota excludes input. Only native-read path/range primitives survive dispatch. */
interface ChildRecord { result: ToolResultMessage; input: Record<string, unknown> | undefined; chars: number; contentChars: number; imageChars: number;
	fact: ChildFact; recovery: { path: string; capped: boolean } | undefined;
	recoveryAttempted: boolean; recoveryPending: Promise<{ path: string; capped: boolean }> | undefined; }
/** Durable mutation outcome; `observationError` is kept outside the receipt-bearing result. */
interface CodemodeResultEntry { version: 1; parentToolCallId: string; result: ToolResultMessage; observationError?: string; }
type ChildFact = CodemodeChildDisplay;
interface DisplayedRead extends CodemodeReadEvent { projectedContentIndex: number; }
interface Invocation {
	context: AgentToolExecutionContext;
	signal?: AbortSignal;
	prefix: string;
	issued: number;
	started: number;
	records: Map<string, ChildRecord>;
	/** At most 256 metadata-only tombstones, released with the script. */
	evicted: Map<string, ChildFact>;
	/** In-flight persistence only; no body survives its write completion. */
	recovering: Map<string, ChildRecord>;
	retainedChars: number;
	retainedImageChars: number;
	shownChars: number;
	shownImageChars: number;
	shown: (TextContent | ImageContent)[];
	reads: DisplayedRead[];
	facts: ChildFact[];
	failed: boolean;
	displayLimited: boolean;
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
const MAX_RETAINED_RECORDS = 256;
const TOOL_SIGNATURE_OPTIONS = Object.freeze({ inputMaxChars: 2048, outputType: "ToolResult" });
const TOOL_RESULT_DECLARATION = 'type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details?: unknown; isError?: boolean; ref: string };\n';
const MAX_DESCRIBE_PAGE_CHARS = 16_000;
const MAX_DESCRIBE_SCHEMA_CHARS = 64 * 1024;
const MAX_DESCRIBE_TOOLS = 16;
const UNAVAILABLE_DOCUMENTATION = "[TOOL_UNAVAILABLE] One or more requested tools are not active in this script. If tools.tool_search is available, search the exact name, then read describeTools again. Newly activated tools use callTool(name,args) in the same script. Excluded tools stay unavailable.";
const DEFERRED_DECLARATIONS = "\nMCP declarations are deferred. Filter ALL_TOOLS and use await describeTools([names]) for their current schemas.\n";
const ALLOW_FAILURE = Object.freeze({ allowFailure: true });

function nestedAllowed(tool: AgentTool<any>): boolean {
	return !tool.orchestration && !tool.modelOnly && !tool.interactionBoundary;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "Codemode execution failed"; }
const FAILURE_TAIL_OPTIONS = Object.freeze({ maxLines: 4, maxBytes: 1024 });
const SUMMARY_TAIL_OPTIONS = Object.freeze({ maxLines: 3, maxBytes: 256 });
function preview(result: ToolResultMessage): string {
	for (const block of result.content) if (block.type === "text") return result.isError
		? codemodeFailureWindow(block.text)
		: block.text.slice(0, CODEMODE_DISPLAY_PREVIEW_CHARS);
	return "";
}
function descriptorName(tool: CodemodeTool): string { return tool.name; }
function splitsSurrogatePair(text: string, offset: number): boolean {
	const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
function unicodePrefix(text: string, limit: number): string {
	return text.slice(0, splitsSurrogatePair(text, limit) ? limit - 1 : limit);
}
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
function requiredReadBlocks(content: readonly ToolResultPresentationContent[]): number {
	let lines = false;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		if (block.readBoundary === "lines") lines = true;
		else if (lines && block.readBoundary === "metadata") return index + 1;
	}
	return content.length;
}
/** The read survived only if its exact blocks occupy their own positions; equal text elsewhere is not this read. */
function readSurvived(read: CodemodeReadEvent, visible: readonly (TextContent | ImageContent)[], start = read.parentContentIndex): boolean {
	const count = read.requiredContentBlocks ?? read.content.length;
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
	/** Script identifier to registered name, for describeTools. */
	private identifierNames = new Map<string, string>();
	/** Weak identities bind documentation pages to live definitions without retaining their text. */
	private documentationVersions = new WeakMap<AgentTool<any>, number>();
	private nextDocumentationVersion = 0;
	private documentationRevisionPrefix: string | undefined;
	private documentationCatalogRevision = 0;
	/** One selection only: at most 16 x 65536 UTF-16 units; no description or tool references. */
	private documentationSnapshot: { revision: string; schemas: string[] } | undefined;
	private sandbox: CodemodeSandbox | undefined;
	private current: Invocation | undefined;
	private readonly store = new CodemodeStore();
	private readonly serializer = new BoundedJson();
	private readonly displayedReads = new Map<string, DisplayedRead[]>();
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
		if (this.closed || this.tools === tools) return;
		this.tools = tools;
		this.documentationCatalogRevision++;
		this.documentationSnapshot = undefined;
		const descriptors: CodemodeTool[] = [];
		let description = CODEMODE_DESCRIPTION + DEFERRED_DECLARATIONS + "\nCurrent local tool declarations:\n" + TOOL_RESULT_DECLARATION;
		let omitted = 0;
		for (const tool of tools) {
			if (!nestedAllowed(tool)) continue;
			const name = tool.name;
			const fullDescription = tool.fullDescription ?? tool.description;
			const summary = fullDescription.length <= 1024 ? fullDescription : unicodePrefix(fullDescription, 900) + "\n[Summary only; await describeTools([name]) for full instructions.]";
			descriptors.push({ name, description: summary, inputSchema: tool.parameters as never,
				execute: args => this.invoke(name, args) });
		}
		const identifiers = assignCodemodeIdentifiers(descriptors.map(descriptorName));
		for (const descriptor of descriptors) {
			if (descriptor.name.startsWith("mcp__")) continue;
			if (description.length >= MAX_CODEMODE_DESCRIPTION_CHARS - 256) { omitted++; continue; }
			const purpose = unicodePrefix(descriptor.description ?? "", 256).replace(/[\r\n\u2028\u2029]/g, " ");
			const signature = `// ${purpose}\n` + renderToolSignature(descriptor, { ...TOOL_SIGNATURE_OPTIONS, identifier: identifiers.get(descriptor.name) });
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
		this.identifierNames.clear();
		for (const [name, identifier] of identifiers) this.identifierNames.set(identifier, name);
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
	/** Projection retains canonical block identities before transport strips the markers.
	 * Remap only the original native span, never a textually equal script copy.
	 */
	recordToolResultProjection(source: ToolResultMessage, retained: readonly ToolResultPresentationContent[], canonical: readonly ToolResultPresentationContent[], transport: readonly ToolResultPresentationContent[], visible: readonly ToolResultPresentationContent[]): void {
		const reads = this.displayedReads.get(source.toolCallId);
		if (!reads) return;
		for (const read of reads) {
			read.projectedContentIndex = -1;
			if (!readSurvived(read, source.content)) continue;
			// A validated cache hit may own equivalent blocks from an earlier message array.
			const first = canonical[read.parentContentIndex]!;
			const start = retained.indexOf(first);
			if (start < 0) continue;
			const finalStart = transport === visible ? start : visible.indexOf(transport[start]!);
			if (finalStart < 0) continue;
			const required = read.requiredContentBlocks ?? read.content.length;
			let count = 0;
			while (count < required && retained[start + count] === canonical[read.parentContentIndex + count]
				&& visible[finalStart + count] === transport[start + count]) count++;
			if (count === required) read.projectedContentIndex = finalStart;
		}
	}

	/** Called only on the actual model projection, never previews; exact native blocks must survive. */
	recordProjection(messages: readonly Message[], remapped = false): void {
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
				if (readSurvived(read, result.content, remapped ? read.projectedContentIndex : read.parentContentIndex)) this.visibleReads.push(read);
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
	private async invoke(name: string, args: unknown, options?: unknown): Promise<unknown> {
		const invocation = this.requireInvocation();
		invocation.pending++;
		try {
			if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options)
				|| (options as { allowFailure?: unknown }).allowFailure !== undefined && typeof (options as { allowFailure?: unknown }).allowFailure !== "boolean")) {
				throw new Error("callTool options must be an object with an optional boolean allowFailure");
			}
			return await this.runChild(invocation, name, args, (options as { allowFailure?: boolean } | undefined)?.allowFailure === true);
		}
		catch (error) { invocation.failed = true; throw error; }
		finally {
			if (--invocation.pending === 0) { invocation.resolveIdle?.(); invocation.resolveIdle = undefined; }
		}
	}
	private async runChild(invocation: Invocation, name: string, args: unknown, allowFailure: boolean): Promise<unknown> {
		if (!args || typeof args !== "object" || Array.isArray(args)) { invocation.failed = true; throw new Error("Tool arguments must be an object"); }
		const input = args as Record<string, unknown>;
		// Validate before effects; argument objects are never retained by the ref cache.
		this.serializer.stringify(input, 256 * 1024);
		const sequence = ++invocation.started;
		const startedAt = Date.now();
		const raw = await invocation.context.callTool(name, input, allowFailure ? ALLOW_FAILURE : undefined);
		const failureHandled = raw.isError && allowFailure && !raw.observationFailure && !invocation.signal?.aborted;
		const fact: ChildFact = { toolCallId: raw.toolCallId, toolName: raw.toolName, isError: raw.isError, preview: preview(raw), inputSummary: codemodeInputSummary(input), sequence, durationMs: Date.now() - startedAt,
			executed: raw.executionStatus !== "not_executed", resultComplete: "unknown", displayLimited: false, failureHandled };
		if (name === "bash" || name === "powershell") {
			const execution = readShellExecution(raw.details);
			if (execution) { fact.executionStatus = execution.executionStatus; fact.exitCode = execution.exitCode; fact.executed = execution.started; fact.resultComplete = execution.output.complete; }
		}
		if (raw.executionStatus === "not_executed") { fact.executionStatus = "not_executed"; fact.executed = false; }
		invocation.facts.push(fact);
		invocation.failed ||= raw.isError && !failureHandled;
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
			if (!raw.isError) fact.preview = block.text.slice(0, CODEMODE_DISPLAY_PREVIEW_CHARS);
			fact.previewTruncated = block.text.length > CODEMODE_DISPLAY_PREVIEW_CHARS;
			break;
		}
		fact.outputDigests = codemodeOutputDigests(result.content);
		fact.outputPath = result.details?.codemodeOutput?.path ?? result.details?.fullOutputPath;
		const contentChars = codemodeContentChars(result);
		const chars = contentChars + (this.serializer.stringify(result.details, 128 * 1024)?.length ?? 0);
		const imageChars = codemodeImageChars(result.content);
		const ref = `${invocation.prefix}:${++invocation.issued}`;
		fact.ref = ref;
		const readInput = name === "read" && typeof input.path === "string" && input.path.length <= 32768
			&& (input.offset === undefined || typeof input.offset === "number") && (input.limit === undefined || typeof input.limit === "number")
			? { path: input.path, offset: input.offset, limit: input.limit } : undefined;
		const record: ChildRecord = { result, input: readInput, chars, contentChars, imageChars, fact, recovery: undefined, recoveryAttempted: false, recoveryPending: undefined };
		while ((invocation.retainedChars + chars > MAX_CODEMODE_RETAINED_CHARS
			|| invocation.retainedImageChars + imageChars > MAX_RETAINED_IMAGE_CHARS
			|| invocation.records.size >= MAX_RETAINED_RECORDS) && invocation.records.size) {
			const oldest = invocation.records.keys().next().value!;
			const evicted = invocation.records.get(oldest)!;
			invocation.retainedChars -= evicted.chars;
			invocation.retainedImageChars -= evicted.imageChars;
			invocation.records.delete(oldest);
			invocation.evicted.set(oldest, evicted.fact);
			evicted.fact.evicted = true;
			invocation.recovering.set(oldest, evicted);
			try { await this.recoverRecord(evicted); }
			finally { invocation.recovering.delete(oldest); }
		}
		if (chars <= MAX_CODEMODE_RETAINED_CHARS && imageChars <= MAX_RETAINED_IMAGE_CHARS) {
			invocation.records.set(ref, record);
			invocation.retainedChars += chars;
			invocation.retainedImageChars += imageChars;
		} else {
			invocation.evicted.set(ref, fact);
			fact.evicted = true;
			await this.recoverRecord(record);
		}
		if (result.isError && !failureHandled) {
			// Failure throws before the script can show(ref). Preserve partial browser
			// receipts in the bounded parent output, without duplicating its traceback.
			if (name === "browser_exec") for (let index = 1; index < result.content.length; index++) {
				const block = result.content[index]!;
				if (invocation.shown.length >= 256) break;
				if (block.type === "text") {
					const remaining = MAX_SHOWN_CHARS - invocation.shownChars;
					if (remaining <= 0) break;
					const notice = "\n… partial browser output truncated by the parent display budget";
					const text = block.text.length > remaining
						? unicodePrefix(block.text, Math.max(0, remaining - notice.length)) + notice.slice(0, remaining) : block.text;
					invocation.shown.push(text === block.text ? block : { type: "text", text });
					invocation.shownChars += text.length;
				} else if (invocation.shownImageChars + block.data.length <= MAX_SHOWN_IMAGE_CHARS) {
					invocation.shown.push(block);
					invocation.shownImageChars += block.data.length;
				}
			}
			throw new Error(`[${ref}] ${codemodeFailureReason(fact.preview, "model")}\n${truncateTail(fact.preview.slice(-1024), FAILURE_TAIL_OPTIONS).content}${fact.outputPath ? "\nOutput: " + fact.outputPath : ""}`);
		}
		const content = imageChars > MAX_SCRIPT_IMAGE_CHARS ? scriptContent(result.content) : result.content;
		return { content, details: result.details, isError: result.isError, ref, executed: fact.executed, resultComplete: fact.resultComplete, failureHandled };
	}
	private async show(ref: unknown): Promise<unknown> {
		const invocation = this.requireInvocation();
		invocation.pending++;
		try { return await this.showRecord(invocation, ref); }
		catch (error) { invocation.failed = true; throw error; }
		finally { if (--invocation.pending === 0) { invocation.resolveIdle?.(); invocation.resolveIdle = undefined; } }
	}
	private async showRecord(invocation: Invocation, ref: unknown): Promise<unknown> {
		const record = typeof ref === "string" ? invocation.records.get(ref) ?? invocation.recovering.get(ref) : undefined;
		if (!record) {
			const evicted = typeof ref === "string" ? invocation.evicted.get(ref) : undefined;
			if (!evicted) { invocation.failed = true; throw new Error("Unknown or expired result reference; references belong to the current script"); }
			invocation.displayLimited = evicted.displayLimited = true;
			return { evicted: true, ref, path: evicted.outputPath, capped: evicted.recoveryCapped, recoveryError: evicted.recoveryError };
		}
		const limited = invocation.shownChars + record.contentChars > MAX_SHOWN_CHARS
			|| invocation.shown.length + record.result.content.length > 256
			|| invocation.shownImageChars + record.imageChars > MAX_SHOWN_IMAGE_CHARS;
		if (limited) {
			invocation.displayLimited = record.fact.displayLimited = true;
			await this.recoverRecord(record);
		}
		const shownIndex = invocation.shown.length;
		for (const block of record.result.content) {
			if (invocation.shown.length >= 256) break;
			if (block.type === "image") {
				if (invocation.shownImageChars + block.data.length > MAX_SHOWN_IMAGE_CHARS) continue;
				invocation.shownImageChars += block.data.length;
				invocation.shown.push(block);
			} else {
				const remaining = MAX_SHOWN_CHARS - invocation.shownChars;
				if (remaining <= 0) continue;
				const text = block.text.length > remaining ? unicodePrefix(block.text, remaining) : block.text;
				invocation.shownChars += text.length;
				invocation.shown.push(text === block.text ? block : { type: "text", text });
			}
		}
		if (!limited && record.input && record.result.toolName === "read" && !record.result.isError &&
			(record.result.content as unknown as Record<symbol, unknown>)[MUTATION_READ_SOURCE] && invocation.reads.length < MAX_SHOWN_READS) {
			// Offset within shown blocks; execute() adds the final position of the first shown block.
			invocation.reads.push({ type: "codemode_read", toolCallId: record.result.toolCallId, parentToolCallId: invocation.context.parentToolCallId,
				input: record.input, content: record.result.content, details: record.result.details, parentContentIndex: shownIndex, projectedContentIndex: -1,
				requiredContentBlocks: requiredReadBlocks(record.result.content) });
		}
	}
	private async recoverRecord(record: ChildRecord): Promise<void> {
		if (!record.recoveryAttempted) {
			record.recoveryAttempted = true;
			record.recoveryPending = persistCodemodeResult(record.result, this.serializer);
		}
		try {
			if (record.recoveryPending) record.recovery = await record.recoveryPending;
			if (record.recovery) {
				record.fact.outputPath = record.recovery.path;
				record.fact.recoveryCapped = record.recovery.capped;
				if (record.recovery.capped) record.fact.resultComplete = false;
			}
		} catch (error) { record.fact.recoveryError = message(error).slice(0, 512); }
		finally { record.recoveryPending = undefined; }
	}
	private describe(names: unknown, options?: unknown): string {
		const invocation = this.requireInvocation();
		if (!Array.isArray(names) || names.length > MAX_DESCRIBE_TOOLS) throw new Error("describeTools expects up to 16 names");
		if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) throw new Error("describeTools options must be an object");
		const { offset = 0, limit = 8000, format = "typescript", revision } = (options ?? {}) as { offset?: number; limit?: number; format?: string; revision?: string };
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 256 || limit > MAX_DESCRIBE_PAGE_CHARS || (format !== "typescript" && format !== "json") || (revision !== undefined && (typeof revision !== "string" || revision.length > 512))) {
			throw new Error("describeTools expects offset >= 0, limit 256..16000, and format 'typescript' or 'json'");
		}
		if (offset > 0 && revision === undefined) throw new Error("describeTools continuation requires the revision returned by page one; restart at offset:0.");
		// Revalidate the live selection before reusing serialized schema text. Full descriptions
		// remain query-owned references; no work is added to child/progress delivery.
		const described: AgentTool<any>[] = [];
		let unavailable = false;
		let currentRevision = (this.documentationRevisionPrefix ??= randomUUID()) + ":" + this.documentationCatalogRevision + ":" + format + ":";
		for (const requested of names) {
			if (typeof requested !== "string") continue;
			// ALL_TOOLS lists script identifiers; accept them as well as registered names.
			const alias = this.identifierNames.get(requested);
			const tool = invocation.context.findTool(requested) ?? (alias === undefined ? undefined : invocation.context.findTool(alias));
			if (!tool || !nestedAllowed(tool)) { unavailable = true; continue; }
			if (described.includes(tool)) continue;
			described.push(tool);
			let version = this.documentationVersions.get(tool);
			if (version === undefined) this.documentationVersions.set(tool, version = ++this.nextDocumentationVersion);
			currentRevision += version + ",";
		}
		currentRevision += unavailable ? "unavailable" : "";
		if (revision !== undefined && revision !== currentRevision) {
			this.documentationSnapshot = undefined;
			throw new Error("[TOOL_DOCUMENTATION_CHANGED] Tool definitions or selection changed. Discard earlier pages and restart describeTools at offset:0 without a revision.");
		}
		if (described.length === 0) { this.documentationSnapshot = undefined; return unavailable ? UNAVAILABLE_DOCUMENTATION : ""; }
		let snapshot = this.documentationSnapshot;
		if (snapshot?.revision !== currentRevision) {
			this.documentationSnapshot = undefined;
			const schemas: string[] = [];
			for (const tool of described) {
				let schema: string;
				if (format === "json") {
					try { schema = this.serializer.stringify(tool.parameters, MAX_DESCRIBE_SCHEMA_CHARS) ?? "unknown"; }
					catch { schema = "[Schema exceeds the 65536-character structural safety limit or is not serializable; do not guess arguments.]"; }
				} else {
					schema = renderToolSignature({ name: tool.name, inputSchema: tool.parameters as never }, { inputMaxChars: 16_000, identifier: this.identifiers.get(tool.name), outputType: "ToolResult" });
					if (schema.length > MAX_DESCRIBE_SCHEMA_CHARS) schema = "[Signature exceeds the structural safety limit; use format:'json' for input constraints.]";
				}
				schemas.push(schema);
			}
			snapshot = this.documentationSnapshot = { revision: currentRevision, schemas };
		}
		const parts: string[] = [TOOL_RESULT_DECLARATION];
		if (unavailable) parts.push(UNAVAILABLE_DOCUMENTATION, "\n");
		for (let index = 0; index < described.length; index++) {
			const tool = described[index]!;
			parts.push(`\nTool: ${tool.name}\n`, tool.fullDescription ?? tool.description, "\n");
			if (format === "json") parts.push("Input JSON Schema:\n", snapshot.schemas[index]!, "\nResult: ToolResult\n");
			else parts.push(snapshot.schemas[index]!, "\n");
		}
		parts.push("\nTypeScript is a summary; use format:'json' for exact input constraints, long defaults/patterns, or unknown types. Child failures throw by default and keep the parent failed even if caught. callTool(name,args,{allowFailure:true}) returns the true isError outcome, including tool_call refusals; inspect it and select an alternative. Ref values belong only to this script; show(ref) reports eviction with a saved path. Display limits do not change execution status.\n");
		let position = 0, pageOffset = offset, text = "", pageComplete = false;
		for (const part of parts) {
			let start = Math.max(0, pageOffset - position);
			if (!pageComplete && start < part.length && text.length < limit) {
				// Rewind an explicit mid-pair offset; shorten the end to keep the body within its limit.
				if (splitsSurrogatePair(part, start)) { start--; pageOffset--; }
				let end = Math.min(part.length, start + limit - text.length);
				if (splitsSurrogatePair(part, end)) end--;
				text += part.slice(start, end);
				// A shortened boundary must resume in this segment, not skip into the next one.
				pageComplete = end < part.length;
			}
			position += part.length;
		}
		const end = Math.min(position, pageOffset + text.length);
		if (end === position) this.documentationSnapshot = undefined;
		const continuation = end < position ? `\n[More tool documentation: describeTools with the same names/format, offset:${end}, limit:${limit}, revision:"${currentRevision}".]` : "";
		return `[Tool documentation chars ${Math.min(pageOffset, position)}..${end} of ${position}; format:${format}; revision:${currentRevision}]\n${text}${continuation}`;
	}
	private async ensureSandbox(): Promise<CodemodeSandbox> {
		if (this.sandbox) return this.sandbox;
		const { CodemodeSandbox } = await import("@super-pi/codemode");
		if (this.closed) throw new Error("Codemode session is disposed");
		this.sandbox = new CodemodeSandbox({ reuseWorker: true, tools: this.descriptors, globals: [
			{ name: "callTool", spread: true, execute: args => {
				const [name, input, options] = args as unknown[];
				if (typeof name !== "string") { this.requireInvocation().failed = true; throw new Error("callTool requires a tool name"); }
				return this.invoke(name, input, options);
			} },
			{ name: "show", execute: ref => this.show(ref) },
			{ name: "describeTools", spread: true, execute: args => {
				const [names, options] = args as unknown[];
				return this.describe(names, options);
			} },
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
		const invocation: Invocation = { context, signal, prefix: randomUUID(), issued: 0, started: 0, records: new Map(), evicted: new Map(), recovering: new Map(), retainedChars: 0, retainedImageChars: 0,
			shownChars: 0, shownImageChars: 0, shown: [], reads: [], facts: [], failed: false, displayLimited: false, pending: 0, resolveIdle: undefined };
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
			if (failed) this.documentationSnapshot = undefined;
			const content: (TextContent | ImageContent)[] = result.output;
			if (result.ok && result.value !== undefined) content.push({ type: "text", text: typeof result.value === "string" ? result.value : JSON.stringify(result.value) });
			if (!result.ok) content.push({ type: "text", text: `[CODEMODE_${result.error.kind.toUpperCase()}] ${result.error.message}` });
			// Compact causes stay in the summary. A separate bounded tail preserves status
			// and secondary diagnostics without changing collapsed UI cause selection.
			if (result.ok) for (const fact of invocation.facts) if (fact.isError) content.push({ type: "text",
				text: `[Child output tail ${fact.ref}]\n${truncateTail(fact.preview.slice(-1024), SUMMARY_TAIL_OPTIONS).content}` });
			// The summary is unshifted below; capping keeps every block before the cut (and only images
			// after it), so retained text blocks keep these positions.
			const shownOffset = content.length + 1;
			for (const block of invocation.shown) content.push(block);
			let summary = `[CODEMODE_${failed ? "FAILED" : "OK"}] Child calls: ${invocation.facts.length}.`;
			let handledFailures = 0;
			for (const fact of invocation.facts) if (fact.failureHandled) handledFailures++;
			if (handledFailures) summary += ` Handled failures: ${handledFailures}.`;
			if (invocation.displayLimited) summary += "\n[CODEMODE_DISPLAY_LIMITED] Display budget reached; output omitted/truncated. Use read on the saved Output paths below; do not repeat completed tools. Each saved result is capped at 5 MiB, with an explicit marker if later bytes were not saved.";
			const imageSave = saveCodemodeImages(content);
			const imageFiles = imageSave ? await imageSave : undefined;
			// Keep the path in the retained head, before variable child previews,
			// and out of the trailing native-read group.
			if (imageFiles) summary += "\n" + imageFiles.notice;
			const imagePrefix = imageFiles ? summary.length : 0;
			for (const fact of invocation.facts) summary += `\n${fact.toolName.slice(0, 80)}: ${fact.executionStatus ?? (fact.isError ? "failed" : "completed")}${fact.executionStatus && (fact.toolName === "bash" || fact.toolName === "powershell") ? "; exit=" + (fact.exitCode ?? "unknown") : ""}${fact.isError ? " — " + codemodeFailureReason(fact.preview, "model") + " [" + fact.ref + "]" : ""}${fact.outputPath ? " Output: " + fact.outputPath : ""}`;
			for (const fact of invocation.facts) if (fact.recoveryError) summary += `\n[CODEMODE_RECOVERY_UNAVAILABLE] ${fact.ref}: ${fact.recoveryError}. Do not repeat completed tools.`;
			for (const fact of invocation.facts) if (fact.evicted && fact.displayLimited) summary += `\n[CODEMODE_REF_EVICTED] ${fact.ref}: result left the memory cache.${fact.outputPath ? " Recover with read: " + fact.outputPath : " Recovery unavailable."}`;
			if (failed) summary += "\nCompleted tool side effects are not rolled back. Do not automatically retry mutations.";
			const summaryBlock: TextContent & { projectionPrefix?: number } = { type: "text", text: summary };
			content.unshift(summaryBlock);
			let projected: (TextContent | ImageContent)[];
			try { projected = await capCodemodeOutput(content, outputTokens, imageFiles?.notice, imageFiles); }
			finally { if (imageFiles) imageFiles.ownedFiles = undefined; }
			summary = summaryBlock.text;
			const first = projected[0];
			if (imageFiles?.saved && first?.type === "text" && first.text.length >= imagePrefix && summary.startsWith(first.text)) {
				(first as TextContent & { projectionPrefix?: number }).projectionPrefix = imagePrefix;
			}
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
			return { content: projected, isError: failed, details: { codemode: { version: 1, scriptOk: result.ok, handledFailures, displayLimited: invocation.displayLimited || projected !== content, summaryDigest: codemodeTextDigest(displayedSummary), calls: invocation.facts, runtimeCalls: result.calls, imageFiles } } };
		} catch (error) {
			this.documentationSnapshot = undefined;
			await context.finish();
			if (invocation.pending) await new Promise<void>(resolve => { invocation.resolveIdle = resolve; });
			invocation.facts.sort(compareChildSequence);
			return { content: [{ type: "text" as const, text: `[CODEMODE_FAILED] ${message(error)}. Completed tool side effects are not rolled back.` }],
				isError: true, details: { codemode: { version: 1, scriptOk: false, calls: invocation.facts } } };
		} finally {
			if (signal?.aborted) this.documentationSnapshot = undefined;
			invocation.records.clear();
			invocation.evicted.clear();
			invocation.recovering.clear();
			invocation.shown.length = 0;
			invocation.retainedChars = invocation.retainedImageChars = invocation.shownChars = invocation.shownImageChars = 0;
			this.current = undefined;
		}
	}
	async close(): Promise<void> {
		this.closed = true;
		this.pendingStore = undefined;
		this.restoreError = undefined;
		this.documentationSnapshot = undefined;
		try {
			await this.sandbox?.close();
		} finally {
			this.sandbox = undefined;
			this.tools = EMPTY_TOOLS;
			this.descriptors.length = 0;
			this.identifiers.clear();
			this.identifierNames.clear();
			this.documentationVersions = new WeakMap();
			this.documentationRevisionPrefix = undefined;
			this.definition.description = CODEMODE_DESCRIPTION;
			this.store.reset();
			this.clearReadEvidence();
		}
	}
}
