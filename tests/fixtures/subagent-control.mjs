import { installChildControl } from "../../packages/extensions/subagent/child-control.ts";
const hooks = new Map();
let aborted = 0;
installChildControl({ on(name, hook) { hooks.set(name, hook); } });
await hooks.get("session_start")({}, { abort() { aborted++; } });
const initial = [{ role: "user", content: "new instruction", timestamp: 3 }];
const context = await hooks.get("context")({ messages: initial });
const prompt = await hooks.get("before_agent_start")({ systemPrompt: "fixture" });
const mode = process.argv[2];
let denied;
for (let i = 0; i < 2; i++) {
	const admission = await hooks.get("before_model_request")({});
	if (admission?.block) { denied = admission.reason; break; }
	const message = { role: "assistant", api: "test", provider: "test", model: "fixture", timestamp: 4 + i, stopReason: "stop",
		usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: mode === "bad-checkpoint" ? [{ type: "image", data: "unsupported" }] : [{ type: "text", text: "done" }] };
	await hooks.get("message_end")({ message });
	await hooks.get("turn_end")({ message, toolResults: [] });
	if (aborted) break;
}
process.stdout.write(JSON.stringify({ seedRoles: context?.messages.map(message => message.role), initialCount: initial.length, prompt: prompt.systemPrompt, aborted, denied }));
await hooks.get("session_shutdown")();
