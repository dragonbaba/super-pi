import type { AgentTool, AgentToolCall, AgentToolExecutionContext, NestedToolResultMessage } from "./types.ts";

export const MAX_NESTED_TOOL_CALLS = 256;
export const MAX_NESTED_READ_CONCURRENCY = 4;
/** After cancellation, children get this long to settle before the parent stops waiting for them. */
export const NESTED_CANCEL_GRACE_MS = 5_000;
const EMPTY_TOOLS: readonly AgentTool<any>[] = Object.freeze([]);

type InvokeNestedTool = (call: AgentToolCall, tool: AgentTool<any> | undefined, signal: AbortSignal) => Promise<NestedToolResultMessage>;
interface PendingCall {
	call: AgentToolCall;
	resolve: (result: NestedToolResultMessage) => void;
	reject: (error: unknown) => void;
	/** `performance.now()` when the orchestrator issued the call, before any queueing. */
	issuedAt: number;
}
function observeRejection(): void {}
function findByName(tools: readonly AgentTool<any>[], name: string): AgentTool<any> | undefined {
	for (let index = 0; index < tools.length; index++) {
		if (tools[index]!.name === name) return tools[index];
	}
	return undefined;
}
/** Close-path only: one timer per orchestration call whose children outlive cancellation. */
function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms, false);
		void promise.then(() => { clearTimeout(timer); resolve(true); });
	});
}
export function isConcurrentNestedRead(tool: AgentTool<any> | undefined): boolean {
	return tool?.executionPath?.access === "read" && tool.executionMode !== "sequential"
		&& !tool.orchestration && !tool.interactionBoundary && !tool.modelOnly;
}

/** One owner per orchestration invocation. No per-progress callbacks or global scratch. */
export class NestedToolDispatch implements AgentToolExecutionContext {
	readonly parentToolCallId: string;
	private getCurrentTools: (() => readonly AgentTool<any>[]) | undefined;
	private turnTools: readonly AgentTool<any>[] | undefined;
	/** Live tool names when this dispatch started. */
	private baseline: Set<string> | undefined;
	private invoke: InvokeNestedTool | undefined;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private readonly pending: Array<PendingCall | undefined> = [];
	private readonly running = new Set<PendingCall>();
	private readonly cancelGraceMs: number;
	private pendingIndex = 0;
	private issued = 0;
	private active = 0;
	private writing = false;
	private accepting = true;
	private idle: Promise<void> | undefined;
	private resolveIdle: (() => void) | undefined;
	hasErrors = false;
	completedCalls = 0;
	/** Children that ignored cancellation past the grace period; they may still change state. */
	abandonedCalls = 0;
	maxActive = 0;
	private terminationSamples = 0;
	private allChildrenTerminate = true;
	get shouldTerminate(): boolean { return this.terminationSamples > 0 && this.allChildrenTerminate; }
	observeTermination(terminate: boolean | undefined): void {
		this.terminationSamples++;
		this.allChildrenTerminate &&= terminate === true;
	}

	/**
	 * `getTools` returns the live tools. `turnTools`, when given, is the active turn context's
	 * tool set; the live tool names seen now become the baseline that later live changes are judged against.
	 */
	constructor(parentToolCallId: string, getTools: () => readonly AgentTool<any>[], invoke: InvokeNestedTool, signal?: AbortSignal,
		cancelGraceMs = NESTED_CANCEL_GRACE_MS, turnTools?: readonly AgentTool<any>[]) {
		this.parentToolCallId = parentToolCallId;
		this.cancelGraceMs = cancelGraceMs;
		this.getCurrentTools = getTools;
		if (turnTools) {
			const live = getTools();
			const baseline = new Set<string>();
			for (let index = 0; index < live.length; index++) baseline.add(live[index]!.name);
			this.turnTools = turnTools;
			this.baseline = baseline;
		}
		this.invoke = invoke;
		this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
	}

	getTools(): readonly AgentTool<any>[] {
		if (!this.getCurrentTools) return EMPTY_TOOLS;
		return this.turnTools ?? this.getCurrentTools();
	}

	/**
	 * The live array may be mutated in place, so array identity proves nothing about its
	 * contents. Scan it on every lookup: authorization must see removals; no allocation.
	 * With a turn context, that context decides whether a name is allowed unless the name was
	 * added to or removed from the live tools after this dispatch started. Membership, not
	 * wrapper identity, decides: a registry refresh re-wraps every tool without changing which
	 * names the turn allowed. An allowed name runs its latest live wrapper, so a replaced
	 * implementation still fails isCurrentTool for a call prepared before the replacement.
	 */
	findTool(name: string): AgentTool<any> | undefined {
		const live = findByName(this.getCurrentTools?.() ?? EMPTY_TOOLS, name);
		const turnTools = this.turnTools, baseline = this.baseline;
		if (!turnTools || !baseline || baseline.has(name) !== (live !== undefined)) return live;
		const turn = findByName(turnTools, name);
		return turn === undefined ? undefined : live ?? turn;
	}

	isCurrentTool(tool: AgentTool<any>): boolean {
		return this.findTool(tool.name) === tool;
	}

	callTool(name: string, args: Record<string, unknown>): Promise<NestedToolResultMessage> {
		if (!this.accepting || this.signal.aborted || this.issued >= MAX_NESTED_TOOL_CALLS) {
			this.hasErrors = true;
			const rejected = Promise.reject<NestedToolResultMessage>(new Error("Nested tool dispatch is closed, cancelled, or at its 256-call limit"));
			void rejected.catch(observeRejection);
			return rejected;
		}
		const call: AgentToolCall = { type: "toolCall", id: `${this.parentToolCallId}:nested:${++this.issued}`, name, arguments: args };
		const issuedAt = performance.now();
		const result = new Promise<NestedToolResultMessage>((resolve, reject) => {
			this.pending.push({ call, resolve, reject, issuedAt });
		});
		// Scripts may intentionally omit await. The owner still observes every failure.
		void result.catch(observeRejection);
		this.pump();
		return result;
	}

	private pump(): void {
		while (!this.writing && this.active < MAX_NESTED_READ_CONCURRENCY && this.pendingIndex < this.pending.length) {
			const entry = this.pending[this.pendingIndex]!;
			const tool = this.findTool(entry.call.name);
			const readonly = isConcurrentNestedRead(tool);
			if (!readonly && this.active > 0) return;
			this.pending[this.pendingIndex++] = undefined;
			this.active++;
			this.writing = !readonly;
			if (this.active > this.maxActive) this.maxActive = this.active;
			void this.run(entry, tool);
		}
		if (this.active === 0 && this.pendingIndex === this.pending.length) {
			this.pending.length = 0;
			this.pendingIndex = 0;
			this.resolveIdle?.();
			this.resolveIdle = undefined;
			this.idle = undefined;
		}
	}

	private async run(entry: PendingCall, tool: AgentTool<any> | undefined): Promise<void> {
		this.running.add(entry);
		try {
			const result = await this.invoke!(entry.call, tool, this.signal);
			this.hasErrors ||= result.isError;
			entry.resolve(result);
		} catch (error) {
			this.hasErrors = true;
			entry.reject(error);
		} finally {
			this.running.delete(entry);
			this.completedCalls++;
			this.active--;
			this.writing = false;
			this.pump();
		}
	}

	/**
	 * When a running child was issued. Serialized siblings reach policy hooks only after earlier
	 * calls finish, so hooks compare this time, not their own admission order.
	 */
	issuedAt(callId: string): number | undefined {
		for (const entry of this.running) if (entry.call.id === callId) return entry.issuedAt;
		return undefined;
	}

	/** Wait for children, including calls whose promises the script did not await. */
	async finish(): Promise<boolean> { await this.close(); return this.hasErrors; }

	/** A child that ignores its abort signal must not wedge the parent past its deadline. */
	private abandon(): void {
		this.hasErrors = true;
		const error = new Error(`Nested tool ignored cancellation for ${this.cancelGraceMs} ms; it may still be running or changing state`);
		for (const entry of this.running) { this.abandonedCalls++; entry.reject(error); }
		this.running.clear();
		for (let index = this.pendingIndex; index < this.pending.length; index++) this.pending[index]?.reject(new Error("Nested tool dispatch closed before this call started"));
	}

	async close(): Promise<void> {
		this.accepting = false;
		this.controller.abort();
		try {
			// An abandoned child is never awaited again; later closes return at once.
			if (this.abandonedCalls === 0 && (this.active > 0 || this.pendingIndex < this.pending.length)) {
				this.idle ??= new Promise<void>(resolve => { this.resolveIdle = resolve; });
				if (!await settlesWithin(this.idle, this.cancelGraceMs)) this.abandon();
			}
		} finally {
			this.pending.length = 0;
			this.pendingIndex = 0;
			this.getCurrentTools = undefined;
			this.turnTools = undefined;
			this.baseline = undefined;
			this.invoke = undefined;
			this.resolveIdle = undefined;
			this.idle = undefined;
		}
	}
}
