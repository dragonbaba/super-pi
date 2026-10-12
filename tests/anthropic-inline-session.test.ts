import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { stream } from "../packages/ai/src/api/anthropic-messages.ts";
import type { Model } from "../packages/ai/src/types.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { alphaModelRuntime } from "./helpers/alpha-session.ts";

test("AgentSession persists inline checkpoints and synchronizes active, nested and removed tools", async t => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-session-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const model: Model<"anthropic-messages"> = { id: "claude-opus-5", name: "Fixture", api: "anthropic-messages", provider: "anthropic",
		baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
	const bodies: any[] = [];
	let executions = 0;
	const runtime = alphaModelRuntime((requestModel, context, options) => stream(requestModel as Model<"anthropic-messages">, context, {
		...options, apiKey: "fixture", maxRetries: 0, cacheRetention: "none", fetch: async (input, init) => {
			bodies.push(await new Request(input, init).json());
			const callRemoved = bodies.length === 3;
			const block = callRemoved ? { type: "tool_use", id: "removed-call", name: "visible_a", input: {} } : { type: "text", text: "OK" };
			const events = [
				{ type: "message_start", message: { id: "fixture", usage: {} } },
				{ type: "content_block_start", index: 0, content_block: block },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: callRemoved ? "tool_use" : "end_turn" }, usage: {} },
				{ type: "message_stop" },
			];
			assert.ok(bodies.length <= 4, "unexpected tool loop");
			return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		},
	}));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await loader.reload();
	const manager = SessionManager.create(root, join(root, "sessions"));
	const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
		settingsManager: settings, resourceLoader: loader, sessionManager: manager, noTools: "builtin",
		customTools: ["visible_a", "visible_b", "nested_probe"].map(name => ({ name, label: name, description: name,
			modelOnly: name !== "nested_probe", parameters: Type.Object({}), promptGuidelines: [`RULE_${name}`],
			execute: async () => { executions++; return { content: [{ type: "text" as const, text: "done" }], details: {} }; },
		})),
	});
	t.after(() => session.dispose());
	session.setActiveToolsByName(["visible_a", "nested_probe"]);
	await session.prompt("first");
	const initialTools = bodies[0].tools;
	assert.ok(initialTools.some((tool: any) => tool.name === "visible_a"));
	assert.equal(initialTools.some((tool: any) => tool.name === "nested_probe"), false);
	session.setActiveToolsByName(["visible_b", "nested_probe"]);
	await session.prompt("second");
	assert.deepEqual(bodies[1].tools, initialTools);
	const changes = bodies[1].messages.at(-1).content;
	assert.ok(changes.some((block: any) => block.type === "tool_removal" && block.tool.name === "visible_a"));
	assert.ok(changes.some((block: any) => block.type === "tool_addition" && block.tool.definition.name === "visible_b"));
	assert.match(changes.find((block: any) => block.type === "text").text, /RULE_visible_b/);
	assert.doesNotMatch(changes.find((block: any) => block.type === "text").text, /RULE_visible_a/);
	const restored = SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages;
	assert.equal(restored.filter(message => message.role === "assistant" && message.anthropicContext).length, 2);
	session.agent.state.messages = restored;
	await session.prompt("third");
	assert.equal(executions, 0, "removed tool must never execute");
	assert.ok(session.messages.some(message => message.role === "toolResult" && message.toolName === "visible_a" && message.isError));
	assert.equal(bodies.length, 4);
});
