import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export function transactionWriter(t: TestContext, path: string, key: string, action: string) {
	const child = spawn(process.execPath, ["--experimental-strip-types",
		fileURLToPath(new URL("../fixtures/oauth-transaction-writer.mjs", import.meta.url)), path, key, action], {
		stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
	});
	let stderr = "", observed: unknown, ready!: () => void, failed!: (error: Error) => void;
	const waiting = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
	void waiting.catch(() => {});
	child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
	child.on("message", (message: { type?: string; refresh?: string }) => {
		if (message.type === "waiting") ready();
		if (message.type === "committed") observed = message.refresh;
	});
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once("error", (error) => { failed(error); reject(error); });
		child.once("close", (code) => { failed(new Error(`fixture exited before lock wait: ${stderr}`)); resolve(code); });
	});
	void closed.catch(() => {});
	async function stop() {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await closed;
	}
	t.after(stop);
	return { waiting, stop, async done() {
		assert.equal(await closed, 0, stderr);
		return observed;
	} };
}
