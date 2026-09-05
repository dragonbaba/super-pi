import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const targetRoot = resolve(process.argv[2] ?? ".");
const moduleUrl = (relativePath: string): string => pathToFileURL(join(targetRoot, relativePath)).href;
const [
	{ TuiMainScreen },
	{ AgentSessionRuntime },
	{ DefaultResourceLoader },
	{ createAgentSession },
	{ SessionManager },
	{ SettingsManager },
	{ ToolExecutionComponent },
	{ InteractiveMode },
	{ FakeTerminal },
] = await Promise.all([
	import(moduleUrl("packages/tui/src/index.ts")),
	import(moduleUrl("packages/coding-agent/src/core/agent-session-runtime.ts")),
	import(moduleUrl("packages/coding-agent/src/core/resource-loader.ts")),
	import(moduleUrl("packages/coding-agent/src/core/sdk.ts")),
	import(moduleUrl("packages/coding-agent/src/core/session-manager.ts")),
	import(moduleUrl("packages/coding-agent/src/core/settings-manager.ts")),
	import(moduleUrl("packages/coding-agent/src/modes/interactive/components/tool-execution.ts")),
	import(moduleUrl("packages/coding-agent/src/modes/interactive/interactive-mode.ts")),
	import(moduleUrl("tests/helpers/runtime-instrumentation.ts")),
]);

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureModel(): any {
	return {
		id: "ui-default-off-target",
		name: "UI Default-Off Target",
		api: "openai-responses",
		provider: "fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	};
}

function createModelRuntime(): any {
	return {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key" as const }),
		isUsingOAuth: () => false,
		isUsingSubscription: () => false,
		streamSimple: () => { throw new Error("streaming is not expected in the default-off benchmark"); },
		registerProvider: () => {},
		registerNativeProvider: () => {},
		unregisterProvider: () => {},
		getModel: () => undefined,
		getAuth: async () => undefined,
	};
}

function toolResult(toolCallId: string): any {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture-tool",
		content: [{ type: "text", text: `default-off-${toolCallId}-`.repeat(1_024) }],
		isError: false,
		timestamp: 2,
	};
}

function summarize(values: number[]): { p50Ms: number; p95Ms: number; p99Ms: number; cv: number } {
	let mean = 0;
	for (let index = 0; index < values.length; index++) mean += values[index]!;
	mean /= values.length;
	let squaredDifference = 0;
	for (let index = 0; index < values.length; index++) {
		const difference = values[index]! - mean;
		squaredDifference += difference * difference;
	}
	values.sort((left, right) => left - right);
	const percentile = (ratio: number): number => values[Math.ceil(values.length * ratio) - 1] ?? 0;
	return {
		p50Ms: percentile(0.5),
		p95Ms: percentile(0.95),
		p99Ms: percentile(0.99),
		cv: mean === 0 ? 0 : Math.sqrt(squaredDifference / values.length) / mean,
	};
}

async function measure(modeName: "absent" | "disabled"): Promise<any> {
	const root = mkdtempSync(join(tmpdir(), "super-pi-ui-default-off-target-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const toolResultPresentation = modeName === "disabled"
		? { enabled: false as const, budgetTokens: 128 }
		: undefined;
	const settingsManager = toolResultPresentation
		? SettingsManager.inMemory({ toolResultPresentation })
		: SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory(cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noExtensions: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: createModelRuntime(),
		settingsManager,
		sessionManager,
		resourceLoader,
		toolResultPresentation,
	});
	const runtime = new AgentSessionRuntime(
		session,
		{ cwd, agentDir },
		async () => { throw new Error("session replacement is not expected in the default-off benchmark"); },
	);
	const interactive = new InteractiveMode(runtime, { tuiMode: "regular" });
	const internals = interactive as any;
	await internals.renderer.dispose({ preserveScreen: true });
	await yieldToEventLoop();
	const renderer = new TuiMainScreen(new FakeTerminal(120, 40), false);
	renderer.setRenderInstrumentation(internals.renderInstrumentation);
	internals.renderer = renderer;
	internals.isInitialized = true;
	const unsubscribe = session.subscribe((event: any) => internals.handleEvent(event));
	const durations = new Array<number>(64);
	try {
		for (let index = 0; index < durations.length; index++) {
			const toolCallId = `target-${modeName}-${index}`;
			const started = performance.now();
			await internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
			const component = internals.pendingTools.get(toolCallId);
			if (!(component instanceof ToolExecutionComponent)) throw new Error("default-off tool component missing");
			const message = toolResult(toolCallId);
			session.agent.state.messages.push(message);
			await internals.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "fixture-tool",
				result: { content: message.content, isError: false },
				isError: false,
			});
			await session._handleAgentEvent({ type: "message_end", message });
			durations[index] = performance.now() - started;
		}
		return { ...summarize(durations), lifecycle: internals.getToolResultDiscoveryLifecycleCounts() };
	} finally {
		unsubscribe();
		await interactive.stop("transcript");
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

const commit = spawnSync("git", ["-C", targetRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const statusBefore = spawnSync("git", ["-C", targetRoot, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim();
const absent = await measure("absent");
const disabled = await measure("disabled");
const statusAfter = spawnSync("git", ["-C", targetRoot, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim();
process.stdout.write(`${JSON.stringify({ commit, statusBefore, statusAfter, absent, disabled })}\n`);
