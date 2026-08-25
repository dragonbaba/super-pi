import { createHash } from "node:crypto";

export const BENCHMARK_FIXTURE_VERSION = "phase0-v1" as const;
const MEBIBYTE = 1024 * 1024;
const TOOL_OUTPUT_PATTERN = '{"level":"error","path":"src/example.ts","message":"sample failure"}\n';

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function createAssistantDeltas(count = 100_000): string[] {
	const deltas = new Array<string>(count);
	const samples = ["a", "中", "😀", "\n", "{", "}", "\u001b[32mgreen\u001b[0m"];
	for (let index = 0; index < count; index++) deltas[index] = samples[index % samples.length]!;
	return deltas;
}

export interface ToolProgressFixture {
	toolCallId: string;
	sequence: number;
	content: string;
}

export function createToolProgress(count = 100_000, activeTools = 4): ToolProgressFixture[] {
	const updates = new Array<ToolProgressFixture>(count);
	for (let index = 0; index < count; index++) {
		updates[index] = {
			toolCallId: `tool-${index % activeTools}`,
			sequence: index,
			content: index % 3 === 0 ? `进度 ${index}` : `progress ${index}`,
		};
	}
	return updates;
}

export function createTranscriptItems(count: number): string[] {
	const samples = [
		"Plain English transcript line",
		"中文消息与宽字符测试",
		'```ts\nconst value = { ok: true };\n```',
		'{"kind":"json","value":42}',
		"\u001b[36mANSI cyan\u001b[0m",
		"emoji 😀 combining e\u0301",
	];
	const items = new Array<string>(count);
	for (let index = 0; index < count; index++) items[index] = `${index}: ${samples[index % samples.length]}`;
	return items;
}

export function createToolOutput(mebibytes: number): string {
	const targetBytes = mebibytes * MEBIBYTE;
	const repeats = Math.ceil(targetBytes / TOOL_OUTPUT_PATTERN.length);
	return TOOL_OUTPUT_PATTERN.repeat(repeats).slice(0, targetBytes);
}

function seededShuffle(values: readonly string[], seed: number): string[] {
	const shuffled = values.slice();
	let state = seed >>> 0;
	for (let index = shuffled.length - 1; index > 0; index--) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		const target = state % (index + 1);
		const current = shuffled[index]!;
		shuffled[index] = shuffled[target]!;
		shuffled[target] = current;
	}
	return shuffled;
}

export function createResourceOrderings(count = 100): string[][] {
	const resources = Array.from({ length: 64 }, (_, index) => `resources/资源-${index.toString().padStart(3, "0")}.md`);
	return Array.from({ length: count }, (_, index) => seededShuffle(resources, index + 1));
}

export const modelProfileSamples = {
	known: { id: "known-reasoning", reasoning: true, cache: true, toolCalling: true },
	unknown: { id: "future-model", reasoning: false, cache: false, toolCalling: false },
	custom: { id: "custom-model", reasoning: true, cache: false, toolCalling: true },
} as const;

export function benchmarkFixtureManifest() {
	const assistant = createAssistantDeltas();
	const progress = createToolProgress();
	const transcript5k = createTranscriptItems(5_000);
	const transcript50k = createTranscriptItems(50_000);
	const output1m = createToolOutput(1);
	const output10m = createToolOutput(10);
	const resources = createResourceOrderings();
	return {
		version: BENCHMARK_FIXTURE_VERSION,
		fixtures: {
			assistantDeltas100k: { items: assistant.length, sha256: sha256(assistant.join("")) },
			toolProgress100k: { items: progress.length, sha256: sha256(JSON.stringify(progress)) },
			transcript5k: { items: transcript5k.length, sha256: sha256(transcript5k.join("\n")) },
			transcript50k: { items: transcript50k.length, sha256: sha256(transcript50k.join("\n")) },
			toolOutput1m: { items: Buffer.byteLength(output1m), sha256: sha256(output1m) },
			toolOutput10m: { items: Buffer.byteLength(output10m), sha256: sha256(output10m) },
			resourceOrderings100: { items: resources.length, sha256: sha256(JSON.stringify(resources)) },
			modelProfiles: { items: Object.keys(modelProfileSamples).length, sha256: sha256(JSON.stringify(modelProfileSamples)) },
		},
	};
}
