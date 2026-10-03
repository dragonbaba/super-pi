import { Worker } from "node:worker_threads";
import { assignCodemodeIdentifiers } from "../identifier.ts";
import { BoundedJson } from "../bounded-json.ts";
import { IDENTIFIER_RE as IDENTIFIER } from "../regex.ts";
import {
	DEFAULT_MEMORY_BYTES, DEFAULT_TIMEOUT_MS, MAX_BRIDGE_CHARS, MAX_CATALOG_CHARS, MAX_CODE_CHARS,
	MAX_ERROR_CHARS, MAX_STORE_KEY_CHARS, MAX_STORE_KEYS, MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS,
	MAX_TIMEOUT_MS, MAX_TOOLS, MAX_VALUE_CHARS,
} from "../limits.ts";
import type {
	CodemodeCall,
	CodemodeCallStatus,
	CodemodeError,
	CodemodeExecuteOptions,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeSandboxOptions,
	CodemodeStoreWrites,
	CodemodeTool,
} from "../types.ts";
import { type CodemodeWasmModule, loadQuickJSWasm } from "../wasm.ts";
import {
	BridgeBudget,
	type HostToWorkerMessage,
	isWorkerToHostMessage,
	type WorkerData,
	type WorkerToHostMessage,
} from "./protocol.ts";

const WORKER_EXEC_ARGV = ["--experimental-strip-types"];
const WORKER_COMPILED_EXEC_ARGV: string[] = [];
const WORKER_ENV = Object.freeze({});
const RESERVED_GLOBALS: ReadonlySet<string> = new Set([
	"tools",
	"ALL_TOOLS",
	"console",
	"text",
	"image",
	"exit",
	"globalThis",
	"store",
	"load",
]);

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown sandbox error").slice(0, MAX_ERROR_CHARS);
}

function serializeStore(store: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	const serialized: Record<string, string> = Object.create(null);
	if (!store) return serialized;
	let chars = 0;
	let count = 0;
	const serializer = new BoundedJson();
	const keys = Object.keys(store);
	if (keys.length > MAX_STORE_KEYS) throw new RangeError("Codemode store keys exceed limits");
	for (const key of keys) {
		if (++count > MAX_STORE_KEYS || key.length > MAX_STORE_KEY_CHARS) throw new RangeError("Codemode store keys exceed limits");
		const json = serializer.stringify(store[key], MAX_STORE_VALUE_CHARS);
		if (json !== undefined) {
			chars += key.length + json.length;
			if (chars > MAX_STORE_TOTAL_CHARS) throw new RangeError("Codemode store exceeds its limit");
			serialized[key] = json;
		}
	}
	return serialized;
}

function parseStoreWrites(json: string): CodemodeStoreWrites {
	const writes: CodemodeStoreWrites = { set: Object.create(null), delete: [] };
	const entries: unknown = JSON.parse(json);
	if (!Array.isArray(entries) || entries.length > MAX_STORE_KEYS) throw new Error("Invalid Codemode store writes");
	let chars = 0;
	for (const entry of entries) {
		if (!Array.isArray(entry) || entry.length > 2) throw new Error("Invalid Codemode store entry");
		const [key, value] = entry;
		if (typeof key !== "string" || key.length > MAX_STORE_KEY_CHARS || value !== undefined && typeof value !== "string") throw new Error("Invalid Codemode store key/value");
		chars += key.length + (value?.length ?? 0);
		if (value?.length > MAX_STORE_VALUE_CHARS || chars > MAX_STORE_TOTAL_CHARS + MAX_STORE_KEYS * MAX_STORE_KEY_CHARS) throw new RangeError("Codemode store writes exceed limits");
		if (value === undefined) writes.delete.push(key);
		else writes.set[key] = JSON.parse(value);
	}
	return writes;
}

function defaultWorkerUrl(): URL {
	// `.ts` when running from source (tests, tsx), `.js` from the published dist.
	return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

interface PendingCall {
	record: CodemodeCall | undefined;
	startedAt: number;
	controller: AbortController;
}

interface ExecutionOptions {
	code: string;
	tools: ReadonlyMap<string, CodemodeTool>;
	globals: ReadonlyMap<string, CodemodeTool>;
	toolCatalog: WorkerData["tools"];
	globalCatalog: WorkerData["globals"];
	timeoutMs: number;
	signal: AbortSignal | undefined;
	memoryLimitBytes: number | undefined;
	store: Record<string, string>;
	wasm: Promise<CodemodeWasmModule>;
	workerUrl: string | URL;
	lifecycle: { workersStarted: number; workersStopped: number };
}

/**
 * One script run in its own worker and QuickJS VM. A fresh worker per run keeps
 * termination simple: a runaway script, including one that only spins the
 * microtask queue, is killed with `terminate()` and cannot poison a later run.
 */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private resolveResult!: (result: CodemodeResult) => void;
	private worker: Worker | undefined;
	private readonly interrupt = new SharedArrayBuffer(4);
	private tools: ReadonlyMap<string, CodemodeTool> | undefined;
	private globals: ReadonlyMap<string, CodemodeTool> | undefined;
	private readonly signal: AbortSignal | undefined;
	private readonly timer: NodeJS.Timeout | undefined;
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	private finished = false;
	private readonly budget = new BridgeBudget();
	private readonly serializer = new BoundedJson();
	private replyChars = 0;
	private readonly lifecycle: ExecutionOptions["lifecycle"];

	constructor(options: ExecutionOptions) {
		this.lifecycle = options.lifecycle;
		this.promise = new Promise<CodemodeResult>((resolve) => {
			this.resolveResult = resolve;
		});
		this.tools = options.tools;
		this.globals = options.globals;
		this.signal = options.signal;

		if (Number.isFinite(options.timeoutMs)) {
			this.timer = setTimeout(() => {
				this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeoutMs} ms` });
			}, options.timeoutMs);
		}

		if (options.signal) {
			if (options.signal.aborted) {
				this.onAbort();
			} else {
				options.signal.addEventListener("abort", this.onAbort, { once: true });
			}
		}

		void options.wasm.then(
			(wasm) => this.start(options, wasm),
			(error: unknown) => {
				this.finish({ kind: "sandbox", message: `Failed to load QuickJS: ${errorMessage(error)}` });
			},
		).catch(this.onStartFailure);
	}
	private readonly onStartFailure = (error: unknown): void => {
		this.finish({ kind: "sandbox", message: errorMessage(error) });
	};

	abort(message: string): Promise<CodemodeResult> {
		this.finish({ kind: "aborted", message });
		return this.promise;
	}

	private start(options: ExecutionOptions, wasm: CodemodeWasmModule): void {
		if (this.finished) return;
		const workerData: WorkerData = {
			code: options.code,
			tools: options.toolCatalog,
			globals: options.globalCatalog,
			wasm,
			memoryLimitBytes: options.memoryLimitBytes,
			store: options.store,
			interrupt: this.interrupt,
		};
		let worker: Worker;
		try {
			// Host preload/inspector hooks and environment credentials are not VM dependencies.
			const source = typeof options.workerUrl === "string" ? options.workerUrl.endsWith(".ts") : options.workerUrl.pathname.endsWith(".ts");
			worker = new Worker(options.workerUrl, { workerData, execArgv: source ? WORKER_EXEC_ARGV : WORKER_COMPILED_EXEC_ARGV, env: WORKER_ENV });
		} catch (error) {
			this.finish({ kind: "sandbox", message: `Failed to start worker: ${errorMessage(error)}` });
			return;
		}
		this.worker = worker;
		this.lifecycle.workersStarted++;
		worker.on("message", (message: unknown) => this.handleMessage(message));
		worker.on("error", (error: unknown) => {
			this.finish({
				kind: "sandbox",
				name: error instanceof Error ? error.name : undefined,
				message: errorMessage(error),
			});
		});
		worker.on("exit", (code) => {
			this.finish({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` });
		});
	}

	private readonly onAbort = (): void => {
		const reason: unknown = this.signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	private post(message: HostToWorkerMessage): void {
		this.worker?.postMessage(message);
	}

	private handleMessage(message: unknown): void {
		if (this.finished) return;
		if (!isWorkerToHostMessage(message) || !this.budget.consume(message)) {
			this.finish({ kind: "sandbox", message: "Invalid or oversized Codemode bridge message" });
			return;
		}
		switch (message.type) {
			case "output":
				this.output.push(message.item);
				break;
			case "call":
				void this.handleCall(message);
				break;
			case "done":
				this.handleDone(message);
				break;
			case "crash":
				this.finish({ kind: "sandbox", message: message.message });
				break;
		}
	}

	private handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
		try {
		if (!message.ok) {
			const parsed = JSON.parse(message.error) as Omit<CodemodeError, "kind">;
			this.finish({ kind: "script", message: typeof parsed.message === "string" ? parsed.message : "Script failed",
				name: typeof parsed.name === "string" ? parsed.name : undefined, stack: typeof parsed.stack === "string" ? parsed.stack : undefined });
			return;
		}
		this.finish(undefined, message.value === undefined ? undefined : JSON.parse(message.value), parseStoreWrites(message.writes));
		} catch (error) {
			this.finish({ kind: "sandbox", message: errorMessage(error) });
		}
	}

	private async handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): Promise<void> {
		const { id, name } = message;
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool ? { name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(id, pending);

		let status: CodemodeCallStatus;
		let reply: HostToWorkerMessage;
		try {
			const tool = (isTool ? this.tools : this.globals)?.get(name);
			if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await tool.execute(args, { signal: pending.controller.signal });
			if (this.finished) return;
			const payload = value === undefined ? undefined : this.serializer.stringify(value, MAX_VALUE_CHARS);
			this.replyChars += payload?.length ?? 0;
			if (this.replyChars > MAX_BRIDGE_CHARS) throw new RangeError("Codemode cumulative tool result limit exceeded");
			reply = { type: "result", id, ok: true, payload };
			status = "ok";
		} catch (error) {
			reply = { type: "result", id, ok: false, payload: errorMessage(error) };
			status = "error";
		}

		// Already cancelled by finish(): the record keeps "cancelled" and the
		// worker is gone or going.
		if (!this.pending.delete(id)) return;
		if (record) {
			record.status = status;
			record.durationMs = performance.now() - pending.startedAt;
		}
		this.post(reply);
	}

	private finish(error: CodemodeError | undefined, value?: unknown, writes?: CodemodeStoreWrites): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);

		const now = performance.now();
		for (const pending of this.pending.values()) {
			if (pending.record) pending.record.durationMs = now - pending.startedAt;
			pending.controller.abort();
		}
		this.pending.clear();
		this.tools = undefined;
		this.globals = undefined;

		const result: CodemodeResult = error
			? { ok: false, error, output: this.output, calls: this.calls }
			: {
					ok: true,
					value,
					output: this.output,
					calls: this.calls,
					storeWrites: writes ?? { set: Object.create(null), delete: [] },
				};
		if (!this.worker) {
			this.resolveResult(result);
			return;
		}
		Atomics.store(new Int32Array(this.interrupt), 0, 1);
		const worker = this.worker;
		this.worker = undefined;
		worker
			.terminate()
			.catch(() => undefined)
			.then(() => { worker.removeAllListeners(); this.lifecycle.workersStopped++; this.resolveResult(result); });
	}
}

/**
 * Runs JavaScript in a QuickJS VM (a separate wasm instance) inside a worker
 * thread. The script sees `tools.<name>(args)` for every registered tool, `ALL_TOOLS`,
 * the output helpers `text`, `image`, `exit`, and `console.*`, `store`/`load`, and the
 * configured globals; nothing else (no timers, `fetch`, `process`, `require`, modules).
 *
 * Each `execute()` gets its own worker and VM; the sandbox only holds the tool
 * table and defaults. `close()` aborts in-flight executions.
 */
export class CodemodeSandbox {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly globalsByName = new Map<string, CodemodeTool>();
	private readonly timeoutMs: number;
	private readonly memoryLimitBytes: number | undefined;
	private readonly wasm: CodemodeWasmModule | Promise<CodemodeWasmModule> | undefined;
	private readonly workerUrl: string | URL;
	private readonly running = new Set<Execution>();
	private closed = false;
	private toolSnapshot: ReadonlyMap<string, CodemodeTool> | undefined;
	private toolCatalog: WorkerData["tools"] = [];
	private readonly globalCatalog: WorkerData["globals"] = [];
	private readonly lifecycle = { workersStarted: 0, workersStopped: 0 };
	/** Diagnostic snapshot, allocated only on explicit inspection. */
	get stats() { return { activeExecutions: this.running.size, ...this.lifecycle }; }

	constructor(options: CodemodeSandboxOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_BYTES;
		if (!Number.isSafeInteger(this.memoryLimitBytes) || this.memoryLimitBytes < 1024 * 1024 || this.memoryLimitBytes > DEFAULT_MEMORY_BYTES) throw new RangeError("Invalid Codemode memory limit");
		this.wasm = options.wasm;
		this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
		for (const tool of options.tools ?? []) this.registerTool(tool);
		const namespaces = new Set<string>();
		for (const global of options.globals ?? []) {
			const parts = global.name.split(".");
			if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(parts[0])) {
				throw new Error(`Invalid global name "${global.name}"`);
			}
			if (this.globalsByName.has(global.name)) throw new Error(`Global "${global.name}" is already registered`);
			if (parts.length === 2) namespaces.add(parts[0]);
			this.globalsByName.set(global.name, global);
			this.globalCatalog.push({ name: global.name, spread: global.spread === true });
		}
		for (const name of namespaces) {
			if (this.globalsByName.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
		}
	}

	/** Throws if a tool with the same name is already registered. */
	registerTool(tool: CodemodeTool): void {
		if (this.closed) throw new Error("Sandbox is closed");
		if (tool.name.length > 1024 || this.toolsByName.size >= MAX_TOOLS) throw new RangeError("Codemode tool catalog exceeds limits");
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
		this.toolSnapshot = undefined;
	}

	unregisterTool(name: string): boolean {
		this.toolSnapshot = undefined;
		return this.toolsByName.delete(name);
	}

	get tools(): CodemodeTool[] {
		return [...this.toolsByName.values()];
	}

	get globals(): CodemodeTool[] {
		return [...this.globalsByName.values()];
	}

	/**
	 * `code` is an async function body: `return` and top-level `await` work.
	 * Never rejects for script failures; those come back as `{ ok: false }`.
	 * The script can use `store(key, value)` and `load(key)` on `options.store`.
	 */
	async execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
		if (this.running.size !== 0) throw new Error("Codemode sandbox already has an active execution");
		if (code.length > MAX_CODE_CHARS) throw new RangeError("Codemode source exceeds its limit");
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new RangeError("Codemode timeout must be 1..300000 ms");
		if (!this.toolSnapshot) {
			this.toolCatalog = [];
			const identifiers = assignCodemodeIdentifiers(this.toolsByName.keys());
			let chars = 0;
			for (const tool of this.toolsByName.values()) {
				const description = tool.description ?? "";
				chars += tool.name.length * 2 + description.length;
				if (chars > MAX_CATALOG_CHARS) throw new RangeError("Codemode catalog text exceeds its limit");
				this.toolCatalog.push({ name: tool.name, jsName: identifiers.get(tool.name)!, description });
			}
			this.toolSnapshot = new Map(this.toolsByName);
		}
		const execution = new Execution({
			code,
			tools: this.toolSnapshot,
			globals: this.globalsByName,
			toolCatalog: this.toolCatalog,
			globalCatalog: this.globalCatalog,
			timeoutMs,
			signal: options.signal,
			memoryLimitBytes: this.memoryLimitBytes,
			store: serializeStore(options.store),
			wasm: this.wasm === undefined ? loadQuickJSWasm() : Promise.resolve(this.wasm),
			workerUrl: this.workerUrl,
			lifecycle: this.lifecycle,
		});
		this.running.add(execution);
		try { return await execution.promise; }
		finally { this.running.delete(execution); }
	}

	/** Aborts in-flight executions (they resolve with `kind: "aborted"`) and rejects new ones. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
		this.toolsByName.clear();
		this.globalsByName.clear();
		this.toolSnapshot = undefined;
		this.toolCatalog.length = 0;
		this.globalCatalog.length = 0;
	}
}
