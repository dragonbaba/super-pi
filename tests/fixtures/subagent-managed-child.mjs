// Offline child fixture: writes only a ready marker in its task-owned temporary cwd.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const task = process.argv.at(-1) ?? "";
const delay = task.includes("slow") ? 800 : task.includes("hold") ? 30_000 : 10;
const message = {
	role: "assistant", content: [{ type: "text", text: `fixture result: ${task}` }],
	api: "test", provider: "test", model: "fixture", stopReason: "stop", timestamp: 0,
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
if (!process.argv.includes("--no-session") || !process.argv.includes("--no-extensions")) process.exit(90);
const promptIndex = process.argv.indexOf("--append-system-prompt");
const systemPrompt = promptIndex < 0 ? "" : readFileSync(process.argv[promptIndex + 1], "utf8");
const toolsIndex = process.argv.indexOf("--tools");
const tools = toolsIndex < 0 ? undefined : process.argv[toolsIndex + 1];
writeFileSync(join(process.cwd(), `child-${process.pid}.ready.json`), JSON.stringify({ pid: process.pid, task, systemPrompt, tools, allowBash: process.env.SP_SUBAGENT_ALLOW_BASH }));
let sequence = 0;
async function control(kind, fields = {}) {
	if (process.env.SP_SUBAGENT_CONTROL !== "1") return {};
	const id = ++sequence;
	return new Promise((resolve, reject) => {
		process.once("message", raw => {
			const reply = JSON.parse(raw);
			if (reply.id !== id || !reply.ok) reject(new Error(reply.reason ?? "Bad fixture control reply"));
			else resolve(reply);
		});
		process.send(JSON.stringify({ id, kind, ...fields }));
	});
}
try {
	const init = await control("ready");
	const capacityHandoff = task.includes("capacity-handoff");
	const turns = task.includes("two-turn") || capacityHandoff ? 2 : 1;
	for (let turn = 0; turn < turns; turn++) {
		if (init.checkpoint) await control("begin");
		await new Promise(resolve => setTimeout(resolve, delay));
		const response = capacityHandoff && turn === 0 ? { ...message, content: [{ type: "text", text: "large evidence ".repeat(60_000) }] } : message;
		process.stdout.write(`${JSON.stringify({ type: "message_end", message: response })}\n`);
		if (init.checkpoint) await control("turn", { completed: true, message: response, results: [] });
		if (task.includes("checkpoint-hold")) await new Promise(resolve => setTimeout(resolve, 30_000));
	}
	process.exitCode = task.includes("fail") ? 1 : 0;
} catch (error) {
	process.stdout.write(`${JSON.stringify({ type: "message_end", message: { ...message, stopReason: "error", errorMessage: error.message } })}\n`);
	process.exitCode = 1;
} finally { if (process.connected) process.disconnect(); }
