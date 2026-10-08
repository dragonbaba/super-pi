// Offline child fixture: writes only a ready marker in its task-owned temporary cwd.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const task = process.argv.at(-1) ?? "";
const delay = task.includes("slow") ? 800 : task.includes("hold") ? 30_000 : 10;
const message = {
	role: "assistant", content: [{ type: "text", text: `fixture result: ${task}` }],
	api: "test", provider: "test", model: "fixture", stopReason: "stop", timestamp: 0,
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
if (!process.argv.includes("--no-session") || !process.argv.includes("--no-extensions")) process.exit(90);
writeFileSync(join(process.cwd(), `child-${process.pid}.ready.json`), JSON.stringify({ pid: process.pid, task }));
setTimeout(() => {
	process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
	process.exitCode = task.includes("fail") ? 1 : 0;
}, delay);
