import { join } from "node:path";
import { toolResultFromError } from "@super-pi/agent-core";
import { getConfigDir, readShellExecution, type BackgroundShellExecution, type BackgroundShellLaunch, type BashToolDetails, type ExtensionAPI, type ExtensionContext } from "@super-pi/coding-agent";
import { registerManagedTasks, configureTaskHistory, formatManagedTask, SHELL_TASK_RESULT_EVENT, type ManagedTaskRegistration } from "../managed-tasks.ts";
import { loadSubagentLimits, HARD_MAX_CONCURRENT, HARD_MAX_TASKS } from "../subagent/limits.ts";
import { SubagentScheduler, type TaskReservation } from "../subagent/scheduler.ts";
import { SubagentTasks, type ManagedSubagentTask } from "../subagent/tasks.ts";
import { SESSION_PERMISSION_EVENT } from "./permission-contract.ts";

export const BACKGROUND_SHELL_LIMITS_PATH = join(getConfigDir(), "background-shell-limits.json");

function retainedShellText(text: string, details: BashToolDetails | undefined): string {
	const facts = readShellExecution(details);
	const status = facts ? `Shell: ${facts.executionStatus}; exit=${facts.exitCode ?? "unknown"}; termination=${facts.termination}.` : "Shell completion could not be observed; inspect before retrying.";
	if (text.length <= 11_000) return `${status}\n\n${text}`;
	let start = text.length - 10_000;
	if (text.charCodeAt(start) >= 0xDC00 && text.charCodeAt(start) <= 0xDFFF) start++;
	const end = text.charCodeAt(499) >= 0xD800 && text.charCodeAt(499) <= 0xDBFF ? 499 : 500;
	return `${status}\n\n${text.slice(0, end)}\n[output truncated; retained head and tail]\n${text.slice(start)}`;
}

/** Owns only commands admitted through final authorization; no raw-output observer. */
export class BackgroundShellTasks {
	readonly limits = loadSubagentLimits(BACKGROUND_SHELL_LIMITS_PATH, "Background shell");
	readonly scheduler = new SubagentScheduler(this.limits, "Background shell");
	readonly tasks = new SubagentTasks(this.limits.maxTasks, "Background shell");
	private readonly results = new WeakMap<ManagedSubagentTask, BashToolDetails>();
	private readonly pending = new Set<Promise<void>>();
	private authority = new AbortController();
	private sessionGeneration = 0;
	private changingSession = 0;
	private closed = false;
	private cleanupBlocked = false;
	private disposal: Promise<void> | undefined;
	private readonly removePermissionListener: () => void;
	private readonly taskRegistration: ManagedTaskRegistration;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		const guidance = `Background shell limits: ${this.limits.maxConcurrent} running concurrently, ${this.limits.maxTasks} admitted commands including queued work; hard ceilings ${HARD_MAX_CONCURRENT}/${HARD_MAX_TASKS}. Config: ${BACKGROUND_SHELL_LIMITS_PATH}; reload after editing. Separate from subagent quotas. Use background: true with explicit cwd in bash/powershell; ordinary shell inspection and authorization still apply. Default runtime 1800s, maximum 7200s; queue time excluded. Read status with tasks; wait for terminal facts before reporting success. Retain the latest ${this.limits.maxTasks} completed records, at most 12000 characters each, with no durable output logs. Avoid overlapping edits/builds and use only independently useful concurrency.`;
		this.taskRegistration = registerManagedTasks(pi, "shell", { tasks: this.tasks, guidance, list: this.list, details: this.details });
		this.removePermissionListener = pi.events.on(SESSION_PERMISSION_EVENT, this.revoke);
		pi.on("session_start", async (_event, ctx) => { await this.beginSession(); configureTaskHistory(this.tasks, "shell", ctx); });
		pi.on("session_before_tree", this.beginSession);
		pi.on("session_tree", this.beginSession);
		pi.on("session_shutdown", this.dispose);
	}

	private readonly details = (task: ManagedSubagentTask): BashToolDetails | undefined => this.results.get(task);
	private readonly list = (): string => {
		let text = `${this.scheduler.active}/${this.limits.maxConcurrent} running · ${this.scheduler.outstanding}/${this.limits.maxTasks} active/queued · ${this.scheduler.queued} queued`;
		for (const task of this.tasks.values()) text += `\n${formatManagedTask(task)}`;
		return text;
	};
	private readonly revoke = (): void => {
		this.authority.abort(new Error("Background shell permission changed; submit a new authorized request."));
		this.tasks.cancelAll();
		this.authority = new AbortController();
	};
	private readonly beginSession = async (): Promise<void> => {
		this.sessionGeneration++;
		this.changingSession++;
		this.revoke();
		try { await Promise.allSettled(this.pending); }
		finally { this.changingSession--; }
	};

	assertAvailable(ctx: ExtensionContext): void {
		if (this.closed) throw new Error("Background shell session is closed.");
		if (this.changingSession) throw new Error("Background shell session is changing; wait for previous tasks to stop.");
		configureTaskHistory(this.tasks, "shell", ctx);
		this.tasks.assertHistoryAvailable();
		if (this.cleanupBlocked) throw new Error("Background shell cleanup failed; inspect the reported process/log diagnostics and reload after resolving it.");
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Background commands require a live TUI or RPC session; use foreground execution here.");
		if (!this.taskRegistration.controlsAvailable(ctx)) throw new Error("Background commands require the built-in tasks management tool; enable it and remove conflicting tasks registrations, or use foreground execution.");
	}

	createLaunch(name: string, callId: string, command: string, cwd: string, ctx: ExtensionContext, assertCurrent: () => void): BackgroundShellLaunch {
		return (execute, signal, release) => {
			signal?.throwIfAborted(); assertCurrent(); this.assertAvailable(ctx);
			// Slot admission only; normal permission checks own filesystem authority.
			const reservation = this.scheduler.reserve([{ canonicalCwd: cwd, allowMutation: false }]);
			let task: ManagedSubagentTask;
			try { task = this.tasks.create(name, cwd, ctx.sessionManager?.getLeafId()); }
			catch (error) { reservation.release(); throw error; }
			const input = { command, cwd, background: true as const };
			const authoritySignal = this.authority.signal;
			const operation = this.run(task, reservation, authoritySignal, execute, release, assertCurrent, callId, input, ctx.cwd, this.sessionGeneration);
			this.pending.add(operation);
			void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
			return { content: [{ type: "text", text: `Background command accepted: ${task.id}. Acceptance is not completion. Continue independent work; use tasks status/wait/cancel with this ID.` }], details: { backgroundTask: { id: task.id, state: "queued", kind: "shell" } } };
		};
	}

	private async run(task: ManagedSubagentTask, reservation: TaskReservation, authority: AbortSignal, execute: BackgroundShellExecution, release: () => void,
		assertCurrent: () => void, callId: string, input: { command: string; cwd: string; background: true }, sessionCwd: string, generation: number): Promise<void> {
		const signal = AbortSignal.any([authority, task.controller!.signal]);
		let failed = false, text = "";
		let details: BashToolDetails | undefined;
		try {
			const result = await this.scheduler.run(signal, async () => {
				assertCurrent(); this.tasks.start(task);
				try {
					const result = await execute(signal);
					this.checkCleanup(result.details, task);
					return result;
				} catch (error) {
					this.checkCleanup(toolResultFromError(error)?.details as BashToolDetails | undefined, task);
					throw error;
				}
			});
			details = result.details;
			for (const item of result.content) if (item.type === "text") text += item.text;
		} catch (error) {
			failed = true;
			const result = toolResultFromError(error);
			details = result?.details as BashToolDetails | undefined;
			text = error instanceof Error ? error.message : String(error);
		} finally { try { release(); } finally { reservation.release(); } }
		if (signal.aborted) task.controller?.abort();
		this.tasks.finish(task, retainedShellText(text, details), failed, readShellExecution(details));
		// Keep numeric truncation facts without retaining a second 50 KiB text tail.
		details = { ...details, truncation: details?.truncation ? { ...details.truncation, content: "" } : undefined,
			backgroundTask: { id: task.id, state: task.state as "completed" | "failed" | "cancelled", kind: "shell" } };
		this.results.set(task, details);
		if (this.closed || generation !== this.sessionGeneration) return;
		this.pi.events.emit(SHELL_TASK_RESULT_EVENT, { toolName: task.agent, toolCallId: callId, input, cwd: sessionCwd, details, isError: failed || signal.aborted });
		if (authority.aborted) return;
		try {
			this.pi.sendMessage({ customType: "shell-task-completion", content: `Background ${task.agent} task ${task.id} ${task.state}. Read its terminal result with tasks status before reporting success or retrying.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		} catch { /* Session replacement can invalidate delivery after process cleanup. */ }
	}

	readonly dispose = (): Promise<void> => this.disposal ??= this.close();
	private checkCleanup(details: BashToolDetails | undefined, failedTask: ManagedSubagentTask): void {
		const facts = readShellExecution(details);
		if (facts?.output.cleanup !== "failed" && !facts?.observationError?.startsWith("Process-tree cleanup failed:")) return;
		this.cleanupBlocked = true;
		// Latch before scheduler.run releases its slot and drains the next waiter.
		this.scheduler.dispose();
		for (const task of this.tasks.values()) if (task !== failedTask) this.tasks.cancel(task.id);
	}
	private async close(): Promise<void> {
		this.closed = true;
		this.removePermissionListener(); this.taskRegistration.unregister();
		this.authority.abort(new Error("Background shell session closed.")); this.tasks.cancelAll(); this.scheduler.dispose();
		await Promise.allSettled(this.pending);
		this.pending.clear(); this.tasks.dispose();
	}
}
