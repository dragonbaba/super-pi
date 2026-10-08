import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "node:inspector/promises";
import { createHook } from "node:async_hooks";
import { setImmediate as tick } from "node:timers/promises";

if (!globalThis.gc) throw new Error("Run with --expose-gc.");
// Configure before importing extension constants; never read user settings.
const root = mkdtempSync(join(tmpdir(), "sp-shell-bench-"));
// This standalone benchmark process owns the environment override until exit.
process.env.SP_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "config"), { recursive: true });
writeFileSync(join(root, "agent", "config", "background-shell-limits.json"), '{"maxConcurrent":4,"maxTasks":8}');
const { BackgroundShellTasks } = await import("../../packages/extensions/resource-lifecycle-guard/background-shell.ts");
const { createEventBus } = await import("../../packages/coding-agent/src/core/event-bus.ts");
const { createBashToolDefinition } = await import("../../packages/coding-agent/src/core/tools/bash.ts");
const { registerLocalShellBackend, getShellCwdBinding } = await import("../../packages/coding-agent/src/core/tools/shell-cwd.ts");
const { attachBackgroundShellLaunch } = await import("../../packages/coding-agent/src/core/tools/shell-background.ts");
const updates = 1000, chunk = Buffer.from("evidence ".repeat(128) + "\n");
let pumping = false, chunkPromises = 0, chunkControllers = 0;
const hook = createHook({ init(_id, type) { if (pumping && type === "PROMISE") chunkPromises++; } });
const NativeController = globalThis.AbortController;
globalThis.AbortController = class extends NativeController { constructor() { super(); if (pumping) chunkControllers++; } };

function harness() {
	const events = createEventBus(), hooks: unknown[] = [], tools = new Map<string, any>();
	let notifications = 0;
	const pi: any = { events, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on: (_name: string, fn: unknown) => hooks.push(fn), sendMessage: () => { notifications++; } };
	const manager = new BackgroundShellTasks(pi);
	pi.getAllTools = () => [...tools.values()];
	const ctx: any = { cwd: root, mode: "tui", getActiveTools: () => ["bash", "tasks"] };
	return { manager, ctx, events, tools, notifications: () => notifications,
		async dispose() { await manager.dispose(); hooks.length = 0; tools.clear(); events.clear(); } };
}

function sampledSites(node: any, sites: Map<string, number>): number {
	let bytes = node.selfSize;
	if (bytes) {
		const name = `${node.callFrame.functionName}:${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
		sites.set(name, (sites.get(name) ?? 0) + bytes);
	}
	for (const child of node.children ?? []) bytes += sampledSites(child, sites);
	return bytes;
}

async function profile(background: boolean) {
	const h = harness(); let publications = 0, received = 0;
	const backend = registerLocalShellBackend({ async exec(_command: string, cwd: string, options: any) {
		options.beforeSpawn?.(cwd);
		// Synthetic producer; the consumer is the real shell handleData/accumulator.
		pumping = true;
		try { for (let i = 0; i < updates; i++) { options.onData(chunk); received++; } }
		finally { pumping = false; }
		return { exitCode: 0, termination: "exit" as const, observation: { started: true, cwd, exitCode: 0, signal: null, outputDrained: true } };
	} });
	const tool = createBashToolDefinition(root, { operations: backend, exposeSessionEnvironment: false });
	const input = { command: "fixture", cwd: ".", background };
	if (background) attachBackgroundShellLaunch(input, h.manager.createLaunch("bash", "fixture", input.command, root, h.ctx, () => {}));
	const inspector = new Session(); inspector.connect(); globalThis.gc!();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	let result: any;
	try {
		result = await tool.execute("fixture", input, undefined, value => { structuredClone(value); publications++; }, h.ctx);
		if (background) {
			const id = result.details.backgroundTask.id;
			const task = await h.manager.tasks.wait(id, 60_000);
			assert.equal(task.state, "completed"); assert.ok(task.result!.length <= 12_000);
			result = await h.tools.get("tasks").execute("read", { action: "status", id });
			assert.equal(result.details.result.truncation.content, "");
			assert.equal(result.details.result.shellExecution.output.cleanup, "removed");
		}
		const { profile } = await inspector.post("HeapProfiler.stopSampling");
		const sites = new Map<string, number>(), sampledBytes = sampledSites(profile.head, sites);
		assert.equal(received, updates); if (background) assert.equal(publications, 0);
		const weak = [new WeakRef(input), new WeakRef(backend), new WeakRef(tool), new WeakRef(h.manager)];
		const binding = getShellCwdBinding(input); assert.ok(binding?.isReleased); weak.push(new WeakRef(binding!));
		return { mode: background ? "background" : "foreground", updates: received, publications, notifications: h.notifications(), sampledBytesPerChunk: sampledBytes / updates,
			topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 5), weak };
	} finally {
		inspector.disconnect();
		const path = result?.details?.fullOutputPath;
		if (path) { assert.equal(dirname(path), tmpdir()); unlinkSync(path); if (existsSync(path + ".sp-owned")) unlinkSync(path + ".sp-owned"); }
		await h.dispose();
	}
}

async function lifecycle(mode: "complete" | "failure" | "cancel" | "dispose") {
	const h = harness(), weak: WeakRef<object>[] = [new WeakRef(h.manager)]; let releases = 0;
	const ids: string[] = [];
	for (let i = 0; i < 8; i++) {
		const execute = async (signal: AbortSignal) => { await tick(); signal.throwIfAborted(); if (mode === "failure") throw new Error("fixture failure"); return { content: [{ type: "text" as const, text: "result" }], details: undefined }; };
		weak.push(new WeakRef(execute));
		const accepted = h.manager.createLaunch("bash", `call-${i}`, "fixture", root, h.ctx, () => {})(execute, undefined, () => { releases++; });
		const task = h.manager.tasks.get(accepted.details.backgroundTask!.id);
		weak.push(new WeakRef(task), new WeakRef(task.controller!)); ids.push(task.id);
	}
	if (mode === "cancel") h.manager.tasks.cancelAll();
	if (mode === "dispose") await h.dispose();
	else for (const id of ids) await h.manager.tasks.wait(id, 1000);
	await h.dispose();
	const s = h.manager.scheduler, tasks = h.manager.tasks;
	const retained = s.active + s.queued + s.reserved + s.outstanding + s.reservationCount + tasks.size + tasks.waiterCount;
	assert.equal(retained, 0); assert.equal(releases, 8); assert.equal(s.highWaterMark, 4);
	return { mode, highWaterMark: s.highWaterMark, queueHighWaterMark: s.queueHighWaterMark, releases, retained, weak };
}

try {
	hook.enable();
	const profiles = [await profile(false), await profile(true)];
	const lifecycles = [];
	for (const mode of ["complete", "failure", "cancel", "dispose"] as const) lifecycles.push(await lifecycle(mode));
	hook.disable();
	for (let i = 0; i < 8; i++) { await tick(); globalThis.gc!(); }
	let total = 0, live = 0;
	for (const item of [...profiles, ...lifecycles]) for (const ref of item.weak) { total++; if (ref.deref()) live++; }
	assert.equal(live, 0); assert.equal(chunkPromises, 0); assert.equal(chunkControllers, 0);
	console.log(JSON.stringify({ node: process.version, platform: process.platform, producer: "synthetic chunks through production shell tool and manager; no provider traffic",
		profiles: profiles.map(({ weak, ...rest }) => rest), lifecycle: lifecycles.map(({ weak, ...rest }) => rest), perChunk: { promises: chunkPromises, controllers: chunkControllers }, references: { total, live } }, null, 2));
} finally {
	hook.disable(); globalThis.AbortController = NativeController;
	assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true });
}
