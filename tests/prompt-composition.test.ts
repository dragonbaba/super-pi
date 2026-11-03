import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { getReadmePath } from "../packages/coding-agent/src/config.ts";
import { buildSystemPrompt, buildSystemPromptComposition, type SystemPromptComposition } from "../packages/coding-agent/src/core/system-prompt.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { promptFixture } from "./helpers/prompt-fixture.ts";

test("native composition preserves pre-refactor golden bytes and owns five immutable segments", () => {
	// Captured from the old builder; normalize only its installation-specific README path.
	const golden = {
		default: "85fd3a3d57e39f264069ff5f2787f48571f77a39720607c5b7c7bf4c34ec05d6",
		custom: "502bd8b859df2b38a5ce8d78645036ece28d350a6d9a66ac8ea8a9a834a29a7d",
		empty: "ba9929d53f5a6cfe575fcbecfc79d46f6ce2d2a287a3a52bec852a279d1a3754",
		nested: "955b788f2e9fabbf0cbde7238bcdfe3caebe1d0109084e958530e5e33c4f038c",
	};
	for (const [kind, hash] of Object.entries(golden)) {
		const options = promptFixture(kind), composition = buildSystemPromptComposition(options);
		assert.equal(createHash("sha256").update(composition.text.replaceAll(getReadmePath(), "<README>")).digest("hex"), hash);
		assert.equal(buildSystemPrompt(options), composition.text);
		assert.equal(composition.segments.map(segment => segment.text).join(""), composition.text);
		assert.deepEqual(composition.segments.map(segment => segment.source), [kind === "custom" ? "custom" : "default", "append", "workspace", "skills", "cwd"]);
		assert.ok(Object.isFrozen(composition) && Object.isFrozen(composition.segments) && Object.isFrozen(composition.dynamicSources));
		assert.ok(composition.segments.every(segment => Object.isFrozen(segment) && segment.version === 1));
		assert.equal(composition.dynamicSources.visibleSkillCount, kind === "empty" ? 0 : 1);
		options.contextFiles![0].path = "changed";
		assert.equal(composition.dynamicSources.maxContextPathChars, "D:/项目/AGENTS.md".length);
	}
	const hidden = promptFixture(); hidden.skills![0].disableModelInvocation = true;
	assert.equal(buildSystemPromptComposition(hidden).segments[3].text, "");
});

test("runner captures provenance across awaits and invalidates every raw override", async () => {
	const options = promptFixture(), original = buildSystemPromptComposition(options);
	let latest = original;
	let override = original.text;
	const seen: (SystemPromptComposition | null | undefined)[] = [];
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(pi => {
		pi.on("before_agent_start", async event => {
			seen.push(event.systemPromptComposition);
			await Promise.resolve();
			latest = buildSystemPromptComposition(promptFixture("custom"));
			return { message: { customType: "fixture", content: "message only", display: false } };
		});
		pi.on("before_agent_start", event => { seen.push(event.systemPromptComposition); return { systemPrompt: override }; });
		pi.on("before_agent_start", event => { seen.push(event.systemPromptComposition); return { systemPrompt: "later override" }; });
		pi.on("before_agent_start", event => { seen.push(event.systemPromptComposition); });
	}, options.cwd, createEventBus(), runtime);
	const runner = new ExtensionRunner([extension], runtime, options.cwd, SessionManager.inMemory(options.cwd), {} as never);
	runner.onError(error => { throw new Error(error.error); });
	for (const text of [original.text, ""]) {
		override = text; seen.length = 0;
		const result = await runner.emitBeforeAgentStart("hello", undefined, original.text, options, original);
		assert.deepEqual(seen, [original, original, null, null]);
		assert.notEqual(latest, original);
		assert.equal(result?.systemPrompt, "later override");
		assert.equal(result?.messages?.length, 1);
	}
	seen.length = 0;
	await runner.emitBeforeAgentStart("legacy", undefined, original.text, options);
	assert.deepEqual(seen, [undefined, undefined, null, null]);
	seen.length = 0;
	await runner.emitBeforeAgentStart("mismatch", undefined, "different", options, original);
	assert.deepEqual(seen, [null, null, null, null]);
});

test("composition allocation is restricted to prompt rebuild and never progress delivery", () => {
	const file = new URL("../packages/coding-agent/src/core/agent-session.ts", import.meta.url);
	const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const calls: string[] = [];
	function visit(node: ts.Node, owner = "") {
		if (ts.isMethodDeclaration(node)) owner = node.name.getText(source);
		if (ts.isCallExpression(node) && node.expression.getText(source) === "buildSystemPromptComposition") calls.push(owner);
		ts.forEachChild(node, child => visit(child, owner));
	}
	visit(source);
	assert.deepEqual(calls, ["_rebuildSystemPrompt"]);
});
