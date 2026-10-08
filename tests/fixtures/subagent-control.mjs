import { installChildControl } from "../../packages/extensions/subagent/child-control.ts";
const hooks = new Map();
const initialMessageListeners = process.listenerCount("message");
const initialDisconnectListeners = process.listenerCount("disconnect");
let aborted = 0;
let toolsDisabled = 0;
let followUps = 0;
installChildControl({ on(name, hook) { hooks.set(name, hook); }, setActiveTools(names) { if (names.length) throw new Error("Unexpected tools"); toolsDisabled++; },
	sendMessage(message, options) { if (options.deliverAs !== "followUp" || !options.triggerTurn || !message.content.includes("HANDOFF NOW")) throw new Error("Bad handoff follow-up"); followUps++; } });
await hooks.get("session_start")({}, { abort() { aborted++; } });
const initial = [{ role: "user", content: "new instruction", timestamp: 3 }];
const context = await hooks.get("context")({ messages: initial });
const prompt = await hooks.get("before_agent_start")({ systemPrompt: "fixture" });
const startupDisabled = toolsDisabled;
const mode = process.argv[2];
for (let i = 0; i < 2; i++) {
	await hooks.get("turn_start")({});
	if (aborted) break;
	const message = { role: "assistant", api: "test", provider: "test", model: "fixture", timestamp: 4 + i, stopReason: "stop",
		usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: mode === "bad-checkpoint" ? [{ type: "image", data: "unsupported" }] : [{ type: "text", text:
			i === 0 && mode === "large-turn" ? "x".repeat(800_000) : i === 0 && mode === "transport-overflow" ? "€".repeat(800_000)
			: i === 0 && mode === "checkpoint-overflow" ? "€".repeat(400_000) : toolsDisabled ? "handoff: done; remaining inspection belongs to a fresh bounded assignment" : "done" }] };
	const toolResults = [];
	if (i === 0 && mode === "large-tool-result") {
		message.stopReason = "toolUse";
		message.content = [{ type: "toolCall", id: "large-read", name: "read", arguments: { path: "fixture.txt" } }];
		toolResults.push({ role: "toolResult", toolCallId: "large-read", toolName: "read", isError: false, timestamp: 5, content: [{ type: "text", text: "x".repeat(800_000) }] });
	}
	await hooks.get("turn_end")({ message, toolResults });
	if (aborted) break;
}
const lastContext = await hooks.get("context")({ messages: initial });
const summary = { seedRoles: context?.messages.map(message => message.role), initialCount: initial.length, prompt: prompt?.systemPrompt, aborted,
	startupDisabled, toolsDisabled, followUps, toolBlocked: (await hooks.get("tool_call")({ toolName: "read" }))?.block === true,
	capacityNotice: lastContext?.messages.at(-1)?.content };
await hooks.get("session_shutdown")();
summary.messageListeners = process.listenerCount("message") - initialMessageListeners;
summary.disconnectListeners = process.listenerCount("disconnect") - initialDisconnectListeners;
process.stdout.write(JSON.stringify(summary));
