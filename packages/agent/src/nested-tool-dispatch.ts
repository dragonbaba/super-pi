import type { AgentTool, AgentToolCall, AgentToolExecutionContext, NestedToolResultMessage } from "./types.ts";

export const MAX_NESTED_TOOL_CALLS = 256;
export const MAX_NESTED_READ_CONCURRENCY = 4;
const EMPTY_TOOLS: readonly AgentTool<any>[] = Object.freeze([]);

type InvokeNestedTool = (call: AgentToolCall, tool: AgentTool<any> | undefined, signal: AbortSignal) => Promise<NestedToolResultMessage>;
interface PendingCall {
	call: AgentToolCall;
	resolve: (result: NestedToolResultMessage) => void;
	reject: (error: unknown) => void;
}
function observeRejection(): void {}
export function isConcurrentNestedRead(tool: AgentTool<any> | undefined): boolean {
	return tool?.executionPath?.access === "read" && tool.executionMode !== "sequential"
		&& !tool.orchestration && !tool.interactionBoundary && !tool.modelOnly;
}

/** One owner per orchestration invocation. No per-progress callbacks or global scratch. */
export class NestedToolDispatch implements AgentToolExecutionContext {
	readonly parentToolCallId: string;
	private getCurrentTools: (() => readonly AgentTool<any>[]) | undefined;
	private invoke: InvokeNestedTool | undefined;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private readonly pending: Array<PendingCall | undefined> = [];
	private pendingIndex = 0;
	private issued = 0;
	private active = 0;
	private writing = false;
	private accepting = true;
	private idle: Promise<void> | undefined;
	private resolveIdle: (() => void) | undefined;
	private toolSnapshot: readonly AgentTool<any>[] | undefined;
	private readonly toolsByName = new Map<string, AgentTool<any>>();
	hasErrors = false;
	completedCalls = 0;
	maxActive = 0;
	private terminationSamples = 0;
	private allChildrenTerminate = true;
	get shouldTerminate(): boolean { return this.terminationSamples > 0 && this.allChildrenTerminate; }
	observeTermination(terminate: boolean | undefined): void {
		this.terminationSamples++;
		this.allChildrenTerminate &&= terminate === true;
	}

	constructor(parentToolCallId: string, getTools: () => readonly AgentTool<any>[], invoke: InvokeNestedTool, signal?: AbortSignal) {
		this.parentToolCallId = parentToolCallId;
		this.getCurrentTools = getTools;
		this.invoke = invoke;
		this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
	}

	getTools(): readonly AgentTool<any>[] {
		return this.getCurrentTools?.() ?? EMPTY_TOOLS;
	}

	private findTool(name: string): AgentTool<any> | undefined {
		const tools = this.getTools();
		if (tools !== this.toolSnapshot) {
			this.toolsByName.clear();
			for (let index = 0; index < tools.length; index++) {
				const tool = tools[index]!;
				if (!this.toolsByName.has(tool.name)) this.toolsByName.set(tool.name, tool);
			}
			this.toolSnapshot = tools;
		}
		return this.toolsByName.get(name);
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
		const result = new Promise<NestedToolResultMessage>((resolve, reject) => {
			this.pending.push({ call, resolve, reject });
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
		try {
			const result = await this.invoke!(entry.call, tool, this.signal);
			this.hasErrors ||= result.isError;
			entry.resolve(result);
		} catch (error) {
			this.hasErrors = true;
			entry.reject(error);
		} finally {
			this.completedCalls++;
			this.active--;
			this.writing = false;
			this.pump();
		}
	}

	/** Wait for children, including calls whose promises the script did not await. */
	async finish(): Promise<boolean> { await this.close(); return this.hasErrors; }

	async close(): Promise<void> {
		this.accepting = false;
		this.controller.abort();
		try {
			if (this.active > 0 || this.pendingIndex < this.pending.length) {
				this.idle ??= new Promise<void>(resolve => { this.resolveIdle = resolve; });
				await this.idle;
			}
		} finally {
			this.pending.length = 0;
			this.pendingIndex = 0;
			this.toolSnapshot = undefined;
			this.toolsByName.clear();
			this.getCurrentTools = undefined;
			this.invoke = undefined;
			this.resolveIdle = undefined;
			this.idle = undefined;
		}
	}
}
