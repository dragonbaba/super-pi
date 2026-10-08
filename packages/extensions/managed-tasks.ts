import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@super-pi/coding-agent";
import type { AgentToolResult } from "@super-pi/agent-core";
import { Type } from "typebox";
import type { ManagedSubagentTask, SubagentTasks } from "./subagent/tasks.ts";

type Kind = "shell" | "subagent";
export interface ManagedTaskProvider {
	readonly tasks: SubagentTasks;
	readonly guidance: string;
	list(): string;
	details?(task: ManagedSubagentTask): unknown;
}
interface TaskDirectory {
	providers: Map<Kind, ManagedTaskProvider>;
	parameters: ToolDefinition["parameters"];
	stopDiscovery(): void;
}
export interface ManagedTaskRegistration {
	unregister(): void;
	controlsAvailable(ctx: ExtensionContext): boolean;
}
const DIRECTORY_EVENT = "super-pi:managed-tasks-directory";
export const SHELL_TASK_RESULT_EVENT = "super-pi:shell-task-result";

export function formatManagedTask(task: ManagedSubagentTask): string {
	return `${task.id} · ${task.agent} · ${task.state}${task.recovered ? " · historical" : ""}${task.startedAt === undefined || task.state === "interrupted" ? "" : ` · ${Math.floor(((task.completedAt ?? Date.now()) - task.startedAt) / 1000)}s`}`;
}

export function configureTaskHistory(tasks: SubagentTasks, kind: Kind, ctx: ExtensionContext): void {
	const session = ctx.sessionManager;
	if (session) tasks.configureHistory({ file: session.getSessionFile(), id: session.getSessionId(), cwd: ctx.cwd }, kind);
}

function taskText(task: ManagedSubagentTask, item: ManagedTaskProvider): string {
	return `${formatManagedTask(task)}${task.cwd ? `\nWorkspace: ${task.cwd}; branch: ${task.branchId ?? "root"}` : ""}${task.checkpointAvailable ? "\nCheckpoint available: use a fresh authorized subagent request with resumeTaskId and new instructions; inspect any unobserved side effects first." : ""}${task.result === undefined ? "" : `\n\n${task.result}`}${item.tasks.historyError ? `\n\n${item.tasks.historyStatus}` : ""}`;
}

/** Two bounded providers; registration and explicit control calls are lifecycle work. */
export function registerManagedTasks(pi: ExtensionAPI, kind: Kind, provider: ManagedTaskProvider): ManagedTaskRegistration {
	// Each extension receives its own EventBus facade. Discover the session owner
	// through one synchronous startup event, including across source/dist loaders.
	const request: { directory?: TaskDirectory } = {};
	pi.events.emit(DIRECTORY_EVENT, request);
	let directory = request.directory;
	if (!directory) {
		const owned = new Map<Kind, ManagedTaskProvider>();
		const parameters = Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("cancel")]),
			id: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
		}, { additionalProperties: false });
		directory = { providers: owned, parameters, stopDiscovery: () => {} };
		const created = directory;
		directory.stopDiscovery = pi.events.on(DIRECTORY_EVENT, value => { (value as typeof request).directory = created; });
		pi.on("session_before_shutdown", async (event, ctx) => {
			let active = 0;
			for (const item of owned.values()) active += item.tasks.size - item.tasks.retainedResults;
			if (active === 0 || event.signal.aborted) return;
			const confirmed = await ctx.ui.confirm("退出 Super Pi？", `还有 ${active} 项任务尚未结束。确认退出将停止这些任务，清理后台进程后退出。`, { signal: event.signal });
			return { cancel: !confirmed };
		});
		const list = (): string => {
			if (owned.size === 0) throw new Error("Task session is closed.");
			let text = "";
			for (const [name, item] of owned) text += `${text ? "\n\n" : ""}${name}: ${item.list()}\n${item.tasks.historyStatus}`;
			return text;
		};
		const find = (id: string): [Kind, ManagedTaskProvider, ManagedSubagentTask] => {
			for (const [name, item] of owned) {
				const task = item.tasks.find(id);
				if (task) return [name, item, task];
			}
			for (const item of owned.values()) item.tasks.assertHistoryAvailable();
			throw new Error("Unknown or expired task ID. List current tasks.");
		};
		pi.registerTool({
			name: "tasks", label: "Tasks", modelOnly: true,
			description: "Manage session shell/subagent tasks and bounded saved history: list, status, wait, cancel. Wait 0–60000ms (default 10000); at most 64 pending waits per kind. Timeout never cancels work. Persistent sessions restore historical results; unobserved completion becomes interrupted with unknown side effects. History grants no permissions or current verification evidence and never replays work. IDs expire on history eviction; memory-only sessions lose them on close. Prefer completion notifications over polling. Read capacities using list before launching background work.",
			parameters,
			async execute(_id, args, signal): Promise<AgentToolResult<Record<string, unknown>>> {
				if (args.action === "list") return { content: [{ type: "text", text: list() }], details: {} };
				if (!args.id) throw new Error("A task ID is required.");
				const [name, item, task] = find(args.id);
				if (args.action === "cancel") item.tasks.cancel(task.id);
				else if (args.action === "wait") await item.tasks.wait(task.id, args.timeoutMs ?? 10_000, signal);
				return { content: [{ type: "text", text: taskText(task, item) }],
					details: { task: { id: task.id, kind: name, state: task.state, historical: task.recovered === true, cwd: task.cwd, branchId: task.branchId },
						historyError: item.tasks.historyError, result: structuredClone(item.details?.(task) ?? (task.shellExecution ? { shellExecution: task.shellExecution } : undefined)) } };
			},
		});
		pi.registerCommand("tasks", {
			description: "List tasks/history; /tasks status <id> reads a result; /tasks cancel <id> stops active work",
			async handler(args, ctx) {
				try {
					const parts = args.trim().split(/\s+/);
					if ((parts[0] === "cancel" || parts[0] === "status") && parts.length === 2) {
						const [, item, task] = find(parts[1]);
						if (parts[0] === "cancel") item.tasks.cancel(task.id);
						ctx.ui.notify(taskText(task, item), "info");
					} else if (args.trim()) ctx.ui.notify("Usage: /tasks or /tasks status|cancel <id>", "error");
					else ctx.ui.notify(list(), "info");
				} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
			},
		});
	}
	if (directory.providers.has(kind)) throw new Error(`Task provider already registered: ${kind}.`);
	directory.providers.set(kind, provider);
	const owned = directory;
	// Sent before the model can submit work; no per-output updates or polling.
	pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${provider.guidance}` }));
	return {
		unregister() {
			if (owned.providers.get(kind) !== provider) return;
			owned.providers.delete(kind);
			if (owned.providers.size === 0) owned.stopDiscovery();
		},
		controlsAvailable(ctx) {
			if (!ctx.getActiveTools().includes("tasks")) return false;
			// Effective tool metadata preserves the registered schema reference;
			// a same-named tool or a copied schema is not this controller.
			for (const tool of pi.getAllTools()) if (tool.name === "tasks") return tool.parameters === owned.parameters;
			return false;
		},
	};
}
