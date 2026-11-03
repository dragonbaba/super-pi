import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { stream as streamBedrock } from "../../packages/ai/src/api/bedrock-converse-stream.ts";
import type { Model } from "../../packages/ai/src/types.ts";

export const bedrockArgumentsModel: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-sonnet-4-5", name: "fixture", api: "bedrock-converse-stream", provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", reasoning: false, input: ["text"],
	contextWindow: 1000000, maxTokens: 1000000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Real adapter and event delivery after the SDK send boundary; no network decoding is measured. */
export function bedrockArgumentsFixture(inputs: readonly string[], chunkCharacters: number, omitToolStop = false, failAfterChunks?: number) {
	const events: any[] = [{ messageStart: { role: "assistant" } }];
	for (let index = 0; index < inputs.length; index++) events.push({ contentBlockStart: { contentBlockIndex: index, start: { toolUse: { toolUseId: `tool-${index}`, name: "fixture" } } } });
	for (let offset = 0; inputs.some(input => offset < input.length); offset += chunkCharacters) {
		for (let index = 0; index < inputs.length; index++) if (offset < inputs[index].length) events.push({ contentBlockDelta: {
			contentBlockIndex: index, delta: { toolUse: { input: inputs[index].slice(offset, offset + chunkCharacters) } },
		} });
	}
	if (!omitToolStop) for (let index = 0; index < inputs.length; index++) events.push({ contentBlockStop: { contentBlockIndex: index } });
	events.push({ messageStop: { stopReason: "tool_use" } });
	const originalSend = BedrockRuntimeClient.prototype.send;
	BedrockRuntimeClient.prototype.send = (async (_command: unknown, options: { abortSignal?: AbortSignal }) => ({ $metadata: {}, stream: (async function* () {
		for (let index = 0; index < events.length; index++) {
			options.abortSignal?.throwIfAborted();
			if (index === failAfterChunks) throw new Error("injected transport failure");
			yield events[index];
		}
	})() })) as typeof originalSend;
	return {
		events,
		start(factory: typeof streamBedrock = streamBedrock, signal?: AbortSignal) {
			return factory(bedrockArgumentsModel, { messages: [] }, { signal, region: "us-east-1", apiKey: "synthetic-bedrock-token",
				env: { AWS_PROFILE: "", AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" } });
		},
		release(): void { BedrockRuntimeClient.prototype.send = originalSend; events.length = 0; },
	};
}
