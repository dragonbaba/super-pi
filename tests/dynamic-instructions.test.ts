import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import dynamicInstructions from "../packages/dynamic-instructions/src/index.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { buildSystemPromptComposition, type SystemPromptComposition } from "../packages/coding-agent/src/core/system-prompt.ts";
import { promptFixture } from "./helpers/prompt-fixture.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
	const runtime = createExtensionRuntime(), manager = SessionManager.inMemory();
	let override: string | undefined;
	const extension = await loadExtensionFromFactory(pi => {
		pi.on("before_agent_start", () => override === undefined ? undefined : { systemPrompt: override });
		dynamicInstructions(pi);
	}, process.cwd(), createEventBus(), runtime);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), manager, {} as never);
	runner.onError(error => { throw new Error(error.error); });
	return {
		runner, manager,
		override(value: string | undefined) { override = value; },
		persist(result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>) {
			for (const message of result?.messages ?? []) manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
}

test("native dynamic projection preserves duplicate custom text and migrates nested-read skills", async () => {
	const f = await fixture(), options = promptFixture("nested");
	const initial = buildSystemPromptComposition(options);
	const first = await f.runner.emitBeforeAgentStart("first", undefined, initial.text, options, initial);
	assert.ok(String(first?.messages?.[0].content).includes(initial.segments[3].text));
	assert.ok(initial.segments[3].text.length > 0);
	assert.equal(first?.systemPrompt?.includes("<available_skills>"), false);
	const details = first!.messages![0].details as { workspaceSha256: string; skillsSha256: string };
	assert.equal(details.skillsSha256, hash(initial.segments[3].text));
	f.persist(first);
	options.customPrompt = initial.segments[2].text + initial.segments[3].text;
	options.appendSystemPrompt = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n"
		+ "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)\n" + initial.segments[2].text;
	const duplicate = buildSystemPromptComposition(options);
	// Earlier extensions can mutate options; native migration uses build-owned bounds and bytes.
	options.contextFiles = Array.from({ length: 65 }, () => ({ path: "x".repeat(2049), content: "changed" }));
	options.skills = [];
	const next = await f.runner.emitBeforeAgentStart("next", undefined, duplicate.text, options, duplicate);
	assert.equal(next?.systemPrompt, duplicate.segments[0].text + duplicate.segments[1].text + duplicate.segments[4].text);
	assert.equal(next?.messages, undefined);
});

test("invalid native provenance and migration budgets preserve the complete prompt without tombstones", async () => {
	const f = await fixture(), options = promptFixture(), valid = buildSystemPromptComposition(options);
	f.persist(await f.runner.emitBeforeAgentStart("first", undefined, valid.text, options, valid));
	for (const override of [valid.text, ""]) {
		f.override(override);
		const result = await f.runner.emitBeforeAgentStart("override", undefined, valid.text, options, valid);
		assert.equal(result?.systemPrompt, override);
		assert.equal(result?.messages, undefined);
	}
	f.override(undefined);
	const invalid = [
		null,
		Object.freeze({ ...valid, version: 2 }),
		Object.freeze({ ...valid, segments: Object.freeze([Object.freeze({ ...valid.segments[0], source: "unknown" }), ...valid.segments.slice(1)]) }),
		Object.freeze({ ...valid, segments: Object.freeze(valid.segments.slice(1)) }),
		Object.freeze({ ...valid, dynamicSources: Object.freeze({ ...valid.dynamicSources, contextFileCount: 65 }) }),
		Object.freeze({ ...valid, dynamicSources: Object.freeze({ ...valid.dynamicSources, visibleSkillCount: 257 }) }),
		Object.freeze({ ...valid, dynamicSources: Object.freeze({ ...valid.dynamicSources, maxContextPathChars: 2049 }) }),
		Object.freeze({ ...valid, dynamicSources: Object.freeze({ ...valid.dynamicSources, maxSkillPathChars: 2049 }) }),
	];
	for (const composition of invalid) {
		assert.equal(await f.runner.emitBeforeAgentStart("invalid", undefined, valid.text, options, composition as SystemPromptComposition | null), undefined);
	}
	options.contextFiles![0].content = "x".repeat(256 * 1024);
	const oversized = buildSystemPromptComposition(options);
	assert.equal(await f.runner.emitBeforeAgentStart("large", undefined, oversized.text, options, oversized), undefined);
	assert.equal(f.manager.getBranch().length, 1);
});

test("dynamic replacements follow durable branch hashes, including failed append, changes, empty and restore", async () => {
	const f = await fixture(), options = promptFixture();
	let composition = buildSystemPromptComposition(options);
	const emit = () => f.runner.emitBeforeAgentStart("turn", undefined, composition.text, options, composition);
	const first = await emit();
	assert.ok(first?.messages?.[0]);
	assert.deepEqual((await emit())?.messages, first.messages); // append failed: history unchanged
	f.persist(first);
	const originalLeaf = f.manager.getLeafId()!;
	assert.equal((await emit())?.messages, undefined);
	options.contextFiles![0].content = "new policy";
	composition = buildSystemPromptComposition(options);
	const workspace = await emit();
	assert.ok(String(workspace?.messages?.[0].content).includes("new policy"));
	assert.equal(String(workspace?.messages?.[0].content).includes("Available skill catalog replacement"), false);
	f.persist(workspace);
	options.skills![0].description = "new skill";
	composition = buildSystemPromptComposition(options);
	const skills = await emit();
	assert.ok(String(skills?.messages?.[0].content).includes("new skill"));
	assert.equal(String(skills?.messages?.[0].content).includes("Workspace/project instructions replacement"), false);
	f.persist(skills);
	options.contextFiles = []; options.skills = [];
	composition = buildSystemPromptComposition(options);
	const empty = await emit();
	assert.ok(String(empty?.messages?.[0].content).includes("empty (previous workspace"));
	assert.ok(String(empty?.messages?.[0].content).includes("empty (previous skill"));
	f.persist(empty);
	assert.equal((await emit())?.messages, undefined);
	f.manager.branch(originalLeaf);
	composition = buildSystemPromptComposition(promptFixture());
	await f.runner.emit({ type: "session_shutdown", reason: "reload" });
	await f.runner.emit({ type: "session_start", reason: "reload" });
	assert.equal((await emit())?.messages, undefined);
	f.manager.resetLeaf();
	assert.ok((await emit())?.messages?.[0]);
});

test("only absent metadata uses the conservative legacy formatting and unique-match path", async () => {
	const f = await fixture(), options = promptFixture(), composition = buildSystemPromptComposition(options);
	const result = await f.runner.emitBeforeAgentStart("legacy", undefined, composition.text, options);
	assert.ok(result?.messages?.[0]);
	assert.equal(result?.systemPrompt, composition.segments[0].text + composition.segments[1].text + composition.segments[4].text);
	const duplicate = composition.text + composition.segments[2].text;
	assert.equal(await f.runner.emitBeforeAgentStart("duplicate", undefined, duplicate, options), undefined);
	const docs = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n"
		+ "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
	const old = await f.runner.emitBeforeAgentStart("docs", undefined, composition.text + docs, options);
	assert.ok(old?.systemPrompt?.includes("Pi-specific tasks: read Pi's installed README"));
});

test("native projection has no full-prompt search, resource formatting, serialization or callback allocation", () => {
	const file = new URL("../packages/dynamic-instructions/src/index.ts", import.meta.url);
	const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	let inspected = 0;
	for (const statement of source.statements) {
		if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== "buildNativeProjection") continue;
		inspected++;
		function visit(node: ts.Node) {
			assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node), false);
			if (ts.isCallExpression(node)) assert.doesNotMatch(node.expression.getText(source), /(?:indexOf|slice|substring|split|join|map|filter|JSON|formatContextFiles|formatSkills|removeUniqueSection|compactPiDocs)/u);
			ts.forEachChild(node, visit);
		}
		visit(statement);
	}
	assert.equal(inspected, 1);
});
