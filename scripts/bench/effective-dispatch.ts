import { observePiMessagesEffectiveDispatch } from "../../packages/ai/src/api/pi-messages.ts";
import type { EffectiveDispatchObservation, Model } from "../../packages/ai/src/types.ts";
import { createToolOutput } from "./fixtures.ts";
import { readIntegerOption, runBenchmarkMain } from "./benchmark.ts";

export interface EffectiveDispatchStructuralMetrics extends Record<string, number> {
	payloadBytes: number;
	iterations: number;
	observerCallbacks: number;
	fullPayloadSerializations: number;
}

function fixtureModel(): Model<"pi-messages"> {
	return {
		id: "effective-dispatch-benchmark",
		name: "Effective Dispatch Benchmark",
		api: "pi-messages",
		provider: "fixture",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

export function createEffectiveDispatchBenchmarkScenario(
	mebibytes: number,
	observerEnabled: boolean,
): { run(): EffectiveDispatchStructuralMetrics } {
	const largeContent = createToolOutput(mebibytes);
	const payloadBytes = Buffer.byteLength(largeContent);
	let fullPayloadSerializations = 0;
	let observerCallbacks = 0;
	let iterations = 0;
	const payload = {
		model: "effective-dispatch-benchmark",
		context: {
			systemPrompt: "bounded prefix",
			messages: [{ role: "user", content: largeContent }],
			tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
		},
		options: { cacheRetention: "long", sessionId: "benchmark-session" },
	};
	Object.defineProperty(payload, "toJSON", {
		enumerable: false,
		value: () => {
			fullPayloadSerializations++;
			return { model: payload.model, context: payload.context, options: payload.options };
		},
	});
	const model = fixtureModel();
	const options = observerEnabled
		? {
			onEffectiveDispatch: (_observation: Readonly<EffectiveDispatchObservation>) => {
				observerCallbacks++;
			},
		}
		: undefined;
	return {
		run() {
			iterations++;
			observePiMessagesEffectiveDispatch(options, model, payload);
			return {
				payloadBytes,
				iterations,
				observerCallbacks,
				fullPayloadSerializations,
			};
		},
	};
}

function observerMode(argv = process.argv.slice(2)): boolean {
	const index = argv.indexOf("--observer");
	const value = index === -1 ? "on" : argv[index + 1];
	if (value !== "on" && value !== "off") throw new Error("--observer must be on or off");
	return value === "on";
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
	const mebibytes = readIntegerOption("--size", 1);
	const enabled = observerMode();
	const scenario = createEffectiveDispatchBenchmarkScenario(mebibytes, enabled);
	await runBenchmarkMain({
		name: "effective-dispatch-prefix-observer",
		fixture: `pi-messages-${mebibytes}m-observer-${enabled ? "on" : "off"}`,
		run: () => scenario.run(),
		observations: () => ({
			observer: enabled ? "on" : "off",
			payloadMebibytes: mebibytes,
			fullPayloadHashing: false,
		}),
	});
}
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
