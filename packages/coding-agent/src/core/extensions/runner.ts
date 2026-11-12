import type { ToolDefinition } from "./types.ts";
import { getShellCwdBinding } from "../tools/shell-cwd.ts";
import type { SessionExecutionBoundary } from "../execution-boundary.ts";
import type { NativePolicyInvocation } from "../execution-policy.ts";
import { FILE_RESULT_ENTRY } from "../files/file-result-protocol.ts";
/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { AgentMessage, ToolInvocationAuthorization } from "@super-pi/agent-core";
import type { ImageContent, Model, Provider, ProviderHeaders } from "@super-pi/ai";
import type { KeyId } from "@super-pi/tui";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import { createScopedExtensionIdentifier } from "../prefix-manifest.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions, SystemPromptComposition } from "../system-prompt.ts";
import { setOwnProperty } from "../../utils/record.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	SupplementalSummaryHookScope,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	EntryRenderer,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionMode,
	HandlerFn,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageUpdateEvent,
	MessageRenderer,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	ProviderRequestAuthSnapshot,
	RegisteredCommand,
	RegisteredTool,
	RegisteredExtensionObserver,
	ReplacedSessionContext,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeCompactEvent,
	CompactionStrategyHandler,
	RegisteredCompactionStrategy,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeShutdownResult,
	SessionBeforeTreeResult,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolRenderers,
	ToolResultEvent,
	ToolResultEventResult,
	ToolExecutionUpdateEvent,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			setOwnProperty(builtinKeybindings, normalizedKey, {
				keybinding,
				restrictOverride,
			});
		}
	}
	return builtinKeybindings;
};

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" | "session_before_shutdown" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeShutdownResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: TEvent extends { type: "session_before_shutdown" }
					? SessionBeforeShutdownResult | undefined
					: undefined;

export interface ExtensionRunnerScheduler {
	now(): number;
	schedule(callback: () => void, delayMs: number): unknown;
	cancel(handle: unknown): void;
}

export type ExtensionHookTimeoutPolicy = "fail-open" | "fail-closed";

export interface ExtensionRunnerOptions {
	scheduler?: ExtensionRunnerScheduler;
	hookTimeouts?: {
		/** Safety and veto hooks always fail closed when a timeout is configured. */
		safety?: { timeoutMs: number };
		/** Transform hooks require an explicit timeout policy. */
		transform?: { timeoutMs: number; onTimeout: ExtensionHookTimeoutPolicy };
		/** Interactive hooks are unbounded unless the host explicitly configures them. */
		interaction?: { timeoutMs: number; onTimeout: ExtensionHookTimeoutPolicy };
		/** Legacy lifecycle handlers are unbounded unless explicitly configured. */
		lifecycle?: { timeoutMs: number; onTimeout: ExtensionHookTimeoutPolicy };
	};
}

function validateTimeoutMs(name: string, timeoutMs: number): void {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new RangeError(`${name} must be a finite non-negative number`);
	}
}

function validateHookTimeouts(options: ExtensionRunnerOptions): void {
	for (const category of ["safety", "transform", "interaction", "lifecycle"] as const) {
		const configured = options.hookTimeouts?.[category];
		if (configured) validateTimeoutMs(`hookTimeouts.${category}.timeoutMs`, configured.timeoutMs);
	}
}

export type ExtensionObserverDiagnostic =
	| { type: "observer-error"; extensionPath: string; event: string; error: unknown }
	| { type: "observer-slow"; extensionPath: string; event: string; durationMs: number }
	| { type: "observer-disabled"; extensionPath: string; event: string };

export interface ExtensionObserverDeliveryStats {
	received: number;
	delivered: number;
	errors: number;
	slow: number;
	disabled: number;
	timeouts: number;
	durationP95Ms: number;
}

export interface ExtensionHookDeliveryStats {
	timeouts: number;
}

export class ExtensionHookTimeoutError extends Error {
	readonly extensionPath: string;
	readonly event: string;
	readonly timeoutMs: number;

	constructor(extensionPath: string, event: string, timeoutMs: number) {
		super(`Extension hook "${event}" from "${extensionPath}" timed out after ${timeoutMs}ms`);
		this.name = "ExtensionHookTimeoutError";
		this.extensionPath = extensionPath;
		this.event = event;
		this.timeoutMs = timeoutMs;
	}
}

type HookCategory = "safety" | "transform" | "interaction" | "lifecycle";
type ObserverEvent = MessageUpdateEvent | ToolExecutionUpdateEvent;

class ExtensionObserverTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Extension observer timed out after ${timeoutMs}ms`);
		this.name = "ExtensionObserverTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

const DEFAULT_EXTENSION_RUNNER_SCHEDULER: ExtensionRunnerScheduler = {
	now: () => performance.now(),
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const OBSERVER_DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 1_000, 5_000, 30_000] as const;
const SAFETY_HOOK_EVENTS = new Set([
	"project_trust",
	"tool_call",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_before_tree",
]);
const TRANSFORM_HOOK_EVENTS = new Set([
	"context",
	"before_provider_request",
	"before_provider_headers",
	"before_agent_start",
	"message_end",
	"tool_result",
]);
const INTERACTION_HOOK_EVENTS = new Set(["input", "user_bash", "session_before_shutdown"]);
// Intercepting calls and explicit completion boundaries only. Ordinary stream,
// progress and observer delivery never acquire this lifecycle ownership.
const OWNED_HOOK_EVENTS = new Set([
	...SAFETY_HOOK_EVENTS, ...TRANSFORM_HOOK_EVENTS, ...INTERACTION_HOOK_EVENTS,
	"agent_end", "agent_settled", "tool_execution_end", "session_compact", "session_compact_failed", "session_tree",
]);

export type ExtensionErrorListener = (error: ExtensionError) => void;

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
): Promise<boolean> {
	let emitted = false, failed = false;
	let failure: unknown;
	try {
		if (extensionRunner.hasHandlers("session_shutdown")) {
			await extensionRunner.emit(event);
			emitted = true;
		}
	} catch (error) { failed = true; failure = error; }
	try {
		// Normal shutdown, replacement and reload must join terminal cleanup.
		const results = await Promise.allSettled([extensionRunner.disposeExecutionBoundary(), extensionRunner.disposeProviderOwners()]);
		for (const result of results) if (result.status === "rejected") throw result.reason;
	} catch (error) { if (!failed) { failed = true; failure = error; } }
	if (failed) throw failure;
	return emitted;
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
	options: ExtensionRunnerOptions = {},
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	validateHookTimeouts(options);
	const scheduler = options.scheduler ?? DEFAULT_EXTENSION_RUNNER_SCHEDULER;
	const timeoutMs = options.hookTimeouts?.safety?.timeoutMs ?? 0;
	const errors: ExtensionError[] = [];
	for (const ext of extensionsResult.extensions) {
		// A single extension may register multiple handlers for the same event.
		// The first project_trust handler that returns yes/no wins; undecided falls through.
		const handlers = ext.handlers.get("project_trust");
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const handlerPromise = handler(event, ctx);
				let handlerResult: ProjectTrustEventResult;
				if (timeoutMs > 0 && handlerPromise && typeof (handlerPromise as PromiseLike<unknown>).then === "function") {
					const timeoutError = new ExtensionHookTimeoutError(ext.path, event.type, timeoutMs);
					let handle: unknown;
					const timeout = new Promise<never>((_resolve, reject) => {
						handle = scheduler.schedule(() => reject(timeoutError), timeoutMs);
					});
					try {
						handlerResult = (await Promise.race([handlerPromise, timeout])) as ProjectTrustEventResult;
					} catch (error) {
						if (error !== timeoutError) throw error;
						errors.push({
							extensionPath: ext.path,
							event: event.type,
							error: timeoutError.message,
							stack: timeoutError.stack,
						});
						// project_trust is a safety decision: timeout is always fail-closed.
						// JavaScript promises cannot be forcibly cancelled; any late result is ignored.
						return { result: { trusted: "no" }, errors };
					} finally {
						if (handle !== undefined) scheduler.cancel(handle);
					}
				} else {
					handlerResult = (await handlerPromise) as ProjectTrustEventResult;
				}
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionPath: ext.path,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

/** Invocation-owned machine deadline. Only actual select/input/confirm waits pause it.
	* Cancellation revokes host authority; it cannot stop arbitrary extension JavaScript.
	*/
class ToolCallDeadline {
	readonly controller = new AbortController();
	readonly cancelled: Promise<never>;
	readonly drained: Promise<void>;
	private reject!: (reason: unknown) => void;
	private finishDrain!: () => void;
	// Delivery, the actual handler and each admitted dialog are separately owned.
	private pending = 1;
	private returnedAuthorization: ToolInvocationAuthorization | undefined;
	private cleanupFailed = false;
	private handle: unknown;
	private remaining: number;
	private startedAt = 0;
	private finished = false;
	private readonly parent: AbortSignal | undefined;
	private readonly scheduler: ExtensionRunnerScheduler;
	private readonly timeoutError: ExtensionHookTimeoutError;
	private readonly owners: Set<ToolCallDeadline>;
	constructor(owners: Set<ToolCallDeadline>, scheduler: ExtensionRunnerScheduler, timeoutError: ExtensionHookTimeoutError, parent?: AbortSignal) {
		this.owners = owners;
		this.scheduler = scheduler;
		this.timeoutError = timeoutError;
		this.remaining = timeoutError.timeoutMs;
		this.parent = parent;
		this.drained = new Promise(resolve => { this.finishDrain = resolve; });
		this.cancelled = new Promise<never>((_resolve, reject) => { this.reject = reject; });
		parent?.addEventListener("abort", this.onParentAbort, { once: true });
		if (parent?.aborted) this.onParentAbort();
		else this.resume();
	}
	private readonly onParentAbort = (): void => { this.revoke(this.parent?.reason ?? new Error("Tool approval aborted")); };
	private readonly expire = (): void => { this.handle = undefined; this.revoke(this.timeoutError); };
	revoke(reason?: unknown): void {
		if (this.finished) return;
		if (reason === undefined) {
			const error = new Error("Tool approval is obsolete"); error.stack = error.message; reason = error;
		}
		this.pause();
		this.reject(reason);
		this.controller.abort(reason);
	}
	pause(): void {
		if (this.handle === undefined) return;
		this.scheduler.cancel(this.handle);
		this.handle = undefined;
		this.remaining = Math.max(0, this.remaining - (this.scheduler.now() - this.startedAt));
	}
	resume(): void {
		if (this.finished || this.controller.signal.aborted || this.timeoutError.timeoutMs === 0) return;
		this.startedAt = this.scheduler.now();
		this.handle = this.scheduler.schedule(this.expire, this.remaining);
	}
	assertCurrent(): void { this.controller.signal.throwIfAborted(); }
	trackHandler(result: unknown): Promise<unknown> {
		this.pending++;
		const operation = Promise.resolve(result);
		void operation.then(this.onHandlerResult, this.finishActual);
		return operation;
	}
	trackDialog<T>(operation: Promise<T>): Promise<T> {
		this.pending++;
		void operation.then(this.finishActual, this.finishActual);
		return operation;
	}
	private readonly onHandlerResult = (result: unknown): void => {
		try {
			this.returnedAuthorization = (result as ToolCallEventResult | undefined)?.finalAuthorization;
			if (this.controller.signal.aborted) this.releaseReturnedAuthorization();
		} catch { this.cleanupFailed = true; }
		finally { this.finishActual(); }
	};
	private readonly finishActual = (): void => {
		if (--this.pending !== 0) return;
		if (!this.cleanupFailed) this.owners.delete(this);
		this.finishDrain();
	};
	private releaseReturnedAuthorization(): void {
		try { this.returnedAuthorization?.release(); this.returnedAuthorization = undefined; }
		catch { this.cleanupFailed = true; }
	}
	takeResult(): void { this.returnedAuthorization = undefined; }
	async drain(): Promise<void> {
		await this.drained;
		if (this.cleanupFailed) throw new Error("Tool hook authorization cleanup is unconfirmed; execution remains closed.");
	}
	dispose(): void {
		if (this.finished) return;
		this.pause();
		this.finished = true;
		this.parent?.removeEventListener("abort", this.onParentAbort);
		const reason = new Error("Tool hook invocation ended"); reason.stack = reason.message;
		this.controller.abort(reason);
		this.releaseReturnedAuthorization();
		this.finishActual();
	}
}

/** Bounded live ownership only; no historical tool-call map or waiting queue. */
/** Shared per epoch only when there is no policy, hook, or native preparation.
 * It carries no operation grant, input snapshot, or asynchronous producer. */
class OrdinaryToolEpoch implements ToolInvocationAuthorization {
	private live = true;
	readonly generation: number;
	private readonly boundary: SessionExecutionBoundary;
	constructor(boundary: SessionExecutionBoundary) { this.boundary = boundary; this.generation = boundary.generation; }
	consume(args: unknown, _id: string, _name: string, signal?: AbortSignal): unknown {
		if (!this.live) throw new Error("[EXECUTION_BOUNDARY_CHANGED] Ordinary tool epoch was revoked and is obsolete");
		signal?.throwIfAborted(); this.boundary.assertCurrent(this.generation); return args;
	}
	release(): void {}
	revoke(): void { this.live = false; }
}

class PendingToolAuthorization implements ToolInvocationAuthorization {
	policy?: NativePolicyInvocation;
	private checks: (ToolInvocationAuthorization | undefined)[] = [];
	private authority: ToolInvocationAuthorization | undefined;
	// One rejected/late delivery remains owned until its release succeeds. A
	// rejected add ends collection, so this slot cannot become an unbounded queue.
	private incoming: ToolInvocationAuthorization | undefined;
	private collecting = true;
	private live = true;
	private releasing = false;
	private owners: Set<PendingToolAuthorization> | undefined;
	private boundary: SessionExecutionBoundary | undefined;
	private readonly generation: number;
	constructor(owners: Set<PendingToolAuthorization>, boundary: SessionExecutionBoundary, generation: number) {
		this.owners = owners; owners.add(this); this.boundary = boundary; this.generation = generation;
	}
	add(check: ToolInvocationAuthorization): void {
		this.incoming = check;
		if (!this.live || this.checks.length + (this.authority ? 1 : 0) >= 32) {
			throw new Error("Blocked by policy: final authorization capacity or lifetime exceeded");
		}
		if (check.finalAuthority) {
			if (this.authority) throw new Error("Blocked by policy: conflicting final authority checks");
			this.authority = check;
		} else this.checks.push(check);
		this.incoming = undefined;
	}
	get hasChecks(): boolean { return this.authority !== undefined || this.checks.length !== 0; }
	finishCollection(handedOff: boolean): void {
		this.collecting = false;
		if (!handedOff || !this.live) this.release();
	}
	consume(args: unknown, id: string, name: string, signal?: AbortSignal): unknown {
		let terminalValues: unknown;
		let handedOff = false;
		try {
			if (!this.live || signal?.aborted) throw new Error("Blocked by policy: final authorization is obsolete");
			this.boundary!.assertCurrent(this.generation);
      this.policy?.consume(args, id, name, signal);
      // An ordinary tool needs only the epoch gate; permission policy still ran
      // in tool_call. Native mutation grants retain their private value checks.
      if (!this.authority && this.checks.length === 0) return args;
      // Native files have one terminal authority and own a private prepared payload.
      if (name === "file_batch" || name === "edit" || name === "write" || name === "copy" || name === "delete" || name === "move") {
        if (this.checks.length || !this.authority) throw new Error("Blocked by policy: file operation requires one terminal authority");
        const authority = this.authority;
        try { return authority.consume(args, id, name, signal); }
        finally { authority.release(); this.authority = undefined; }
      }
      // Shell snapshots continue through their existing agreement checks.
			if (name !== "bash" && name !== "powershell") throw new Error("Blocked by policy: unsupported final authorization tool");
			let command: unknown, timeout: unknown, cwd: unknown, purpose: unknown, background: unknown;
			for (let i = 0; i < this.checks.length; i++) {
				const check = this.checks[i]!;
				this.checks[i] = undefined;
				try {
				const approved = check.consume(args, id, name, signal);
				if (!approved || typeof approved !== "object" || approved === args) {
					throw new Error("Blocked by policy: final authorization did not supply private execution values");
				}
				const approvedCommand = Object.getOwnPropertyDescriptor(approved, "command");
				const approvedTimeout = Object.getOwnPropertyDescriptor(approved, "timeout");
				const approvedCwd = Object.getOwnPropertyDescriptor(approved, "cwd");
				const approvedPurpose = Object.getOwnPropertyDescriptor(approved, "purpose");
				const approvedBackground = Object.getOwnPropertyDescriptor(approved, "background");
				if (!approvedCommand || !("value" in approvedCommand) || typeof approvedCommand.value !== "string"
					|| (approvedTimeout && (!("value" in approvedTimeout)
						|| (approvedTimeout.value !== undefined && typeof approvedTimeout.value !== "number")))
					|| (approvedCwd && (!("value" in approvedCwd) || (approvedCwd.value !== undefined && typeof approvedCwd.value !== "string")))
					|| (approvedPurpose && (!("value" in approvedPurpose) || (approvedPurpose.value !== undefined && typeof approvedPurpose.value !== "string")))
					|| (approvedBackground && (!("value" in approvedBackground) || (approvedBackground.value !== undefined && typeof approvedBackground.value !== "boolean")))) {
					throw new Error("Blocked by policy: invalid final authorization values");
				}
				if (i === 0) { command = approvedCommand.value; timeout = approvedTimeout?.value; cwd = approvedCwd?.value; purpose = approvedPurpose?.value; background = approvedBackground?.value; }
				else if (command !== approvedCommand.value || timeout !== approvedTimeout?.value || cwd !== approvedCwd?.value || purpose !== approvedPurpose?.value || background !== approvedBackground?.value) {
					throw new Error("Blocked by policy: final authorization snapshots disagree");
				}
				} finally {
					try { check.release(); }
					catch (error) { this.checks[i] = check; throw error; }
				}
			}
			if (!this.live || signal?.aborted || !this.authority) throw new Error("Blocked by policy: final authorization is obsolete or missing");
			this.boundary!.assertCurrent(this.generation);
			// All auxiliary consume/release callbacks have settled. The one terminal
			// guard checks current authority, returns private values, and self-releases.
			const authority = this.authority;
			const approved = terminalValues = authority.consume(args, id, name, signal) as { command: unknown; timeout: unknown; cwd: unknown; purpose: unknown; background: unknown };
			this.authority = undefined;
			if (this.checks.length && (command !== approved.command || timeout !== approved.timeout || cwd !== approved.cwd || purpose !== approved.purpose || background !== approved.background)) {
				throw new Error("Blocked by policy: final authorization snapshots disagree");
			}
			if (!this.live || signal?.aborted) throw new Error("Blocked by policy: final authorization is obsolete");
			this.boundary!.assertCurrent(this.generation);
			handedOff = true;
			return approved;
		} finally { if (!handedOff) getShellCwdBinding(terminalValues)?.release(); this.release(); }
	}
	release(): void {
		if (!this.owners || this.releasing) return;
		this.live = false;
		this.boundary = undefined;
		this.releasing = true;
		this.policy?.release(); this.policy = undefined;
		let failed = false;
		try {
			for (let i = 0; i < this.checks.length; i++) {
				try { this.checks[i]?.release(); this.checks[i] = undefined; }
				catch { failed = true; }
			}
			try { this.authority?.release(); this.authority = undefined; }
			catch { failed = true; }
			try { this.incoming?.release(); this.incoming = undefined; }
			catch { failed = true; }
			if (failed) throw new Error("Final authorization cleanup is unconfirmed; execution remains closed.");
			this.checks.length = 0;
			// Revoke may race an awaited producer. Keep the reservation until its
			// actual delivery/finally has run, even if no grant arrived yet.
			if (this.collecting) return;
			this.owners.delete(this);
			this.owners = undefined;
		}
		finally { this.releasing = false; }
	}
}

function ignoreToolRendererRejection(): void {}

export class ExtensionRunner {
	private ordinaryToolEpoch?: OrdinaryToolEpoch;
	private extensions: Extension[];
	private handlerEventTypes: Set<string>;
	private observerEventTypes: Set<string>;
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private observerDiagnosticListeners = new Set<(diagnostic: ExtensionObserverDiagnostic) => void>();
	private readonly scheduler: ExtensionRunnerScheduler;
	private readonly options: ExtensionRunnerOptions;
	private readonly observerDurationBuckets = new Uint32Array(OBSERVER_DURATION_BUCKETS_MS.length);
	private observerReceived = 0;
	private observerDelivered = 0;
	private observerErrors = 0;
	private observerSlow = 0;
	private observerDisabled = 0;
	private observerTimeouts = 0;
	private hookTimeouts = 0;
	private getModel: () => Model<any> | undefined = () => undefined;
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: (revalidateIdentity?: boolean) => boolean = (revalidateIdentity) => revalidateIdentity !== true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private mcpResultInputActions: Pick<ExtensionContextActions, "getMcpResultInputConfigured" | "admitMcpResultInput"> | undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () => ({ cwd: this.cwd });
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private toolCallDeadlines: Set<ToolCallDeadline> | undefined;
	private actualHooks = 0;
	private hooksIdle: Promise<void> | undefined;
	private finishHooks: (() => void) | undefined;
	private readonly finishHook = (): void => {
		if (--this.actualHooks !== 0) return;
		const finish = this.finishHooks;
		this.finishHooks = undefined;
		this.hooksIdle = undefined;
		finish?.();
	};
	private finalAuthorizations: Set<PendingToolAuthorization> | undefined;
	private toolCallDialogOwner: ToolCallDeadline | undefined;
	private rendererToolName: string | undefined;
	private rendererBase: ToolRenderers | undefined;
	private rendererExtensionIndex = 0;
	private rendererResolverIndex = 0;
	private rendererDepth = 0;
	// One callback per runner lifecycle; never capture a tool name/base per lookup.
	private readonly nextToolRenderer = (): ToolRenderers | undefined => {
		const toolName = this.rendererToolName;
		if (toolName === undefined || this.staleMessage) return undefined;
		if (this.rendererDepth >= 128) throw new RangeError("Tool renderer resolution exceeds 128 frames");
		const extensionIndex = this.rendererExtensionIndex;
		const resolverIndex = this.rendererResolverIndex;
		this.rendererDepth++;
		try {
			while (this.rendererExtensionIndex < this.extensions.length) {
				const extension = this.extensions[this.rendererExtensionIndex];
				const resolver = extension.toolRenderers?.[this.rendererResolverIndex++];
				if (!resolver) {
					this.rendererExtensionIndex++;
					this.rendererResolverIndex = 0;
					continue;
				}
				try {
					const result = resolver(toolName, this.nextToolRenderer);
					// A malformed async extension must not leave a rejected promise unobserved.
					if (result && typeof result === "object" && "then" in result) void Promise.resolve(result).catch(ignoreToolRendererRejection);
					if (result !== undefined && (result === null || typeof result !== "object" || "then" in result)) {
						throw new TypeError("Tool renderer resolver must synchronously return renderers or undefined");
					}
					return result;
				} catch (error) {
					this.emitError({ extensionPath: extension.path, event: "tool_renderer",
						error: error instanceof Error ? error.message : String(error) });
					return this.rendererBase;
				}
			}
			return this.rendererBase;
		} finally {
			this.rendererDepth--;
			this.rendererExtensionIndex = extensionIndex;
			this.rendererResolverIndex = resolverIndex;
		}
	};

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
		options: ExtensionRunnerOptions = {},
	) {
		validateHookTimeouts(options);
		this.extensions = extensions;
		this.handlerEventTypes = new Set();
		this.observerEventTypes = new Set();
		for (const extension of extensions) {
			for (const [eventType, handlers] of extension.handlers) {
				if (handlers.length > 0) this.handlerEventTypes.add(eventType);
			}
			for (const [eventType, observers] of extension.observers) {
				if (observers.length > 0) this.observerEventTypes.add(eventType);
			}
		}
		this.options = options;
		this.scheduler = options.scheduler ?? DEFAULT_EXTENSION_RUNNER_SCHEDULER;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		runtime.executionBoundary.register("extension-runner", { revoke: this.revokeExecution, drain: this.drainExecution });
	}

	private readonly revokeExecution = (): void => {
		this.ordinaryToolEpoch?.revoke(); this.ordinaryToolEpoch = undefined;
		try { this.revokeAuthorizations(); }
		finally { for (const deadline of this.toolCallDeadlines ?? []) deadline.revoke(); }
	};
	/** Native session shutdown joins this again after foreground settlement. */
	readonly drainExecution = async (): Promise<void> => {
		const pending: Promise<void>[] = [];
		if (this.hooksIdle) pending.push(this.hooksIdle);
		for (const deadline of this.toolCallDeadlines ?? []) pending.push(deadline.drain());
		const results = await Promise.allSettled(pending);
		for (const result of results) if (result.status === "rejected") throw result.reason;
		if (this.finalAuthorizations?.size) throw new Error("Final authorization cleanup is unconfirmed; execution remains closed.");
	};

	private readonly revokeAuthorizations = (): void => {
		let failure: unknown;
		let failed = false;
		for (const authorization of this.finalAuthorizations ?? []) {
			try { authorization.release(); } catch (error) { failed = true; failure ??= error; }
		}
		if (this.finalAuthorizations?.size === 0) this.finalAuthorizations = undefined;
		if (failed) throw failure;
	};

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig) => void;
			registerNativeProvider?: (provider: Provider) => void;
			unregisterProvider?: (name: string) => void;
		},
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.transitionExecution = actions.transitionExecution;
		this.runtime.waitForExecutionIdle = actions.waitForExecutionIdle;
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.appendFileEntry = actions.appendFileEntry ?? this.appendNativeFileEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.getToolCatalog = actions.getToolCatalog;
		this.runtime.buildProviderRequestPayload = actions.buildProviderRequestPayload;
		this.runtime.withSupplementalSummary = actions.withSupplementalSummary;
		this.runtime.compactProviderRequestPayload = actions.compactProviderRequestPayload;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.getScopedModels = contextActions.getScopedModels;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.mcpResultInputActions = contextActions;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.cwd }));

		// Flush provider registrations queued during extension loading
		for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];
		for (const { provider, extensionPath } of this.runtime.pendingNativeProviderRegistrations) {
			try {
				if (providerActions?.registerNativeProvider) {
					providerActions.registerNativeProvider(provider);
				} else {
					this.modelRegistry.registerProvider(provider);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingNativeProviderRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.registerNativeProvider = (provider) => {
			if (providerActions?.registerNativeProvider) {
				providerActions.registerNativeProvider(provider);
				return;
			}
			this.modelRegistry.registerProvider(provider);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
	}
  /** Standalone ExtensionRunner callers have the same actual append-ID owner as
   * AgentSession. It never infers an ID from a later leaf or emits per-row events. */
  private readonly appendNativeFileEntry = (kind: string, data: unknown): string => {
    if (kind !== FILE_RESULT_ENTRY) throw new Error("Invalid private file entry kind.");
    return this.sessionManager.appendCustomEntry(kind, data);
  };

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		if (this.uiContext !== (uiContext ?? noOpUIContext)) {
			for (const deadline of this.toolCallDeadlines ?? []) deadline.revoke();
		}
		this.uiContext = uiContext ?? noOpUIContext;
		this.mode = mode;
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	/** Presentation-only chain. Base is already looked up; no per-resolution thunk or list. */
	resolveToolRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers | undefined {
		this.assertActive();
		const previousName = this.rendererToolName;
		const previousBase = this.rendererBase;
		const previousExtension = this.rendererExtensionIndex;
		const previousResolver = this.rendererResolverIndex;
		this.rendererToolName = toolName;
		this.rendererBase = base;
		this.rendererExtensionIndex = 0;
		this.rendererResolverIndex = 0;
		try { return this.nextToolRenderer(); }
		finally {
			this.rendererToolName = previousName;
			this.rendererBase = previousBase;
			this.rendererExtensionIndex = previousExtension;
			this.rendererResolverIndex = previousResolver;
		}
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		ownersCleanupStarted = false,
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.ordinaryToolEpoch?.revoke(); this.ordinaryToolEpoch = undefined;
			try { this.revokeAuthorizations(); }
			finally {
				for (const deadline of this.toolCallDeadlines ?? []) deadline.revoke(new Error(message));
				this.mcpResultInputActions = undefined;
				this.runtime.invalidate(message, ownersCleanupStarted);
			}
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	assertExecutionCurrent(): void {
		this.assertActive();
		this.runtime.executionBoundary.assertCurrent();
	}

	getCodexRemoteCompactionEnabled(): boolean {
		this.assertActive();
		return this.runtime.codexRemoteCompactionEnabled;
	}

	getOpenAIResponsesDispatch() {
		return this.runtime.openAIResponsesDispatch;
	}

	getOpenAICodexDispatch() {
		return this.runtime.codexDispatch;
	}

	disposeProviderOwners(): Promise<void> {
		return this.runtime.disposeProviderOwners();
	}
	disposeExecutionBoundary(): Promise<void> { return this.runtime.executionBoundary.dispose(); }

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		return this.handlerEventTypes.has(eventType) || (eventType === "session_before_compact" && this.runtime.compactionStrategies.size > 0)
			|| this.runtime.nativeTasks?.hasHandlers(eventType) === true || this.runtime.nativeFiles?.hasHandlers(eventType) === true;
	}

	/** Stable live identifiers for request-transform handlers in actual invocation order. */
	getHandlerChainIdentifiers(eventTypes: readonly string[]): string[] {
		const identifiers: string[] = [];
		for (const eventType of eventTypes) {
			for (const extension of this.extensions) {
				const handlers = extension.handlers.get(eventType);
				if (!handlers) continue;
				const extensionIdentifier = createScopedExtensionIdentifier(extension, this.cwd);
				for (let index = 0; index < handlers.length; index++) {
					identifiers.push(`${eventType}:${extensionIdentifier}#${index}`);
				}
			}
		}
		return identifiers;
	}

	hasObservers(eventType: string): boolean {
		return this.observerEventTypes.has(eventType);
	}

	onObserverDiagnostic(listener: (diagnostic: ExtensionObserverDiagnostic) => void): () => void {
		this.observerDiagnosticListeners.add(listener);
		return () => this.observerDiagnosticListeners.delete(listener);
	}

	get observerDeliveryStats(): ExtensionObserverDeliveryStats {
		return {
			received: this.observerReceived,
			delivered: this.observerDelivered,
			errors: this.observerErrors,
			slow: this.observerSlow,
			disabled: this.observerDisabled,
			timeouts: this.observerTimeouts,
			durationP95Ms: this.observerDurationPercentile(0.95),
		};
	}

	get hookDeliveryStats(): ExtensionHookDeliveryStats {
		return { timeouts: this.hookTimeouts };
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return this.extensions.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.entryRenderers?.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();
		const nativeCommand = this.runtime.nativeTasks?.command;
		if (nativeCommand) { commands.push(nativeCommand); counts.set(nativeCommand.name, 1); }
		const changesCommand = this.runtime.nativeFiles?.command;
		if (changesCommand) { commands.push(changesCommand); counts.set(changesCommand.name, 1); }

		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	getActiveTools(): string[] {
		this.assertActive();
		return this.runtime.getActiveTools();
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(requestModel?: Model<any>, invocationSignal?: AbortSignal): ExtensionContext {
		const runner = this;
		const getModel = this.getModel;
		const getScopedModels = this.getScopedModels;
		return {
			get ui() {
				runner.assertActive();
				return runner.uiContext;
			},
			get mode() {
				runner.assertActive();
				return runner.mode;
			},
			get hasUI() {
				runner.assertActive();
				return runner.hasUI();
			},
			get cwd() {
				runner.assertActive();
				return runner.cwd;
			},
			get sessionManager() {
				runner.assertActive();
				return runner.sessionManager;
			},
			get modelRegistry() {
				runner.assertActive();
				return runner.modelRegistry;
			},
			get model() {
				runner.assertActive();
				return requestModel ?? getModel();
			},
			get scopedModels() {
				runner.assertActive();
				return getScopedModels();
			},
			get thinkingLevel() {
				runner.assertActive();
				return runner.runtime.getThinkingLevel();
			},
			isIdle: () => {
				runner.assertActive();
				return runner.isIdleFn();
			},
			isProjectTrusted: (revalidateIdentity) => {
				runner.assertActive();
				return runner.isProjectTrustedFn(revalidateIdentity);
			},
			get signal() {
				runner.assertActive();
				return invocationSignal ?? runner.getSignalFn();
			},
			abort: () => {
				runner.assertActive();
				runner.abortFn();
			},
			hasPendingMessages: () => {
				runner.assertActive();
				return runner.hasPendingMessagesFn();
			},
			getActiveTools: () => runner.getActiveTools(),
			shutdown: () => {
				runner.assertActive();
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				runner.assertActive();
				return runner.getContextUsageFn();
			},
			get mcpResultInputConfigured() {
				runner.assertActive();
				return runner.mcpResultInputActions?.getMcpResultInputConfigured?.() ?? false;
			},
			admitMcpResultInput: (content, toolCallId) => {
				runner.assertActive();
				runner.mcpResultInputActions?.admitMcpResultInput?.(content, toolCallId);
			},
			compact: (options) => {
				runner.assertActive();
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				runner.assertActive();
				return runner.getSystemPromptFn();
			},
		};
	}

	createCommandContext(): ExtensionCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionCommandContext;
		context.getSystemPromptOptions = () => {
			this.assertActive();
			return this.getSystemPromptOptionsFn();
		};
		context.waitForIdle = () => {
			this.assertActive();
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			this.assertActive();
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			this.assertActive();
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			this.assertActive();
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionPath, options) => {
			this.assertActive();
			return this.switchSessionHandler(sessionPath, options);
		};
		context.reload = () => {
			this.assertActive();
			return this.reloadHandler();
		};
		return context;
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree" ||
			event.type === "session_before_shutdown"
		);
	}

	private hookCategory(eventType: string): HookCategory {
		if (SAFETY_HOOK_EVENTS.has(eventType)) return "safety";
		if (TRANSFORM_HOOK_EVENTS.has(eventType)) return "transform";
		if (INTERACTION_HOOK_EVENTS.has(eventType)) return "interaction";
		return "lifecycle";
	}

	private async invokeHook(
		handler: HandlerFn,
		event: unknown,
		ctx: ExtensionContext,
		extensionPath: string,
		eventType: string,
	): Promise<unknown> {
		const category = this.hookCategory(eventType);
		const configured = this.options.hookTimeouts?.[category];
		const timeoutMs = configured?.timeoutMs ?? 0;
		if (eventType === "tool_call") {
			return this.invokeToolCallHook(handler, event, ctx, extensionPath, timeoutMs);
		}
		const result = OWNED_HOOK_EVENTS.has(eventType) ? this.invokeOwnedHook(handler, event, ctx) : handler(event, ctx);
		if (timeoutMs === 0 || !result || typeof (result as PromiseLike<unknown>).then !== "function") {
			return await result;
		}

		const timeoutError = new ExtensionHookTimeoutError(extensionPath, eventType, timeoutMs);
		timeoutError.stack = timeoutError.stack;
		let handle: unknown;
		const timeout = new Promise<never>((_resolve, reject) => {
			handle = this.scheduler.schedule(() => reject(timeoutError), timeoutMs);
		});
		try {
			return await Promise.race([result, timeout]);
		} catch (error) {
			if (error !== timeoutError) throw error;
			this.hookTimeouts++;
			this.emitError({
				extensionPath,
				event: eventType,
				error: timeoutError.message,
				stack: timeoutError.stack,
			});
			const policy = category === "safety" ? "fail-closed" : configured && "onTimeout" in configured ? configured.onTimeout : "fail-closed";
			if (policy === "fail-closed") throw timeoutError;
			return undefined;
		} finally {
			if (handle !== undefined) this.scheduler.cancel(handle);
		}
	}

	private beginOwnedHook(): void {
		if (this.actualHooks >= 128) throw new Error("Too many unfinished intercepting hooks; execution blocked");
		if (this.actualHooks++ === 0) this.hooksIdle = new Promise(resolve => { this.finishHooks = resolve; });
	}
	private invokeOwnedHook(handler: HandlerFn, event: unknown, ctx: ExtensionContext): unknown {
		this.beginOwnedHook();
		try {
			const result = handler(event, ctx);
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).then(this.finishHook, this.finishHook);
			} else this.finishHook();
			return result;
		} catch (error) { this.finishHook(); throw error; }
	}

	private async invokeToolCallHook(handler: HandlerFn, event: unknown, ctx: ExtensionContext,
		extensionPath: string, timeoutMs: number): Promise<unknown> {
		this.assertActive();
		ctx.signal?.throwIfAborted();
		if ((this.toolCallDeadlines?.size ?? 0) >= 128) throw new Error("Too many active tool hooks; execution blocked");
		const timeoutError = new ExtensionHookTimeoutError(extensionPath, "tool_call", timeoutMs);
		// Materialize diagnostic frames before an aborted signal can outlive this invocation.
		timeoutError.stack = timeoutError.stack;
		const owners = this.toolCallDeadlines ??= new Set();
		const deadline = new ToolCallDeadline(owners, this.scheduler, timeoutError, ctx.signal);
		owners.add(deadline);
		const ui = Object.create(ctx.ui) as ExtensionUIContext;
		const originalUI = ctx.ui;
		ui.editor = rejectUncancellableToolCallUI;
		ui.custom = rejectUncancellableToolCallUI;
		const descriptors = Object.getOwnPropertyDescriptors(ctx);
		descriptors.signal = { value: deadline.controller.signal };
		descriptors.ui = { value: ui };
		const invocationContext = Object.create(Object.getPrototypeOf(ctx), descriptors) as ExtensionContext;
		const waitForSelection = async <T>(show: () => Promise<T>): Promise<T> => {
			deadline.assertCurrent();
			if (this.toolCallDialogOwner) throw new Error("Another approval dialog is active; request was not approved");
			this.toolCallDialogOwner = deadline;
			deadline.pause();
			try {
				const actual = deadline.trackDialog(show());
				const result = await actual;
				deadline.assertCurrent();
				return result;
			} finally {
				if (this.toolCallDialogOwner === deadline) this.toolCallDialogOwner = undefined;
				deadline.resume();
			}
		};
		// These operation-level wrappers never run on delta/progress delivery.
		ui.select = (title, options, opts) => waitForSelection(() => originalUI.select(title, options,
			{ ...opts, signal: opts?.signal && opts.signal !== deadline.controller.signal ? AbortSignal.any([opts.signal, deadline.controller.signal]) : deadline.controller.signal }));
		ui.input = (title, placeholder, opts) => waitForSelection(() => originalUI.input(title, placeholder,
			{ ...opts, signal: opts?.signal && opts.signal !== deadline.controller.signal ? AbortSignal.any([opts.signal, deadline.controller.signal]) : deadline.controller.signal }));
		ui.confirm = (title, message, opts) => waitForSelection(() => originalUI.confirm(title, message,
			{ ...opts, signal: opts?.signal && opts.signal !== deadline.controller.signal ? AbortSignal.any([opts.signal, deadline.controller.signal]) : deadline.controller.signal }));
		try {
			deadline.assertCurrent();
			const result = await Promise.race([deadline.trackHandler(handler(event, invocationContext)), deadline.cancelled]);
			deadline.assertCurrent();
			deadline.takeResult();
			return result;
		} catch (error) {
			if (error === timeoutError) {
				this.hookTimeouts++;
				this.emitError({ extensionPath, event: "tool_call", error: timeoutError.message, stack: timeoutError.stack,
					toolCallId: (event as ToolCallEvent).toolCallId });
			}
			throw error;
		} finally {
			deadline.dispose();
			if (this.toolCallDeadlines?.size === 0) this.toolCallDeadlines = undefined;
		}
	}

	private emitObserverDiagnostic(diagnostic: ExtensionObserverDiagnostic): void {
		for (const listener of this.observerDiagnosticListeners) {
			try {
				listener(diagnostic);
			} catch {
				// Diagnostics must not turn a display-only observer failure into an agent failure.
			}
		}
	}

	private recordObserverDuration(durationMs: number): void {
		for (let index = 0; index < OBSERVER_DURATION_BUCKETS_MS.length; index++) {
			if (durationMs <= OBSERVER_DURATION_BUCKETS_MS[index]!) {
				this.observerDurationBuckets[index]++;
				return;
			}
		}
		this.observerDurationBuckets[this.observerDurationBuckets.length - 1]++;
	}

	private observerDurationPercentile(percentile: number): number {
		let count = 0;
		for (const value of this.observerDurationBuckets) count += value;
		if (count === 0) return 0;
		const target = Math.max(1, Math.ceil(count * percentile));
		let cumulative = 0;
		for (let index = 0; index < this.observerDurationBuckets.length; index++) {
			cumulative += this.observerDurationBuckets[index]!;
			if (cumulative >= target) return OBSERVER_DURATION_BUCKETS_MS[index]!;
		}
		return 0;
	}

	async emitObservers(event: ObserverEvent): Promise<void> {
		const ctx = this.createContext();
		for (const extension of this.extensions) {
			const observers = extension.observers.get(event.type);
			if (!observers || observers.length === 0) continue;
			for (const observer of observers) {
				this.observerReceived++;
				if (observer.disabled) continue;
				await this.deliverExtensionObserver(extension.path, event, ctx, observer);
			}
		}
	}

	private async deliverExtensionObserver(
		extensionPath: string,
		event: ObserverEvent,
		ctx: ExtensionContext,
		observer: RegisteredExtensionObserver,
	): Promise<void> {
		const startedAt = this.scheduler.now();
		try {
			await this.invokeObserver(observer, event, ctx);
			observer.consecutiveErrors = 0;
			this.observerDelivered++;
		} catch (error) {
			this.observerErrors++;
			observer.consecutiveErrors++;
			const timedOut = error instanceof ExtensionObserverTimeoutError;
			if (timedOut) this.observerTimeouts++;
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			try {
				this.emitError({ extensionPath, event: event.type, error: message, stack });
			} catch {
				// Error reporters are observers too; isolate them from the agent run.
			}
			this.emitObserverDiagnostic({ type: "observer-error", extensionPath, event: event.type, error });
			if (timedOut || observer.consecutiveErrors >= observer.disableAfterErrors) {
				observer.disabled = true;
				this.observerDisabled++;
				this.emitObserverDiagnostic({ type: "observer-disabled", extensionPath, event: event.type });
			}
		}
		const durationMs = this.scheduler.now() - startedAt;
		this.recordObserverDuration(durationMs);
		if (durationMs >= observer.slowThresholdMs) {
			this.observerSlow++;
			this.emitObserverDiagnostic({ type: "observer-slow", extensionPath, event: event.type, durationMs });
		}
	}

	private async invokeObserver(
		observer: RegisteredExtensionObserver,
		event: ObserverEvent,
		ctx: ExtensionContext,
	): Promise<void> {
		const result = observer.handler(event, ctx);
		if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return;
		const timeoutError = new ExtensionObserverTimeoutError(observer.timeoutMs);
		let handle: unknown;
		const timeout = new Promise<never>((_resolve, reject) => {
			handle = this.scheduler.schedule(() => reject(timeoutError), observer.timeoutMs);
		});
		try {
			await Promise.race([result, timeout]);
		} finally {
			if (handle !== undefined) this.scheduler.cancel(handle);
		}
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const ctx = this.createContext();
		const compactionModel = event.type === "session_before_compact" ? ctx.model : undefined;
		const compactionGeneration = event.type === "session_before_compact" ? this.runtime.executionBoundary.generation : 0;
		let result: SessionBeforeEventResult | undefined;
		let terminalTimeout: ExtensionHookTimeoutError | undefined;
		let shutdownFailure: unknown;
		let shutdownFailed = false;
		if (event.type === "session_shutdown") this.runtime.nativePermissions?.dispose();
		if (this.runtime.nativeFiles?.hasHandlers(event.type)) {
			try { await this.runtime.nativeFiles.emit(event); }
			catch (error) {
				if (event.type !== "session_shutdown") throw error;
				shutdownFailed = true; shutdownFailure = error;
			}
		}
		if (this.runtime.nativeTasks?.hasHandlers(event.type)) {
			try {
				const nativeResult = await this.runtime.nativeTasks.emit(event, ctx);
				if (nativeResult && (nativeResult as SessionBeforeEventResult).cancel) return nativeResult as RunnerEmitResult<TEvent>;
			} catch (error) {
				if (event.type !== "session_shutdown") throw error;
				shutdownFailed = true; shutdownFailure = error;
			}
		}

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await this.invokeHook(handler, event, ctx, ext.path, event.type);

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = handlerResult as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
						if (event.type === "session_before_compact" && "compaction" in result && result.compaction) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					if (event.type === "session_before_shutdown") throw err;
					if (event.type === "session_shutdown") {
						if (!shutdownFailed) { shutdownFailed = true; shutdownFailure = err; }
						// Every owner gets its cleanup even when an earlier handler fails.
						continue;
					}
					if (err instanceof ExtensionHookTimeoutError) {
						// The tool has already finished. Later handlers still receive its terminal
						// event so per-call cleanup runs; the first timeout is reported afterwards.
						if (event.type !== "tool_execution_end") throw err;
						terminalTimeout ??= err;
						continue;
					}
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		if (terminalTimeout) throw terminalTimeout;
		if (shutdownFailed) throw shutdownFailure;
		if (event.type === "session_before_compact") return await this.executeCompactionStrategy(event, ctx, compactionModel, compactionGeneration) as RunnerEmitResult<TEvent>;
		return result as RunnerEmitResult<TEvent>;
	}

	/** Legacy hooks retain their existing veto/override; native adapters select before any execution. */
	private assertCompactionCurrent(event: SessionBeforeCompactEvent, ctx: ExtensionContext, model: Model<any> | undefined, generation: number): void {
		this.assertExecutionCurrent(); this.runtime.executionBoundary.assertCurrent(generation); event.signal.throwIfAborted();
		if (ctx.model !== model) throw new Error("Compaction strategy selection belongs to a stale model");
	}

	private async executeCompactionStrategy(event: SessionBeforeCompactEvent, ctx: ExtensionContext, model: Model<any> | undefined, generation: number): Promise<SessionBeforeCompactResult | undefined> {
		this.assertCompactionCurrent(event, ctx, model, generation);
		let selected: RegisteredCompactionStrategy | undefined, handler: CompactionStrategyHandler | undefined;
		for (const strategy of this.runtime.compactionStrategies.values()) {
			// Invalid asynchronous prepare results still belong to the existing hook settlement owner.
			const candidate = this.invokeOwnedHook(strategy.prepare as HandlerFn, ctx, ctx);
			this.assertCompactionCurrent(event, ctx, model, generation);
			if (candidate === undefined) continue;
			if (typeof candidate !== "function") throw new Error(`Compaction strategy ${strategy.id} must prepare synchronously`);
			if (selected) throw new Error(`Conflicting compaction strategies: ${selected.id} and ${strategy.id}. Disable one policy before compacting.`);
			selected = strategy; handler = candidate as CompactionStrategyHandler;
		}
		this.assertCompactionCurrent(event, ctx, model, generation);
		if (!selected || !handler) return undefined;
		// Outside the legacy emit catch: selection/execution failures must not trigger another strategy or native summary.
		const result = await this.invokeHook(handler as HandlerFn, event, ctx, selected.extensionPath, "session_before_compact") as SessionBeforeCompactResult | undefined;
		this.assertCompactionCurrent(event, ctx, model, generation);
		if (result !== undefined && (!result || typeof result !== "object" ||
			(result.cancel !== true && (!result.compaction || typeof result.compaction !== "object")))) {
			throw new Error(`Compaction strategy ${selected.id} must return a compaction, cancellation or explicit undefined fallback`);
		}
		return result;
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("message_end");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					const handlerResult = (await this.invokeHook(
						handler,
						currentEvent,
						ctx,
						ext.path,
						"message_end",
					)) as MessageEndEventResult | undefined;
					if (!handlerResult?.message) continue;

					if (handlerResult.message.role !== currentMessage.role) {
						this.emitError({
							extensionPath: ext.path,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					currentMessage = handlerResult.message;
					modified = true;
				} catch (err) {
					if (err instanceof ExtensionHookTimeoutError) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: message,
						stack,
					});
				}
			}
		}

		return modified ? currentMessage : undefined;
	}

	async emitToolResult(event: ToolResultEvent): Promise<(ToolResultEventResult & { observationFailed?: true }) | undefined> {
		this.runtime.nativeFiles?.finish(event.toolCallId);
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;
		let observationFailed: true | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = (await this.invokeHook(
						handler,
						currentEvent,
						ctx,
						ext.path,
						"tool_result",
					)) as ToolResultEventResult | undefined;
					if (!handlerResult) continue;

					if (handlerResult.content !== undefined) {
						currentEvent.content = handlerResult.content;
						modified = true;
					}
					if (handlerResult.details !== undefined) {
						currentEvent.details = handlerResult.details;
						modified = true;
					}
					if (handlerResult.isError !== undefined) {
						currentEvent.isError = handlerResult.isError;
						modified = true;
					}
					if (handlerResult.usage !== undefined) {
						currentEvent.usage = handlerResult.usage;
						modified = true;
					}
				} catch (err) {
					if (err instanceof ExtensionHookTimeoutError) throw err;
					observationFailed = true;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_result",
						error: message,
						stack,
					});
				}
			}
		}

		if (!modified && !observationFailed) {
			return undefined;
		}

		return {
			observationFailed,
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
			usage: currentEvent.usage,
		};
	}

	async emitToolCall(event: ToolCallEvent, definition?: ToolDefinition, invocationSignal?: AbortSignal): Promise<ToolCallEventResult | undefined> {
		const boundary = this.runtime.executionBoundary, generation = boundary.generation;
		boundary.assertCurrent(generation);
		const name = event.toolName;
		if (!this.runtime.nativePermissions && !this.handlerEventTypes.has("tool_call")
			&& !this.runtime.nativeFiles?.ownsDefinition(definition) && name !== "bash" && name !== "powershell"
			&& name !== "edit" && name !== "write" && name !== "copy" && name !== "delete" && name !== "move" && name !== "file_batch") {
			if (this.ordinaryToolEpoch?.generation !== generation) this.ordinaryToolEpoch = new OrdinaryToolEpoch(boundary);
			return { finalAuthorization: this.ordinaryToolEpoch };
		}
		if ((this.finalAuthorizations?.size ?? 0) >= 128) throw new Error("Too many pending tool invocations");
		const ctx = this.createContext(undefined, invocationSignal);
		let result: ToolCallEventResult | undefined;
		// Reserve before any producer starts. The same hook idle deferred covers
		// actual native/hook delivery and cleanup, including a late rejected grant.
		this.beginOwnedHook();
		const authorization = new PendingToolAuthorization(this.finalAuthorizations ??= new Set(), boundary, generation);
		let handedOff = false;
		let filesPrepared = false;
    // One invocation setup hook. Cheap policy denials precede its filesystem
    // preflight; its plans are included in the one approval and existing drain.
    const prepareNativeFiles = async (canonicalPaths?: readonly string[]): Promise<(() => string) | undefined> => {
      if (!this.runtime.nativeFiles?.ownsDefinition(definition)) return;
      const native = await this.runtime.nativeFiles.prepareInvocation(event, ctx, canonicalPaths);
      filesPrepared = true;
      if (native) { authorization.add(native); return native.describePreflight; }
    };
		try {
		if (this.runtime.nativePermissions) authorization.policy = await this.runtime.nativePermissions.authorize(event, ctx, definition, false, prepareNativeFiles);
    if (!filesPrepared) await prepareNativeFiles();
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				boundary.assertCurrent(generation);
				const handlerResult = await this.invokeHook(handler, event, ctx, ext.path, "tool_call");

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.finalAuthorization) {
						authorization.add(result.finalAuthorization);
					}
					if (result.block) {
						return result;
					}
				}
				boundary.assertCurrent(generation);
			}
		}

		// Legacy grants keep their existing terminal authority; both paths use the same task owner.
		if (!authorization.hasChecks && this.runtime.nativeTasks && (event.toolName === "bash" || event.toolName === "powershell")) {
			const native = await this.runtime.nativeTasks.prepareInvocation(event, ctx);
			if (native) {
				authorization.add(native);
			}
		}
		boundary.assertCurrent(generation);
		handedOff = true;
		return { block: result?.block, reason: result?.reason, details: result?.details, terminate: result?.terminate, finalAuthorization: authorization };
		} finally {
			try { authorization.finishCollection(handedOff); }
			finally { this.finishHook(); }
		}
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("user_bash");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await this.invokeHook(handler, event, ctx, ext.path, "user_bash");
					if (handlerResult) {
						return handlerResult as UserBashEventResult;
					}
				} catch (err) {
					if (err instanceof ExtensionHookTimeoutError) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "user_bash",
						error: message,
						stack,
					});
				}
			}
		}

		return undefined;
	}

	async emitContext(messages: AgentMessage[], dryRun = false): Promise<AgentMessage[]> {
		if (!this.hasHandlers("context")) return messages;
		const ctx = this.createContext();
		let currentMessages = structuredClone(messages);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages, dryRun };
					const handlerResult = await this.invokeHook(handler, event, ctx, ext.path, "context");

					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
					if (err instanceof ExtensionHookTimeoutError) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "context",
						error: message,
						stack,
					});
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeProviderRequest(payload: unknown, dryRun = false, requestAuth?: ProviderRequestAuthSnapshot, scope?: SupplementalSummaryHookScope): Promise<unknown> {
		const ctx = this.createContext(scope?.model);
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
						dryRun,
						requestAuth,
						purpose: scope?.purpose,
					};
					scope?.assertCurrent();
					const handlerResult = await this.invokeHook(
						handler,
						event,
						ctx,
						ext.path,
						"before_provider_request",
					);
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
					scope?.assertCurrent();
				} catch (err) {
					if (scope) throw err;
					if (err instanceof ExtensionHookTimeoutError) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		return currentPayload;
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders, scope?: SupplementalSummaryHookScope): Promise<ProviderHeaders> {
		const ctx = this.createContext(scope?.model);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_headers");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					// Handlers mutate `headers` in place; the return value is ignored.
					const event: BeforeProviderHeadersEvent = {
						type: "before_provider_headers",
						headers,
						purpose: scope?.purpose,
					};
					scope?.assertCurrent();
					await this.invokeHook(handler, event, ctx, ext.path, "before_provider_headers");
					scope?.assertCurrent();
				} catch (err) {
					if (scope) throw err;
					if (err instanceof ExtensionHookTimeoutError) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_headers",
						error: message,
						stack,
					});
				}
			}
		}

		return headers;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
		systemPromptComposition?: SystemPromptComposition | null,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		let currentSystemPrompt = systemPrompt;
		// Capture the matching build for this whole waterfall, including async handlers.
		let currentComposition = systemPromptComposition && systemPromptComposition.text !== systemPrompt
			? null : systemPromptComposition;
		const ctx = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionContext;
		ctx.getSystemPrompt = () => {
			this.assertActive();
			return currentSystemPrompt;
		};
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = {
						type: "before_agent_start",
						prompt,
						images,
						systemPrompt: currentSystemPrompt,
						systemPromptOptions,
						systemPromptComposition: currentComposition,
					};
					const handlerResult = await this.invokeHook(handler, event, ctx, ext.path, "before_agent_start");

					if (handlerResult) {
						const result = handlerResult as BeforeAgentStartEventResult;
						if (result.message) {
							messages.push(result.message);
						}
						if (result.systemPrompt !== undefined) {
							currentSystemPrompt = result.systemPrompt;
							currentComposition = null;
							systemPromptModified = true;
						}
					}
				} catch (err) {
					if (err instanceof ExtensionHookTimeoutError) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_agent_start",
						error: message,
						stack,
					});
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
					const handlerResult = await this.invokeHook(handler, event, ctx, ext.path, "resources_discover");
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					if (result?.skillPaths?.length) {
						skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.promptPaths?.length) {
						promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.themePaths?.length) {
						themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
					}
				} catch (err) {
					if (err instanceof ExtensionHookTimeoutError) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "resources_discover",
						error: message,
						stack,
					});
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
		submissionId?: string,
		imageContentDigest?: string,
		phase: "submit" | "image-processing" = "submit",
	): Promise<InputEventResult> {
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get(phase === "submit" ? "input" : "input:image-processing") ?? []) {
				try {
					const event: InputEvent = {
						type: "input",
						submissionId,
						imageContentDigest: currentImages === images ? imageContentDigest : undefined,
						text: currentText,
						images: currentImages,
						source,
						streamingBehavior,
					};
					const result = (await this.invokeHook(handler, event, ctx, ext.path, "input")) as
						| InputEventResult
						| undefined;
					if (result?.action === "handled") return result;
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images ?? currentImages;
					}
				} catch (err) {
					if (submissionId || err instanceof ExtensionHookTimeoutError) throw err;
					this.emitError({
						extensionPath: ext.path,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}

function rejectUncancellableToolCallUI(): never {
 throw new Error("editor/custom UI is not supported inside a timed tool_call hook; use select, input or confirm with invocation cancellation");
}
