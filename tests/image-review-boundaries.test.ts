import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { offlineImageRuntime } from "./helpers/offline-image-runtime.ts";
import { pngFixture } from "./helpers/image-acceptance-fixtures.ts";
import { alphaSession, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { response } from "./helpers/selected-integration-fixture.ts";

function deferred<T = void>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const image = (size = 8) => ({ type: "image" as const, mimeType: "image/png", data: pngFixture(size, size).toString("base64") });

for (const auxiliary of [false, true]) for (const removeImages of [false, true]) {
	test(`SDK committed input projection survives restore: ${auxiliary} remove=${removeImages}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "sp-projection-restore-")); let f: any;
		try {
			f = await offlineImageRuntime(root, auxiliary, undefined, undefined, event => event.images?.length
				? { action: "transform", text: "committed transform", ...(removeImages ? { images: [] } : {}) } : undefined);
			await f.session.prompt("original user", { images: [image()] });
			assert.equal(f.counts.vision, auxiliary && !removeImages ? 1 : 0);
			const saved = f.session.sessionManager.getSessionFile(); await f.close();
			const wires: any[] = [];
			f = await offlineImageRuntime(root, auxiliary, saved, undefined, () => undefined, { beforeWireResponse: (_vision, wire) => { wires.push(wire); } });
			assert.equal(f.counts.main, 0); assert.equal(f.counts.vision, 0);
			await f.session.prompt("continue");
			assert.equal(f.counts.imageHooks, 0); assert.equal(f.counts.vision, 0, "saved derivation reused, ordinary input not replayed");
			assert.match(JSON.stringify(wires), /committed transform/);
			assert.doesNotMatch(JSON.stringify(wires), /inputProjection|imageSubmission/);
			const original = f.session.messages.find((m: any) => m.imageSubmission) as any;
			assert.equal(original.content[0].text, "original user"); assert.equal(original.imageSubmission.attachments.length, 1);
			assert.equal(original.content[1].data, image().data);
		} finally { await f?.close(); rmSync(root, { recursive: true }); }
	});
}

for (const auxiliary of [false, true]) for (const action of ["handled", "transform"] as const) {
	test(`SDK ordinary image input: ${auxiliary ? "text+vision" : "multimodal"} ${action}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "sp-input-boundary-")); const original = image(), replacement = image(10);
		const events: any[] = [], wires: any[] = [];
		const f = await offlineImageRuntime(root, auxiliary, undefined, undefined, event => {
			if (!event.images?.length) return;
			events.push(event);
			return action === "handled" ? { action } : { action, text: "transformed question", images: [replacement] };
		}, { beforeWireResponse(vision, wire) { wires.push({ vision, wire }); } });
		try {
			await f.session.prompt("original question", { images: [original], source: "rpc", streamingBehavior: "followUp" });
			assert.equal(events.length, 1); assert.equal(events[0].source, "rpc");
			if (action === "handled") { assert.equal(wires.length, 0); assert.equal(f.session.messages.filter(m => m.role === "user").length, 0); }
			else {
				const user = f.session.messages.find(m => m.role === "user") as any;
				assert.equal(user.content[0].text, "original question"); assert.equal(user.content[1].data, original.data);
				assert.match(JSON.stringify(wires), /transformed question/);
				assert.ok(JSON.stringify(wires).includes(replacement.data)); assert.ok(!JSON.stringify(wires).includes(original.data));
				assert.doesNotMatch(JSON.stringify(wires), /imageSubmission|inputProjection|policyRevision/);
				await f.session.prompt("follow-up"); assert.equal(events.length, 1, "ordinary image interception is not replayed for history");
				assert.equal(f.counts.vision, auxiliary ? 1 : 0);
			}
		} finally { await f.close(); rmSync(root, { recursive: true }); }
	});
}

for (const stage of ["vision", "context", "headers", "payload"] as const) for (const change of ["block", "block-unblock", "override-unblock", "model", "cancel"] as const) {
	test(`SDK image validity rechecked after ${stage} await: ${change}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "sp-policy-boundary-")); const entered = deferred(), resume = deferred();
		const f = await offlineImageRuntime(root, true, undefined, undefined, undefined, {
			beforeWireResponse: async vision => { if (vision && stage === "vision") { entered.resolve(); await resume.promise; } },
			extensions: [(pi: any) => { if (stage !== "vision") pi.on(stage === "context" ? "context" : stage === "headers" ? "before_provider_headers" : "before_provider_request", async () => { entered.resolve(); await resume.promise; }); }],
		});
		try {
			const run = f.session.prompt("image question", { images: [image()] }); await entered.promise;
			await f.session.followUp("must remain queued");
			if (change.startsWith("block")) f.session.settingsManager.setBlockImages(true);
			if (change === "block-unblock") f.session.settingsManager.setBlockImages(false);
			if (change === "override-unblock") { f.session.settingsManager.applyOverrides({ images: { blockImages: true } }); f.session.settingsManager.applyOverrides({ images: { blockImages: false } }); }
			if (change === "model") f.session.agent.state.model = { ...f.session.model!, id: "changed-main" };
			const cancelled = change === "cancel" ? f.session.abort() : undefined;
			resume.resolve(); await run; await cancelled;
			assert.equal((f.session as any)._imageRequest, undefined, "completed/failed/cancelled request releases its guard");
			assert.equal(f.counts.vision, 1); assert.equal(f.counts.main, 0); assert.equal(f.session.pendingMessageCount, 1);
			assert.ok(f.session.messages.some((m: any) => m.imageSubmission));
			if (stage !== "vision" || change !== "cancel") assert.ok(f.session.sessionManager.getBranch().some((e: any) => e.customType === "image-vision-result-v1"));
			assert.match(JSON.stringify(f.session.messages), change === "cancel" ? /aborted|Image submission blocked/ : /Image submission blocked/);
		} finally { resume.resolve(); await f.close(); rmSync(root, { recursive: true }); }
	});
}

for (const auxiliary of [false, true]) for (const action of ["handled", "transform"] as const) {
	test(`SDK queued ordinary image input once: ${auxiliary ? "auxiliary" : "multimodal"} ${action}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "sp-queued-input-")); const entered = deferred(), resume = deferred();
		const original = image(), replacement = image(10), events: any[] = [], wires: any[] = [];
		const f = await offlineImageRuntime(root, auxiliary, undefined, undefined, event => {
			if (!event.images?.length) return;
			events.push(event); return action === "handled" ? { action } : { action, text: "queued transform", images: [replacement] };
		}, { beforeWireResponse: async (vision, wire) => {
			wires.push(wire); if (!vision && wires.length === 1) { entered.resolve(); await resume.promise; }
		} });
		try {
			const run = f.session.prompt("first"); await entered.promise;
			await f.session.prompt("queued original", { images: [original], source: "rpc", streamingBehavior: "followUp" });
			assert.equal(events.length, 1); assert.equal(events[0].streamingBehavior, "followUp"); assert.equal(events[0].source, "rpc");
			assert.equal(f.counts.vision, 0); assert.equal(f.counts.main, 1);
			assert.equal(f.session.pendingMessageCount, action === "handled" ? 0 : 1);
			resume.resolve(); await run;
			assert.equal(events.length, 1); assert.equal(f.counts.main, action === "handled" ? 1 : 2);
			if (action === "transform") {
				const user = f.session.messages.find((m: any) => m.imageSubmission) as any;
				assert.equal(user.content[0].text, "queued original"); assert.equal(user.content[1].data, original.data);
				assert.ok(JSON.stringify(wires).includes(replacement.data)); assert.ok(!JSON.stringify(wires).includes(original.data));
				assert.equal(f.counts.vision, auxiliary ? 1 : 0);
			}
		} finally { resume.resolve(); await f.close(); rmSync(root, { recursive: true }); }
	});
}

for (const count of [0, 7, 8, "bytes"] as const) {
	test(`real TUI preflight rejection preserves independent next draft (${count})`, async () => {
		let calls = 0, authCalls = 0; const runtime = alphaModelRuntime(model => { calls++; return response(model, []); });
		const f = await alphaSession({ runtime, settings: { compaction: { enabled: false } } });
		const entered = deferred(), auth = deferred<any>(); const rejected: unknown[] = [];
		const rejectListener = (e: unknown) => rejected.push(e); process.on("unhandledRejection", rejectListener);
		try {
			await f.mode.init(); f.session.agent.state.model = { ...f.session.model!, input: ["text", "image"] };
			const path = join(f.root, "fixture.png"); writeFileSync(path, count === "bytes" ? pngFixture(1600, 1600, true) : pngFixture(8, 8));
			const paste = async (n: number) => { f.input.write(`\x1b[200~${Array(n).fill(`"${path}"`).join(" ")}\x1b[201~`); while (f.internal.imageDraft.busy) await turn(); };
			await paste(1); const oldId = f.internal.imageDraft.items[0].id;
			runtime.hasConfiguredAuth = () => false; runtime.checkAuth = async () => { authCalls++; entered.resolve(); return auth.promise; };
			const originalSubmit = f.internal.defaultEditor.onSubmit; let operation: Promise<void> | undefined;
			f.internal.defaultEditor.onSubmit = (text: string) => { operation = originalSubmit(text); operation!.catch(e => rejected.push(e)); return operation; };
			f.input.write("old question\r"); await entered.promise;
			assert.equal(f.session.messages.filter(m => m.role === "user").length, 0);
			const n = count === "bytes" ? 4 : count; if (n) await paste(n); f.input.write("next question");
			const next = JSON.stringify(f.internal.imageDraft.items);
			const originalOperation = operation;
			if (n) { f.input.write("\r"); await operation; assert.equal(f.internal.editor.getText(), "next question"); }
			assert.equal(authCalls, 1);
			auth.reject(new Error("controlled preflight auth failure")); await originalOperation; await turn();
			assert.equal(f.internal.editor.getText(), "next question"); assert.equal(JSON.stringify(f.internal.imageDraft.items), next);
			const recovery = f.internal.imageSubmissionRecovery;
			assert.equal(recovery.state, "failed"); assert.equal(recovery.text, "old question"); assert.equal(recovery.submission.attachments[0].id, oldId);
			assert.match(recovery.error, /controlled preflight auth failure/); assert.match(f.internal.defaultEditor.render(120).join("\n"), /image-recover/);
			assert.equal(calls, 0); assert.equal(f.session.pendingMessageCount, 0); assert.deepEqual(rejected, []);
			f.input.write("\x15/image-recover\r"); await operation;
			if (n) {
				assert.equal(f.internal.imageSubmissionRecovery, recovery); assert.equal(JSON.stringify(f.internal.imageDraft.items), next);
				f.input.write("/image-discard\r"); await operation; assert.equal(f.internal.imageSubmissionRecovery, undefined);
				assert.equal(JSON.stringify(f.internal.imageDraft.items), next);
			} else { assert.equal(f.internal.imageSubmissionRecovery, undefined); assert.equal(f.internal.imageDraft.items[0].id, oldId); assert.equal(f.internal.editor.getText(), "old question"); }
		} finally { auth.resolve(undefined); process.off("unhandledRejection", rejectListener); await f.release(); }
	});
}

for (const failMain of [false, true]) for (const auxiliary of [false, true]) for (const operation of ["compact", "branch"] as const) for (const change of ["model", "policy"] as const) {
	test(`completed image guard cannot block ${operation}: auxiliary=${auxiliary}, change=${change}, failed=${failMain}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "sp-image-guard-")), wires: any[] = [];
		const f = await offlineImageRuntime(root, auxiliary, undefined, undefined, undefined, { beforeWireResponse: (_vision, wire) => { wires.push(wire); } });
		try {
			f.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 256 } });
			await f.session.prompt("prior text ".repeat(512));
			const target: any = f.session.sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "user");
			if (failMain) f.failMain();
			await f.session.prompt("image question", { images: [image()] });
			assert.equal(f.counts.failures, failMain ? 1 : 0);
			if (change === "model") f.session.agent.state.model = { ...f.session.model!, id: "changed-main" };
			else { f.session.settingsManager.setBlockImages(true); f.session.settingsManager.setBlockImages(false); }
			f.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 256 } });
			const before = f.counts.main;
			if (operation === "compact") assert.ok((await f.session.compact()).summary);
			else assert.ok((await f.session.navigateTree(target.id, { summarize: true })).summaryEntry);
			assert.ok(f.counts.main > before);
			assert.doesNotMatch(JSON.stringify(wires.at(-1)), /input_image|imageSubmission|policyRevision/);
			assert.equal(f.counts.vision, auxiliary ? 1 : 0);
		} finally { await f.close(); rmSync(root, { recursive: true }); }
	});
}
