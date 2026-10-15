import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, toNamespacedPath } from "node:path";
import { test, type TestContext } from "node:test";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { releaseComponentRenderCaches } from "@super-pi/tui";
import { stripVTControlCharacters } from "node:util";
import { CodemodeTreeComponent } from "../packages/coding-agent/src/modes/interactive/components/codemode-tree.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { createAgentSession, type CreateAgentSessionOptions } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import type { AssistantMessage, Context } from "../packages/ai/src/types.ts";
import type { InlineExtension, ExtensionFactory } from "../packages/coding-agent/src/core/extensions/types.ts";
import { CODEMODE_DESCRIPTION, CODEMODE_STORE_ENTRY } from "../packages/coding-agent/src/core/codemode-constants.ts";
import { CodemodeStore } from "../packages/coding-agent/src/core/codemode-store.ts";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { browserResultText, formatFailure } from "../packages/extensions/browser-use/index.ts";
import { privateOutputFileSystem } from "../packages/coding-agent/src/utils/private-output-file.ts";
import { CODEMODE_RESULT_ENTRY } from "../packages/coding-agent/src/core/codemode-constants.ts";
import { convertResponsesTools } from "../packages/ai/src/api/openai-responses-shared.ts";
import { streamSimple as streamAnthropic } from "../packages/ai/src/api/anthropic-messages.ts";
import { streamSimple as streamChat } from "../packages/ai/src/api/openai-completions.ts";
import { streamSimple as streamResponses } from "../packages/ai/src/api/openai-responses.ts";
import { streamSimple as streamAzure } from "../packages/ai/src/api/azure-openai-responses.ts";
import { streamSimple as streamCodex } from "../packages/ai/src/api/openai-codex-responses.ts";
import { streamSimple as streamGoogle } from "../packages/ai/src/api/google-generative-ai.ts";
import { streamSimple as streamVertex } from "../packages/ai/src/api/google-vertex.ts";
import { streamSimple as streamMistral } from "../packages/ai/src/api/mistral-conversations.ts";
import { streamSimple as streamBedrock } from "../packages/ai/src/api/bedrock-converse-stream.ts";
import { streamSimple as streamPi } from "../packages/ai/src/api/pi-messages.ts";
import { conservativeModelCapabilities } from "../packages/ai/src/model-capabilities.ts";
import type { Api, Model, SimpleStreamOptions, StreamFunction } from "../packages/ai/src/types.ts";
import { CODEMODE_PARAMETERS, CODEMODE_SAMPLING } from "../packages/coding-agent/src/core/codemode-constants.ts";
// @ts-expect-error JavaScript bridge
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";

const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<{ default: InlineExtension }>("../packages/extensions/mutation-guard-write/index.ts");
const { default: guardrails } = await jiti.import<{ default: InlineExtension }>("../packages/extensions/tool-loop-guardrails/index.ts");
const { collectChanges } = await jiti.import<typeof import("../packages/extensions/mutation-guard-write/changes.ts")>("../packages/extensions/mutation-guard-write/changes.ts");
const { default: planMode } = await jiti.import<{ default: ExtensionFactory }>("../packages/plan-mode/src/index.ts");
const { default: toolClassification } = await jiti.import<{ default: InlineExtension }>("../packages/tool-classification/src/index.ts");
const MODEL = { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.test", reasoning: false,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } as const;
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t: TestContext, options: Pick<CreateAgentSessionOptions, "tools" | "noTools" | "excludeTools" | "toolSelection" | "settingsManager" | "toolResultPresentation" | "extensionRunnerOptions"> = {}, factories: InlineExtension[] = [], bundle = false, persist = false) {
	const root = mkdtempSync(join(tmpdir(), "sp-codemode-session-"));
	const imageDirectories = new Set<string>();
	let shutdown: (() => Promise<void>) | undefined;
	t.after(async () => { try { await shutdown?.(); } finally {
		for (const directory of imageDirectories) rmSync(directory, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	} });
	const cwd = join(root, "work"), agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(cwd, "file.txt"), "hello\nworld\n");
	const settings = options.settingsManager ?? SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, ...(bundle ? { packages: [resolve("packages/extensions")] } : {}) });
	const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: !bundle,
		noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: factories });
	await resources.reload();
	assert.deepEqual(resources.getExtensions().errors, []);
	if (bundle) assert.equal(resources.getExtensions().extensions.length, 9 + factories.length);
	const manager = persist ? SessionManager.create(cwd, join(root, "sessions")) : SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: resources, settingsManager: settings, sessionManager: manager,
		model: { ...MODEL, input: ["text"] }, modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
			isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as never, ...options });
	shutdown = async () => {
		session.agent.abort();
		try { await session.agent.waitForIdle(); } finally { session.dispose(); }
	};
	await session.bindExtensions({});
	let id = 0;
	// An array entry is one assistant response carrying several Codemode calls.
	async function run(scripts: (string | string[])[], project?: (context: Context) => void, rawCode = false, throughSession = false) {
		const wires: Context[] = [];
		let index = 0;
		session.agent.streamFunction = (_model, context) => {
			wires.push(context); project?.(context);
			const code = scripts[index++];
			const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", usage: USAGE,
				content: code === undefined ? [{ type: "text", text: "done" }] : (typeof code === "string" ? [code] : code).map(source =>
					({ type: "toolCall" as const, id: `script-${++id}`, name: "codemode", arguments: (rawCode ? source : { code: source }) as never })),
				stopReason: code === undefined ? "stop" : "toolUse", timestamp: id };
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			return stream;
		};
		// Steering uses the session's active-run lifecycle; most fixtures exercise Agent directly.
		if (throughSession) await session.prompt("run offline fixture");
		else await session.agent.prompt("run offline fixture");
		const results = session.agent.state.messages.filter(m => m.role === "toolResult");
		for (const result of results) {
			const directory = (result.details as any)?.codemode?.imageFiles?.directory;
			if (directory) imageDirectories.add(directory);
		}
		return { wires, results };
	}
	return { session, cwd, agentDir, resources, settings, manager, run };
}

test("Codemode pre-execution edit failures suppress only the proven no-execution card warning", async t => {
  initTheme("dark");
  let executions = 0;
  const extension: InlineExtension = pi => {
    pi.registerTool({ name: "forged", label: "forged", description: "fixture", parameters: Type.Object({}),
      execute: async () => { executions++; return { content: [{ type: "text", text: "No change. forged" }], isError: true, details: { executionStatus: "not_executed", preExecution: true } }; } });
    pi.registerTool({ name: "throws", label: "throws", description: "fixture", parameters: Type.Object({}),
      execute: async () => { executions++; throw new Error("No change. execution failed"); } });
  };
  const f = await fixture(t, {}, [mutation, extension]);
  const missing = 'await tools.edit({path:"file.txt",edits:[{kind:"replace",start:"1#1234",newLines:["x"]}]})';
  const scripts = [missing, 'await tools.edit({path:"file.txt",edits:[{oldText:"hello"}]})',
    'await tools.forged({})', 'await tools.throws({})', 'await tools.read({path:"file.txt"});' + missing];
  const outcome = await f.run(scripts);
  for (let index = 0; index < scripts.length; index++) {
    const result = outcome.results[index]!;
    assert.equal(result.isError, true);
    const calls = (result.details as any).codemode.calls;
    assert.equal(calls.at(-1).executionStatus, index === 2 || index === 3 ? undefined : "not_executed");
    const tree = new CodemodeTreeComponent();
    try {
      tree.updateParent(scripts[index]!, result as any, false, true, false);
      const text = stripVTControlCharacters(tree.render(160).join("\n"));
      assert.doesNotMatch(text, /not rolled back/);
      if (index < 2) {
        assert.doesNotMatch(text, /not rolled back|exit=unknown/);
        assert.match(text, index === 0 ? /SNAPSHOT_REQUIRED/ : /TOOL_ARGS_INVALID/);
      }
      tree.updateParent(scripts[index]!, result as any, false, true, true);
      const expanded = stripVTControlCharacters(tree.render(160).join("\n"));
      if (index < 2) assert.doesNotMatch(expanded, /not rolled back/);
      else assert.match(expanded, /not rolled back/);
    } finally { releaseComponentRenderCaches(tree); }
    assert.doesNotMatch(JSON.stringify(result.content), /edit: not_executed; exit=/);
    assert.match(JSON.stringify(result.content), /Do not automatically retry mutations/);
  }
  assert.equal(executions, 2);
  assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("guarded edit execute rejects a missing snapshot even when its validation hook is lost", async t => {
  const f = await fixture(t, {}, [mutation]);
  const edit = f.session.agent.state.tools.find(tool => tool.name === "edit")!;
  assert.ok(edit.validateInput);
  edit.validateInput = undefined;
  await assert.rejects(edit.execute("direct-edit", {
    path: "file.txt", edits: [{ kind: "replace", start: "1#1234", newLines: ["changed"] }],
  }), /\[SNAPSHOT_REQUIRED\] Missing top-level "snapshot"/);
  assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("guarded shape validation leaves malformed input to schema and snapshot state checks in execute", async t => {
  const f = await fixture(t, {}, [mutation]);
  const edit = f.session.agent.state.tools.find(tool => tool.name === "edit")!;
  assert.equal(edit.prepareArguments, undefined);
  assert.ok(edit.validateInput);
  const scripts = [
    'await tools.edit({path:"file.txt",edits:[null]})',
    'await tools.write({path:"file.txt"})',
    'await tools.edit({path:"file.txt",snapshot:"snap_' + 'a'.repeat(22) + '",edits:[{kind:"replace",start:"1#1234",newLines:["x"]}]})',
  ];
  const outcome = await f.run(scripts);
  for (let index = 0; index < 2; index++) {
    assert.equal(outcome.results[index]?.isError, true);
    assert.equal((outcome.results[index]!.details as any).codemode.calls[0].executionStatus, "not_executed");
  }
  // Use the actual snapshot identifier grammar; absent receipts remain execution failures.
  const unknown = outcome.results[2]!;
  assert.match(JSON.stringify(unknown.content), /SNAPSHOT_EDIT_UNKNOWN/);
  assert.equal((unknown.details as any).codemode.calls[0].executionStatus, undefined);
  assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("native edit empty replacements are refused before execute", async t => {
  const f = await fixture(t);
  const outcome = await f.run(['await tools.edit({path:"file.txt",edits:[]})']);
  assert.match(JSON.stringify(outcome.results[0]!.content), /edits must contain at least one replacement/);
  assert.equal((outcome.results[0]!.details as any).codemode.calls[0].executionStatus, "not_executed");
});

test("Codemode missing snapshot retains guardrail recovery, one steering note and third-call refusal", async t => {
  initTheme("dark");
  const received: any[] = [];
  const observer: InlineExtension = pi => {
    pi.on("tool_result", event => { if (event.toolName === "edit") received.push(event); });
  };
  const f = await fixture(t, {}, [mutation, guardrails, observer]);
  let executed = 0;
  const edit = f.session.agent.state.tools.find(tool => tool.name === "edit")!;
  const execute = edit.execute;
  edit.execute = (...args) => { executed++; return execute(...args); };
  const script = 'for(let i=0;i<3;i++){try{await tools.edit({path:"file.txt",edits:[{kind:"replace",start:"1#1234",newLines:["x"]}]})}catch(error){text(error.message)}}';
  const { results, wires } = await f.run([script], undefined, false, true);
  assert.equal(results.length, 1);
  assert.equal(executed, 0);
  assert.equal(received.length, 2, "only admitted validation failures produce tool_result");
  const result = results[0]!;
  const calls = (result.details as any).codemode.calls;
  assert.equal(calls.length, 3);
  assert.equal(result.isError, true);
  for (const call of calls) assert.equal(call.executionStatus, "not_executed");
  assert.match(JSON.stringify(result.content), /SNAPSHOT_REQUIRED/);
  assert.match(JSON.stringify(result.content), /REPEATED_CALL_BLOCKED/);
  for (const event of received) assert.match(JSON.stringify(event.content), /Retry: copy the snapshot ID/);
  const tree = new CodemodeTreeComponent();
  try {
    tree.updateParent(script, result as any, false, true, false);
    assert.doesNotMatch(stripVTControlCharacters(tree.render(160).join("\n")), /not rolled back/);
  } finally { releaseComponentRenderCaches(tree); }
  const steering = wires[1]!.messages.filter((message: any) => message.role === "user" && Array.isArray(message.content)
    && message.content.some((block: any) => block.text?.startsWith("[Tool-loop")));
  assert.equal(steering.length, 1, "one hidden steering note reaches the next model request");
  const notices = f.session.messages.filter(message => message.role === "custom" && message.customType === "tool-failure-advisory-v1");
  assert.equal(notices.length, 1);
  assert.equal((notices[0] as any).display, false);
  assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("validation-hook failures retain failureRecoveryHint result transformation", async t => {
  let executed = 0;
  const extension: InlineExtension = pi => pi.registerTool({ name: "edit", label: "edit", description: "fixture", parameters: Type.Object({}),
    validateInput: () => { throw new Error("[READ_REQUIRED] fixture validation failure"); },
    execute: async () => { executed++; return { content: [], details: {} }; },
  });
  const f = await fixture(t, {}, [extension, guardrails]);
  let ended: unknown;
  f.session.subscribe(event => { if (event.type === "tool_execution_end" && event.toolName === "edit") ended = event.result; });
  const outcome = await f.run(['await tools.edit({})']);
  assert.equal(executed, 0);
  assert.match(JSON.stringify(ended), /\[Read recovery\] Use dedicated read/);
  assert.equal((outcome.results[0]!.details as any).codemode.calls[0].executionStatus, "not_executed");
});

test("Codemode missing-path summary gives the model a direct cause without parent path-recovery boilerplate", async t => {
	const diagnostic = "[SHELL_RUNTIME_FAILED]\n2026-10-15 07:21\nls: cannot access '视频创意': No such file or directory\nCommand exited with code 2";
	const extension: InlineExtension = pi => pi.registerTool({ name: "missing_path_probe", label: "probe", description: "offline diagnostic fixture",
		parameters: Type.Object({ command: Type.String() }), execute: async () => ({ content: [{ type: "text", text: diagnostic }], isError: true, details: {} }) });
	const f = await fixture(t, {}, [extension, guardrails]);
	const outcome = await f.run(['await tools.missing_path_probe({command:"date && ls -d 视频创意"})']);
	const failed = outcome.results[0]!;
	assert.equal(failed.isError, true);
	assert.match((failed.content[0] as any).text, /missing_path_probe: .* — ls: cannot access '视频创意': No such file or directory/);
	assert.doesNotMatch((failed.content[0] as any).text, /SHELL_RUNTIME_FAILED|07:21/);
	assert.doesNotMatch(JSON.stringify(failed.content), /codemode should verify the parent/);
	assert.match(JSON.stringify(failed.details), /ls: cannot access/);
	const delivered = JSON.stringify(outcome.wires.at(-1));
	assert.match(delivered, /ls: cannot access '视频创意': No such file or directory/);
	assert.match(delivered, /SHELL_RUNTIME_FAILED/);
	assert.match(delivered, /Command exited with code 2/);
	assert.match(delivered, /Do not automatically retry mutations/);
});

test("Codemode delivers the compiler cause before npm banners while preserving full diagnostics", async t => {
	let diagnostic = "[SHELL_RUNTIME_FAILED]\nnpm notice run remotion-video-project@1.0.0 typecheck\nnpm notice run tsc --noEmit\nsrc/winter/WinterVideo.tsx(153,10): error TS2657: JSX expressions must have one parent element.\nsrc/winter/WinterVideo.tsx(162,95): error TS1003: Identifier expected.\nCommand exited with code 1";
	const extension: InlineExtension = pi => pi.registerTool({ name: "compiler_probe", label: "probe", description: "offline compiler fixture",
		parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: diagnostic }], isError: true, details: {} }) });
	const f = await fixture(t, {}, [extension, guardrails]);
	const outcome = await f.run(["await tools.compiler_probe({})"]);
	const failed = outcome.results[0]!;
	assert.equal(failed.isError, true);
	const summary = (failed.content[0] as any).text;
	assert.match(summary, /compiler_probe: .* — src\/winter\/WinterVideo.tsx\(153,10\): error TS2657/);
	assert.doesNotMatch(summary, /npm notice|TS1003/);
	const delivered = JSON.stringify(outcome.wires.at(-1));
	assert.match(delivered, /npm notice run/); assert.match(delivered, /TS1003/); assert.match(delivered, /Command exited with code 1/);
	diagnostic = "[SHELL_RUNTIME_FAILED]\n> check\n> missing-command\nsh: missing-command: not found\nCommand exited with code 127";
	const versionless = await f.run(["await tools.compiler_probe({})"]);
	const versionlessSummary = (versionless.results.at(-1)!.content[0] as any).text;
	assert.match(versionlessSummary, /compiler_probe: .* — sh: missing-command: not found/);
	assert.doesNotMatch(versionlessSummary, /> check/);
	assert.match(JSON.stringify(versionless.wires.at(-1)), /> check/);
	diagnostic = "[SHELL_RUNTIME_FAILED]\n> authentication failed\n> token expired\n> refresh denied\nCommand exited with code 1";
	const quoted = await f.run(["await tools.compiler_probe({})"]);
	assert.match((quoted.results.at(-1)!.content[0] as any).text, /compiler_probe: .* — > authentication failed > token expired/);
	assert.match(JSON.stringify(quoted.wires.at(-1)), /token expired/);
	assert.match(JSON.stringify(quoted.wires.at(-1)), /refresh denied/);
	assert.match((quoted.results.at(-1)!.content[0] as any).text, /refresh denied/);
	diagnostic = "[SHELL_RUNTIME_FAILED]\nsrc/old.ts(1,1): error TS1000: stale cached diagnostic.\nTimeoutError: compiler server did not respond\nCommand exited with code 1";
	const terminal = await f.run(["await tools.compiler_probe({})"]);
	assert.match((terminal.results.at(-1)!.content[0] as any).text, /compiler_probe: .* — TimeoutError: compiler server did not respond/);
	assert.match(JSON.stringify(terminal.wires.at(-1)), /TS1000/);
	diagnostic = "[SHELL_RUNTIME_FAILED]\nsrc/old.ts(1,1): error TS1000: stale cached diagnostic.\nError: spawnSync C:/path/tool.exe UNKNOWN\nCommand exited with code 1";
	const spawn = await f.run(["await tools.compiler_probe({})"]);
	assert.match((spawn.results.at(-1)!.content[0] as any).text, /compiler_probe: .* — Error: spawnSync C:\/path\/tool.exe UNKNOWN/);
	assert.match(JSON.stringify(spawn.wires.at(-1)), /TS1000/);
});

test("Codemode delivers native PowerShell refusal recovery for an unshown child", async t => {
	const diagnostic = "[SHELL_BACKGROUND] PowerShell not executed: unmanaged background work requires an owned task.\nNext: submit a literal foreground command for normal authorization; do not retry the same blocked call.";
	const extension: InlineExtension = pi => pi.registerTool({ name: "refusal_probe", label: "probe", description: "offline refusal fixture",
		parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: diagnostic }], isError: true, details: {} }) });
	const f = await fixture(t, {}, [extension, guardrails]);
	const outcome = await f.run(["await tools.refusal_probe({})"]);
	assert.equal(outcome.results[0]!.isError, true);
	assert.match((outcome.results[0]!.content[0] as any).text, /refusal_probe: .*Next: submit a literal foreground command.*do not retry/);
	assert.match(JSON.stringify(outcome.wires.at(-1)), /Next: submit a literal foreground command/);
});

for (const repeated of [false, true]) test(`budgeted default bundle accepts multiple shown native reads: repeated=${repeated}`, async t => {
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: 8000 } }, [], true);
	writeFileSync(join(f.cwd, "other.txt"), "other\n");
	const outcome = await f.run([repeated
		? 'const r=await tools.read({path:"file.txt"}); await show(r.ref); await show(r.ref)'
		: 'await show((await tools.read({path:"file.txt"})).ref); await show((await tools.read({path:"other.txt"})).ref)']);
	assert.equal(f.session.agent.state.errorMessage, undefined);
	assert.equal(outcome.wires.length, 2);
	assert.equal(outcome.results[0]?.isError, false);
	const markers = outcome.results[0]!.content.filter((b: any) => b.readBoundary).map((b: any) => b.readBoundary);
	assert.deepEqual(markers, ["lines", "metadata", "lines", "metadata"]);
	await f.run([]);
	assert.equal(f.session.agent.state.errorMessage, undefined, "the next user request must also succeed");
});

test("saved multi-read Codemode history recovers after request failure and reopen without replaying reads", async t => {
	const options = { toolResultPresentation: { enabled: true, budgetTokens: 8000 } };
	const f = await fixture(t, options, [], true, true);
	const convert = f.session.agent.convertToLlm;
	f.session.agent.convertToLlm = (...args) => {
		if (args[0].some(m => m.role === "toolResult")) throw new Error("Read projection requires one source-line block followed by paired metadata.");
		return convert(...args);
	};
	await f.run(['await show((await tools.read({path:"file.txt",offset:1,limit:1})).ref); await show((await tools.read({path:"file.txt",offset:2,limit:1})).ref)']);
	assert.match(f.session.agent.state.errorMessage!, /Read projection requires/);
	const parent = f.session.agent.state.messages.find(m => m.role === "toolResult")!;
	const canonical = JSON.stringify(parent);
	f.session.agent.convertToLlm = convert;
	const continued = await f.run([]);
	assert.equal(f.session.agent.state.errorMessage, undefined);
	assert.equal(continued.wires.length, 1);
	assert.equal(JSON.stringify(parent), canonical);
	assert.equal(continued.results.length, 1);
	const file = f.manager.getSessionFile()!;
	f.session.dispose();
	await f.resources.reload();
	const { session } = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, resourceLoader: f.resources,
		settingsManager: f.settings, sessionManager: SessionManager.open(file), ...options,
		model: { ...MODEL, input: ["text"] }, modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
			isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as never });
	try {
		await session.bindExtensions({});
		let requests = 0;
		session.agent.streamFunction = () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", usage: USAGE,
				content: [{ type: "text", text: "Recovered without replay" }], stopReason: "stop", timestamp: 1 } });
			return stream;
		};
		await session.agent.prompt("Continue the saved session");
		assert.equal(session.agent.state.errorMessage, undefined);
		assert.equal(requests, 1);
		const saved = session.agent.state.messages.filter(m => m.role === "toolResult");
		assert.equal(saved.length, 1);
		assert.equal(JSON.stringify(saved[0]), canonical);
	} finally { session.dispose(); }
});

function isolateTemporaryFiles(t: TestContext, cwd: string): void {
	// Any capped spill belongs to this test's registered fixture root too.
	const temporary = join(cwd, "tmp"); mkdirSync(temporary);
	const previousTmp = process.env.TMP, previousTemp = process.env.TEMP, previousTmpdir = process.env.TMPDIR;
	process.env.TMP = temporary; process.env.TEMP = temporary; process.env.TMPDIR = temporary;
	t.after(() => {
		if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
		if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
		if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
	});
}

test("five native reads under a shared budget continue without granting omitted reads edit authority", async t => {
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: 512 } }, [], true);
	isolateTemporaryFiles(t, f.cwd);
	for (let file = 0; file < 3; file++) writeFileSync(join(f.cwd, `middle${file}.txt`), Array.from({ length: 400 }, (_, line) => `hidden${file} line${line}\n`).join(""));
	writeFileSync(join(f.cwd, "last.txt"), "last\n");
	const outcome = await f.run([
		'for (const path of ["file.txt","middle0.txt","middle1.txt","middle2.txt","last.txt"]) await show((await tools.read({path})).ref)',
		'await tools.edit({path:"middle1.txt",edits:[{oldText:"hidden1 line0",newText:"must not write"}]})',
	]);
	assert.equal(f.session.agent.state.errorMessage, undefined);
	assert.equal(outcome.wires.length, 3);
	assert.equal(outcome.results[0]?.isError, false);
	assert.equal(outcome.results[0]?.details?.codemode.calls.length, 5);
	assert.equal(outcome.results[1]?.isError, true);
	assert.match(JSON.stringify(outcome.results[1]?.content), /READ_REQUIRED/);
	assert.ok(readFileSync(join(f.cwd, "middle1.txt"), "utf8").startsWith("hidden1 line0\n"));
	const recovery = await f.run([
		'await show((await tools.read({path:"middle1.txt",offset:1,limit:1})).ref)',
		'await tools.edit({path:"middle1.txt",edits:[{oldText:"hidden1 line0",newText:"verified change"}]})',
	]);
	assert.equal(f.session.agent.state.errorMessage, undefined);
	assert.equal(recovery.results.at(-1)?.isError, false, JSON.stringify(recovery.results.at(-1)?.content));
	assert.ok(readFileSync(join(f.cwd, "middle1.txt"), "utf8").startsWith("verified change\n"));
});

for (const cloned of [false, true]) test(`a complete tail read retained after projection still authorizes its edit: cloned=${cloned}`, async t => {
	const clone: InlineExtension = pi => pi.on("context", event => ({ messages: structuredClone(event.messages) }));
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: 512 } }, cloned ? [clone] : [], true);
	writeFileSync(join(f.cwd, "first.txt"), "earlier data\n".repeat(140));
	const outcome = await f.run([
		'await show((await tools.read({path:"first.txt"})).ref); await show((await tools.read({path:"file.txt"})).ref)',
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"retained tail"}]})',
	]);
	assert.equal(f.session.agent.state.errorMessage, undefined);
	const canonical = outcome.results[0]!.content;
	const visible = outcome.wires[1]!.messages.find(m => m.role === "toolResult")!.content;
	const sourceIndex = canonical.findIndex(b => b.type === "text" && b.text.includes("|hello"));
	const modelIndex = visible.findIndex(b => b.type === "text" && b.text.includes("|hello"));
	assert.ok(sourceIndex > modelIndex && modelIndex >= 0, "the complete tail read must move after the omitted first group");
	assert.equal(outcome.results[1]?.isError, false, JSON.stringify(outcome.results[1]?.content));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "retained tail\nworld\n");
});

test("enabled presentation without a token budget keeps native read evidence", async t => {
	const f = await fixture(t, { toolResultPresentation: { enabled: true } }, [], true);
	const outcome = await f.run([
		'await show((await tools.read({path:"file.txt"})).ref)',
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"unprojected"}]})',
	]);
	assert.equal(outcome.results[1]?.isError, false, JSON.stringify(outcome.results[1]?.content));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "unprojected\nworld\n");
});

for (const projected of [false, true]) test(`blocked adjacent images do not displace the evidence of a visible native read: projected=${projected}`, async t => {
	const pictures: InlineExtension = pi => pi.registerTool({ name: "pictures", label: "pictures", description: "image fixture", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "BBBB", mimeType: "image/png" }], details: {} }) });
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: projected ? 1024 : 8000 } }, [pictures], true);
	f.settings.setBlockImages(true);
	writeFileSync(join(f.cwd, "before.txt"), "leading\n");
	const outcome = await f.run([
		(projected ? 'text("padding ".repeat(1000)); await show((await tools.read({path:"before.txt"})).ref);' : '') + 'await show((await tools.pictures({})).ref); await show((await tools.read({path:"file.txt"})).ref)',
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"after images"}]})',
	]);
	const visible = outcome.wires[1]!.messages.find(m => m.role === "toolResult")!.content;
	assert.equal(visible.filter(b => b.type === "text" && b.text === "Image reading is disabled.").length, 1, JSON.stringify(visible));
	assert.equal(visible.some(b => b.type === "image"), false);
	assert.ok(visible.some(b => b.type === "text" && b.text.includes("|hello")));
	assert.equal(outcome.results[1]?.isError, false, JSON.stringify(outcome.results[1]?.content));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "after images\nworld\n");
});

for (const mode of ["live", "reload", "unrecognized"] as const) test(`capped trailing read annotations keep source evidence boundaries: ${mode}`, async t => {
	const annotation = (mode === "unrecognized" ? "arbitrary extra text\n" : "[TLG: fixture]\n") + "annotation ".repeat(1000);
	const annotate: InlineExtension = pi => pi.on("tool_result", event => {
		if (event.toolName !== "read") return;
		// Append to the tool-owned array so its nonserializing native-source proof survives.
		event.content.push({ type: "text", text: annotation });
	});
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: 8000 } }, mode === "reload" ? [mutation, guardrails, annotate] : [annotate], mode !== "reload");
	isolateTemporaryFiles(t, f.cwd);
	const read = await f.run(['// @options: {"max_output_tokens":512}\nawait show((await tools.read({path:"file.txt"})).ref)', 'text("acknowledge the displayed read")']);
	const parent = read.results[0]!.content;
	assert.equal(parent.filter((b: any) => b.readBoundary).length, 2, JSON.stringify(parent));
	assert.equal(parent.some(b => b.type === "text" && b.text === annotation), false);
	assert.match(JSON.stringify(parent), /Codemode output truncated/);
	if (mode === "reload") {
		const errors: unknown[] = [];
		await f.session.bindExtensions({ onError: error => errors.push(error) });
		await f.session.reload();
		assert.deepEqual(errors, []);
	}
	const edit = await f.run(['await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"annotation safe"}]})']);
	assert.equal(edit.results.at(-1)?.isError, mode === "unrecognized", JSON.stringify(edit.results.at(-1)?.content));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), mode === "unrecognized" ? "hello\nworld\n" : "annotation safe\nworld\n");
});

test("projection never substitutes a printed read copy for an omitted native group", async t => {
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: 512 } }, [], true);
	writeFileSync(join(f.cwd, "large.txt"), "surrounding data\n".repeat(100));
	const outcome = await f.run([
		'const r=await tools.read({path:"file.txt"}); for(const b of r.content) text(b.text); const large=await tools.read({path:"large.txt"}); await show(large.ref); await show(r.ref); await show(large.ref)',
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"must not write"}]})',
	]);
	assert.equal(f.session.agent.state.errorMessage, undefined);
	const original = outcome.results[0]!.content;
	const lines = original.find((b: any) => b.readBoundary === "lines" && b.text.includes("|hello"));
	assert.ok(lines?.type === "text");
	const visible = outcome.wires[1]!.messages.find(m => m.role === "toolResult")!.content;
	assert.equal(original.filter(b => b.type === "text" && b.text === lines.text).length, 2);
	assert.equal(visible.filter(b => b.type === "text" && b.text === lines.text).length, 1, "only the printed copy survives");
	assert.equal(outcome.results[1]?.isError, true);
	assert.match(JSON.stringify(outcome.results[1]?.content), /READ_REQUIRED/);
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("SDK defaults to Codemode declarations and native control tools, retaining callable tools", async t => {
	const f = await fixture(t);
	(f.session as any)._providerRequestPayloadBuilder = (input: any) => ({ tools: input.tools.map((tool: any) => tool.name) });
	const preview = await f.session.buildProviderRequestPayload({ messages: [], systemPrompt: "fixture" });
	assert.deepEqual((preview?.tools as string[]).sort(), ["ask_user", "codemode"], "provider compaction/preview uses the model-facing catalog too");
	assert.ok(f.session.getActiveToolNames().includes("read"));
	const outcome = await f.run(['const r=await tools.read({path:"file.txt"}); await show(r.ref);']);
	assert.deepEqual(outcome.wires[0]!.tools?.map(tool => tool.name).sort(), ["ask_user", "codemode"]);
	const prompt = outcome.wires[0]!.systemPrompt!;
	const toolsSection = prompt.slice(prompt.indexOf("Available tools:"), prompt.indexOf("Guidelines:"));
	assert.match(toolsSection, /- codemode:/);
	assert.doesNotMatch(toolsSection, /- (read|bash|powershell|edit|write):/);
	assert.match(prompt, /For read inside codemode:/);
	assert.match(prompt, /for file operations/, "shell guidance counts Codemode children as callable tools");
	assert.equal(outcome.results[0]?.isError, false);
	assert.match(JSON.stringify(outcome.results[0]?.content), /hello/);
	assert.deepEqual(outcome.results.map(r => r.toolName), ["codemode"]);
});

test("default extension bundle allows sequential verification after an authorized edit", async t => {
	const f = await fixture(t, {}, [], true);
	const outcome = await f.run([
		'const r=await tools.read({path:"file.txt"});await show(r.ref)',
		'await tools.read({path:"file.txt"});await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"changed"}]});const r=await tools.read({path:"file.txt"});await show(r.ref)',
	]);
	assert.ok(outcome.results.every(r => !r.isError), JSON.stringify(outcome.results));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "changed\nworld\n");
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /changed/);
});

test("default extension bundle still requires a completed prior visible read", async t => {
	const f = await fixture(t, {}, [], true);
	const outcome = await f.run(['const r=await tools.read({path:"file.txt"});await show(r.ref);await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"bad"}]})']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]), /READ_REQUIRED/);
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("SDK allowlist constrains children while adding the default transport; no-tools stays empty", async t => {
	const f = await fixture(t, { tools: ["read"] });
	assert.deepEqual(f.session.getActiveToolNames().sort(), ["codemode", "read"]);
	const outcome = await f.run(['try { await callTool("write",{path:"forbidden.txt",content:"bad"}); } catch {} text("success")']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.deepEqual(outcome.wires[0]!.tools?.map(tool => tool.name), ["codemode"]);
	const empty = await fixture(t, { noTools: "all" });
	assert.deepEqual(empty.session.getActiveToolNames(), []);
	assert.deepEqual(empty.session.agent.state.modelTools, []);
});

test("tool selection expressions modify configured defaults and intersect literal SDK lists", async t => {
	const settings = SettingsManager.inMemory({ defaultTools: ["read", "write"] });
	const f = await fixture(t, { settingsManager: settings, toolSelection: { tools: ["+grep", "-write"] } });
	assert.deepEqual(f.session.getActiveToolNames().sort(), ["codemode", "grep", "read"]);
	assert.deepEqual(settings.getDefaultTools(), ["read", "write"]);
	const strict = await fixture(t, { tools: ["read", "write"], toolSelection: { tools: ["*"], excludeTools: ["writ?"] } });
	strict.session.setActiveToolsByName(["read", "write", "bash"]);
	assert.deepEqual(strict.session.getActiveToolNames().sort(), ["codemode", "read"]);
	const literal = await fixture(t, { tools: ["rea*"] });
	assert.equal(literal.session.getActiveToolNames().includes("read"), false);
	const empty = await fixture(t, { toolSelection: { tools: ["missing_*"] } });
	assert.deepEqual(empty.session.agent.state.modelTools, []);
	const added = await fixture(t, { noTools: "all", toolSelection: { tools: ["+read"] } });
	assert.deepEqual(added.session.getActiveToolNames().sort(), ["codemode", "read"]);
});

test("tool selection expressions constrain late MCP registration, explicit activation and reload", async t => {
	let registerLate: () => void = () => { throw new Error("not initialized"); };
	let allowed = 0, denied = 0;
	const extension: InlineExtension = pi => {
		const runtime = new McpBridgeRuntime(pi, "fixture");
		t.after(() => runtime.close());
		pi.on("session_shutdown", () => runtime.close());
		const state = { status: "connected", catalogReady: true, config: { id: "fixture", toolTimeoutMs: 1000 }, tools: new Map([["lookup", {}], ["delete", {}]]), client: {
			async callTool(request: { name: string }) { if (request.name === "lookup") allowed++; else denied++; return { content: [{ type: "text", text: request.name }] }; }, async close() {} } };
		runtime.states.set("fixture", state);
		registerLate = () => {
			for (const name of ["lookup", "delete"]) {
				runtime.registerRemoteTool(state, { name, description: "fixture", inputSchema: { type: "object", properties: {} } });
			}
			pi.setActiveTools(["mcp__fixture__lookup", "mcp__fixture__delete", "write"]);
		};
	};
	const f = await fixture(t, { toolSelection: { tools: ["mcp__fixture__*", "-*__delete"] } }, [extension]);
	assert.deepEqual(f.session.getActiveToolNames(), []);
	registerLate();
	assert.deepEqual(f.session.getActiveToolNames().sort(), ["codemode", "mcp__fixture__lookup"]);
	const outcome = await f.run(['const r=await callTool("mcp__fixture__lookup",{});text(r.content)', 'await callTool("mcp__fixture__delete",{})']);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	assert.equal(outcome.results[1]?.isError, true);
	assert.equal(allowed, 1); assert.equal(denied, 0);
	await f.session.reload();
	registerLate();
	assert.deepEqual(f.session.getActiveToolNames().sort(), ["codemode", "mcp__fixture__lookup"]);
	f.session.dispose();
	assert.equal((f.session as any)._toolSelection, undefined);
});

test("tool selection wildcard and denied activation preserve unavailable PowerShell", async t => {
	const { default: lifecycle } = await jiti.import<{ default: InlineExtension }>("../packages/extensions/resource-lifecycle-guard/index.ts");
	const settings = SettingsManager.inMemory({ powershellStatus: { available: false, verified: false, path: "missing.exe" } });
	const f = await fixture(t, { settingsManager: settings, toolSelection: { tools: ["*"] } }, [toolClassification, lifecycle]);
	assert.equal(f.session.getActiveToolNames().includes("powershell"), false);
	assert.equal(settings.getPowerShellStatus()?.available, false);
	assert.equal(f.session.getAllTools().find(tool => tool.name === "powershell")?.available, false);
	const blocked = await f.session.agent.dispatchHostTool({ type: "toolCall", id: "unavailable-recovery", name: "bash", arguments: { command: "powershell.exe -NoProfile -Command 'Write-Output fixture'" } });
	assert.equal(blocked.isError, true);
	assert.match(JSON.stringify(blocked.content), /directly inspectable foreground command/);
	assert.doesNotMatch(JSON.stringify(blocked.content), /Use tool_search|enabled native PowerShell/);
	const search = await f.session.agent.dispatchHostTool({ type: "toolCall", id: "unavailable-search", name: "tool_search", arguments: { query: "powershell" } });
	assert.equal(search.isError, false);
	assert.deepEqual((search.details as any)?.matches, []);
	assert.equal(f.session.getActiveToolNames().includes("powershell"), false);
	const denied = await fixture(t, { settingsManager: settings, toolSelection: { tools: ["read", "-powershell"] } });
	denied.session.setActiveToolsByName(["powershell", "read"]);
	assert.deepEqual(denied.session.getActiveToolNames().sort(), ["codemode", "read"]);
	assert.equal(settings.getPowerShellStatus()?.available, false);
	if (process.platform === "win32") {
		f.session.setActiveToolsByName(["bash", "tool_search", "powershell"]);
		assert.equal(f.session.getAllTools().find(tool => tool.name === "powershell")?.available, true);
		(f.session as any)._powerShellToolState.disable("offline transient failure");
		assert.equal(f.session.getAllTools().find(tool => tool.name === "powershell")?.available, false);
		const unavailable = await f.session.agent.dispatchHostTool({ type: "toolCall", id: "disabled-active-recovery", name: "bash", arguments: { command: "powershell.exe -Command 'Write-Output fixture'" } });
		assert.doesNotMatch(JSON.stringify(unavailable.content), /Use tool_search|enabled native PowerShell/);
	}
});

test("real tool_search activates allowed tools inside Codemode without exposing denied names", async t => {
	const extension: InlineExtension = pi => {
		for (const name of ["catalog_lookup", "catalog_delete"]) pi.registerTool({ name, label: name, description: "catalog fixture",
			parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: name }], details: {} }) });
	};
	const f = await fixture(t, { toolSelection: { tools: ["tool_search", "catalog_*", "-catalog_delete"] } }, [toolClassification, extension]);
	f.session.setActiveToolsByName(["tool_search"]);
	const outcome = await f.run([
		'const r=await tools.tool_search({query:"catalog",limit:1});text(r.details);text(ALL_TOOLS.some(t=>t.name==="catalog_lookup"));text((await callTool("catalog_lookup",{})).content);text(await describeTools(["catalog_delete"]));',
		'text(ALL_TOOLS.map(t=>t.name));await callTool("catalog_delete",{});',
	]);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	const discovered = JSON.stringify(outcome.results[0]?.content);
	assert.match(discovered, /catalog_lookup/);
	assert.match(discovered, /false/); // The running script keeps its initial ALL_TOOLS snapshot.
	assert.doesNotMatch(discovered, /catalog_delete/);
	assert.equal(outcome.results[1]?.isError, true);
	assert.match(JSON.stringify(outcome.results[1]?.content), /catalog_lookup/);
	assert.deepEqual(f.session.getActiveToolNames().sort(), ["catalog_lookup", "codemode", "tool_search"]);
});

test("exact tool-name search outranks matching words in another tool description", async t => {
	let browserCalls = 0, batchCalls = 0;
	const extension: InlineExtension = pi => {
		pi.registerTool({ name: "browser_exec", label: "Browser", description: "file: navigation is unsupported; batch a browser procedure",
			parameters: Type.Object({}), execute: async () => { browserCalls++; return { content: [], details: {} }; } });
		pi.registerTool({ name: "file_batch", label: "File batch", description: "file batch fixture",
			parameters: Type.Object({}), execute: async () => { batchCalls++; return { content: [], details: {} }; } });
	};
	const f = await fixture(t, {}, [toolClassification, extension]);
	f.session.setActiveToolsByName(["tool_search"]);
	const outcome = await f.run(['text((await tools.tool_search({query:"  FILE_BATCH  ",limit:1})).details);await callTool("file_batch",{});']);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	assert.equal(batchCalls, 1);
	assert.equal(browserCalls, 0);
	assert.deepEqual(f.session.getActiveToolNames().sort(), ["codemode", "file_batch", "tool_search"]);
});

test("browser search separates browsing and DevTools while approval failures pause automatic switching", async t => {
	let devtoolsCalls = 0, browserCalls = 0;
	const extension: InlineExtension = pi => {
		pi.registerTool({ name: "browser_exec", label: "Browser Use", description: "browser web search",
			parameters: Type.Object({}), execute: async () => { browserCalls++; throw new Error("[BROWSER_EXEC_PERMISSION_REQUIRED] Chrome approval is incomplete."); } });
		pi.registerTool({ name: "chrome_devtools_list_pages", label: "Chrome pages", description: "browser web search cdp",
			parameters: Type.Object({}), execute: async () => { devtoolsCalls++; return { content: [{ type: "text", text: "explicit browser" }], details: {} }; } });
	};
	const f = await fixture(t, {}, [toolClassification, extension]);
	f.session.setActiveToolsByName(["tool_search"]);
	const outcome = await f.run([
		'const r=await tools.tool_search({query:"web search",limit:3});text(r.details);',
		'await tools.browser_exec({});',
		'const r=await tools.tool_search({query:"chrome_devtools_list_pages",limit:12});text(r.details);await callTool("chrome_devtools_list_pages",{});',
	]);
	assert.equal(outcome.results[0]?.isError, false);
	assert.match(JSON.stringify(outcome.results[0]?.content), /browser_exec/);
	assert.doesNotMatch(JSON.stringify(outcome.results[0]?.content), /chrome_devtools/);
	assert.equal(outcome.results[1]?.isError, true);
	assert.match(JSON.stringify(outcome.results[1]?.content), /PERMISSION_REQUIRED/);
	assert.equal(outcome.results[2]?.isError, true);
	assert.equal(devtoolsCalls, 0, "guessing a disabled name must not launch a second browser");
	assert.equal(f.session.getActiveToolNames().includes("chrome_devtools_list_pages"), false);
	const retry = await f.run(['await tools.browser_exec({});']);
	assert.equal(retry.results.at(-1)?.isError, true);
	assert.match(JSON.stringify(retry.results.at(-1)?.content), /BROWSER_APPROVAL_PAUSED/);
	assert.equal(browserCalls, 1, "approval failure cannot cause another automatic connection attempt");
	// Even a previously activated CDP tool cannot bypass an unresolved approval in this run.
	f.session.setActiveToolsByName(["tool_search", "chrome_devtools_list_pages"]);
	await (f.session as any)._extensionRunner.emitInput("continue automatically", undefined, "extension");
	const blocked = await f.run(['await tools.chrome_devtools_list_pages({});']);
	assert.equal(blocked.results.at(-1)?.isError, true);
	assert.match(JSON.stringify(blocked.results.at(-1)?.content), /BROWSER_APPROVAL_PAUSED/);
	assert.equal(devtoolsCalls, 0);
	// A new user-directed run can select DevTools for its own task without a manual enable command.
	f.session.setActiveToolsByName(["tool_search"]);
	const directed = await f.run(['await tools.tool_search({query:"browser_debug"});text(await callTool("chrome_devtools_list_pages",{}));'], undefined, false, true);
	assert.equal(directed.results.at(-1)?.isError, false, JSON.stringify(directed.results));
	assert.equal(devtoolsCalls, 1);
});

test("parent cancellation preserves browser approval pause and partial browser output reaches the next model turn", async t => {
	let devtoolsCalls = 0, started = false;
	const evidence = 'browser-harness: Chrome is asking "Allow remote debugging?" — click Allow to continue.\npermission-pending: Chrome approval is pending';
	const extension: InlineExtension = pi => {
		pi.registerTool({ name: "browser_exec", label: "browser", description: "fixture", parameters: Type.Object({ wait: Type.Optional(Type.Boolean()) }),
			execute: async (_id, args, signal) => {
				started = true;
				if (args.wait) await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
				return { content: browserResultText({ stdout: args.wait ? "" : "Partial NASA fact before navigation failed", stderr: args.wait ? evidence : "Traceback (most recent call last):\nTimeoutError: earlier\nTraceback (most recent call last):\nStopIteration: final cause",
					exitCode: 1, killed: !!args.wait, timedOut: false, aborted: !!args.wait, stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 48, stderrBytes: 180 }),
					isError: true, details: { aborted: !!args.wait } };
			} });
		pi.registerTool({ name: "chrome_devtools_list_pages", label: "cdp", description: "fixture", parameters: Type.Object({}),
			execute: async () => { devtoolsCalls++; return { content: [], details: {} }; } });
	};
	const f = await fixture(t, {}, [toolClassification, extension]);
	f.session.setActiveToolsByName(["browser_exec", "chrome_devtools_list_pages"]);
	const partial = await f.run(['await tools.browser_exec({});']);
	const result = partial.results.at(-1)!;
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /Partial NASA fact/);
	assert.match(JSON.stringify(partial.wires.at(-1)), /Partial NASA fact/);
	assert.match(JSON.stringify(result.content[0]), /StopIteration: final cause/);
	initTheme("dark");
	const tree = new CodemodeTreeComponent();
	tree.updateParent("await tools.browser_exec({})", result as any, false, true, false);
	const collapsed = stripVTControlCharacters(tree.render(120).join("\n"));
	assert.match(collapsed, /StopIteration: final cause/);
	assert.doesNotMatch(collapsed, /Partial NASA fact|Traceback/);
	tree.updateParent("await tools.browser_exec({})", result as any, false, true, true);
	const expanded = stripVTControlCharacters(tree.render(120).join("\n"));
	assert.match(expanded, /Partial NASA fact/); assert.match(expanded, /StopIteration: final cause/);
	releaseComponentRenderCaches(tree);
	started = false;
	const cancelled = await f.run(['// @options: {"timeout_ms":1000}\nawait tools.browser_exec({wait:true});', 'await tools.chrome_devtools_list_pages({});']);
	assert.equal(started, true);
	assert.match(JSON.stringify(cancelled.results.at(-2)!.content), /BROWSER_APPROVAL_PENDING/);
	assert.match(JSON.stringify(cancelled.results.at(-1)!.content), /BROWSER_APPROVAL_PAUSED/);
	assert.equal(devtoolsCalls, 0);
	assert.match(formatFailure("ABORTED", evidence), /current state is unknown/);
});

test("DevTools is discoverable for local preview and exact names without enabling general browsing tools", async t => {
	let browserCalls = 0, devtoolsCalls = 0;
	const extension: InlineExtension = pi => {
		pi.registerTool({ name: "browser_exec", label: "Browser", description: "browse web pages and screenshots",
			parameters: Type.Object({}), execute: async () => { browserCalls++; throw new Error("[BROWSER_EXEC_FAILED] Python error quoting [BROWSER_EXEC_PERMISSION_REQUIRED]"); } });
		pi.registerTool({ name: "chrome_devtools_list_pages", label: "Chrome pages", description: "list browser pages cdp",
			parameters: Type.Object({}), execute: async () => { devtoolsCalls++; return { content: [], details: {} }; } });
	};
	const f = await fixture(t, {}, [toolClassification, extension]);
	f.session.setActiveToolsByName(["tool_search", "browser_exec"]);
	const failed = await f.run(['await tools.browser_exec({});']);
	assert.equal(failed.results.at(-1)?.isError, true);
	const queries = ["browser_debug", "cdp", "local preview", "本地页面预览", "chrome_devtools_list_pages",
		"DOM inspection", "JavaScript inspection", "UI validation", "inspect DOM", "validate UI", "DOM检查", "界面验证", "browser_debug screenshot"];
	for (const query of queries) {
		f.session.setActiveToolsByName(["tool_search"]);
		const outcome = await f.run([`text((await tools.tool_search({query:${JSON.stringify(query)}})).details);await callTool("chrome_devtools_list_pages",{});`]);
		assert.equal(outcome.results.at(-1)?.isError, false, `${query}: ${JSON.stringify(outcome.results)}`);
		assert.equal(f.session.getActiveToolNames().includes("browser_exec"), false, query);
	}
	assert.equal(devtoolsCalls, queries.length); assert.equal(browserCalls, 1, "an ordinary browser error does not pause DevTools");
});

test("explicit DevTools enable and selection clear only their session approval pause", async t => {
	const configRoot = mkdtempSync(join(tmpdir(), "sp-cdp-user-selection-"));
	const previousAgentDir = process.env.SP_CODING_AGENT_DIR;
	process.env.SP_CODING_AGENT_DIR = join(configRoot, "agent");
	let f: Awaited<ReturnType<typeof fixture>> | undefined;
	let selectionSubscriptions = 0;
	t.after(async () => { try { await (f?.session as any)?._extensionRunner.emit({ type: "session_shutdown" });
		assert.equal(selectionSubscriptions, 0, "shutdown releases the selection subscription"); }
		finally { if (previousAgentDir === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previousAgentDir;
			rmSync(configRoot, { recursive: true, force: true }); } });
	const { default: chromeDevtools } = await jiti.import<{ default: ExtensionFactory }>("../packages/chrome-devtools/src/chrome-devtools.ts");
	const { setSelectedChromeDevtoolsTools } = await jiti.import<any>("../packages/chrome-devtools/src/tool-selector.ts");
	let api: any, calls = 0;
	f = await fixture(t, {}, [pi => (toolClassification as ExtensionFactory)({ ...pi, events: { ...pi.events,
		on: (channel, handler) => {
			const stop = pi.events.on(channel, handler);
			if (channel !== "super-pi:chrome-devtools:user-selection") return stop;
			selectionSubscriptions++;
			let subscribed = true;
			return () => { stop(); if (subscribed) { selectionSubscriptions--; subscribed = false; } };
		},
	} }), pi => {
		api = pi;
		chromeDevtools({ ...pi, registerTool: definition => pi.registerTool({ ...definition,
			execute: async () => { calls++; return { content: [], details: undefined as never }; } }) });
		pi.registerTool({ name: "browser_exec", label: "Browser", description: "browser fixture", parameters: Type.Object({}),
			execute: async () => { throw new Error("[BROWSER_EXEC_PERMISSION_REQUIRED] Pending approval"); } });
	}]);
	assert.equal(selectionSubscriptions, 1);
	f.session.setActiveToolsByName(["browser_exec", "chrome_devtools_list_pages"]);
	await f.run(['await tools.browser_exec({});']);
	api.events.emit("super-pi:chrome-devtools:user-selection", { sessionId: "another-session" });
	const denied = await f.run(['await tools.chrome_devtools_list_pages({});']);
	assert.equal(denied.results.at(-1)?.isError, true); assert.equal(calls, 0);
	await f.session.prompt("/chrome-devtools disable");
	f.session.setActiveToolsByName(["browser_exec", "chrome_devtools_list_pages"]);
	const stillDenied = await f.run(['await tools.chrome_devtools_list_pages({});']);
	assert.equal(stillDenied.results.at(-1)?.isError, true); assert.equal(calls, 0);
	await f.session.prompt("/chrome-devtools enable");
	const enabled = await f.run(['await tools.chrome_devtools_list_pages({});']);
	assert.equal(enabled.results.at(-1)?.isError, false, JSON.stringify(enabled.results.at(-1)));
	assert.equal(calls, 1);
	await f.run(['await tools.browser_exec({});']);
	await f.session.prompt("/chrome-devtools enable");
	const reenabled = await f.run(['await tools.chrome_devtools_list_pages({});']);
	assert.equal(reenabled.results.at(-1)?.isError, false, "explicit enable resumes even if all tools were active");
	assert.equal(calls, 2);
	await f.run(['await tools.browser_exec({});']);
	const selectionContext = (f.session as any)._extensionRunner.createContext();
	for (const reason of ["partial deselection", "unchanged selection"]) {
		assert.equal(await setSelectedChromeDevtoolsTools(api, selectionContext, ["chrome_devtools_list_pages"]), true);
		const paused = await f.run(['await tools.chrome_devtools_list_pages({});']);
		assert.equal(paused.results.at(-1)?.isError, true, reason); assert.equal(calls, 2, reason);
	}
	assert.equal(await setSelectedChromeDevtoolsTools(api, selectionContext, ["chrome_devtools_list_pages", "chrome_devtools_evaluate"]), true);
	const selected = await f.run(['await tools.chrome_devtools_list_pages({});']);
	assert.equal(selected.results.at(-1)?.isError, false, JSON.stringify(selected.results.at(-1)));
	assert.equal(calls, 3);
	// Hold real settings I/O while a previously submitted choice is overtaken by
	// a browser failure. Its eventual successful save is not newer user direction.
	const { saveSettings } = await jiti.import<any>("../packages/chrome-devtools/src/settings.js");
	const { updateChromeDevtoolsTools, allChromeDevtoolsTools } = await jiti.import<any>("../packages/chrome-devtools/src/tool-selector.ts");
	const { rename } = await import("node:fs/promises");
	let releaseSave!: () => void, reachedSave!: () => void;
	const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
	const saveEntered = new Promise<void>(resolve => { reachedSave = resolve; });
	const heldSave = saveSettings({ tools: [], updatedAt: 0 }, { rename: async (from: string, to: string) => {
		reachedSave(); await saveGate; await rename(from, to);
	} });
	let enabling: Promise<unknown> | undefined;
	try {
		await saveEntered;
		enabling = updateChromeDevtoolsTools(api, selectionContext, allChromeDevtoolsTools(), "enabled all", true);
		await f.run(['await tools.browser_exec({});']);
	} finally { releaseSave(); await heldSave; await enabling; }
	const overtaken = await f.run(['await tools.chrome_devtools_list_pages({});']);
	assert.equal(overtaken.results.at(-1)?.isError, true, "pre-failure choice must not clear the later pause");
	assert.equal(calls, 3);
	await f.session.prompt("/chrome-devtools enable");
	const freshEnable = await f.run(['await tools.chrome_devtools_list_pages({});']);
	assert.equal(freshEnable.results.at(-1)?.isError, false); assert.equal(calls, 4);
});

test("successful state writes persist as a versioned branch entry; failed script writes do not", async t => {
	const f = await fixture(t, { tools: ["read"] });
	const outcome = await f.run(['store("n",3)', 'store("n",4); throw new Error("fail")', 'text(load("n"))']);
	assert.equal(outcome.results[0]?.isError, false);
	assert.equal(outcome.results[1]?.isError, true);
	assert.match(JSON.stringify(outcome.results[2]?.content), /3/);
	const saved = f.manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY);
	assert.equal(saved.length, 1);
});

for (const [label, code, allowed] of [
	["shown native read", 'const r=await tools.read({path:"file.txt"}); await show(r.ref)', true],
	["hidden native read", 'await tools.read({path:"file.txt"})', false],
	["printed copy", 'const r=await tools.read({path:"file.txt"}); text(r.content)', false],
	["forged reference", 'try { await show("forged") } catch {}', false],
] as const) {
	test(`mutation evidence: ${label}`, async t => {
		const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
		const outcome = await f.run([code, 'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"changed"}]})']);
		assert.equal(outcome.results[1]?.isError, !allowed, JSON.stringify(outcome.results));
		if (!allowed) assert.match(JSON.stringify(outcome.results[1]), /READ_REQUIRED/);
		assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), allowed ? "changed\nworld\n" : "hello\nworld\n");
	});
}

test("same-script shown read cannot authorize an edit", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	const outcome = await f.run(['const r=await tools.read({path:"file.txt"});await show(r.ref);await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"bad"}]})']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]), /READ_REQUIRED/);
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("tool discovery changes are callable within the same script through the current catalog", async t => {
	const extra: InlineExtension = pi => {
		pi.registerTool({ name: "activate", label: "activate", description: "fixture", parameters: Type.Object({}), execute: async () => {
			pi.setActiveTools([...pi.getActiveTools(), "conditional"]); return { content: [], details: {} };
		} });
		pi.registerTool({ name: "conditional", label: "conditional", description: "fixture", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "activated" }], details: {} }) });
	};
	const f = await fixture(t, {}, [extra]);
	f.session.setActiveToolsByName(["activate"]);
	const outcome = await f.run(['await tools.activate({}); const r=await callTool("conditional",{}); text(r.content)']);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	assert.match(JSON.stringify(outcome.results[0]?.content), /activated/);
});

test("Codemode store ownership isolates branches and preserves prototype keys", () => {
	const store = new CodemodeStore();
	store.restore(JSON.parse('{"__proto__":{"v":1},"a":2}'));
	const first = store.snapshot;
	store.apply({ set: { a: 3 }, delete: [] });
	assert.equal(first.a, 2);
	assert.equal(store.snapshot.a, 3);
	assert.deepEqual(store.snapshot.__proto__, { v: 1 });
	store.restore(first);
	assert.equal(store.snapshot.a, 2);
	store.reset();
	assert.equal(Object.keys(store.snapshot).length, 0);
});

test("numeric store values survive host commit, reload and VM transfer", async t => {
	const f = await fixture(t);
	let outcome = await f.run(['store("numbers",Array(20000).fill(0))']);
	assert.equal(outcome.results[0]?.isError, false);
	await f.session.reload();
	outcome = await f.run(['text(load("numbers").length)']);
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /20000/);
});

test("invalid saved store reports an explicit failure before executing tools", async t => {
	const f = await fixture(t);
	f.manager.appendCustomEntry(CODEMODE_STORE_ENTRY, { version: 1, values: { oversized: "x".repeat(262145) } });
	await f.session.reload();
	const outcome = await f.run(['await tools.read({path:"file.txt"})', 'text(load("oversized")===undefined)']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]?.content), /STORE_RESTORE_FAILED.*No tools were executed/);
	assert.equal(outcome.results[1]?.isError, false);
});

for (const truncated of [false, true]) test(`store persistence failure removes ${truncated ? "truncated" : "full"} OK summary and preserves previous snapshot`, async t => {
	const f = await fixture(t);
	await f.run(['store("n",7)']);
	const original = f.manager.appendCustomEntry.bind(f.manager);
	f.manager.appendCustomEntry = (kind, data) => { if (kind === CODEMODE_STORE_ENTRY) throw new Error("fixture storage failure"); return original(kind, data); };
	const code = truncated ? '// @options: {"max_output_tokens":256}\nfor(let i=0;i<96;i++) await tools.read({path:"file.txt"}); store("n",9)' : 'store("n",9)';
	const outcome = await f.run([code, 'text(load("n"))']);
	const failed = outcome.results.at(-2)!;
	assert.equal(failed.isError, true);
	assert.doesNotMatch(JSON.stringify(failed.content), /CODEMODE_OK/);
	assert.match(JSON.stringify(failed.content), /CODEMODE_FAILED.*storage failure/);
	if (truncated) assert.match(JSON.stringify(failed.content), /Codemode output truncated/);
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /"text":"7"/);
});

test("mutation result serialization failure records the completed outcome without replay", async t => {
	let writes = 0;
	const large: InlineExtension = pi => pi.registerTool({ name: "write", label: "fixture write", description: "fixture", parameters: Type.Object({}),
		execute: async () => { writes++; return { content: [], details: { huge: "x".repeat(1024 * 1024 + 1) } }; } });
	const f = await fixture(t, {}, [large]);
	const outcome = await f.run(['await tools.write({})']);
	assert.equal(writes, 1);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]?.content), /RESULT_PROCESSING_FAILED/);
	const saved = f.manager.getBranch().filter(e => e.type === "custom" && e.customType === CODEMODE_RESULT_ENTRY);
	assert.equal(saved.length, 1);
	const result = (saved[0] as any).data.result;
	assert.equal(result.isError, false, "preserve actual child outcome separately from result processing failure");
	assert.equal(result.details.requiresVerification, true);
	assert.match(result.details.codemodeResultError, /limit/);
});

test("a completed write stays recoverable in /changes when its end event times out", async t => {
	const stalled: InlineExtension = pi => { pi.on("tool_execution_end", async event => { if (event.toolName === "write") await new Promise(() => {}); }); };
	const f = await fixture(t, { tools: ["read", "write"], extensionRunnerOptions: { hookTimeouts: { lifecycle: { timeoutMs: 20, onTimeout: "fail-closed" } } } },
		[mutation, stalled], false, true);
	const outcome = await f.run(['await tools.write({path:"new.txt",content:"created\\n"})']);
	assert.equal(readFileSync(join(f.cwd, "new.txt"), "utf8"), "created\n");
	assert.equal(outcome.results[0]?.isError, true, "the parent still reports the observation failure");
	assert.match(JSON.stringify(outcome.results[0]?.content), /Child calls: 1[\s\S]*TOOL_OBSERVATION_FAILED/);
	const saved = f.manager.getBranch().filter(e => e.type === "custom" && e.customType === CODEMODE_RESULT_ENTRY);
	assert.equal(saved.length, 1);
	assert.equal((saved[0] as any).data.result.isError, false, "the persisted receipt keeps the tool's own outcome");
	assert.match((saved[0] as any).data.observationError, /tool_execution_end.*timed out after 20ms/);
	const sha256 = createHash("sha256").update("created\n").digest("hex");
	for (const branch of [f.manager.getBranch(), SessionManager.open(f.manager.getSessionFile()!).getBranch()]) {
		const changes = collectChanges(branch, f.cwd);
		assert.equal(changes.length, 1, JSON.stringify(changes));
		assert.equal(changes[0]!.operation, "write");
		assert.equal(changes[0]!.status, "succeeded");
		assert.equal(changes[0]!.receipt?.sha256, sha256, "the receipt matches the file's current state");
		const request = branch.find(entry => entry.type === "custom" && entry.customType === "codemode-tool-call-v1"
			&& (entry.data as any)?.call?.id === changes[0]!.toolCallId);
		assert.ok(request); assert.equal(changes[0]!.requestEntryId, request.id, "source is the persisted nested call, not the parent result");
	}
});

test("Codemode store checkpoint waits for final result hooks", async t => {
	const reject: InlineExtension = pi => { pi.on("tool_result", event => event.toolName === "codemode" && event.toolCallId === "script-1" ? { isError: true } : undefined); };
	const f = await fixture(t, {}, [reject]);
	const outcome = await f.run(['store("n",99)', 'text(load("n") === undefined)']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[1]?.content), /true/);
	assert.doesNotMatch(JSON.stringify(outcome.results[0]?.content), /CODEMODE_OK/);
	assert.equal(f.manager.getBranch().filter(e => e.type === "custom" && e.customType === CODEMODE_STORE_ENTRY).length, 0);
});

test("Codemode state restores after resource reload and navigation to an earlier branch", async t => {
	const f = await fixture(t);
	await f.run(['store("n",1)']);
	const first = f.manager.getLeafId()!;
	await f.run(['store("n",2)']);
	await f.session.reload();
	let outcome = await f.run(['text(load("n"))']);
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /"text":"2"/);
	await f.session.navigateTree(first);
	outcome = await f.run(['text(load("n"))']);
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /"text":"1"/);
});

test("actual Plan mode retains Codemode with read-only child authorization", async t => {
	const planning: InlineExtension = pi => planMode({ ...pi, getFlag: name => name === "plan" ? true : pi.getFlag(name) });
	const f = await fixture(t, {}, [planning]);
	const names = f.session.agent.state.modelTools!.map(tool => tool.name);
	assert.ok(names.includes("codemode"));
	assert.ok(names.includes("plan_mode_complete"));
	assert.equal(f.session.getActiveToolNames().includes("write"), false);
	const outcome = await f.run(['text((await tools.read({path:"file.txt"})).content)', 'try { await callTool("write",{path:"bad",content:"bad"}) } catch {}']);
	assert.equal(outcome.results[0]?.isError, false);
	assert.equal(outcome.results[1]?.isError, true);
	f.session.agent.streamFunction = () => {
		const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", usage: USAGE,
			content: [{ type: "text", text: "<proposed_plan>\nInspect the file, then verify the result.\n</proposed_plan>" }], stopReason: "stop", timestamp: 1 };
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	};
	await f.session.prompt("Present the plan.");
	await f.session.waitForIdle();
	assert.equal(f.session.messages.filter(m => m.role === "custom" && m.customType === "proposed-plan").length, 1,
		"the actual Plan settled handler must see admission-ready idle and publish its plan");
});

test("Goal/interaction controls remain model-only and cannot be called through a script", async t => {
	const controls: InlineExtension = pi => {
		for (const name of ["goal_complete", "goal_blocked", "plan_mode_question"]) pi.registerTool({ name, label: name, description: "control fixture", parameters: Type.Object({}), execute: async () => { throw new Error("control was invoked indirectly"); } });
	};
	const f = await fixture(t, {}, [controls]);
	const names = f.session.agent.state.modelTools!.map(tool => tool.name);
	for (const name of ["goal_complete", "goal_blocked", "plan_mode_question"]) assert.ok(names.includes(name));
	const outcome = await f.run(['try { await callTool("goal_complete",{}) } catch {}']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.doesNotMatch(JSON.stringify(outcome.results[0]?.content), /control was invoked indirectly/);
});

test("real MCP adapter preserves long instructions and ignores self-reported read concurrency", async t => {
	let runtime: any, active = 0, maximum = 0, calls = 0;
	const extension: InlineExtension = pi => {
		runtime = new McpBridgeRuntime(pi, "fixture");
		const state = { status: "connected", catalogReady: true, config: { id: "fixture", toolTimeoutMs: 1000 }, tools: new Map([["lookup", {}]]), client: {
			async callTool() { calls++; maximum = Math.max(maximum, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return { content: [{ type: "text", text: "native MCP result" }] }; }, async close() {} } };
		runtime.states.set("fixture", state);
		runtime.registerRemoteTool(state, { name: "lookup", description: "lookup instructions ".repeat(250) + "FINAL_MCP_INSTRUCTION", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } });
		pi.registerTool({ name: "mcp_search_tools", label: "search", description: "discovery fixture", parameters: Type.Object({}), execute: async () => {
			pi.setActiveTools([...pi.getActiveTools(), ...runtime.searchTools("lookup")]); return { content: [], details: {} };
		} });
		pi.on("session_shutdown", async () => { await runtime.close(); });
	};
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: 8000 } }, [extension]);
	t.after(() => runtime.close());
	f.session.setActiveToolsByName(["mcp_search_tools"]);
	const outcome = await f.run(['await tools.mcp_search_tools({}); const r=await Promise.all([callTool("mcp__fixture__lookup",{}),callTool("mcp__fixture__lookup",{})]);text(r[0].content);text(await describeTools(["mcp__fixture__lookup"]));']);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	assert.equal(calls, 2); assert.equal(maximum, 1);
	assert.match(JSON.stringify(outcome.results[0]?.content), /native MCP result/);
	assert.match(JSON.stringify(outcome.results[0]?.content), /FINAL_MCP_INSTRUCTION/);
	assert.ok(f.session.getAllTools().find(tool => tool.name === "mcp__fixture__lookup")!.description.length <= 1000);
	assert.equal(runtime.activeCalls.size, 0);
	const controller = (f.session as any)._codemode;
	const description = controller.definition.description;
	runtime.registerRemoteTool(runtime.states.get("fixture"), { name: "lookup", description: "lookup updated", inputSchema: {
		type: "object", properties: { revised: { type: "string" } }, required: ["revised"], additionalProperties: false } });
	assert.equal(controller.definition.description, description, "MCP schema refresh keeps the inline prefix stable");
	const updated = await f.run(['text(await describeTools(["mcp__fixture__lookup"]));', 'await callTool("mcp__fixture__lookup",{});']);
	assert.match(JSON.stringify(updated.results.at(-2)?.content), /revised/);
	assert.equal(updated.results.at(-1)?.isError, true, "current schema rejects stale arguments before the remote call");
	assert.equal(calls, 2);
});

test("mandatory Codemode rejects exclusion before creating resources", async () => {
	await assert.rejects(createAgentSession({ excludeTools: ["codemode"] }), /required default tool transport/);
});

test("Codemode exposes real browser instructions and constraints to the model without executing the browser", async t => {
	const { default: browserUse } = await jiti.import<{ default: InlineExtension }>("../packages/extensions/browser-use/index.ts");
	const f = await fixture(t, {}, [browserUse]);
	const outcome = await f.run(['text(await describeTools(["browser_exec"]));']);
	const text = outcome.results[0]!.content.filter(block => block.type === "text").map(block => block.text).join("\n");
	assert.equal(outcome.results[0]!.isError, false, text);
	assert.match(text, /Helpers are synchronous and pre-imported/);
	assert.match(text, /page_info\(\) requires a loaded document/);
	assert.match(text, /@maxLength 4000/);
	assert.match(text, /@integer @minimum 5000 @maximum 300000 @default 120000/);
	assert.match(text, /Promise<ToolResult>/);
	assert.match(text, /type ToolResult = .*ref: string/);
	assert.doesNotMatch(text, /More tool documentation/);
	assert.deepEqual((outcome.results[0]!.details as any).codemode.calls, []);
	assert.match(outcome.wires[0]!.tools!.find(tool => tool.name === "codemode")!.description, /Drive a real browser/);
});

test("inactive browser documentation guides discovery after reload without executing or widening access", async t => {
	let calls = 0;
	const f = await fixture(t, {}, [toolClassification, pi => {
		pi.registerTool({ name: "browser_exec", label: "Browser", description: "Browser fixture instructions",
			parameters: Type.Object({}), execute: async () => { calls++; return { content: [], details: {} }; } });
	}]);
	f.session.setActiveToolsByName(["tool_search"]);
	const described = await f.run(['text(await describeTools(["browser_exec"]));']);
	assert.match(JSON.stringify(described.results[0]?.content), /TOOL_UNAVAILABLE.*tool_search/);
	assert.equal(calls, 0);
	assert.equal(f.session.getActiveToolNames().includes("browser_exec"), false);
	const missing = await f.run(['await tools.browser_exec({});']);
	assert.match(JSON.stringify(missing.results.at(-1)?.content), /does not exist.*tool_search.*callTool/);
	assert.doesNotMatch(JSON.stringify(missing.results.at(-1)?.content), /Available:|Check for a member/);
	assert.equal(calls, 0);
	const recovered = await f.run(['await tools.tool_search({query:"browser_exec",limit:1});text(await describeTools(["browser_exec"]));await callTool("browser_exec",{});']);
	assert.equal(recovered.results.at(-1)?.isError, false, JSON.stringify(recovered.results));
	assert.match(JSON.stringify(recovered.results.at(-1)?.content), /Browser fixture instructions/);
	assert.equal(calls, 1);
	await f.session.reload();
	f.session.setActiveToolsByName(["tool_search"]);
	const reloaded = await f.run(['text(await describeTools(["browser_exec"]));']);
	assert.match(JSON.stringify(reloaded.results.at(-1)?.content), /TOOL_UNAVAILABLE/);
	assert.equal(calls, 1);
});

test("Codemode exposes the real DevTools task and browser-profile guidance after discovery", async t => {
	const definitions = await jiti.import<Record<string, any>>("../packages/chrome-devtools/src/tools.ts");
	const f = await fixture(t, {}, [toolClassification, pi => {
		for (const key of ["listPagesTool", "selectPageTool", "navigateTool", "evaluateTool", "screenshotTool"]) pi.registerTool(definitions[key]);
	}]);
	f.session.setActiveToolsByName(["tool_search"]);
	const outcome = await f.run(['text((await tools.tool_search({query:"browser_debug"})).details);',
		'text(await describeTools(["chrome_devtools_navigate","chrome_devtools_evaluate"]));']);
	assert.equal(outcome.results.at(-1)?.isError, false);
	const text = JSON.stringify(outcome.results.at(-1)?.content);
	assert.match(text, /local HTML\/localhost preview/);
	assert.match(text, /no manual enable command is required/);
	assert.match(text, /isolated browser profile/);
	assert.match(text, /Do not switch here to bypass incomplete Browser Harness approval/);
	assert.deepEqual((outcome.results.at(-1)?.details as any).codemode.calls, []);
});

test("Codemode documentation pages preserve long instructions and exact schemas without widening tool access", async t => {
	const description = "Long instructions. 🚀 ".repeat(2500) + "FINAL_REQUIRED_INSTRUCTION";
	const properties: Record<string, any> = {};
	for (let i = 0; i < 60; i++) properties[`field_${i}`] = { type: "string", description: "detail ".repeat(45), pattern: "a🚀".repeat(33), default: "𠮷🙂".repeat(25) };
	const tools: InlineExtension = pi => pi.registerTool({ name: "mcp__fixture__large", label: "large", description,
		parameters: { type: "object", properties, additionalProperties: false } as any,
		execute: async () => { throw new Error("Discovery must not execute a tool"); } });
	const f = await fixture(t, {}, [tools]);
	const outcome = await f.run([`
const names=["mcp__fixture__large"];
async function readPages(format) {
  let offset=0, body="", pages=0, maxPage=0, revision;
  while(true) {
    const page=await describeTools(names,{offset,limit:4000,format,revision});
    if(!page.isWellFormed()) throw new Error("page splits a Unicode surrogate pair");
    const header=/^\\[Tool documentation chars (\\d+)\\.\\.(\\d+) of (\\d+); format:\\w+; revision:([^\\]]+)\\]\\n/.exec(page);
    if(!header || Number(header[1])!==offset) throw new Error("bad page offset");
    revision=header[4];
    const end=Number(header[2]), total=Number(header[3]);
    body+=page.slice(header[0].length,header[0].length+end-offset);
    maxPage=Math.max(maxPage,page.length);pages++;
    if(end===total) break;
    if(end<=offset || !page.includes("offset:"+end)) throw new Error("missing continuation");
    offset=end;
  }
  const pair=body.indexOf("🚀");
  const overlap=await describeTools(names,{offset:pair+1,limit:256,format,revision});
  if(!overlap.startsWith("[Tool documentation chars "+pair+"..") || !overlap.isWellFormed()) throw new Error("mid-pair offset was not normalized");
  if(!overlap.slice(overlap.indexOf("\\n")+1).startsWith("🚀")) throw new Error("normalized page lost the first code point");
  return {body,pages,maxPage};
}
const ts=await readPages("typescript"), raw=await readPages("json");
const schema=JSON.parse(raw.body.split("Input JSON Schema:\\n")[1].split("\\nResult: ToolResult")[0]);
text({tail:ts.body.includes("FINAL_REQUIRED_INSTRUCTION"),unknown:ts.body.includes("args: unknown"),
 fields:Object.keys(schema.properties).length,pattern:schema.properties.field_59.pattern,defaultValue:schema.properties.field_59.default,
 rockets:ts.body.split("🚀").length-1,
 pages:ts.pages,maxPage:Math.max(ts.maxPage,raw.maxPage),
 hidden:await describeTools(["not_registered","ask_user","codemode"])});
`]);
	assert.equal(outcome.results[0]!.isError, false, JSON.stringify(outcome.results[0]!.content));
	const block = outcome.results[0]!.content.find(block => block.type === "text" && block.text.startsWith('{"tail"'));
	assert.ok(block?.type === "text");
	const data = JSON.parse(block.text);
	assert.equal(data.tail, true); assert.equal(data.unknown, true);
	assert.equal(data.fields, 60); assert.equal(data.pattern, "a🚀".repeat(33));
	assert.equal(data.defaultValue, "𠮷🙂".repeat(25)); assert.equal(data.rockets, 2500);
	assert.ok(data.pages > 10); assert.ok(data.maxPage < 4300); assert.match(data.hidden, /TOOL_UNAVAILABLE/);
	assert.doesNotMatch(data.hidden, /not_registered|ask_user|Input JSON Schema/);
	assert.deepEqual((outcome.results[0]!.details as any).codemode.calls, []);
});

test("Codemode documentation rejects mixed MCP revisions and requires a continuation token", async t => {
	let runtime: any;
	const extension: InlineExtension = pi => {
		runtime = new McpBridgeRuntime(pi, "fixture");
		const state = { config: { id: "fixture" } };
		const register = (name: string) => runtime.registerRemoteTool(state, { name: "lookup", description: "paged metadata",
			inputSchema: { type: "object", properties: { [name]: { type: "string", description: "detail ".repeat(200) } } } });
		register("cached");
		pi.registerTool({ name: "refresh_catalog", label: "Refresh fixture", description: "replace cached MCP schema",
			parameters: Type.Object({}), execute: async () => { register("live"); return { content: [], details: {} }; } });
	};
	const f = await fixture(t, {}, [extension]);
	t.after(() => runtime.close());
	const outcome = await f.run([`
const names=["mcp__fixture__lookup"], options={format:"json",limit:256};
const first=await describeTools(names,options), revision=/; revision:([^\\]]+)\\]/.exec(first)[1];
await tools.refresh_catalog({});
try { await describeTools(names,{...options,offset:256,revision}); throw new Error("mixed revisions accepted"); }
catch(e) { if(!String(e).includes("TOOL_DOCUMENTATION_CHANGED")) throw e; text("stale revision rejected"); }
try { await describeTools(names,{...options,offset:256}); throw new Error("missing revision accepted"); }
catch(e) { if(!String(e).includes("continuation requires")) throw e; text("missing revision rejected"); }
const fresh=await describeTools(names,{format:"json",limit:8000});
if(/; revision:([^\\]]+)\\]/.exec(fresh)[1]===revision) throw new Error("revision did not change");
text(JSON.parse(fresh.split("Input JSON Schema:\\n")[1].split("\\nResult: ToolResult")[0]));
`]);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	const text = JSON.stringify(outcome.results[0]?.content);
	assert.match(text, /stale revision rejected/); assert.match(text, /missing revision rejected/);
	assert.match(text, /live/); assert.doesNotMatch(text, /cached/);
});

test("Codemode JSON pagination serializes each selected schema once and releases its snapshot", async t => {
	let schemaReads = 0;
	const names: string[] = [];
	const extension: InlineExtension = pi => {
		for (let i = 0; i < 16; i++) {
			const name = `mcp__paged__tool_${i}`;
			names.push(name);
			const properties = { value: { type: "string", description: "x".repeat(60_000) } };
			pi.registerTool({ name, label: name, description: "large schema fixture",
				parameters: { type: "object", get properties() { schemaReads++; return properties; } } as any,
				execute: async () => { throw new Error("Metadata lookup must not execute a tool"); } });
		}
	};
	const f = await fixture(t, {}, [extension]);
	const owner = (f.session as any)._codemode;
	schemaReads = 0;
	const first = await f.run([`const p=await describeTools(${JSON.stringify(names)},{format:"json"});store("revision",/; revision:([^\\]]+)\\]/.exec(p)[1]);`]);
	assert.equal(first.results[0]!.isError, false);
	assert.equal(schemaReads, 16);
	const rest = await f.run([`
let offset=8000, pages=1;
while(true) {
  const page=await describeTools(${JSON.stringify(names)},{format:"json",offset,revision:load("revision")});
  const h=/chars (\\d+)\\.\\.(\\d+) of (\\d+);/.exec(page);
  if(Number(h[1])!==offset || Number(h[2])<=offset) throw new Error("bad continuation");
  pages++;
  if(h[2]===h[3]) break;
  offset=Number(h[2]);
}
text("pages:"+pages);
`]);
	assert.equal(rest.results[0]!.isError, false, JSON.stringify(rest.results));
	assert.equal(schemaReads, 16, "continuations must not reserialize preceding or following schemas");
	assert.equal(owner.documentationSnapshot, undefined, "the final page releases serialized schemas");
	await f.run([`await describeTools(${JSON.stringify(names)},{format:"json",limit:256});`]);
	assert.ok(owner.documentationSnapshot);
	f.session.setActiveToolsByName([names[0]!]);
	assert.equal(owner.documentationSnapshot, undefined, "catalog changes release the snapshot");
	await f.run([`await describeTools([${JSON.stringify(names[0])}],{format:"json",limit:256});`]);
	assert.ok(owner.documentationSnapshot);
	await f.run(['throw new Error("stop fixture")']);
	assert.equal(owner.documentationSnapshot, undefined, "failed scripts release the snapshot");
	await f.run([`await describeTools([${JSON.stringify(names[0])}],{format:"json",limit:256});`]);
	assert.ok(owner.documentationSnapshot);
	await owner.close();
	assert.equal(owner.documentationSnapshot, undefined, "close releases the snapshot");
});

test("Codemode inline and catalog summaries preserve Unicode at both cutoffs", async () => {
	const owner = new CodemodeController(() => {});
	const description = "a".repeat(255) + "🚀" + "b".repeat(642) + "𠮷" + "c".repeat(200);
	try {
		owner.setTools([{ name: "unicode_fixture", label: "Unicode", description, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }]);
		assert.equal(Buffer.from(owner.definition.description).toString("utf8"), owner.definition.description, "inline purpose must survive UTF-8 at 256");
		const summary = (owner as any).descriptors[0].description;
		assert.equal(Buffer.from(summary).toString("utf8"), summary, "catalog summary must survive UTF-8 at 900");
		assert.match(summary, /Summary only/);
		assert.equal(summary.slice(0, summary.indexOf("\n")).length, 899);
	} finally { await owner.close(); }
});

test("Codemode documentation rejects continuation after identifier collisions change aliases", async t => {
	const extension: InlineExtension = pi => {
		for (const name of ["foo-bar", "foo_bar"]) pi.registerTool({ name, label: name, description: "detail ".repeat(250),
			parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
		pi.registerTool({ name: "activate_fixture", label: "Activate fixture", description: "activate an already registered collision",
			parameters: Type.Object({}), execute: async () => { pi.setActiveTools([...pi.getActiveTools(), "foo_bar"]); return { content: [], details: {} }; } });
	};
	const f = await fixture(t, {}, [extension]);
	f.session.setActiveToolsByName(["foo-bar", "activate_fixture"]);
	const outcome = await f.run([`
const names=["foo-bar"];
const first=await describeTools(names,{limit:256}), revision=/; revision:([^\\]]+)\\]/.exec(first)[1];
await tools.activate_fixture({});
try { await describeTools(names,{offset:256,limit:256,revision}); throw new Error("mixed aliases accepted"); }
catch(e) { if(!String(e).includes("TOOL_DOCUMENTATION_CHANGED")) throw e; text("mapping revision rejected"); }
text(await describeTools(names));
`]);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	assert.match(JSON.stringify(outcome.results[0]?.content), /mapping revision rejected/);
	assert.match(JSON.stringify(outcome.results[0]?.content), /foo_bar_2\(args:/);
});

test("MCP activation keeps inline declarations stable; overflow remains explicitly discoverable", async () => {
	const owner = new CodemodeController(() => {});
	let schemaVisits = 0;
	const schema = Type.Object({});
	Object.defineProperty(schema, "properties", { get() { schemaVisits++; return {}; } });
	const local = { name: "local", label: "local", description: "local", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) };
	try {
		owner.setTools([local]);
		const description = owner.definition.description;
		owner.setTools([local, { ...local, name: "mcp__fixture__remote", parameters: schema }]);
		assert.equal(owner.definition.description, description);
		assert.equal(schemaVisits, 0, "deferred remote schemas are not rendered just to omit them");
		const largeSchema = Type.Object({ value: Type.Union(Array.from({ length: 70 }, (_, index) => Type.Literal(`long_literal_${index}`))) });
		owner.setTools(Array.from({ length: 100 }, (_, index) => ({ ...local, name: `tool_${index}`, parameters: largeSchema })));
		assert.ok(owner.definition.description.length < 32768);
		assert.match(owner.definition.description, /\d+ local declarations omitted.*ALL_TOOLS/);
	} finally {
		await owner.close();
		assert.equal((owner as any).identifiers.size, 0, "closed controllers release the catalog name maps");
		assert.equal((owner as any).identifierNames.size, 0);
		assert.doesNotMatch(owner.definition.description, /tool_\d+/);
	}
});

test("controller releases catalog metadata even when sandbox shutdown rejects", async () => {
	const owner = new CodemodeController(() => {});
	owner.setTools([{ name: "catalog_cleanup", label: "cleanup", description: "cleanup", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }]);
	const failure = new Error("fixture shutdown failure");
	(owner as any).documentationSnapshot = { revision: "fixture", schemas: ["retained schema"] };
	(owner as any).sandbox = { close: async () => { throw failure; } };
	await assert.rejects(owner.close(), error => error === failure);
	assert.equal((owner as any).sandbox, undefined);
	assert.equal((owner as any).tools.length, 0);
	assert.equal((owner as any).descriptors.length, 0);
	assert.equal((owner as any).identifiers.size, 0);
	assert.equal((owner as any).identifierNames.size, 0);
	assert.equal((owner as any).documentationSnapshot, undefined);
	assert.doesNotMatch(owner.definition.description, /catalog_cleanup/);
	await owner.close();
});

test("disposed sessions release wrapped declarations and ignore late catalog callbacks", async t => {
	const f = await fixture(t, { tools: ["read"] });
	const owner = (f.session as any)._codemode;
	await f.run(['await describeTools(["read"]);']);
	const describedTool = f.session.agent.state.tools.find(tool => tool.name === "read")!;
	assert.ok(owner.documentationVersions.has(describedTool));
	const previousTools = owner.tools;
	const wrapper = (f.session as any)._toolRegistry.get("codemode");
	assert.ok(wrapper.description.length > CODEMODE_DESCRIPTION.length);
	f.session.dispose(); await owner.close();
	assert.equal(owner.documentationVersions.has(describedTool), false, "closed owner clears documentation revision identities");
	assert.equal(owner.documentationRevisionPrefix, undefined);
	assert.equal(wrapper.description, CODEMODE_DESCRIPTION);
	assert.equal(f.session.agent.state.tools.find(tool => tool.name === "codemode")!.description, CODEMODE_DESCRIPTION);
	assert.equal(f.session.agent.state.modelTools!.find(tool => tool.name === "codemode")!.description, CODEMODE_DESCRIPTION);
	await new Promise(resolve => setImmediate(resolve));
	f.session.setActiveToolsByName(["read"]);
	(f.session as any)._refreshToolRegistry({ activeToolNames: ["read"] });
	owner.setTools(previousTools);
	assert.equal(owner.tools.length, 0);
	assert.equal(owner.descriptors.length, 0);
	assert.equal(owner.identifiers.size + owner.identifierNames.size, 0);
	assert.equal(owner.definition.description, CODEMODE_DESCRIPTION);
	assert.equal((f.session as any)._toolRegistry.get("codemode"), wrapper);
});

test("grammar and JSON models use the same Codemode runtime", async t => {
	const definition = { name: "codemode", description: "execute", parameters: CODEMODE_PARAMETERS, constrainedSampling: CODEMODE_SAMPLING };
	assert.equal(convertResponsesTools([definition], { supportsOpenAIGrammarTools: true })[0]?.type, "custom");
	assert.equal(convertResponsesTools([definition], { supportsOpenAIGrammarTools: false })[0]?.type, "function");
	const f = await fixture(t, { tools: ["read"] });
	const result = await f.run(['text((await tools.read({path:"file.txt"})).content)'], undefined, true);
	assert.equal(result.results[0]?.isError, false);
});

for (const boundary of ["truncated", "changed-file", "context-filter", "payload-unproven"] as const) test(`read evidence rejects ${boundary}`, async t => {
	const filter: InlineExtension = pi => pi.on("context", event => ({ messages: event.messages.filter(m => m.role !== "toolResult") }));
	const f = await fixture(t, { tools: ["read", "edit"] }, boundary === "context-filter" ? [mutation, filter] : [mutation]);
	if (boundary === "truncated") writeFileSync(join(f.cwd, "file.txt"), "hello\n" + "visible-data\n".repeat(500));
	let requests = 0;
	const outcome = await f.run([
		(boundary === "truncated" ? '// @options: {"max_output_tokens":256}\n' : '') + 'await show((await tools.read({path:"file.txt"})).ref)',
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"bad"}]})',
	], () => {
		if (++requests !== 2) return;
		if (boundary === "changed-file") writeFileSync(join(f.cwd, "file.txt"), "hello\nchanged externally\n");
		if (boundary === "payload-unproven") f.session.discardPendingToolResultBudgetSources();
	});
	assert.equal(outcome.results[1]?.isError, true, JSON.stringify(outcome.results));
	assert.ok(readFileSync(join(f.cwd, "file.txt"), "utf8").startsWith("hello\n"));
});

test("read evidence needs the shown block at its own position, not an equal copy elsewhere", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	writeFileSync(join(f.cwd, "file.txt"), "hello\n" + "visible-data\n".repeat(300));
	const outcome = await f.run([
		'// @options: {"max_output_tokens":1800}\nconst r=await tools.read({path:"file.txt"}); text(r.content[0].text); await show(r.ref)',
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"bad"}]})',
	]);
	const parent = outcome.results[0]!.content as Array<{ type: string; text: string }>;
	// Precondition: the printed copy survives intact while the native shown block is truncated.
	assert.ok(parent[2]!.text.length < parent[1]!.text.length && parent[1]!.text.startsWith(parent[2]!.text), JSON.stringify(parent.map(b => b.text.length)));
	assert.match(parent.at(-1)!.text, /Codemode output truncated/);
	assert.equal(outcome.results[1]?.isError, true, JSON.stringify(outcome.results[1]));
	assert.match(JSON.stringify(outcome.results[1]), /READ_REQUIRED/);
	assert.ok(readFileSync(join(f.cwd, "file.txt"), "utf8").startsWith("hello\n"));
});

test("shown reads from every Codemode call in one assistant batch stay admissible", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	const outcome = await f.run([
		['await show((await tools.read({path:"file.txt"})).ref)', 'text("second call in the same batch")'],
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"changed"}]})',
	]);
	assert.equal(outcome.results.length, 3);
	assert.equal(outcome.results[2]?.isError, false, JSON.stringify(outcome.results[2]));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "changed\nworld\n");
});

for (const tampered of [false, true]) test(`an admitted Codemode read ${tampered ? "with a tampered receipt is not" : "is"} restored after reload`, async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	await f.run(['await show((await tools.read({path:"file.txt"})).ref)', 'text("admits the displayed read")']);
	const saved = f.manager.getBranch().filter(e => e.type === "custom" && e.customType === "codemode-read-evidence-v1") as any[];
	assert.equal(saved.length, 1);
	// The producer binding names the original nested call; a receipt re-pointed elsewhere must fail closed.
	if (tampered) saved[0].data.toolCallId = `${saved[0].data.parentToolCallId}:nested:99`;
	// Reload emits session_start only for a bound host, as in interactive and RPC modes.
	const errors: unknown[] = [];
	await f.session.bindExtensions({ onError: error => errors.push(error) });
	await f.session.reload();
	assert.deepEqual(errors, []);
	const outcome = await f.run(['await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"edited"}]})']);
	assert.equal(outcome.results.at(-1)?.isError, tampered, JSON.stringify(outcome.results.at(-1)));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), tampered ? "hello\nworld\n" : "edited\nworld\n");
});

test("a nested tool that ignores cancellation cannot wedge Codemode past its deadline", async t => {
	let owner: any;
	const hang: InlineExtension = pi => pi.registerTool({ name: "hang", label: "hang", description: "ignores abort ".repeat(100), parameters: Type.Object({}),
		execute: () => { assert.ok(owner.documentationSnapshot); return new Promise<never>(() => {}); } });
	const f = await fixture(t, {}, [hang]);
	owner = (f.session as any)._codemode;
	const started = Date.now();
	const outcome = await f.run(['// @options: {"timeout_ms":200}\nawait describeTools(["hang"],{limit:256});await tools.hang({})']);
	assert.ok(Date.now() - started < 15_000, "bounded by the timeout plus the cancellation grace period");
	const parent = outcome.results[0]!;
	assert.equal(parent.isError, true);
	assert.match(JSON.stringify(parent.content), /CODEMODE_TIMEOUT/);
	assert.match(JSON.stringify(parent.content), /NESTED_TOOL_ABANDONED\] 1 child call/);
	assert.equal(owner.documentationSnapshot, undefined, "deadline cancellation releases pending documentation");
});

test("Codemode image files remain addressable after a completed script and session reopen", async t => {
	const f = await fixture(t, { tools: ["read"] }, [], false, true);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
	const first = await f.run([`image("data:image/png;base64,${png}"); image("data:image/png;base64,${png}")`]);
	const parent = first.results[0]!;
	const files = (parent.details as any).codemode.imageFiles;
	assert.equal(typeof files?.manifestPath, "string", "completed image output needs a later-turn file reference");
	const manifest = JSON.parse(readFileSync(files.manifestPath, "utf8"));
	assert.equal(manifest.images.length, 2);
	assert.equal(manifest.images[0].path, manifest.images[1].path);
	assert.deepEqual(readFileSync(manifest.images[0].path), Buffer.from(png, "base64"));
	assert.equal(parent.content.filter(b => b.type === "image").length, 2);
	assert.ok(parent.content.some(b => b.type === "text" && b.text.includes(files.manifestPath)));
	const reopened = SessionManager.open(f.manager.getSessionFile()!);
	assert.ok(reopened.buildSessionContext().messages.some(m => m.role === "toolResult" && m.content.some(b => b.type === "text" && b.text.includes(files.manifestPath))));
	const later = await f.run([`await show((await tools.read({path:${JSON.stringify(files.manifestPath)}})).ref)`]);
	assert.equal(later.results.at(-1)!.isError, false);
	assert.ok(later.results.at(-1)!.content.some(b => b.type === "text" && b.text.includes("1.png")));
});

for (const budgetTokens of [512, 1024]) test(`Codemode image manifest remains visible after projecting long child facts: ${budgetTokens}`, async t => {
	const failure: InlineExtension = pi => pi.registerTool({ name: "failure", label: "failure", description: "fixture", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "failure details ".repeat(100) }], isError: true, details: {} }) });
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens } }, [failure]);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
	const outcome = await f.run([`// @options: {"max_output_tokens":8192}\nfor(let i=0;i<8;i++) { try { await tools.failure({}); } catch {} } image("data:image/png;base64,${png}"); text("trailing output ".repeat(800))`]);
	const parent = outcome.results[0]!, files = (parent.details as any).codemode.imageFiles;
	assert.ok(parent.content.some(b => b.type === "text" && b.text === "trailing output ".repeat(800)), "the script cap must not have truncated first");
	const visible = outcome.wires[1]!.messages.find(m => m.role === "toolResult")!.content;
	assert.ok(visible.some(b => b.type === "text" && b.text.includes(files.manifestPath)), "next model turn needs the complete manifest path");
	const later = await f.run([`await show((await tools.read({path:${JSON.stringify(files.manifestPath)}})).ref)`]);
	assert.equal(later.results.at(-1)!.isError, false);
});

test("Codemode image file errors preserve completed tools and attachments under a small output budget", async t => {
	let executions = 0;
	const extension: InlineExtension = pi => pi.registerTool({ name: "effect", label: "effect", description: "fixture", parameters: Type.Object({}),
		execute: async () => { executions++; return { content: [{ type: "text", text: "completed" }], details: {} }; } });
	const f = await fixture(t, {}, [extension]);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
	const open = privateOutputFileSystem.openSync;
	privateOutputFileSystem.openSync = () => { throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" }); };
	try {
		const outcome = await f.run([`// @options: {"max_output_tokens":256}\nawait tools.effect({});text("x".repeat(2000));image("data:image/png;base64,${png}")`]);
		const result = outcome.results[0]!;
		assert.equal(executions, 1);
		assert.equal(result.isError, false, "optional file failures must not change the completed script status");
		assert.equal(result.content.filter(b => b.type === "image").length, 1);
		assert.ok(result.content.some(b => b.type === "text" && b.text.includes("disk full")));
	} finally { privateOutputFileSystem.openSync = open; }
	const failed = await f.run([`image("data:image/png;base64,${png}");throw new Error("after-image")`]);
	const result = failed.results.at(-1)!;
	assert.equal(result.isError, true);
	assert.equal((result.details as any).codemode.imageFiles.saved, 1);
	assert.equal(executions, 1);
});

test("Codemode keeps a long manifest notice whole in the next model projection", async t => {
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: 512 } });
	const deep = join(f.cwd, ...Array.from({ length: 4 }, (_, i) => `${i}-` + "a0b1c2d3".repeat(10)));
	mkdirSync(deep, { recursive: true });
	isolateTemporaryFiles(t, toNamespacedPath(deep));
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
	const outcome = await f.run([`// @options: {"max_output_tokens":8192}\nimage("data:image/png;base64,${png}"); text("a0b1c2d3".repeat(1000))`]);
	const files = (outcome.results[0]!.details as any).codemode.imageFiles;
	assert.ok(files.manifestPath);
	const visible = outcome.wires[1]!.messages.find(m => m.role === "toolResult")!.content;
	assert.ok(visible.some(b => b.type === "text" && b.text.includes(files.manifestPath)), "whole path fits overall budget but exceeds the default retained head");
});

test("Codemode text and console boundaries survive actual provider message conversion", async t => {
	const f = await fixture(t, { tools: ["read"] });
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
	const { wires, results } = await f.run([
		'text("alpha"); text(""); console.log("beta", {n:2}); text("line1\\nline2"); return "omega"',
		`text("before-image"); image("data:image/png;base64,${png}"); console.warn("after-image"); text("")`,
		'text("before-error"); console.error("diagnostic"); throw new Error("boundary-stop")',
	]);
	assert.equal(results.length, 3);
	assert.deepEqual(results.map(r => r.isError), [false, false, true]);
	const context = wires.at(-1)!;
	const source = context.messages.filter(m => m.role === "toolResult");
	assert.equal(source.length, 3);
	const texts = source.map(m => m.content.filter(b => b.type === "text").map(b => b.text));
	assert.deepEqual(texts[0], ["[CODEMODE_OK] Child calls: 0.", "alpha", "", 'beta {"n":2}', "line1\nline2", "omega"]);
	assert.deepEqual(source[1]!.content.slice(0, 5).map(b => b.type), ["text", "text", "image", "text", "text"]);
	assert.ok(texts[1]![0]!.startsWith("[CODEMODE_OK] Child calls: 0.\n[Image files:"));
	assert.deepEqual(texts[1]!.slice(1), ["before-image", "after-image", ""]);
	assert.deepEqual(texts[2]!.slice(1), ["before-error", "diagnostic", "[CODEMODE_SCRIPT] boundary-stop"]);
	const before = structuredClone(context.messages);
	const adapters: [Api, StreamFunction<any, SimpleStreamOptions>, string, Record<string, unknown>?][] = [
		["anthropic-messages", streamAnthropic, "claude-sonnet-4-5"],
		["openai-completions", streamChat, "gpt-5"],
		["openai-responses", streamResponses, "gpt-5"],
		["azure-openai-responses", streamAzure, "deployment"],
		["openai-codex-responses", streamCodex, "gpt-5-codex", { transport: "sse" }],
		["google-generative-ai", streamGoogle, "gemini-3-flash-preview"],
		["google-vertex", streamVertex, "gemini-3-flash-preview", { project: "fixture", location: "us-central1" }],
		["mistral-conversations", streamMistral, "mistral-large"],
		["bedrock-converse-stream", streamBedrock, "anthropic.claude-3-7-sonnet", { env: { AWS_REGION: "us-east-1" } }],
		["pi-messages", streamPi, "pi-model"],
	];
	for (const [api, stream, id, options] of adapters) await t.test(api, async () => {
		const model: Model<Api> = { ...MODEL, api, id, input: ["text", "image"],
			provider: api === "openai-codex-responses" ? "openai-codex" : "fixture",
			capabilities: { ...conservativeModelCapabilities(), toolCalling: true, parallelTools: true } };
		let payload: any;
		const stopped = await stream(model, context, {
			apiKey: api === "openai-codex-responses" ? `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }))}.signature` : "fixture-key",
			env: {}, ...options,
			onPayload(value) { payload = value; throw new Error("codemode boundary payload captured"); },
		}).result();
		assert.ok(payload, stopped.errorMessage);
		assert.match(stopped.errorMessage ?? "", /codemode boundary payload captured/);
		let converted: (string | any[])[];
		let images: string[];
		let expectedImage = png;
		switch (api) {
			case "anthropic-messages":
				converted = payload.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.content) : []);
				images = (converted[1] as any[]).filter(b => b.type === "image").map(b => b.source.data);
				break;
			case "openai-completions":
				converted = payload.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
				images = payload.messages.flatMap((m: any) => m.role === "user" && Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "image_url").map((b: any) => b.image_url.url) : []);
				expectedImage = `data:image/png;base64,${png}`;
				break;
			case "openai-responses": case "azure-openai-responses": case "openai-codex-responses":
				converted = payload.input.filter((m: any) => m.type === "function_call_output" || m.type === "custom_tool_call_output").map((m: any) => m.output);
				images = (converted[1] as any[]).filter(b => b.type === "input_image").map(b => b.image_url);
				expectedImage = `data:image/png;base64,${png}`;
				break;
			case "google-generative-ai": case "google-vertex":
				converted = payload.contents.flatMap((m: any) => m.parts.filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse.response.output ?? p.functionResponse.response.error));
				images = payload.contents.flatMap((m: any) => m.parts.flatMap((p: any) => (p.functionResponse?.parts ?? []).filter((b: any) => b.inlineData).map((b: any) => b.inlineData.data)));
				break;
			case "mistral-conversations":
				converted = payload.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content[0].text);
				images = payload.messages.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content.filter((b: any) => b.type === "image_url").map((b: any) => b.imageUrl));
				expectedImage = `data:image/png;base64,${png}`;
				break;
			case "bedrock-converse-stream":
				converted = payload.messages.flatMap((m: any) => m.content.filter((b: any) => b.toolResult).map((b: any) => b.toolResult.content));
				images = (converted[1] as any[]).filter(b => b.image).map(b => Buffer.from(b.image.source.bytes).toString("base64"));
				break;
			case "pi-messages":
				converted = payload.context.messages.filter((m: any) => m.role === "toolResult").map((m: any) => m.content);
				images = (converted[1] as any[]).filter(b => b.type === "image").map(b => b.data);
				break;
			default: assert.fail(`Unverified API ${api}`);
		}
		assert.deepEqual(images, [expectedImage], "converted mixed output must retain exactly one image with its original data");
		assert.equal(converted.length, source.length);
		for (let index = 0; index < converted.length; index++) {
			const value = converted[index]!;
			const expected = texts[index]!;
			if (typeof value === "string") {
				const joined = expected.join("\n");
				assert.equal(value, api === "mistral-conversations" ? (source[index]!.isError ? "[tool error] " : "") + joined.trim() : joined);
			} else {
				const blocks = value.filter(b => typeof b.text === "string").map(b => b.text);
				const joined = api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses";
				assert.deepEqual(blocks, joined ? [expected.join("\n")] : api === "bedrock-converse-stream" ? expected.filter(s => s.trim()) : expected);
			}
		}
		assert.deepEqual(context.messages, before, "conversion must not wrap or mutate retained Codemode history");
	});
});

test("unknown tool guidance supports catalog lookup and awaited schemas in a live Codemode session", async t => {
	const f = await fixture(t, { tools: ["read"] });
	const { results } = await f.run([
		"await tools.readFile({})",
		'const tool = ALL_TOOLS.find(t => t.name === "read"); text(await describeTools([tool.name])); text((await tools[tool.name]({path:"file.txt"})).content[0].text); text(typeof searchTools)',
	]);
	assert.equal(results.length, 2);
	assert.equal(results[0]!.isError, true);
	const error = JSON.stringify(results[0]!.content);
	assert.match(error, /ALL_TOOLS/);
	assert.match(error, /await describeTools\(\[names\]\)/);
	assert.doesNotMatch(error, /searchTools/);
	assert.deepEqual((results[0]!.details as any).codemode.calls, []);
	assert.equal(results[1]!.isError, false, JSON.stringify(results[1]));
	const recovered = JSON.stringify(results[1]!.content);
	assert.match(recovered, /read\(args:/);
	assert.match(recovered, /hello/);
	assert.match(recovered, /undefined/);
});

test("built-in patch attempts preserve live Codemode discovery, reads and committed state", async t => {
	const f = await fixture(t, { tools: ["read"] });
	const { results } = await f.run([
		'Array.prototype.toJSON = () => null; Object.prototype.toJSON = () => 5; text(await describeTools(["read"])); await show((await callTool("read", {path:"file.txt"})).ref); store("kept", [7])',
		'"use strict"; store("lost", 1); Array.prototype.toJSON = () => null',
		'text(load("kept")); text(load("lost"))',
	]);
	assert.equal(results.length, 3);
	assert.equal(results[0]!.isError, false, JSON.stringify(results[0]));
	assert.match(JSON.stringify(results[0]!.content), /read\(args:/);
	assert.match(JSON.stringify(results[0]!.content), /hello/);
	assert.equal(results[1]!.isError, true);
	assert.match(JSON.stringify(results[1]!.content), /CODEMODE_SCRIPT/);
	assert.equal(results[2]!.isError, false, JSON.stringify(results[2]));
	assert.deepEqual(results[2]!.content.slice(1), [{ type: "text", text: "[7]" }, { type: "text", text: "undefined" }]);
});

test("colliding tool names get distinct declared identifiers that scripts and describeTools accept", async t => {
	const tools: InlineExtension = pi => {
		for (const name of ["foo-bar", "foo_bar"]) pi.registerTool({ name, label: name, description: `fixture ${name}`, parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: `ran ${name}` }], details: {} }) });
	};
	const f = await fixture(t, {}, [tools]);
	const outcome = await f.run(['text(await describeTools(["foo_bar_2"])); text((await tools.foo_bar_2({})).content[0].text); text((await tools.foo_bar({})).content[0].text)']);
	const declared = outcome.wires[0]!.tools!.find(tool => tool.name === "codemode")!.description;
	assert.match(declared, /\nfoo_bar\(args/);
	assert.match(declared, /\nfoo_bar_2\(args/);
	const text = JSON.stringify(outcome.results[0]?.content);
	assert.equal(outcome.results[0]?.isError, false, text);
	assert.match(text, /fixture foo-bar/);
	assert.match(text, /ran foo-bar/);
	assert.match(text, /ran foo_bar/);
});

test("a shown read answered by a final text response is persisted before reload", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	// The run ends with the model's text answer; no later tool call admits the read.
	await f.run(['await show((await tools.read({path:"file.txt"})).ref)']);
	assert.equal(f.manager.getBranch().filter(e => e.type === "custom" && e.customType === "codemode-read-evidence-v1").length, 1);
	// Reload emits session_start only for a bound host, as in interactive and RPC modes.
	const errors: unknown[] = [];
	await f.session.bindExtensions({ onError: error => errors.push(error) });
	await f.session.reload();
	assert.deepEqual(errors, []);
	const outcome = await f.run(['await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"edited"}]})']);
	assert.equal(outcome.results.at(-1)?.isError, false, JSON.stringify(outcome.results.at(-1)));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "edited\nworld\n");
});

test("the long-running subagent tool stays directly declared instead of being forced into Codemode", async t => {
	const f = await fixture(t, {}, [], true);
	const subagent = f.session.agent.state.tools.find(tool => tool.name === "subagent");
	assert.ok(subagent, "bundled subagent extension registers its tool");
	assert.equal(subagent.modelOnly, true);
	assert.equal(subagent.modelExposure, undefined);
	assert.ok(f.session.agent.state.modelTools?.includes(subagent), "declared to the provider directly");
	const outcome = await f.run(['await callTool("subagent", {agent:"scout", task:"x"})']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]?.content), /direct model call/);
});

test("a Codemode read whose parent result sits just before the retained tail is still restored", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	await f.run(['await show((await tools.read({path:"file.txt"})).ref)']);
	let branch = f.manager.getBranch();
	const marker = branch.findIndex(e => e.type === "custom" && e.customType === "codemode-read-evidence-v1");
	const parent = branch.findIndex(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "codemode");
	assert.ok(parent >= 0 && parent < marker);
	// Restoration keeps the last 512 entries: place the marker first in that tail, its parent outside.
	for (let fill = marker + 512 - branch.length; fill > 0; fill--) f.manager.appendCustomEntry("restore-window-filler", {});
	branch = f.manager.getBranch();
	assert.equal(branch.length - 512, marker);
	const errors: unknown[] = [];
	await f.session.bindExtensions({ onError: error => errors.push(error) });
	await f.session.reload();
	assert.deepEqual(errors, []);
	const outcome = await f.run(['await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"edited"}]})']);
	assert.equal(outcome.results.at(-1)?.isError, false, JSON.stringify(outcome.results.at(-1)));
});

test("screenshot-sized images survive Codemode bounding and are shown whole beside spilled text", async t => {
	const shot: InlineExtension = pi => pi.registerTool({ name: "shot", label: "shot", description: "large text plus an image",
		parameters: Type.Object({ size: Type.Integer() }),
		// `size` is the base64 length: a PNG signature padded to size * 3 / 4 bytes.
		execute: async (_id, params: { size: number }) => {
			const bytes = Buffer.alloc(params.size / 4 * 3);
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
			return { content: [{ type: "text", text: "log ".repeat(50_000) },
				{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }], details: {} };
		} });
	const f = await fixture(t, {}, [shot]);
	const outcome = await f.run([
		'const small=await tools.shot({size:4096}); text(small.content.map(b=>b.type).join()); image(small.content[1]);' +
		'const big=await tools.shot({size:2*1024*1024}); text(big.content[1].text); await show(big.ref)']);
	const parent = outcome.results[0]!;
	assert.equal(parent.isError, false, JSON.stringify(parent.content).slice(0, 2000));
	const texts = parent.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n");
	assert.match(texts, /text,image/, "a small image stays attachable from inside the script");
	assert.match(texts, /image\/png \(2097152 base64 chars\) held by the host; attach it with await show/);
	assert.match(texts, /Codemode bounded result/);
	const images = parent.content.filter(block => block.type === "image").map(block => (block as { data: string }).data.length);
	assert.deepEqual(images, [4096, 2 * 1024 * 1024]);
});

test("the Codemode gateway cannot be excluded, and a registry without it leaves ordinary tools directly declared", async t => {
	// Rejected before any directory, loader or session is created.
	await assert.rejects(createAgentSession({ excludeTools: ["codemode"] }), /required default tool transport/);
	const f = await fixture(t);
	// A directly constructed AgentSession can still pass excludedToolNames; ordinary tools must stay reachable.
	(f.session as any)._excludedToolNames = new Set(["codemode"]);
	(f.session as any)._refreshToolRegistry({ activeToolNames: ["read", "bash", "edit"] });
	(f.session as any)._providerRequestPayloadBuilder = (input: any) => ({ tools: input.tools.map((tool: any) => tool.name) });
	const preview = await f.session.buildProviderRequestPayload({ messages: [], systemPrompt: "fixture" });
	const declared = preview?.tools as string[];
	assert.equal(declared.includes("codemode"), false);
	for (const name of ["read", "bash", "edit"]) assert.ok(declared.includes(name), `${name} must stay callable: ${declared}`);
	assert.ok(f.session.agent.state.tools.every(tool => tool.modelExposure === undefined));
});

function pngBase64(base64Chars: number): string {
	const bytes = Buffer.alloc(base64Chars / 4 * 3);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
	return bytes.toString("base64");
}

test("Codemode image bounding: images survive text truncation, the image cap applies inline, and show charges only shown content", async t => {
	const tools: InlineExtension = pi => {
		pi.registerTool({ name: "pics", label: "pics", description: "short text plus images", parameters: Type.Object({ count: Type.Integer(), size: Type.Integer() }),
			execute: async (_id, params: { count: number; size: number }) => {
				const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: "pics" }];
				for (let index = 0; index < params.count; index++) content.push({ type: "image", data: pngBase64(params.size), mimeType: "image/png" });
				return { content, details: {} };
			} });
		pi.registerTool({ name: "echo", label: "echo", description: "large input, tiny result", parameters: Type.Object({ blob: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
	};
	const f = await fixture(t, {}, [tools]);
	const outcome = await f.run([
		// Text alone exhausts max_output_tokens before the shown screenshot.
		'// @options: {"max_output_tokens":256}\ntext("word ".repeat(5000)); await show((await tools.pics({count:1,size:1024*1024})).ref)',
		// 20 tiny images with short text: still capped at 16 kept images.
		'await show((await tools.pics({count:20,size:64})).ref)',
		// Two tiny results whose hidden inputs are ~200 KB each fit the 256 KiB display budget.
		'const blob="x".repeat(200000); await show((await tools.echo({blob})).ref); await show((await tools.echo({blob})).ref)',
	]);
	const [truncated, many, echoed] = outcome.results;
	const images = (message: typeof truncated) => message!.content.filter(block => block.type === "image").map(block => (block as { data: string }).data.length);
	assert.match(JSON.stringify(truncated!.content), /Codemode output truncated/);
	assert.deepEqual(images(truncated), [1024 * 1024]);
	assert.equal(many!.isError, false, JSON.stringify(many!.content).slice(0, 1000));
	assert.equal(images(many).length, 16);
	assert.equal(echoed!.isError, false, JSON.stringify(echoed!.content).slice(0, 1000));
	assert.equal(echoed!.content.filter(block => block.type === "text" && block.text === "ok").length, 2);
});

test("identical side effects issued together in one script run once even though the dispatcher serializes them", async t => {
	const { default: guardrails } = await jiti.import<{ default: InlineExtension }>("../packages/extensions/tool-loop-guardrails/index.ts");
	let appended = 0;
	const append: InlineExtension = pi => pi.registerTool({ name: "append", label: "append", description: "appends a line", parameters: Type.Object({ line: Type.String() }),
		// Slow enough that the second call is issued while the first still runs, as with a real shell command.
		execute: async () => { await new Promise(resolve => setTimeout(resolve, 100)); appended++; return { content: [{ type: "text", text: `appended ${appended}` }], details: {} }; } });
	const f = await fixture(t, {}, [guardrails, append]);
	const outcome = await f.run([
		'const r = await Promise.allSettled([tools.append({line:"x"}), tools.append({line:"x"})]); text(r.map(x => x.status).join())',
		// Sequential repeats after the first call completed remain allowed.
		'await tools.append({line:"y"}); await tools.append({line:"y"})',
	]);
	const [together, sequential] = outcome.results;
	assert.match(JSON.stringify(together!.content), /fulfilled,rejected/);
	assert.match(JSON.stringify(together!.content), /DUPLICATE_CALL/);
	assert.equal(sequential!.isError, false, JSON.stringify(sequential!.content).slice(0, 1000));
	assert.equal(appended, 3);
});

test("a nested file_batch records post-mutation evidence for a later guarded overwrite", async t => {
	const f = await fixture(t, {}, [], true);
	const outcome = await f.run([
		'await show((await tools.read({path:"file.txt"})).ref)',
		'await tools.file_batch({operations:[{operation:"edit", path:"file.txt", edits:[{oldText:"hello", newText:"batched"}]}]})',
		// An overwrite needs complete evidence matching the disk; only the batch snapshot matches "batched".
		'await tools.write({path:"file.txt",content:"edited\\nworld\\n"})',
	]);
	assert.equal(outcome.results[1]?.isError, false, JSON.stringify(outcome.results[1]?.content).slice(0, 1000));
	assert.equal(outcome.results[2]?.isError, false, JSON.stringify(outcome.results[2]?.content).slice(0, 1000));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "edited\nworld\n");
});

for (const nested of ["edit", "file_batch"]) test(`a nested ${nested} receipt is restored after reload for a later guarded overwrite`, async t => {
	const f = await fixture(t, {}, [], true);
	const mutate = nested === "edit"
		? 'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"batched"}]})'
		: 'await tools.file_batch({operations:[{operation:"edit", path:"file.txt", edits:[{oldText:"hello", newText:"batched"}]}]})';
	const first = await f.run(['await show((await tools.read({path:"file.txt"})).ref)', mutate]);
	assert.equal(first.results[1]?.isError, false, JSON.stringify(first.results[1]?.content).slice(0, 1000));
	// Reload emits session_start only for a bound host; the restored read predates the mutation.
	const errors: unknown[] = [];
	await f.session.bindExtensions({ onError: error => errors.push(error) });
	await f.session.reload();
	assert.deepEqual(errors, []);
	const outcome = await f.run(['await tools.write({path:"file.txt",content:"edited\\nworld\\n"})']);
	assert.equal(outcome.results.at(-1)?.isError, false, JSON.stringify(outcome.results.at(-1)?.content).slice(0, 1000));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "edited\nworld\n");
});
