import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { Type } from "typebox";
import { ToolSelection } from "../../packages/coding-agent/src/core/tool-selection.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";

const gc = globalThis.gc;
assert.ok(gc, "Run with --expose-gc");
const root = mkdtempSync(join(tmpdir(), "sp-tool-selection-bench-"));
const profiler = new Session(); profiler.connect();
try {
	const policy = new ToolSelection({ tools: ["mcp__fixture__*", "-*__delete*"] });
	const names = Array.from({ length: 256 }, (_, i) => `mcp__fixture__${i % 2 ? "lookup" : "delete"}${i}`);
	function match(rounds: number) {
		let selected = 0;
		for (let i = 0; i < rounds; i++) for (const name of names) if (policy.allows(name)) selected++;
		return selected;
	}
	match(1000); gc();
	await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const selected = match(10000);
	const { profile } = await profiler.post("HeapProfiler.stopSampling");
	let matcherSampledBytes = 0;
	const sites: { function: string; bytes: number }[] = [];
	const stack = [profile.head];
	while (stack.length) {
		const node = stack.pop()!;
		if (node.callFrame.url.endsWith("/core/tool-selection.ts")) {
			matcherSampledBytes += node.selfSize;
			if (node.selfSize) sites.push({ function: node.callFrame.functionName, bytes: node.selfSize });
		}
		for (const child of node.children) stack.push(child);
	}
	assert.equal(selected, 1280000);
	const settings = SettingsManager.inMemory({});
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
		noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, resourceLoader: loader,
		model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid", reasoning: false,
			input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		sessionManager: SessionManager.inMemory(root), toolSelection: { tools: ["mcp__fixture__*", "-*__delete*"] },
		customTools: names.map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) })),
		modelRuntime: { hasConfiguredAuth: () => false, checkAuth: async () => ({ type: "none" }), isUsingOAuth: () => false,
			getModel: () => undefined, getAuth: async () => undefined } as never });
	try {
		assert.equal(session.getActiveToolNames().length, 129);
		assert.equal((session as any)._codemode.sandbox, undefined);
		const owner = new WeakRef((session as any)._toolSelection);
		session.dispose();
		for (let i = 0; i < 4; i++) { await nextTask(); gc(); }
		assert.equal((session as any)._toolSelection, undefined);
		assert.equal(owner.deref(), undefined, "selection owner released while disposed session remains alive");
		process.stdout.write(JSON.stringify({ matches: 2560000, selected, matcherSampledBytes, sites, registeredFixtureTools: 256,
			activeChildren: 128, workersStarted: 0, selectionOwnersRetainedAfterDispose: 0,
			coverage: "production selector allocation sample and SDK catalog/dispose lifecycle; no provider, UI or worker workload" }) + "\n");
	} finally { session.dispose(); }
} finally { profiler.disconnect(); rmSync(root, { recursive: true, force: true }); }
