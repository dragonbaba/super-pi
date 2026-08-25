import { Agent } from "../../packages/agent/src/agent.ts";
import type { AgentEvent } from "../../packages/agent/src/types.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createToolProgress } from "./fixtures.ts";

const updateCount = readIntegerOption("--updates", 100_000);
const legacyDelivery = process.argv.includes("--legacy-delivery");
const updates = createToolProgress(updateCount, 1);

function createAssistantStream(withToolCall: boolean): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const content = withToolCall
			? [{ type: "toolCall", id: "tool-0", name: "progress", arguments: {} }]
			: [{ type: "text", text: "complete" }];
		const message = {
			role: "assistant",
			content,
			api: "benchmark",
			provider: "benchmark",
			model: "benchmark",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: withToolCall ? "toolUse" : "stop",
			timestamp: 0,
		};
		stream.push({ type: "start", partial: message as never });
		if (withToolCall) {
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message as never });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: content[0] as never, partial: message as never });
			stream.push({ type: "done", reason: "toolUse", message: message as never });
		} else {
			stream.push({ type: "text_start", contentIndex: 0, partial: message as never });
			stream.push({ type: "text_end", contentIndex: 0, content: "complete", partial: message as never });
			stream.push({ type: "done", reason: "stop", message: message as never });
		}
	});
	return stream;
}

await runBenchmarkMain({
	name: "tool-progress",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:tool-progress:${updateCount}`,
	run: async () => {
		let streamCalls = 0;
		let deliveredUpdates = 0;
		let pendingSlots = 0;
		let maxPendingSlots = 0;
		const tool = {
			name: "progress",
			label: "Progress",
			description: "Benchmark progress updates",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: async (_id: string, _params: unknown, _signal?: AbortSignal, onUpdate?: (value: unknown) => void) => {
				for (const update of updates) onUpdate?.({ content: [{ type: "text", text: update.content }], details: update });
				return { content: [{ type: "text", text: "done" }], details: { updates: updateCount } };
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool as never] },
			streamFn: () => createAssistantStream(streamCalls++ === 0),
			eventInstrumentation: {
				onToolProgressPending: (_toolCallId, pending) => {
					pendingSlots += pending ? 1 : -1;
					maxPendingSlots = Math.max(maxPendingSlots, pendingSlots);
				},
			},
		});
		const countUpdate = (event: AgentEvent) => {
			if (event.type === "tool_execution_update") deliveredUpdates++;
		};
		if (legacyDelivery) agent.subscribe(countUpdate);
		else agent.subscribeObserver(countUpdate, { minIntervalMs: 60_000 });
		await agent.prompt("benchmark");
		return {
			updates: updateCount,
			eventsDelivered: deliveredUpdates,
			maxPendingSlots,
			maxPendingKeys: agent.eventDeliveryStats.maxPendingKeys,
			legacyDelivery: legacyDelivery ? 1 : 0,
		};
	},
});
