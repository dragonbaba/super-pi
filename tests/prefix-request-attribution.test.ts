import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../packages/ai/src/types.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { observeEffectiveDispatch } from "../packages/ai/src/utils/effective-dispatch.ts";
import { ALPHA_MODEL, alphaHeadless, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { PrefixManifestRecorder } from "../packages/coding-agent/src/core/prefix-manifest.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { stream as streamCodex } from "../packages/ai/src/api/openai-codex-responses.ts";
import { codexModel, codexToken, sseFrames, textEvents } from "./helpers/responses-sse-fixture.ts";

interface Request { model: Model<any>; options: SimpleStreamOptions | undefined; stream: AssistantMessageEventStream }
function dispatch(request: Request, text: string): void {
	observeEffectiveDispatch(request.options, request.model, { transport: "sse", previousResponseMode: "none",
		instructionPrefix: text, orderedToolDefinitions: [], orderedToolIdentifiers: [], cacheKey: "fixture-session",
		cacheRetention: "short", cachePolicy: { enabled: true }, cacheBoundary: [] });
}
function response(): AssistantMessage {
	return { role: "assistant", content: [], api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id,
		stopReason: "stop", timestamp: Date.now(), usage: { input: 2000, cacheRead: 2000, cacheWrite: 0, output: 0,
			totalTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function fixture(t: TestContext) {
	const requests: Request[] = [];
	const control = { prefix: "first", repeats: 1, deferred: false, error: false, synchronous: false };
	const runtime = alphaModelRuntime((model, _context, options) => {
		const request = { model, options, stream: new AssistantMessageEventStream() };
		requests.push(request);
		const complete = () => {
			for (let index = 0; index < control.repeats; index++) dispatch(request, control.prefix);
			const message = response();
			if (control.error) { message.stopReason = "error"; request.stream.push({ type: "error", reason: "error", error: message }); }
			else request.stream.push({ type: "done", reason: "stop", message });
			request.stream.end();
		};
		if (!control.deferred) { if (control.synchronous) complete(); else queueMicrotask(complete); }
		return request.stream;
	});
	const owner = await alphaHeadless(runtime);
	t.after(async () => { owner.session.dispose(); await owner.session.waitForSessionLeaseRelease(); await owner.release(); });
	return { session: owner.session, requests, control, runtime };
}

test("late effective-dispatch callback cannot overwrite the latest completed request", async t => {
	const { session, requests, control } = await fixture(t);
	await session.prompt("first", { expandPromptTemplates: false });
	control.prefix = "second";
	await session.prompt("second", { expandPromptTemplates: false });
	const current = session.prefixManifest;
	dispatch(requests[0]!, "stale first request");
	assert.equal(session.prefixManifest, current);
});

test("repeated dispatch observation compares against the preceding request, not its own retry", async t => {
	const { session, control } = await fixture(t);
	await session.prompt("first", { expandPromptTemplates: false });
	control.prefix = "second"; control.repeats = 2;
	await session.prompt("second", { expandPromptTemplates: false });
	assert.equal(session.prefixDriftDiagnostic?.reasonCode, "UNKNOWN_PREFIX_DRIFT");
});

test("summarization stream does not replace main-response prefix diagnostics", async t => {
	const { session, control } = await fixture(t);
	await session.prompt("main", { expandPromptTemplates: false });
	const current = session.prefixManifest, intent = session.prefixIntentManifest;
	control.prefix = "auxiliary summary";
	const summarize = (session as any)._createSummarizationStream({ model: ALPHA_MODEL, apiKey: "offline-fixture" }, () => {});
	const stream = await summarize(ALPHA_MODEL, { messages: [] }, {});
	await stream.result();
	assert.equal(session.prefixManifest, current);
	assert.equal(session.prefixIntentManifest, intent);
});

test("exact final response is associated before message_end and copied/history messages are unknown", async t => {
	const { session, control } = await fixture(t);
	let completed: AssistantMessage | undefined;
	let observedAtEnd: ReturnType<typeof session.getPrefixObservation>;
	session.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			completed = event.message;
			observedAtEnd = session.getPrefixObservation(completed);
		}
	});
	control.synchronous = true;
	await session.prompt("first", { expandPromptTemplates: false });
	assert.ok(completed); assert.ok(session.getPrefixObservation(completed));
	assert.ok(observedAtEnd); assert.equal(observedAtEnd.observedDispatches, 1);
	assert.equal(observedAtEnd.manifest, session.prefixManifest);
	assert.equal(observedAtEnd.comparisonState, "unavailable");
	assert.equal(session.getPrefixObservation({ ...completed }), undefined);
	const serialized = JSON.stringify(session.getPrefixObservation(completed));
	assert.equal(serialized.includes('"instructionPrefix"'), false);
	assert.equal(serialized.includes('"usage"'), false);
	assert.equal(serialized.includes("offline-fixture"), false);
	assert.equal(serialized.includes('"content"'), false);
});

test("unobserved and failed completions do not borrow the previous response's diagnostic", async t => {
	const { session, control } = await fixture(t);
	const start = () => session.agent.streamFunction(ALPHA_MODEL, { messages: [] }, {});
	const first = await start(); const firstResponse = await first.result();
	assert.ok(session.getPrefixObservation(firstResponse));
	control.repeats = 0;
	const missing = await start(); const missingResponse = await missing.result();
	assert.equal(session.prefixManifest, undefined);
	assert.equal(session.getPrefixObservation(firstResponse), undefined);
	assert.equal(session.getPrefixObservation(missingResponse), undefined);
	control.repeats = 1; control.error = true;
	const failed = await start();
	assert.equal(session.getPrefixObservation(await failed.result()), undefined);
	assert.equal(session.prefixDriftDiagnostic, undefined);
	control.error = false;
	const next = await start();
	assert.equal(session.getPrefixObservation(await next.result())?.comparisonState, "unavailable");
});

test("superseding a request and abort/dispose release its input and reject late callbacks", async t => {
	const { session, requests, control } = await fixture(t);
	control.deferred = true;
	const signal = new AbortController();
	const older = await session.agent.streamFunction(ALPHA_MODEL, { systemPrompt: "old private prompt", messages: [] }, { signal: signal.signal });
	const oldOwner = (older as any).resultObserver;
	assert.ok(oldOwner.input);
	const current = await session.agent.streamFunction(ALPHA_MODEL, { systemPrompt: "new private prompt", messages: [] }, {});
	assert.equal(oldOwner.input, undefined); assert.equal(oldOwner.session, undefined);
	assert.equal(oldOwner.recorder, undefined);
	dispatch(requests[0]!, "late superseded");
	older.end(response());
	assert.equal(session.getPrefixObservation(await older.result()), undefined);
	dispatch(requests[1]!, "current");
	current.end(response());
	assert.ok(session.getPrefixObservation(await current.result()));
	const aborting = await session.agent.streamFunction(ALPHA_MODEL, { messages: [] }, { signal: signal.signal });
	const abortedOwner = (aborting as any).resultObserver;
	signal.abort();
	assert.equal(abortedOwner.input, undefined); assert.equal(abortedOwner.session, undefined);
	dispatch(requests[2]!, "late aborted"); aborting.end(response());
	assert.equal(session.getPrefixObservation(await aborting.result()), undefined);
	const disposing = await session.agent.streamFunction(ALPHA_MODEL, { messages: [] }, {});
	const disposedOwner = (disposing as any).resultObserver;
	session.dispose();
	assert.equal(disposedOwner.input, undefined); assert.equal(disposedOwner.session, undefined);
	assert.equal(disposedOwner.recorder, undefined);
	dispatch(requests[3]!, "late disposed"); disposing.end(response());
	assert.equal(session.prefixManifest, undefined);
	assert.equal(session.getPrefixObservation(await disposing.result()), undefined);
});

test("same-file reload and failed partial reload invalidate the comparison scope", t => {
	const root = mkdtempSync(join(tmpdir(), "prefix-reload-"));
	t.after(() => removeOwnedFixture(root));
	const manager = SessionManager.create(root, root);
	manager.appendMessage(response());
	const file = manager.getSessionFile()!, generation = manager.getContextGeneration();
	manager.setSessionFile(file);
	assert.equal(manager.getContextGeneration(), generation + 1);
	writeFileSync(file, "invalid session\n");
	assert.throws(() => manager.setSessionFile(file));
	assert.equal(manager.getContextGeneration(), generation + 2);
});

test("disposing an obsolete recorder owner cannot clear the current owner's request", () => {
	const recorder = new PrefixManifestRecorder(), older = {}, current = {};
	const first = { released: false, release() { this.released = true; } };
	recorder.beginRequest(older, first, 0, 0, "fixture");
	const sequence = recorder.beginRequest(current, { release() {} }, 0, 0, "fixture");
	assert.equal(first.released, true);
	recorder.releaseOwner(older);
	assert.equal(recorder.isCurrentRequest(sequence), true);
	recorder.releaseOwner(current);
	assert.equal(recorder.isCurrentRequest(sequence), false);
});

test("real Codex SSE dispatch associates normalized usage with its exact SDK response", async t => {
	const events = textEvents();
	(events.at(-1) as any).response.usage = { input_tokens: 15, output_tokens: 2, input_tokens_details: { cached_tokens: 10 } };
	const runtime = alphaModelRuntime((_model, context, options) => streamCodex(codexModel, context, {
		...options, apiKey: codexToken(), transport: "sse", maxRetries: 0,
		fetch: async () => new Response(sseFrames(events), { headers: { "content-type": "text/event-stream" } }),
	}));
	const owner = await alphaHeadless(runtime);
	t.after(async () => { owner.session.dispose(); await owner.session.waitForSessionLeaseRelease(); await owner.release(); });
	const stream = await owner.session.agent.streamFunction(codexModel, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {});
	const message = await stream.result();
	assert.equal(message.stopReason, "stop", message.errorMessage);
	const observed = owner.session.getPrefixObservation(message);
	assert.ok(observed); assert.equal(observed.observedDispatches, 1);
	assert.equal(observed.manifest.provider, codexModel.provider);
	assert.equal(observed.manifest.transport, "sse");
	assert.equal(message.usage.input + message.usage.cacheRead, 15);
});

test("credential changes and explicit context boundaries make old response attribution unavailable", async t => {
	const { session, control, runtime, requests } = await fixture(t);
	let credential = 0; runtime.getCredentialGeneration = () => credential;
	const start = () => session.agent.streamFunction(ALPHA_MODEL, { messages: [] }, {});
	let stream = await start(), message = await stream.result();
	assert.ok(session.getPrefixObservation(message));
	credential++;
	assert.equal(session.getPrefixObservation(message), undefined);
	control.prefix = "after credentials";
	stream = await start(); message = await stream.result();
	assert.equal(session.getPrefixObservation(message)?.comparisonState, "unavailable");
	const manager = session.sessionManager;
	const entry = manager.appendMessage({ role: "user", content: "branch fixture", timestamp: 0 });
	const generation = manager.getContextGeneration();
	assert.ok(session.getPrefixObservation(message), "ordinary append does not change prefix comparison scope");
	manager.branch(entry); assert.equal(manager.getContextGeneration(), generation);
	manager.resetLeaf(); assert.equal(session.getPrefixObservation(message), undefined);
	stream = await start(); message = await stream.result();
	assert.equal(session.getPrefixObservation(message)?.comparisonState, "unavailable");
	manager.branchWithSummary(entry, "summary fixture");
	assert.equal(session.getPrefixObservation(message), undefined);
	stream = await start(); message = await stream.result();
	manager.appendCompaction("compaction fixture", entry, 100);
	assert.equal(session.getPrefixObservation(message), undefined);
	control.deferred = true;
	stream = await start();
	dispatch(requests.at(-1)!, "before credential change");
	credential++;
	stream.end(response());
	assert.equal(session.getPrefixObservation(await stream.result()), undefined);
});

test("context generation advances only at successful context boundaries", () => {
	const manager = SessionManager.inMemory(process.cwd());
	const initial = manager.getContextGeneration();
	const first = manager.appendMessage({ role: "user", content: "first", timestamp: 0 });
	manager.appendMessage({ role: "user", content: "second", timestamp: 0 });
	assert.equal(manager.getContextGeneration(), initial);
	assert.throws(() => manager.branch("missing")); assert.equal(manager.getContextGeneration(), initial);
	manager.branch(first); assert.equal(manager.getContextGeneration(), initial + 1);
	const persist = (manager as any)._persist;
	(manager as any)._persist = () => { throw new Error("persist fixture"); };
	assert.throws(() => manager.appendCompaction("failed", first, 100), /persist fixture/);
	assert.equal(manager.getContextGeneration(), initial + 1);
	assert.equal(manager.getLeafId(), first);
	(manager as any)._persist = persist;
	manager.appendCompaction("ok", first, 100); assert.equal(manager.getContextGeneration(), initial + 2);
	manager.newSession(); assert.equal(manager.getContextGeneration(), initial + 3);
});
