import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getConfigDir, type ExtensionAPI, type ExtensionContext } from "@super-pi/coding-agent";

export interface TaskBudgets { sessionTurns: number; sessionTokens: number; childTurns: number; childTokens: number; }
export interface BudgetUsage { turns: number; tokens: number; cost: number; pending: number; unknown: boolean; }
export const TASK_BUDGET_PATH = join(getConfigDir(), "task-budgets.json");
export const BUDGET_ENTRY = "managed-task-budget-v1";
const DEFAULTS: Readonly<TaskBudgets> = Object.freeze({ sessionTurns: 0, sessionTokens: 0, childTurns: 0, childTokens: 0 });
export const TASK_BUDGET_HELP = "Usage: /task-budget [help | set <field> <value> [<field> <value> ...] | reset]. Fields: sessionTurns, sessionTokens, childTurns, childTokens. Turns: 0–1000000; tokens: 0–1000000000; 0 = unlimited. Set saves global limits and applies here immediately without clearing usage; reset clears only this session's usage. Stop parent and child work before either change.";
type TaskBudgetCommand = { action: "status" | "help" | "reset" } | { action: "set"; changes: Partial<TaskBudgets> };
let nextTempId = 1;
export function emptyBudgetUsage(): BudgetUsage { return { turns: 0, tokens: 0, cost: 0, pending: 0, unknown: false }; }

/** Bounded parsing on an explicit user-command boundary, never on provider updates. */
export function parseTaskBudgetCommand(args: string): TaskBudgetCommand {
	if (args.length > 512) throw new Error("Task budget command exceeds 512 characters.");
	const input = args.trim();
	if (!input) return { action: "status" };
	if (input === "help" || input === "reset") return { action: input };
	const parts = input.split(/\s+/, 10);
	if (parts[0] !== "set" || parts.length < 3 || parts.length > 9 || parts.length % 2 !== 1) throw new Error(TASK_BUDGET_HELP);
	const changes: Partial<TaskBudgets> = {};
	for (let i = 1; i < parts.length; i += 2) {
		const key = parts[i], value = parts[i + 1];
		if (!(key === "sessionTurns" || key === "sessionTokens" || key === "childTurns" || key === "childTokens")) throw new Error(`Unknown task budget: ${key}. ${TASK_BUDGET_HELP}`);
		if (changes[key] !== undefined) throw new Error(`Duplicate task budget: ${key}.`);
		if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${key}; use a nonnegative integer (0 = unlimited).`);
		changes[key] = Number(value);
	}
	parseTaskBudgets(JSON.stringify(changes));
	return { action: "set", changes };
}

export function parseTaskBudgets(content: string): Readonly<TaskBudgets> {
	if (Buffer.byteLength(content) > 4096) throw new Error("Task budget configuration exceeds 4096 bytes.");
	const value: unknown = JSON.parse(content);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task budgets must be an object.");
	const result = { ...DEFAULTS };
	for (const key of Object.keys(value)) {
		if (!(key === "sessionTurns" || key === "sessionTokens" || key === "childTurns" || key === "childTokens")) throw new Error(`Unknown task budget: ${key}.`);
		const limit = (value as Record<string, unknown>)[key];
		const maximum = key.endsWith("Turns") ? 1_000_000 : 1_000_000_000;
		if (!Number.isSafeInteger(limit) || (limit as number) < 0 || (limit as number) > maximum) throw new Error(`Invalid ${key}; expected an integer 0–${maximum} (0 = unlimited).`);
		result[key] = limit as number;
	}
	return Object.freeze(result);
}
export function loadTaskBudgets(file = TASK_BUDGET_PATH): Readonly<TaskBudgets> {
	let fd: number;
	try { fd = openSync(file, "r"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULTS; throw error; }
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 4096) throw new Error("Task budgets must be a file of at most 4096 bytes.");
		const data = Buffer.alloc(4097), count = readSync(fd, data, 0, data.length, 0);
		return parseTaskBudgets(data.toString("utf8", 0, count));
	} finally { closeSync(fd); }
}

function limitReason(usage: BudgetUsage, turns: number, tokens: number, label: string): string | undefined {
	if (tokens > 0 && usage.unknown) return `${label} token usage is incomplete; new requests are blocked. Inspect results and use /task-budget reset only after work stops.`;
	if (turns > 0 && usage.turns >= turns) return `${label} turn budget reached: ${usage.turns}/${turns}. No new model request was started.`;
	if (tokens > 0 && usage.tokens >= tokens) return `${label} token budget reached: ${usage.tokens}/${tokens}. No new model request was started.`;
	return undefined;
}
function validUsage(value: unknown): value is BudgetUsage {
	if (!value || typeof value !== "object") return false;
	const item = value as BudgetUsage;
	return Number.isSafeInteger(item.turns) && item.turns >= 0 && Number.isSafeInteger(item.tokens) && item.tokens >= 0
		&& Number.isSafeInteger(item.pending) && item.pending >= 0 && Number.isFinite(item.cost) && item.cost >= 0 && typeof item.unknown === "boolean";
}

/** One numeric ledger per parent session; children share its admission counter. */
export class TaskBudgetLedger {
	private currentLimits: Readonly<TaskBudgets>;
	get limits(): Readonly<TaskBudgets> { return this.currentLimits; }
	private readonly pi: ExtensionAPI;
	readonly usage = emptyBudgetUsage();
	private sessionId: string | undefined;
	private primary = emptyBudgetUsage();
	private failure: string | undefined;
	constructor(limits: Readonly<TaskBudgets>, pi: ExtensionAPI) { this.currentLimits = limits; this.pi = pi; }

	/** Idle user command only: persist by atomic replacement before changing live admission. */
	setLimits(changes: Partial<TaskBudgets>, file = TASK_BUDGET_PATH): void {
		if (this.usage.pending) throw new Error("Stop all model requests before changing budgets.");
		const limits = parseTaskBudgets(JSON.stringify({ ...loadTaskBudgets(file), ...changes }));
		const directory = dirname(file);
		mkdirSync(directory, { recursive: true });
		const temp = join(directory, `.${basename(file)}.${process.pid}.${nextTempId++}.tmp`);
		let created = false;
		try {
			const fd = openSync(temp, "wx", 0o600); created = true;
			try { writeFileSync(fd, `${JSON.stringify(limits, null, 2)}\n`, "utf8"); }
			finally { closeSync(fd); }
			renameSync(temp, file); created = false;
			this.currentLimits = limits;
		} finally { if (created) rmSync(temp, { force: true }); }
	}

	configure(ctx: ExtensionContext): void {
		const id = ctx.sessionManager?.getSessionId();
		if (id === this.sessionId) return;
		if (this.usage.pending) throw new Error("Drain model requests before switching their budget owner.");
		this.sessionId = id; this.failure = undefined; this.primary = emptyBudgetUsage();
		Object.assign(this.usage, emptyBudgetUsage());
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "custom" || entry.customType !== BUDGET_ENTRY) continue;
			if (!validUsage(entry.data)) { this.failure = "Invalid task budget ledger; preserved for inspection."; break; }
			this.usage.turns = entry.data.turns; this.usage.tokens = entry.data.tokens; this.usage.pending = entry.data.pending;
			this.usage.cost = entry.data.cost; this.usage.unknown = entry.data.unknown;
			if (this.usage.pending > 0) { this.usage.unknown = true; this.usage.pending = 0; }
			break;
		}
	}
	private persist(): void {
		try { this.pi.appendEntry(BUDGET_ENTRY, { ...this.usage }); }
		catch (error) { this.failure = error instanceof Error ? error.message : String(error); throw error; }
	}
	assertAvailable(child?: BudgetUsage): void {
		const reason = this.failure ?? limitReason(this.usage, this.limits.sessionTurns, this.limits.sessionTokens, "Session (parent + children)")
			?? (child ? limitReason(child, this.limits.childTurns, this.limits.childTokens, "Child") : undefined);
		if (reason) throw new Error(reason);
	}
	request(child?: BudgetUsage): void {
		this.assertAvailable(child);
		const owner = child ?? this.primary;
		if (owner.pending !== 0) throw new Error("A model request is already awaiting usage for this task.");
		if (this.usage.turns === Number.MAX_SAFE_INTEGER) throw new Error("Task turn counter reached its safe numeric ceiling; inspect and reset budgets after work stops.");
		owner.turns++; owner.pending++;
		this.usage.turns++; this.usage.pending++;
		this.persist();
	}
	/** Completion boundary only. Count input/output/cache once; cost is a reported estimate. */
	settle(value: unknown, child?: BudgetUsage, incomplete = false): void {
		const owner = child ?? this.primary;
		if (owner.pending === 0) return;
		const usage = value as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } } | undefined;
		let tokens = 0, known = !!usage && !incomplete;
		for (const part of [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite]) {
			if (!Number.isSafeInteger(part) || (part as number) < 0 || (part as number) > 1_000_000_000) known = false;
			else tokens += part as number;
		}
		const cost = typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0 ? usage.cost.total : 0;
		owner.pending--; this.usage.pending--;
		owner.tokens += tokens; this.usage.tokens += tokens;
		owner.cost += cost; this.usage.cost += cost;
		if (!Number.isSafeInteger(this.usage.tokens) || !Number.isFinite(this.usage.cost)) {
			this.failure = "Task usage exceeded its safe numeric ceiling; inspect and reset budgets after work stops.";
			this.usage.tokens = Number.MAX_SAFE_INTEGER; this.usage.cost = Number.MAX_VALUE; known = false;
		}
		owner.unknown ||= !known; this.usage.unknown ||= !known;
		this.persist();
	}
	reset(): void {
		if (this.usage.pending) throw new Error("Stop all model requests before resetting budgets.");
		Object.assign(this.usage, emptyBudgetUsage()); this.primary = emptyBudgetUsage(); this.failure = undefined; this.persist();
	}
	describe(): string {
		return `Execution budgets: session (parent + children) turns ${this.usage.turns}/${this.limits.sessionTurns || "unlimited"}, tokens ${this.usage.tokens}/${this.limits.sessionTokens || "unlimited"}; per-child turns ${this.limits.childTurns || "unlimited"}, tokens ${this.limits.childTokens || "unlimited"}. ${this.usage.pending} requests in flight; reported cost estimate $${this.usage.cost.toFixed(4)}; usage ${this.usage.unknown ? "incomplete" : "known"}. Limits apply before model requests; in-flight responses may exceed token caps. Provider-internal retries/compaction are not separate turns; unreported billing is unknown. Config: ${TASK_BUDGET_PATH}.`;
	}
}
