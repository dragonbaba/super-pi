import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { observeAnthropicEffectiveDispatch } from "../../packages/ai/src/api/anthropic-messages.ts";
import type { EffectiveDispatchObservation, Model } from "../../packages/ai/src/types.ts";
import { readIntegerOption, runBenchmarkMain } from "./benchmark.ts";

function fixtureModel(): Model<"anthropic-messages"> {
	return {
		id: "cache-marker-benchmark",
		name: "Cache Marker Benchmark",
		api: "anthropic-messages",
		provider: "fixture",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
	const messageCount = readIntegerOption("--messages", 50_000);
	const marker = { type: "ephemeral", ttl: "1h" };
	const messages = Array.from({ length: messageCount }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: [{
			type: "text",
			text: `m${index}`,
			...(index === messageCount - 1 ? { cache_control: marker } : {}),
		}],
	}));
	let observerCallbacks = 0;
	await runBenchmarkMain({
		name: "cache-marker-extraction",
		fixture: `anthropic-${messageCount}-short-messages`,
		run: () => {
			observeAnthropicEffectiveDispatch({
				onEffectiveDispatch: (_observation: Readonly<EffectiveDispatchObservation>) => {
					observerCallbacks++;
				},
			}, fixtureModel(), {
				model: "cache-marker-benchmark",
				stream: true,
				max_tokens: 64,
				messages,
			} as never);
			return { messageCount, observerCallbacks };
		},
		observations: () => ({
			providerShape: "anthropic-messages",
			semanticBoundaryAnchors: true,
			objectPool: false,
		}),
	});
}
