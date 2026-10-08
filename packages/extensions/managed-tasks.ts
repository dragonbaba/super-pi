import type { ExtensionAPI } from "@super-pi/coding-agent";
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
	stopDiscovery(): void;
}
const DIRECTORY_EVENT = "super-pi:managed-tasks-directory";
export const SHELL_TASK_RESULT_EVENT = "super-pi:shell-task-result";

export function formatManagedTask(task: ManagedSubagentTask): string {
	return `${task.id} · ${task.agent} · ${task.state}${task.startedAt === undefined ? "" : ` · ${Math.floor(((task.completedAt ?? Date.now()) - task.startedAt) / 1000)}s`}`;
}

/** Two bounded providers; registration and explicit control calls are lifecycle work. */
export function registerManagedTasks(pi: ExtensionAPI, kind: Kind, provider: ManagedTaskProvider): () => void {
	// Each extension receives its own EventBus facade. Discover the session owner
	// through one synchronous startup event, including across source/dist loaders.
	const request: { directory?: TaskDirectory } = {};
	pi.events.emit(DIRECTORY_EVENT, request);
	let directory = request.directory;
	if (!directory) {
		const owned = new Map<Kind, ManagedTaskProvider>();
		directory = { providers: owned, stopDiscovery: () => {} };
		const created = directory;
		directory.stopDiscovery = pi.events.on(DIRECTORY_EVENT, value => { (value as typeof request).directory = created; });
		const list = (): string => {
			if (owned.size === 0) throw new Error("Task session is closed.");
			let text = "";
			for (const [name, item] of owned) text += `${text ? "\n\n" : ""}${name}: ${item.list()}`;
			return text;
		};
		const find = (id: string): [Kind, ManagedTaskProvider, ManagedSubagentTask] => {
			for (const [name, item] of owned) {
				const task = item.tasks.find(id);
				if (task) return [name, item, task];
			}
			throw new Error("Unknown or expired task ID. List current tasks.");
		};
		pi.registerTool({
			name: "tasks", label: "Tasks", modelOnly: true,
			description: "Manage existing session shell and subagent tasks: list, status, wait, cancel. Wait 0–60000ms (default 10000); at most 64 pending waits per task kind. Waiting timeout never cancels execution. Results and IDs expire when their bounded history is evicted or the session closes. Prefer completion notifications over polling. Cannot launch work or grant permissions. Read current capacities using list before launching background work.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("cancel")]),
				id: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
			}, { additionalProperties: false }),
			async execute(_id, args, signal): Promise<AgentToolResult<Record<string, unknown>>> {
				if (args.action === "list") return { content: [{ type: "text", text: list() }], details: {} };
				if (!args.id) throw new Error("A task ID is required.");
				const [name, item, task] = find(args.id);
				if (args.action === "cancel") item.tasks.cancel(task.id);
				else if (args.action === "wait") await item.tasks.wait(task.id, args.timeoutMs ?? 10_000, signal);
				return { content: [{ type: "text", text: `${formatManagedTask(task)}${task.result === undefined ? "" : `\n\n${task.result}`}` }],
					details: { task: { id: task.id, kind: name, state: task.state }, result: structuredClone(item.details?.(task)) } };
			},
		});
		pi.registerCommand("tasks", {
			description: "List session tasks; /tasks cancel <id> stops one shell command or subagent",
			async handler(args, ctx) {
				try {
					const parts = args.trim().split(/\s+/);
					if (parts[0] === "cancel" && parts.length === 2) {
						const [, item, task] = find(parts[1]); item.tasks.cancel(task.id);
						ctx.ui.notify(formatManagedTask(task), "info");
					} else if (args.trim()) ctx.ui.notify("Usage: /tasks or /tasks cancel <id>", "error");
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
	return () => {
		if (owned.providers.get(kind) !== provider) return;
		owned.providers.delete(kind);
		if (owned.providers.size === 0) owned.stopDiscovery();
	};
}
