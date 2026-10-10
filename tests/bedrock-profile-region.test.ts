import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { BedrockRuntimeClient, type ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { stream, type BedrockOptions } from "../packages/ai/src/api/bedrock-converse-stream.ts";
import { withModelProfile } from "../packages/ai/src/model-capabilities.ts";
import { profileBedrockModel } from "../packages/ai/src/providers/bedrock-profile.ts";
import type { Context, Model } from "../packages/ai/src/types.ts";

async function fixture(t: TestContext, ambientProfile?: string): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "super-pi-bedrock-region-"));
	const configFile = join(directory, "config");
	const credentialsFile = join(directory, "credentials");
	await fs.writeFile(configFile, "[profile fixture-gov]\nregion = us-gov-west-1\n[profile fixture-commercial]\nregion = us-west-2\n[profile fixture-fips]\nregion = fips-us-gov-east-1\n[profile fixture-missing]\noutput = json\n");
	await fs.writeFile(credentialsFile, "");
	const environment: Record<string, string | undefined> = {
		AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
		AWS_PROFILE: ambientProfile, AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined,
		AWS_SDK_LOAD_CONFIG: "1", AWS_EC2_METADATA_DISABLED: "true",
	};
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(environment)) {
		previous.set(name, process.env[name]);
		if (value === undefined) delete process.env[name]; else process.env[name] = value;
	}
	t.after(async () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
		await fs.rm(directory, { recursive: true, force: true });
	});
	return configFile;
}

function model(id = "us.anthropic.claude-haiku-5-5", baseUrl = "https://bedrock-runtime.us-east-1.amazonaws.com"): Model<"bedrock-converse-stream"> {
	return withModelProfile(profileBedrockModel({ id, name: "Claude Haiku 5.5", api: "bedrock-converse-stream",
		provider: "amazon-bedrock", baseUrl, reasoning: true, input: ["text"],
		contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}), "provider-catalog");
}

function mockSend(t: TestContext): { sends: number; region?: string; input?: ConverseStreamCommand["input"] } {
	const observed: { sends: number; region?: string; input?: ConverseStreamCommand["input"] } = { sends: 0 };
	t.mock.method(BedrockRuntimeClient.prototype, "send", async function(this: BedrockRuntimeClient, command: ConverseStreamCommand) {
		observed.sends++;
		observed.region = await this.config.region();
		observed.input = command.input;
		return { $metadata: {}, stream: (async function* () {
			yield { messageStart: { role: "assistant" } };
			yield { messageStop: { stopReason: "end_turn" } };
		})() };
	});
	return observed;
}

interface Case {
	name: string;
	ambient?: string;
	options?: BedrockOptions;
	region: string;
	id?: string;
	baseUrl?: string;
}
const cases: Case[] = [
	{ name: "ambient shared profile", ambient: "fixture-gov", region: "us-gov-west-1" },
	{ name: "scoped shared profile", options: { env: { AWS_PROFILE: "fixture-gov" } }, region: "us-gov-west-1" },
	{ name: "explicit shared profile", options: { profile: "fixture-gov" }, region: "us-gov-west-1" },
	{ name: "explicit profile beats ambient", ambient: "fixture-commercial", options: { profile: "fixture-gov" }, region: "us-gov-west-1" },
	{ name: "scoped profile beats ambient", ambient: "fixture-commercial", options: { env: { AWS_PROFILE: "fixture-gov" } }, region: "us-gov-west-1" },
	{ name: "commercial profile ignores catalog GovCloud endpoint", ambient: "fixture-commercial", baseUrl: "https://bedrock-runtime.us-gov-west-1.amazonaws.com", region: "us-west-2" },
	{ name: "explicit region beats profile", ambient: "fixture-gov", options: { region: "us-east-1" }, region: "us-east-1" },
	{ name: "scoped region beats profile", ambient: "fixture-gov", options: { env: { AWS_REGION: "us-east-1" } }, region: "us-east-1" },
	{ name: "ARN region beats profile", ambient: "fixture-gov", id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque", region: "us-east-1" },
	{ name: "profile FIPS normalization", ambient: "fixture-fips", region: "us-gov-east-1" },
	{ name: "explicit FIPS normalization", options: { region: "fips-us-gov-east-1" }, region: "us-gov-east-1" },
];

for (const scenario of cases) {
	test(`Bedrock request matches SDK region: ${scenario.name}`, async (t) => {
		await fixture(t, scenario.ambient);
		const observed = mockSend(t);
		const target = model(scenario.id, scenario.baseUrl);
		const history: Context = { systemPrompt: "Updated prefix", messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", api: target.api, provider: target.provider, model: target.id, stopReason: "stop", timestamp: 2,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				content: [{ type: "thinking", thinking: "Prior thinking", thinkingSignature: "bound-signature" }, { type: "text", text: "Prior answer" }] },
		] };
		const result = await stream(target, history, {
			apiKey: "fixture", reasoning: "high", ...scenario.options,
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(observed.sends, 1);
		assert.equal(observed.region, scenario.region);
		const fields = observed.input?.additionalModelRequestFields as any;
		assert.equal(fields.thinking.type, "adaptive");
		if (scenario.region.startsWith("us-gov-")) {
			assert.deepEqual(fields.thinking, { type: "adaptive" });
			assert.equal(fields.anthropic_beta, undefined);
			assert.deepEqual(observed.input?.messages?.[1]?.content, [{ text: "Prior answer" }]);
		} else {
			assert.equal(fields.thinking.display, "summarized");
			assert.deepEqual(fields.thinking.block_binding, { prefix_mismatch_behavior: "drop_block" });
			assert.equal(observed.input?.messages?.[1]?.content?.[0]?.reasoningContent?.reasoningText?.signature, "bound-signature");
		}
	});
}

test("missing shared-profile region fails before payload or send", async (t) => {
	await fixture(t, "fixture-missing");
	const observed = mockSend(t);
	let payloads = 0;
	const result = await stream(model(), { messages: [] }, { apiKey: "fixture", reasoning: "high", onPayload() { payloads++; } }).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Region is missing/);
	assert.equal(payloads, 0);
	assert.equal(observed.sends, 0);
});

test("abort while a shared-profile read is pending prevents late payload and send", { timeout: 10_000 }, async (t) => {
	const configFile = await fixture(t, "fixture-gov");
	const observed = mockSend(t);
	const readFile = fs.readFile;
	let beginRead!: () => void;
	let releaseRead!: () => void;
	const started = new Promise<void>(resolve => { beginRead = resolve; });
	const gate = new Promise<void>(resolve => { releaseRead = resolve; });
	t.mock.method(fs, "readFile", async (...args: Parameters<typeof readFile>) => {
		if (args[0] === configFile) { beginRead(); await gate; }
		return readFile(...args);
	});
	const controller = new AbortController();
	let payloads = 0;
	const events = stream(model(), { messages: [] }, {
		apiKey: "fixture", reasoning: "high", signal: controller.signal, onPayload() { payloads++; },
	});
	try {
		await started;
		controller.abort("fixture abort");
	} finally {
		releaseRead();
	}
	const result = await events.result();
	assert.equal(result.stopReason, "aborted");
	assert.equal(payloads, 0);
	assert.equal(observed.sends, 0);
});

test("already-aborted profile requests do not read the profile or build a payload", async (t) => {
	const configFile = await fixture(t, "fixture-gov");
	const observed = mockSend(t);
	const readFile = fs.readFile;
	let reads = 0;
	t.mock.method(fs, "readFile", async (...args: Parameters<typeof readFile>) => {
		if (args[0] === configFile) reads++;
		return readFile(...args);
	});
	const controller = new AbortController();
	controller.abort("fixture abort");
	let payloads = 0;
	const result = await stream(model(), { messages: [] }, {
		apiKey: "fixture", reasoning: "high", signal: controller.signal, onPayload() { payloads++; },
	}).result();
	assert.equal(result.stopReason, "aborted");
	assert.equal(payloads, 0);
	assert.equal(observed.sends, 0);
	assert.equal(reads, 0);
});

test("profile resolution is cached and stays outside streamed deltas", async (t) => {
	const configFile = await fixture(t, "fixture-gov");
	const readFile = fs.readFile;
	let reads = 0;
	let streamingRegionLookups = 0;
	t.mock.method(fs, "readFile", async (...args: Parameters<typeof readFile>) => {
		if (args[0] === configFile) reads++;
		return readFile(...args);
	});
	t.mock.method(BedrockRuntimeClient.prototype, "send", async function(this: BedrockRuntimeClient) {
		assert.equal(await this.config.region(), "us-gov-west-1");
		t.mock.method(this.config, "region", async () => {
			streamingRegionLookups++;
			throw new Error("region must be resolved before streaming");
		});
		return { $metadata: {}, stream: (async function* () {
			yield { messageStart: { role: "assistant" } };
			for (let i = 0; i < 2_000; i++) {
				yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } };
			}
			yield { contentBlockStop: { contentBlockIndex: 0 } };
			yield { messageStop: { stopReason: "end_turn" } };
		})() };
	});
	const result = await stream(model(), { messages: [] }, {
		apiKey: "fixture", reasoning: "high", onPayload() { assert.equal(reads, 1); },
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].type, "text");
	assert.equal(result.content[0].text, "x".repeat(2_000));
	assert.equal(reads, 1);
	assert.equal(streamingRegionLookups, 0);
});
