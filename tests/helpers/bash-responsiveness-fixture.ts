import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import type { Terminal, TerminalFrameWriteCompletion } from "../../packages/tui/src/terminal.ts";

export type BashResponseScenario = "short" | "long" | "output-then-quiet" | "off-tail";
type Probe = { planned: number; handled?: number; inputMs?: number; frame?: number; frameWall?: number; viewport?: number; changed?: boolean; running?: boolean };

/** Simulated terminal, with real TUI input dispatch and asynchronous frame completion.
 * No terminal paint/ConPTY claim is made. Only numeric metadata is retained. */
class ProbeTerminal implements Terminal {
	columns = 120; rows = 40; kittyProtocolActive = false;
	input: ((data: string) => void) | undefined;
	completion: TerminalFrameWriteCompletion | undefined;
	viewport: () => number = () => 0;
	active = 0; highWater = 0; completed = 0; frameBytes = 0;
	latestProbe: Probe | undefined;
	private timer: NodeJS.Timeout | undefined;
	start(input: (data: string) => void): void { this.input = input; }
	stop(): void { this.input = undefined; }
	drainInput(): Promise<void> { return Promise.resolve(); }
	write(): void {}
	setFrameWriteCompletionListener(listener: TerminalFrameWriteCompletion | undefined): void { this.completion = listener; }
	writeFrame(data: string, generation: number): void {
		this.active++; this.highWater = Math.max(this.highWater, this.active);
		this.frameBytes += Buffer.byteLength(data);
		const probe = this.latestProbe, viewport = this.viewport();
		this.timer = setTimeout(() => {
			this.timer = undefined; this.active--; this.completed++;
			if (probe?.handled !== undefined && probe.viewport === viewport && probe.frame === undefined) { probe.frame = performance.now(); probe.frameWall = Date.now(); }
			this.completion?.(generation);
		}, 2);
	}
	cancelFrameWrite(): void {}
	moveBy(): void {} hideCursor(): void {} showCursor(): void {} clearLine(): void {}
	clearFromCursor(): void {} clearScreen(): void {} setTitle(): void {} setProgress(): void {}
	get pendingTimers(): number { return Number(this.timer !== undefined); }
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function percentile(values: number[], fraction: number): number {
	values.sort((a, b) => a - b);
	return values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
}
function quoteBash(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function quotePowerShell(value: string): string { return "'" + value.replace(/'/g, "''") + "'"; }

/** Optional root permits read-only baseline measurement from an existing checkout. */
export async function runBashResponsiveness(scenario: BashResponseScenario, sourceRoot?: string, termination: "success" | "failure" | "abort" = "success") {
	const rootUrl = sourceRoot ? pathToFileURL(resolve(sourceRoot) + "/").href : new URL("../../", import.meta.url).href;
	const [{ createAgentSession }, { DefaultResourceLoader }, { SettingsManager }, { SessionManager },
		{ AssistantMessageEventStream }, { ToolExecutionComponent }, { InteractiveMode }, { initTheme },
		{ TuiAltScreen }, { RetainedContainer }, { ScrollView }, { Text }, { getShellConfig, getPowerShellConfig }] = await Promise.all([
		import(rootUrl + "packages/coding-agent/src/core/sdk.ts"), import(rootUrl + "packages/coding-agent/src/core/resource-loader.ts"),
		import(rootUrl + "packages/coding-agent/src/core/settings-manager.ts"), import(rootUrl + "packages/coding-agent/src/core/session-manager.ts"),
		import(rootUrl + "packages/ai/src/utils/event-stream.ts"), import(rootUrl + "packages/coding-agent/src/modes/interactive/components/tool-execution.ts"),
		import(rootUrl + "packages/coding-agent/src/modes/interactive/interactive-mode.ts"), import(rootUrl + "packages/coding-agent/src/modes/interactive/theme/theme.ts"),
		import(rootUrl + "packages/tui/dist/index.js"), import(rootUrl + "packages/tui/dist/index.js"),
		import(rootUrl + "packages/tui/dist/index.js"), import(rootUrl + "packages/tui/dist/index.js"),
		import(rootUrl + "packages/coding-agent/src/utils/shell.ts"),
	]);
	const root = mkdtempSync(join(tmpdir(), "sp-bash-responsive-"));
	const agentDir = join(root, "agent"); mkdirSync(agentDir);
	const ready = join(root, "ready"), done = join(root, "done"), script = join(root, "quiet.cjs");
	const historyItems = scenario === "off-tail" ? 5000 : 100;
	writeFileSync(script, `const fs=require('node:fs');\n${scenario === "output-then-quiet" ? "console.log('initial output 中文 😀');" : ""}\nfs.writeFileSync(${JSON.stringify(ready)},String(Date.now()));\nsetTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},String(Date.now()));process.exitCode=${termination === "failure" ? 1 : 0}},3000);\n`);
	// Both built-in tools use the production Bash renderer and shared local execution backend.
	const toolName = process.platform === "win32" ? "powershell" : "bash";
	const shell = process.platform === "win32" ? getPowerShellConfig().shell : getShellConfig().shell;
	const command = (process.platform === "win32" ? "& " + quotePowerShell(process.execPath) + " " + quotePowerShell(script) :
		quoteBash(process.execPath) + " " + quoteBash(script)) +
		(scenario === "short" ? "" : "\n" + "# finite quiet command 中文 😀\n".repeat(80));
	const sink = new ProbeTerminal();
	const ui = new TuiAltScreen(sink, false);
	let session: any, run: Promise<void> | undefined;
	const probeTimers: NodeJS.Timeout[] = [];
	const delay = monitorEventLoopDelay({ resolution: 10 });
	let heartbeat: NodeJS.Timeout | undefined;
	try {
		initTheme("dark");
		const transcript = new RetainedContainer();
		for (let i = 0; i < historyItems; i++) transcript.addRetainedChild(new Text(`history-${i}`, 0, 0), { id: `h-${i}`, version: 1, completed: true });
		let timerRefreshes = 0, maxRefreshMs = 0;
		const component = new ToolExecutionComponent(toolName, "quiet-tool", { command }, {
			onVisualInvalidate(c: any) { timerRefreshes++; transcript.invalidateRetainedChild(c); },
		}, undefined, ui, root);
		const originalUpdate = component.updateDisplay;
		component.updateDisplay = function () { const t = performance.now(); const result = originalUpdate.call(this); maxRefreshMs = Math.max(maxRefreshMs, performance.now() - t); return result; };
		transcript.addRetainedChild(component, { id: "quiet-tool", version: 0 });
		ui.setLayoutRoot(new ScrollView(transcript, { follow: "end", primary: true }));
		sink.viewport = () => ui.viewportTop;
		// Real production event handler; startup/editor chrome is outside this focused harness.
		const mode = Object.assign(Object.create(InteractiveMode.prototype), { isInitialized: true, footer: { invalidate() {} },
			pendingTools: new Map([["quiet-tool", component]]), deferredReadExecutions: new Map(), chatContainer: transcript, ui,
			pendingToolResultDiscoveries: new Map(), attachedToolResultDiscoveries: new Map(), tuiLifecycleGeneration: 0 });
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
			noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
		await resourceLoader.reload();
		let providerCalls = 0, abortedProviderCalls = 0, toolCalls = 0, progress = 0, canonical: any, toolError = false;
		const model: any = { id: "offline", name: "offline", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid",
			reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 };
		const runtime: any = { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false,
			isUsingSubscription: () => false, getAuth: async () => undefined, getModel: () => undefined,
			registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
			streamSimple(_model: any, _context: any, options: any) {
				const stream = new AssistantMessageEventStream(), tool = providerCalls++ === 0;
				const aborted = options?.signal?.aborted === true;
				if (aborted) abortedProviderCalls++;
				queueMicrotask(() => {
					const message = { role: "assistant", content: tool ? [{ type: "toolCall", id: "quiet-tool", name: toolName, arguments: { command, timeout: 8 } }] : [{ type: "text", text: "done" }],
						api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					stream.push({ type: "start", partial: message });
					if (aborted) { message.stopReason = "aborted"; stream.push({ type: "error", reason: "aborted", error: message }); }
					else stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			} };
		({ session } = await createAgentSession({ cwd: root, agentDir, model, modelRuntime: runtime, resourceLoader, settingsManager,
			sessionManager: SessionManager.inMemory(root), tools: [toolName] }));
		session.subscribe((event: any) => {
			if (event.type === "tool_execution_start") toolCalls++;
			if (event.type === "tool_execution_update") progress++;
			if (event.type === "tool_execution_end") { canonical = event.result; toolError = event.isError; }
			if (event.type.startsWith("tool_execution_")) return mode.handleEvent(event);
			if (event.type === "agent_end") return ui.flushTerminalFrames();
		}, { criticalAgentEnd: true });
		ui.start(); await sleep(50);
		run = session.prompt("Run the finite offline quiet fixture once.");
		// Detect actual child readiness, not just the tool-start event preceding spawn.
		const readinessDeadline = performance.now() + 6000;
		while (!existsSync(ready) && !canonical && performance.now() < readinessDeadline) await sleep(10);
		assert.ok(existsSync(ready), `Node child never became ready: ${JSON.stringify(canonical)}`);
		const epoch = performance.now();
		ui.scrollBy(-30); await ui.flushTerminalFrames();
		assert.equal(ui.isFollowingOutput, false);
		const probes: Probe[] = [200, 600, 1100, 1600, 2100, 2500].map(offset => ({ planned: epoch + offset }));
		let lastBeat = epoch, longestGapMs = 0;
		heartbeat = setInterval(() => { const now = performance.now(); longestGapMs = Math.max(longestGapMs, now - lastBeat); lastBeat = now; }, 20);
		delay.enable();
		for (let i = 0; i < probes.length; i++) {
			const probe = probes[i]!;
			probeTimers.push(setTimeout(() => {
				probe.running = !existsSync(done);
				const before = ui.viewportTop, t = performance.now();
				sink.latestProbe = probe;
				sink.input?.(i % 2 ? "\x1b[<65;10;10M" : "\x1b[<64;10;10M");
				probe.handled = performance.now(); probe.inputMs = probe.handled - t;
				probe.viewport = ui.viewportTop; probe.changed = before !== probe.viewport;
			}, Math.max(0, probe.planned - performance.now())));
		}
		let abortAt = 0, abortRequest: Promise<void> | undefined;
		if (termination === "abort") probeTimers.push(setTimeout(() => { abortAt = Date.now(); abortRequest = session.abort(); }, 2800));
		await run;
		await abortRequest;
		longestGapMs = Math.max(longestGapMs, performance.now() - lastBeat);
		clearInterval(heartbeat); heartbeat = undefined; delay.disable();
		const childEndedWall = termination === "abort" ? abortAt : Number(readFileSync(done, "utf8"));
		const frames = probes.filter(p => p.frame !== undefined);
		// The existing loop asks the provider to settle the canceled turn; this offline
		// provider must honor the already-aborted signal rather than invent success.
		assert.equal(providerCalls, 2); assert.equal(abortedProviderCalls, termination === "abort" ? 1 : 0); assert.equal(toolCalls, 1);
		assert.equal(toolError, termination !== "success");
		if (termination === "success") assert.equal(canonical.content[0].text.trim(), scenario === "output-then-quiet" ? "initial output 中文 😀" : "(no output)");
		else assert.match(canonical.content[0].text, termination === "abort" ? /Command aborted/ : /code 1/);
		assert.equal(session.agent.state.messages.filter((message: any) => message.role === "toolResult").length, 1, "one canonical result; no tool replay");
		assert.equal(frames.length, probes.length, "every running input must reach a corresponding completed frame");
		for (const probe of probes) {
			assert.equal(probe.running, true); assert.equal(probe.changed, true);
			assert.ok(probe.frameWall! < childEndedWall, "corresponding frame must complete before the child exits");
		}
		assert.equal(ui.isFollowingOutput, false, "timer updates and tool completion must not steal scroll position");
		assert.ok(timerRefreshes >= 2, "multiple live timer boundaries must execute");
		const result = { scenario, termination, node: process.version, platform: process.platform, cpu: cpus()[0]?.model, toolName, shell,
			terminal: "simulated async sink; real fullscreen input dispatcher; no ConPTY", viewport: [120, 40], historyItems, commandCodeUnits: command.length,
			providerCalls, abortedProviderCalls, toolCalls, progress, timerRefreshes, maxRefreshMs, probes, longestEventLoopGapMs: longestGapMs,
			eventLoopDelayP95Ms: delay.percentile(95) / 1e6, eventLoopDelayMaxMs: delay.max / 1e6,
			scheduledToHandledP95Ms: percentile(probes.map(p => p.handled! - p.planned), .95),
			scheduledToFrameP95Ms: percentile(probes.map(p => p.frame! - p.planned), .95),
			inputHandlingP95Ms: percentile(probes.map(p => p.inputMs!), .95),
			handledToFrameP95Ms: percentile(probes.map(p => p.frame! - p.handled!), .95),
			longestProbeFrameGapMs: Math.max(...probes.slice(1).map((p, i) => p.frame! - probes[i]!.frame!)),
			completedProbeFrames: frames.length, completedFrames: sink.completed, frameBytes: sink.frameBytes, maxActiveWrites: sink.highWater,
			childDurationMs: childEndedWall - Number(readFileSync(ready, "utf8")) };
		await ui.dispose({ preserveScreen: true });
		assert.equal(sink.active, 0); assert.equal(sink.pendingTimers, 0);
		assert.equal(component.rendererState.interval, undefined);
		assert.equal(component.rendererState.elapsedTimer, undefined);
		const derived = component.resultRendererComponent.getBashResultRenderCacheReferenceCounts();
		assert.ok(Object.values(derived).every(v => v === 0), "production unmount releases all Bash derived owners");
		return { ...result, released: { activeWrites: sink.active, sinkTimers: sink.pendingTimers, inputReferences: Number(sink.input !== undefined), derived } };
	} finally {
		for (const timer of probeTimers) clearTimeout(timer);
		if (heartbeat) clearInterval(heartbeat);
		delay.disable();
		if (session) { await session.abort(); if (run) await run.catch(() => {}); session.dispose(); }
		await ui.dispose({ preserveScreen: true });
		// Only this invocation's recorded temporary directory may be removed.
		assert.equal(dirname(resolve(root)), resolve(tmpdir()));
		assert.ok(basename(root).startsWith("sp-bash-responsive-"));
		rmSync(root, { recursive: true });
	}
}
