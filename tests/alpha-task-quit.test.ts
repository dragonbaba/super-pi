import assert from "node:assert/strict";
import test from "node:test";
import { alphaSession } from "./helpers/alpha-session.ts";
import { registerManagedTasks } from "../packages/extensions/managed-tasks.ts";
import { SubagentTasks } from "../packages/extensions/subagent/tasks.ts";

for (const mode of ["regular", "fullscreen"] as const) {
	test(`manual quit asks once for both providers, cancel preserves tasks, confirm awaits cleanup: ${mode}`, async t => {
		const shell = new SubagentTasks(2), child = new SubagentTasks(2);
		const shellTask = shell.create("bash"), childTask = child.create("scout"); shell.start(shellTask); child.start(childTask);
		let cleanupStarted = false, cleaned = false, exits = 0, dialogs = 0;
		let releaseCleanup!: () => void;
		let markCleanup!: () => void;
		const cleanupReady = new Promise<void>(resolve => { markCleanup = resolve; });
		const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
		const provider = (kind: "shell" | "subagent", tasks: SubagentTasks) => (pi: any) => {
			const registration = registerManagedTasks(pi, kind, { tasks, guidance: "fixture", list: () => "fixture" });
			pi.on("session_shutdown", async () => {
				tasks.cancelAll(); cleanupStarted = true; markCleanup(); await cleanup;
				registration.unregister(); tasks.dispose(); cleaned = true;
			});
		};
		const f = await alphaSession({ mode, extensions: [provider("shell", shell), provider("subagent", child)] });
		t.mock.method(process, "exit", (code: number) => { assert.equal(code, 0); assert.equal(cleaned, true); exits++; });
		let confirm!: (value: boolean) => void;
		t.mock.method(f.internal, "showExtensionConfirm", (_title: string, message: string) => {
			dialogs++; assert.match(message, /2 项任务/); return new Promise<boolean>(resolve => { confirm = resolve; });
		});
		try {
			await f.mode.init();
			const cancelled = f.internal.shutdown(); assert.equal(f.internal.shutdown(), cancelled);
			assert.equal(dialogs, 1); confirm(false); await cancelled;
			assert.equal(exits, 0); assert.equal(cleanupStarted, false); assert.equal(f.input.isRaw, true);
			assert.equal(shellTask.controller?.signal.aborted, false); assert.equal(childTask.controller?.signal.aborted, false);
			const approved = f.internal.shutdown(); assert.equal(dialogs, 2); confirm(true);
			await cleanupReady;
			assert.equal(exits, 0); assert.equal(cleanupStarted, true);
			releaseCleanup(); await approved;
			assert.equal(exits, 1); assert.equal(shell.size + child.size, 0); assert.equal(f.input.isRaw, false);
		} finally { releaseCleanup(); await f.release(); }
	});
}

test("termination signal cancels a pending quit dialog and joins mandatory cleanup", async t => {
	const tasks = new SubagentTasks(1); tasks.create("scout"); let dialogs = 0, exits = 0;
	const f = await alphaSession({ extensions: [(pi: any) => {
		const registration = registerManagedTasks(pi, "subagent", { tasks, guidance: "fixture", list: () => "fixture" });
		pi.on("session_shutdown", () => { tasks.dispose(); registration.unregister(); });
	}] });
	t.mock.method(process, "exit", () => { exits++; });
	t.mock.method(f.internal, "showExtensionConfirm", (_title: string, _message: string, options: { signal: AbortSignal }) => {
		dialogs++; return new Promise<boolean>(resolve => { options.signal.addEventListener("abort", () => resolve(false), { once: true }); });
	});
	try {
		await f.mode.init(); const pending = f.internal.shutdown();
		assert.equal(f.internal.shutdown({ fromSignal: true }), pending); await pending;
		assert.equal(dialogs, 1); assert.equal(exits, 1); assert.equal(tasks.size, 0);
	} finally { await f.release(); }
});

test("failed confirmation aborts its dialog and preserves the running session for retry", async t => {
	const tasks = new SubagentTasks(1); const task = tasks.create("scout"); let signal: AbortSignal | undefined;
	const f = await alphaSession({ extensions: [(pi: any) => {
		const registration = registerManagedTasks(pi, "subagent", { tasks, guidance: "fixture", list: () => "fixture" });
		pi.on("session_shutdown", () => { tasks.dispose(); registration.unregister(); });
	}] });
	t.mock.method(f.internal, "showExtensionConfirm", (_title: string, _message: string, options: { signal: AbortSignal }) => {
		signal = options.signal; return Promise.reject(new Error("fixture dialog failure"));
	});
	try {
		await f.mode.init(); await assert.rejects(f.internal.shutdown(), /fixture dialog failure/);
		assert.equal(signal?.aborted, true); assert.equal(f.input.isRaw, true); assert.equal(task.controller?.signal.aborted, false);
		assert.equal(f.internal.shutdownOperation, undefined);
	} finally { await f.release(); }
});

test("an earlier failing shutdown extension cannot skip later owners or acknowledge success", async t => {
	let cleaned = false, exits = 0;
	const f = await alphaSession({ extensions: [
		(pi: any) => pi.on("session_shutdown", () => { throw new Error("fixture shutdown failure"); }),
		(pi: any) => pi.on("session_shutdown", () => { cleaned = true; }),
	] });
	t.mock.method(process, "exit", () => { exits++; });
	try {
		await f.mode.init(); await assert.rejects(f.internal.shutdown(), /fixture shutdown failure/);
		assert.equal(cleaned, true); assert.equal(exits, 0); assert.equal(f.input.isRaw, false);
	} finally { await f.release().catch(() => {}); }
});
