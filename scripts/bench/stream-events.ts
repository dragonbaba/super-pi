import { setImmediate as yieldToEventLoop, setTimeout as wait } from "node:timers/promises";
import { Agent } from "../../packages/agent/src/agent.ts";
import type { AgentEvent } from "../../packages/agent/src/types.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createAssistantDeltas } from "./fixtures.ts";

const paced16ms = process.argv.includes("--paced-16ms");
const deltaCount = readIntegerOption("--updates", paced16ms ? 30 : 100_000);
const legacyDelivery = process.argv.includes("--legacy-delivery");
const deliveryMode = legacyDelivery ? "legacy" : "latest";
const deltas = createAssistantDeltas(deltaCount);

function createStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const text = { type: "text" as const, text: "" };
	const message = {
		role: "assistant" as const,
		content: [text],
		api: "benchmark",
		provider: "benchmark",
		model: "benchmark",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: 0,
	};
	void (async () => {
		stream.push({ type: "start", partial: message as never });
		stream.push({ type: "text_start", contentIndex: 0, partial: message as never });
		for (let index = 0; index < deltas.length; index++) {
			const delta = deltas[index]!;
			text.text += delta;
			stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message as never });
			if (paced16ms) await wait(16);
			else if ((index & 511) === 511) await yieldToEventLoop();
		}
		stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message as never });
		stream.push({ type: "done", reason: "stop", message: message as never });
	})();
	return stream;
}

await runBenchmarkMain({
	name: "stream-events",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:assistant-deltas:${deltaCount}:delivery-${deliveryMode}:${paced16ms ? "paced-16ms" : "burst"}`,
	run: async () => {
		let deliveredUpdates = 0;
		let snapshots = 0;
		const agent = new Agent({
			streamFn: () => createStream(),
			eventInstrumentation: { onAssistantSnapshot: () => { snapshots++; } },
		});
		const countUpdate = (event: AgentEvent) => {
			if (event.type === "message_update") deliveredUpdates++;
		};
		if (legacyDelivery) agent.subscribe(countUpdate);
		else agent.subscribeObserver(countUpdate, { minIntervalMs: paced16ms ? 16 : 60_000 });
		await agent.prompt("benchmark");
		return {
			updates: deltaCount,
			eventsDelivered: deliveredUpdates,
			snapshots,
			coalesced: agent.eventDeliveryStats.coalesced,
			maxPendingKeys: agent.eventDeliveryStats.maxPendingKeys,
			legacyDelivery: legacyDelivery ? 1 : 0,
			producerPaceMs: paced16ms ? 16 : 0,
		};
	},
});
