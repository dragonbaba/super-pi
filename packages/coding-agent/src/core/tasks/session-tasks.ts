import type { ToolInvocationAuthorization } from "@super-pi/agent-core";
import type { EventBus } from "../event-bus.ts";
import type { ExtensionContext, ExtensionRuntime, HandlerFn, RegisteredCommand, ToolCallEvent, ToolDefinition } from "../extensions/types.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { attachBackgroundShellLaunch, attachForegroundShellLaunch } from "../tools/shell-background.ts";
import { attachShellCwdBinding, getShellCwdBinding, prepareShellCwd, type ShellCwdBinding } from "../tools/shell-cwd.ts";
import { BACKGROUND_SHELL_OWNER_EVENT, BackgroundShellTasks } from "./background-shell.ts";
import type { TaskHost } from "./managed-tasks.ts";

const STALE = "Shell task invocation is stale; submit a new request in the current session.";
const LIFECYCLE_EVENTS = new Set(["session_start", "session_before_tree", "session_tree", "session_before_shutdown", "session_shutdown"]);
type ShellValues = { command: string; cwd: string; timeout?: number; purpose?: string; background?: boolean };

/** Invocation ownership only. Existing extension authorization remains the terminal authority when present. */
class NativeShellInvocation implements ToolInvocationAuthorization {
	readonly finalAuthority = true;
	private transferred = false;
	private input: object | undefined;
	private values: ShellValues | undefined;
	private binding: ShellCwdBinding | undefined;
	private owner: BackgroundShellTasks | undefined;
	private ctx: ExtensionContext | undefined;
	private runtime: ExtensionRuntime | undefined;
	private authority: AbortSignal | undefined;
	private readonly sessionId: string;
	private readonly sessionCwd: string;
	private readonly callId: string;
	private readonly toolName: string;
	constructor(input: object, values: ShellValues, binding: ShellCwdBinding | undefined, owner: BackgroundShellTasks,
		ctx: ExtensionContext, runtime: ExtensionRuntime, authority: AbortSignal, sessionId: string, sessionCwd: string, callId: string, toolName: string) {
		this.input = input; this.values = values; this.binding = binding; this.owner = owner;
		this.ctx = ctx; this.runtime = runtime; this.sessionId = sessionId; this.sessionCwd = sessionCwd;
		this.callId = callId; this.toolName = toolName;
		this.authority = authority;
	}

	consume(args: unknown, id: string, name: string, signal?: AbortSignal): unknown {
		try {
			const { ctx, runtime, values, binding, owner, authority, sessionId, sessionCwd } = this;
			if (!ctx || !runtime || !values || !binding || !owner || !authority || args !== this.input || id !== this.callId || name !== this.toolName) throw new Error(STALE);
			signal?.throwIfAborted();
			if (getShellCwdBinding(args) !== binding || binding.isReleased) throw new Error(STALE);
			for (const key of ["command", "cwd", "timeout", "purpose", "background"] as const) {
				const descriptor = Object.getOwnPropertyDescriptor(args, key);
				if ((descriptor && !("value" in descriptor)) || descriptor?.value !== values[key]) throw new Error(STALE);
			}
			const assertCurrent = () => {
				runtime.assertActive();
				authority.throwIfAborted();
				if (ctx.cwd !== sessionCwd || ctx.sessionManager.getSessionId() !== sessionId) throw new Error(STALE);
			};
			assertCurrent();
			owner.assertAvailable(ctx, name);
			const approved = { ...values };
			binding.setAuthority(assertCurrent);
			attachShellCwdBinding(approved, binding);
			if (values.background) attachBackgroundShellLaunch(approved, owner.createLaunch(name, id, values.command, binding.canonical, ctx, assertCurrent));
			else attachForegroundShellLaunch(approved, owner.createForegroundLaunch(name, id, values.command, binding.canonical, ctx, assertCurrent, () => binding.beforeSpawn(binding.canonical)));
			this.transferred = true;
			return approved;
		} finally { this.release(); }
	}
	release(): void {
		if (!this.transferred) this.binding?.release();
		this.input = undefined; this.values = undefined; this.binding = undefined;
		this.owner = undefined; this.ctx = undefined; this.runtime = undefined;
		this.authority = undefined;
	}
}

/** Explicit native contribution, assembled before optional extension factories; never an Extension entry. */
export class SessionTasks {
	definition!: ToolDefinition;
	command!: RegisteredCommand;
	readonly shell: BackgroundShellTasks;
	private readonly handlers = new Map<string, HandlerFn[]>();
	private readonly stopDiscovery: () => void;
	private disposal: Promise<void> | undefined;
	private readonly runtime: ExtensionRuntime;
	constructor(runtime: ExtensionRuntime, events: EventBus) {
		this.runtime = runtime;
		const ownedEvents: EventBus = {
			emit: events.emit,
			on: (channel, handler) => runtime.trackEventBusSubscription(events.on(channel, handler)),
		};
		const host: TaskHost = {
			events: ownedEvents,
			getAllTools: () => runtime.getAllTools(),
			sendMessage: (message, options) => runtime.sendMessage(message, options),
			registerTool: definition => { this.definition = definition as ToolDefinition; },
			registerCommand: (name, options) => { this.command = { ...options, name, sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }) }; },
			addTaskGuidance: guidance => { this.definition.promptGuidelines = [guidance]; },
			on: (event, handler) => {
				if (!LIFECYCLE_EVENTS.has(event)) throw new Error(`Unsupported native task event: ${event}`);
				let handlers = this.handlers.get(event);
				if (!handlers) this.handlers.set(event, handlers = []);
				handlers.push(handler as HandlerFn);
			},
		};
		this.shell = new BackgroundShellTasks(host, runtime.executionBoundary);
		runtime.executionBoundary.register("native-shell", { revoke: this.shell.revokeExecution, drain: this.shell.drainExecution });
		this.stopDiscovery = ownedEvents.on(BACKGROUND_SHELL_OWNER_EVENT, request => { (request as { owner?: BackgroundShellTasks }).owner = this.shell; });
	}
	hasHandlers(event: string): boolean { return event === "tool_call" || event === "session_shutdown" || this.handlers.has(event); }
	async emit(event: { type: string }, ctx: ExtensionContext): Promise<unknown> {
		if (event.type === "session_shutdown") return this.dispose();
		const handlers = this.handlers.get(event.type);
		if (handlers) for (const handler of handlers) {
			const result = await handler(event, ctx);
			if (result && (result as { cancel?: boolean }).cancel) return result;
		}
	}
	async prepareInvocation(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolInvocationAuthorization | undefined> {
		this.runtime.executionBoundary.assertCurrent();
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const input = event.input as ShellValues;
		if (input.background !== true && (event.parentToolCallId !== undefined || typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 7200)) return;
		if (typeof input.command !== "string" || typeof input.cwd !== "string") return;
		if (input.background) this.shell.assertAvailable(ctx, event.toolName);
		else if (!this.shell.canManageForeground(ctx, event.toolName)) return;
		const sessionId = ctx.sessionManager.getSessionId(), sessionCwd = ctx.cwd;
		const authority = this.shell.authoritySignal;
		const values: ShellValues = { command: input.command, cwd: input.cwd, timeout: input.timeout, purpose: input.purpose, background: input.background };
		const binding = await prepareShellCwd(input, sessionCwd);
		try {
			this.runtime.assertActive();
			authority.throwIfAborted();
			return new NativeShellInvocation(input, values, binding, this.shell, ctx, this.runtime, authority, sessionId, sessionCwd, event.toolCallId, event.toolName);
		} catch (error) { binding?.release(); throw error; }
	}
	dispose(): Promise<void> { return this.disposal ??= this.close(); }
	private async close(): Promise<void> {
		this.stopDiscovery();
		try { await this.shell.dispose(); }
		finally { this.handlers.clear(); }
	}
}
