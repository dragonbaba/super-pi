import { tmpdir } from "node:os";
import { stream as responsesStream } from "../packages/ai/src/api/openai-responses.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, readFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { setImmediate as turn } from "node:timers/promises";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";
import { response } from "./helpers/selected-integration-fixture.ts";
import { ImageAttachmentDraft, draftAttachmentText, parseImagePaths, localImagePath, attachmentLabel, attachmentDescription, snapshotImageSubmission } from "../packages/coding-agent/src/core/image-attachments.ts";
import * as imagePatterns from "../packages/coding-agent/src/utils/image-input-regex.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import auxiliaryVision from "../packages/extensions/auxiliary-vision/index.ts";
import { loadConfig } from "../packages/extensions/auxiliary-vision/core.ts";
import { registerApiProvider, unregisterApiProviders } from "@super-pi/ai/compat";
import { runClipboardCommand } from "../packages/coding-agent/src/utils/clipboard-image.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { AgentSessionRuntime } from "../packages/coding-agent/src/core/agent-session-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { VIRTUAL_MODULES } from "../packages/coding-agent/src/core/extensions/virtual-modules.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { CLIPBOARD_LIFECYCLE_SYMBOL, ClipboardArtifactLifecycle } from "../packages/extensions/auxiliary-vision/clipboard-lifecycle.ts";
import { readBoundedImage, resolveExistingRoots } from "../packages/extensions/auxiliary-vision/image-io.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
initTheme("dark");

test("modern attachment manifest preserves legacy files and global ownership across SDK reload", { timeout: 5000 }, async () => {
	const tempRoot = resolve(tmpdir()), root = mkdtempSync(join(tempRoot, "pi-attachment-bridge-"));
	const oldTemp = process.env.TEMP, oldTmp = process.env.TMP, oldTmpdir = process.env.TMPDIR, oldAgent = process.env.SP_CODING_AGENT_DIR;
	const globals = globalThis as any, previous = globals[CLIPBOARD_LIFECYCLE_SYMBOL], oldFetch = globalThis.fetch;
	let shutdowns = 0, requests = 0, main = 0;
	const sentinel = { shutdown() { shutdowns++; } };
	let host: AgentSessionRuntime | undefined;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		process.env.TEMP = root; process.env.TMP = root; process.env.TMPDIR = root; process.env.SP_CODING_AGENT_DIR = root;
		assert.equal(tmpdir(), root);
		globals[CLIPBOARD_LIFECYCLE_SYMBOL] = sentinel;
		globalThis.fetch = async () => { requests++; throw new Error("fixture must remain offline"); };
		const historical = join(root, `pi-clipboard-${randomUUID()}.png`);
		writeFileSync(historical, PNG); const aged = new Date(Date.now() - 48 * 60 * 60 * 1000); utimesSync(historical, aged, aged);
		mkdirSync(join(root, "config")); writeFileSync(join(root, "config", "auxiliary-vision.json"), JSON.stringify({ toolMode: "off" }));
		const packageRoot = fileURLToPath(new URL("../packages/extensions/", import.meta.url));
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		const entry = manifest.pi.extensions.find((path: string) => path === "./auxiliary-vision/index.ts"); assert.ok(entry);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
			additionalExtensionPaths: [resolve(packageRoot, entry)], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
		await resources.reload(); assert.deepEqual(resources.getExtensions().errors, []);
		const assertUnowned = () => {
			assert.equal(globals[CLIPBOARD_LIFECYCLE_SYMBOL], sentinel); assert.equal(shutdowns, 0);
			assert.deepEqual(readFileSync(historical), PNG); assert.equal(existsSync(join(root, "pi-clipboard-leases-v1")), false);
			assert.equal(resources.getExtensions().extensions.length, 1);
			assert.equal(resources.getExtensions().extensions[0]!.handlers.has("message_start"), false);
		};
		assertUnowned();
		const runtime = alphaModelRuntime((model, context) => {
			main++; assert.ok(context.messages.some(m => m.role === "user" && Array.isArray(m.content) && m.content.some(c => c.type === "image")));
			return response(model, []);
		});
		({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: resources, settingsManager: settings,
			sessionManager: SessionManager.inMemory(root), model: { ...ALPHA_MODEL, input: ["text", "image"] }, modelRuntime: runtime, noTools: "all" }));
		host = new AgentSessionRuntime(session, { cwd: root, agentDir: root } as never, async () => { throw new Error("unexpected replacement"); });
		const errors: unknown[] = []; await session.bindExtensions({ onError: error => { errors.push(error); } });
		await session.prompt("typed attachment", { images: [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }] });
		await session.prompt(historical);
		const user = session.messages.filter(m => m.role === "user").at(-1)!;
		assert.ok(Array.isArray(user.content) && user.content.some(c => c.type === "image"), "historical path still materializes");
		assertUnowned(); assert.equal(main, 2); assert.equal(requests, 0);
		await session.reload(); assertUnowned();
		await host.dispose(); assertUnowned(); assert.deepEqual(errors, []);
	} finally {
		try { if (host) await host.dispose(); else if (session) { session.dispose(); await session.waitForSessionLeaseRelease(); } }
		finally {
			globals[CLIPBOARD_LIFECYCLE_SYMBOL] = previous; globalThis.fetch = oldFetch;
			if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp;
			if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp;
			if (oldTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmpdir;
			if (oldAgent === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = oldAgent;
			assert.ok(resolve(root).startsWith(tempRoot + sep) && basename(root).startsWith("pi-attachment-bridge-"));
			rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
		}
	}
});

test("legacy and injected clipboard owners retain failure retry and identity-safe confirmation", { timeout: 5000 }, async () => {
	const tempRoot = process.platform === "win32" ? resolve(tmpdir()) : realpathSync.native(tmpdir());
	const root = mkdtempSync(join(tempRoot, "pi-attachment-legacy-"));
	const globals = globalThis as any, previous = globals[CLIPBOARD_LIFECYCLE_SYMBOL];
	const owners: ClipboardArtifactLifecycle[] = [];
	const shutdown: Array<() => unknown> = [];
	try {
		globals[CLIPBOARD_LIFECYCLE_SYMBOL] = undefined;
		const configPath = join(root, "vision.json"); writeFileSync(configPath, JSON.stringify({ model: "fixture/vision", toolMode: "off" }));
		let fail = true;
		for (const injected of [false, true]) {
			const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, tryNative: false, virtualModules: {
				...VIRTUAL_MODULES, "@super-pi/coding-agent": { getConfigDir: () => root, IMAGE_VISION_RESULT_TYPE: "image-vision-result-v1", ...(injected ? { IMAGE_ATTACHMENT_VERSION: 2 } : {}) },
				"@super-pi/ai/compat": { complete: async () => { if (fail) throw new Error("fixture vision failure"); return { stopReason: "stop", content: [{ type: "text", text: "fixture description" }], usage: {} }; } },
			} });
			const extension = await jiti.import<typeof auxiliaryVision>("../packages/extensions/auxiliary-vision/index.ts", { default: true });
			const handlers = new Map<string, any[]>(), tools = new Map<string, any>();
			const pi: any = { on: (name: string, handler: any) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
				registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, appendEntry() {} };
			const other = new ClipboardArtifactLifecycle({ tempDir: realpathSync.native(root) }); owners.push(other);
			if (injected) {
				globals[CLIPBOARD_LIFECYCLE_SYMBOL] = other.api;
				extension(pi, { systemTempDir: root, configPath });
				assert.equal(handlers.has("message_start"), false, "future native capability must not reinstall legacy bridge");
				handlers.get("session_shutdown")![0](); handlers.clear(); tools.clear();
			}
			const owner = injected ? new ClipboardArtifactLifecycle({ tempDir: root }) : undefined;
			if (owner) owners.push(owner);
			extension(pi, { systemTempDir: root, configPath, clipboardLifecycle: owner });
			const close = handlers.get("session_shutdown")![0]; shutdown.push(close);
			const registered = globals[CLIPBOARD_LIFECYCLE_SYMBOL];
			if (injected) assert.equal(registered, other.api); else assert.ok(registered?.ownerId);
			const image = () => { const path = join(root, `pi-clipboard-${randomUUID()}.png`); writeFileSync(path, PNG); return path; };
			const file = image(), foreign = image(); assert.equal(other.created({ path: realpathSync.native(foreign), mimeType: "image/png" }), true);
			const input = handlers.get("input")![0], accepted = handlers.get("message_start")![0];
			const ctx: any = { cwd: root, model: { input: ["text"] }, ui: { notify() {}, setStatus() {} },
				modelRegistry: { find: () => ({ provider: "fixture", id: "vision", input: ["text", "image"] }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-fixture" }) },
				sessionManager: { getBranch: () => [], getSessionId: () => "fixture" } };
			fail = true;
			const failed = await input({ text: file, source: "interactive" }, ctx);
			assert.match(failed.text, /auxiliary_vision_error/); assert.equal(failed.images.length, 1); assert.ok(existsSync(file));
			fail = false;
			const retry = await input({ text: file, source: "interactive" }, ctx);
			assert.match(retry.text, /fixture description/); assert.deepEqual(retry.images, []); assert.ok(existsSync(file));
			accepted({ message: { role: "assistant" } }); assert.ok(existsSync(file));
			accepted({ message: { role: "user" } }); assert.equal(existsSync(file), false);
			ctx.model.input = ["text", "image"];
			const changed = image(); await input({ text: changed, source: "interactive" }, ctx); writeFileSync(changed, Buffer.concat([PNG, Buffer.from("changed")]));
			await input({ text: foreign, source: "interactive" }, ctx); accepted({ message: { role: "user" } });
			assert.ok(existsSync(changed)); assert.ok(existsSync(foreign));
			const inspected = image(); const inspection = await tools.get("inspect_image").execute("inspect", { path: inspected, question: "describe" }, undefined, undefined, ctx);
			assert.equal(existsSync(inspected), false, JSON.stringify({ injected, root, inspected, details: inspection.details }));
			const owned = image(), creator = owner?.api ?? registered;
			assert.equal(creator.created({ path: owned, mimeType: "image/png" }), true);
			creator.editorChanged(owned); await Promise.resolve(); assert.ok(existsSync(owned)); creator.submitted(owned);
			fail = true;
			await assert.rejects(tools.get("inspect_image").execute("retry-inspect", { path: owned, question: "describe" }, undefined, undefined, ctx), /fixture vision failure/);
			assert.ok(existsSync(owned)); fail = false;
			await tools.get("inspect_image").execute("retry-inspect", { path: owned, question: "describe" }, undefined, undefined, ctx);
			assert.equal(existsSync(owned), false);
			const externalDir = join(root, `external-${injected}`); mkdirSync(externalDir);
			const sameName = image(), external = join(externalDir, basename(sameName)); writeFileSync(external, PNG);
			await tools.get("inspect_image").execute("external-inspect", { path: external, question: "describe" }, undefined, undefined, ctx);
			assert.ok(existsSync(external)); assert.ok(existsSync(sameName), "same UUID filename outside the exact temp root is not owned");
			const pending = image(); await input({ text: pending, source: "interactive" }, ctx); close(); shutdown.pop();
			assert.equal(existsSync(pending), false); assert.ok(existsSync(foreign)); assert.ok(existsSync(changed));
			assert.equal(globals[CLIPBOARD_LIFECYCLE_SYMBOL], injected ? other.api : undefined);
			other.shutdown(); if (injected) globals[CLIPBOARD_LIFECYCLE_SYMBOL] = undefined;
		}
		assert.equal(existsSync(join(root, "pi-clipboard-leases-v1")), false);
	} finally {
		try { for (const close of shutdown) close(); for (const owner of owners) owner.shutdown(); }
		finally {
			globals[CLIPBOARD_LIFECYCLE_SYMBOL] = previous;
			assert.ok(resolve(root).startsWith(tempRoot + sep) && basename(root).startsWith("pi-attachment-legacy-"));
			rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
		}
	}
});

test("real Windows clipboard aliases share live and stale lease boundaries", { timeout: 5000 }, async (t) => {
	const tempRoot = resolve(tmpdir());
	if (process.platform !== "win32" || tempRoot.toLowerCase() === realpathSync.native(tempRoot).toLowerCase()) {
		t.skip("No real short/long Windows temp-directory alias is available"); return;
	}
	const root = mkdtempSync(join(tempRoot, "pi-attachment-alias-"));
	const owners: ClipboardArtifactLifecycle[] = [];
	try {
		const nativeRoot = realpathSync.native(root); assert.notEqual(root.toLowerCase(), nativeRoot.toLowerCase());
		const image = (directory: string, aged = false) => {
			const path = join(directory, `pi-clipboard-${randomUUID()}.png`); writeFileSync(path, PNG);
			if (aged) { const date = new Date(Date.now() - 48 * 60 * 60 * 1000); utimesSync(path, date, date); }
			return path;
		};
		const owner = (directory: string) => { const instance = new ClipboardArtifactLifecycle({ tempDir: directory, processAlive: pid => pid === process.pid }); owners.push(instance); return instance; };
		const longOwner = owner(nativeRoot), longFile = image(nativeRoot, true);
		assert.equal(longOwner.created({ path: longFile, mimeType: "image/png" }), true);
		const shortOwner = owner(root); assert.ok(existsSync(longFile), "short-root startup protects the long-root active lease");
		const shortFile = image(root, true); assert.equal(shortOwner.created({ path: shortFile, mimeType: "image/png" }), true);
		const observer = owner(nativeRoot); assert.ok(existsSync(shortFile), "long-root startup protects the short-root active lease");
		const roots = await resolveExistingRoots([root]);
		for (const [consumer, file] of [[shortOwner, longFile], [observer, shortFile]] as const) {
			const loaded = await readBoundedImage(file, 1024, roots);
			consumer.materialized([{ ...loaded, path: loaded.resolvedPath }]); consumer.confirmMaterialized();
			assert.ok(existsSync(file), "a different spelling must not transfer live ownership");
		}
		const leaseDir = join(root, "pi-clipboard-leases-v1");
		const stale = (path: string) => {
			const state = lstatSync(path), ownerId = randomUUID();
			const manifest = join(leaseDir, `owner-${ownerId}.json`);
			const record = { path, mimeType: "image/png", dev: state.dev, ino: state.ino, size: state.size, mtimeMs: state.mtimeMs,
				createdAtMs: Date.now() - 10 * 60 * 1000, state: "materialized", sessionId: null };
			writeFileSync(manifest, JSON.stringify({ version: 1, ownerId, pid: -1, processStartedAtMs: 0, startupIdentity: "-1:0", updatedAtMs: 0, files: [record] }));
			return { manifest, record };
		};
		const overlapping = stale(join(root, basename(longFile)));
		owner(root); assert.ok(existsSync(longFile), "a dead lease must not override a live owner's alias");
		assert.ok(existsSync(overlapping.manifest)); assert.ok(existsSync(join(leaseDir, `owner-${longOwner.ownerId}.json`)));
		const staleLong = image(nativeRoot), longLease = stale(staleLong);
		owner(root); assert.equal(existsSync(staleLong), false); assert.equal(existsSync(longLease.manifest), false);
		const staleShort = image(root), shortLease = stale(staleShort);
		owner(nativeRoot); assert.equal(existsSync(staleShort), false); assert.equal(existsSync(shortLease.manifest), false);
		const changed = image(root), changedLease = stale(changed); writeFileSync(changed, Buffer.concat([PNG, Buffer.from("changed")]));
		const outsideDir = join(root, "outside"); mkdirSync(outsideDir);
		const outside = image(outsideDir), outsideLease = stale(outside);
		const unresolvedLease = stale(image(root));
		const unresolved = JSON.parse(readFileSync(unresolvedLease.manifest, "utf8"));
		unresolved.files[0].path = join(root, "missing-parent", basename(unresolvedLease.record.path));
		writeFileSync(unresolvedLease.manifest, JSON.stringify(unresolved));
		const link = join(root, `pi-clipboard-${randomUUID()}.png`); symlinkSync(outsideDir, link, "junction");
		const linkedLease = stale(link);
		owner(nativeRoot);
		assert.ok(existsSync(changed)); assert.ok(existsSync(changedLease.manifest));
		assert.ok(existsSync(outside)); assert.ok(existsSync(outsideLease.manifest));
		assert.ok(existsSync(unresolvedLease.record.path)); assert.ok(existsSync(unresolvedLease.manifest), "failed alias resolution is not a missing-file receipt");
		assert.ok(lstatSync(link).isSymbolicLink()); assert.ok(existsSync(linkedLease.manifest));
		assert.ok(existsSync(longFile)); assert.ok(existsSync(shortFile));
		for (const instance of owners) {
			instance.shutdown(); assert.equal((instance as any).records.size, 0);
			assert.equal((instance as any).pendingEditorText, ""); assert.equal((instance as any).editorReconcileQueued, false);
		}
		assert.equal(existsSync(longFile), false); assert.equal(existsSync(shortFile), false);
		t.diagnostic("Actual Windows short/long aliases: bidirectional live protection and stale cleanup passed");
	} finally {
		try { for (const instance of owners) instance.shutdown(); }
		finally {
			assert.ok(resolve(root).startsWith(tempRoot + sep) && basename(root).startsWith("pi-attachment-alias-"));
			rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
		}
	}
});

test("shared image input patterns preserve matching and replacement state across calls", () => {
	const replacements = new Set([imagePatterns.IMAGE_LABEL_CONTROL_PATTERN, imagePatterns.IMAGE_DESCRIPTION_LINE_BREAK_PATTERN, imagePatterns.IMAGE_DESCRIPTION_CONTROL_PATTERN]);
	for (const pattern of Object.values(imagePatterns)) {
		assert.equal(pattern.sticky, false);
		assert.equal(pattern.global, replacements.has(pattern));
	}
	try {
		for (let iteration = 0; iteration < 3; iteration++) {
			for (const pattern of replacements) pattern.lastIndex = 99;
			assert.equal(attachmentDescription("one\r\ntwo\u061c"), "one\ntwo�");
			assert.equal(attachmentLabel("name\x1b.png"), "name�.png");
			assert.deepEqual(parseImagePaths('"C:\\safe path\\一🦖.PNG"'), ["C:\\safe path\\一🦖.PNG"]);
			assert.equal(parseImagePaths("example.png"), undefined);
			assert.equal(imagePatterns.IMAGE_FILE_EXTENSION_PATTERN.exec("photo.JPEG")?.[1], "JPEG");
			for (const pattern of replacements) assert.equal(pattern.lastIndex, 0);
		}
	} finally { for (const pattern of replacements) pattern.lastIndex = 0; }
});

function serializedResponse(model: any, context: any, expectedImage: boolean, answer: string) {
 return responsesStream({ ...model, api: "openai-responses" }, context, { apiKey: "offline", maxRetries: 0,
  fetch: async (_url, init) => {
   const wire = String(init?.body);
   assert.doesNotMatch(wire, /imageSubmission|application-snapshot|contentIndex/);
   if (expectedImage) assert.match(wire, /input_image.*data:image\/png;base64,iVBOR/);
   else assert.doesNotMatch(wire, /input_image|iVBOR/);
   const item = { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [] }] };
   const events = [{ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "r", status: "completed", output: [item] } }];
   return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
 });
}

function interactive(session: any): any {
	const mode: any = new InteractiveMode({ session, setBeforeSessionInvalidate() {}, setRebindSession() {} } as never);
	mode.setupKeyHandlers(); mode.setupEditorSubmitHandler();
	// This method-level fixture skips init(); establish its real editor focus
	// explicitly, as init() does before accepting clipboard gestures.
	mode.ui.setFocus(mode.editor);
	mode.showWarning = (message: string) => { mode.warning = message; };
	return mode;
}

for (const source of ["clipboard-image-paste", "path-paste"] as const) for (const auxiliary of [false, true]) {
	test(`${source} + ${auxiliary ? "auxiliary" : "multimodal"}: same visible draft and real submission route`, async () => {
		const events: string[] = [];
		let auxCalls = 0, mainCalls = 0;
		const configRoot = mkdtempSync(join(tmpdir(), "pi-image-config-"));
		const configPath = join(configRoot, "vision.json");
		writeFileSync(configPath, JSON.stringify({ model: "offline/vision", automatic: true, toolMode: "off" }));
		const f = await fixture(false, false, auxiliary ? [(pi) => auxiliaryVision(pi, { configPath, systemTempDir: configRoot })] : []);
		const mode = interactive(f.session);
		const vision = { ...f.session.model!, provider: "offline", id: "vision", input: ["text", "image"], api: "offline-vision" } as any;
		const runtime = (f.session as any)._modelRuntime;
		runtime.getModel = () => vision;
		runtime.getAuth = async () => ({ auth: { apiKey: "offline-fixture" } });
		if (!auxiliary) f.session.agent.state.model = { ...f.session.model!, input: ["text", "image"] };
		registerApiProvider({ api: "offline-vision", stream: (model: any, context: any) => {
			auxCalls++; events.push("vision");
			assert.equal(context.messages[0].content.filter((p: any) => p.type === "image").length, 1);
			return serializedResponse(model, context, true, "图 1：a single white pixel");
		}, streamSimple: (() => { throw new Error("unexpected"); }) as any }, "image-test");
		f.session.agent.streamFunction = (model, context) => {
			mainCalls++; events.push("main");
			const wire = JSON.stringify(context.messages);
			assert.doesNotMatch(wire, /imageSubmission|application-snapshot|contentIndex/);
			if (auxiliary) { assert.doesNotMatch(wire, /iVBOR|"type":"image"/); assert.match(wire, /single white pixel/); }
			else assert.match(wire, /iVBOR/);
			return serializedResponse(model, context, !auxiliary, "done");
		};
		const file = join(f.root, "本地 空格 🐉 & $().png");
		writeFileSync(file, PNG);
		try {
			if (source === "clipboard-image-paste") {
				mode.readClipboardImageForPaste = async () => ({ bytes: PNG, mimeType: "image/png" });
				await mode.handleClipboardPaste();
			} else {
				mode.defaultEditor.handleInput(`\x1b[200~"${file}"\x1b[201~`);
				while (mode.imageDraft.busy) await turn();
			}
			events.push("local");
			assert.equal(mode.imageDraft.items.length, 1);
			assert.equal(mode.imageDraft.items[0].state, "ready");
			const rendered = mode.defaultEditor.render(100).join("\n");
			assert.match(rendered, /图片 1/); assert.match(rendered, /未发送/); events.push("visible");
			for (const Screen of [TuiMainScreen, TuiAltScreen]) {
				const terminal = new FakeTerminal(100, 24);
				const screen = new Screen(terminal);
				screen.addChild(mode.defaultEditor); screen.setFocus(mode.defaultEditor); screen.start();
				try {
					screen.renderNow(true); await screen.flushTerminalFrames();
					assert.match(terminal.writes.join(""), /未发送/);
				} finally { await screen.stop(); }
			}
			mode.defaultEditor.setText("original question");
			for (const width of [40, 120, 60]) mode.defaultEditor.render(width);
			assert.deepEqual([auxCalls, mainCalls], [0, 0]);
			events.push("submit");
			await mode.defaultEditor.onSubmit("original question");
			assert.deepEqual([auxCalls, mainCalls], [auxiliary ? 1 : 0, 1]);
			assert.deepEqual(events, ["local", "visible", "submit", ...(auxiliary ? ["vision"] : []), "main"]);
			const user = f.session.agent.state.messages.find(m => m.role === "user") as any;
			assert.equal(user.content[0].text, "original question");
			assert.equal(user.imageSubmission.attachments.length, 1);
			assert.equal(user.content[1].type, "image");
			mode.addMessageToChat(user);
			assert.match(mode.chatContainer.render(100).join("\n"), /图片 1.*已提交/);
			const stored = f.session.sessionManager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "user") as any;
			assert.equal(stored.message.imageSubmission.id, user.imageSubmission.id);
			assert.ok(existsSync(file)); assert.deepEqual(readFileSync(file), PNG);
			if (auxiliary) {
				const derived = f.session.sessionManager.getBranch().find((entry: any) => entry.customType === "image-vision-result-v1");
				assert.ok(derived); mode.addCustomEntryToChat(derived);
				assert.match(mode.chatContainer.render(100).join("\n"), /辅助视觉结果（派生）/);
				await f.session.prompt("retry context");
				assert.equal(auxCalls, 1, "completed derivation reused on next request");
			}
		} finally { unregisterApiProviders("image-test"); await f.session.extensionRunner.emit({ type: "session_shutdown" } as any); f.close(); rmSync(configRoot, { recursive: true }); }
	});
}

test("draft blocks early send, failed images, late completion and removes without touching text", async () => {
	let renders = 0;
	const draft = new ImageAttachmentDraft(() => renders++);
	const item = draft.begin("capture", "clipboard");
	assert.throws(() => draft.submit(), /尚未就绪/);
	await draft.finish(item, PNG);
	assert.match(draftAttachmentText(draft.items), /未发送/);
	const next = draft.begin("bad", "local-file"); await draft.finish(next, Buffer.from("bad"));
	assert.throws(() => draft.submit(), /失败/); draft.remove(1);
	const saved = draft.submit(); assert.equal(draft.items.length, 0); assert.equal(saved.images.length, 1);
	draft.restore(saved.images, saved.submission); assert.equal(draft.items.length, 1);
	draft.clear(); await draft.finish(item, PNG); assert.equal(draft.items.length, 0); assert.ok(renders >= 6);
});

test("path parsing is bounded, literal and only intercepts complete path-only paste units", () => {
	assert.deepEqual(parseImagePaths('"C:\\中文 空格 🐉 & $().png" \'D:\\two.webp\''), ["C:\\中文 空格 🐉 & $().png", "D:\\two.webp"]);
	assert.equal(parseImagePaths('console.log("C:\\private.png")'), undefined);
	assert.equal(parseImagePaths("explain ./file.png"), undefined);
	assert.deepEqual(parseImagePaths("'./file.png'", true), ["./file.png"]);
	assert.equal(localImagePath(pathToFileURL(join(process.cwd(), "x.png")).href, process.cwd()), join(process.cwd(), "x.png"));
	assert.throws(() => localImagePath("file://server/private.png", process.cwd()), /远程/);
	assert.throws(() => localImagePath("\\\\server\\share\\private.png", process.cwd()), /本地/);
});

test("clipboard child timeout, cancellation and output limit settle asynchronously", async () => {
	await assert.rejects(runClipboardCommand(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 20 }), /Clipboard helper/);
	await assert.rejects(runClipboardCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], { maxBufferBytes: 100 }), /Clipboard helper/);
	const abort = new AbortController();
	const run = runClipboardCommand(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { signal: abort.signal }); abort.abort();
	await assert.rejects(run, /Clipboard helper/);
});

test("image-only submit, immutable snapshots, corrupt files and missing backend fail closed", async () => {
	const f = await fixture(false, false);
	const mode = interactive(f.session);
	let calls = 0;
	f.session.agent.streamFunction = (model) => { calls++; return response(model, []); };
	try {
		const input = mode.imageDraft.begin("empty question.png", "clipboard");
		await mode.imageDraft.finish(input, PNG);
		await mode.defaultEditor.onSubmit("");
		assert.equal(calls, 0, "no raw images reach a text-only model without auxiliary vision");
		assert.ok(f.session.agent.state.messages.some(m => m.role === "user" && (m as any).imageSubmission));
		f.session.agent.state.model = { ...f.session.model!, input: ["text", "image"] };
		await f.session.prompt("retry"); assert.equal(calls, 1);
		const path = join(f.root, "source.png"); writeFileSync(path, PNG);
		await mode.imageDraft.addFiles([path], f.cwd);
		writeFileSync(path, "replaced after local validation");
		const saved = mode.imageDraft.submit(); assert.equal(saved.images[0].data, PNG.toString("base64"));
		await mode.imageDraft.addFiles([path], f.cwd);
		assert.equal(mode.imageDraft.items[0].state, "failed");
		assert.throws(() => mode.imageDraft.submit(), /失败/);
		mode.imageDraft.clear();
		const corrupt = mode.imageDraft.begin("corrupt.png", "clipboard");
		await mode.imageDraft.finish(corrupt, PNG.subarray(0, 35));
		assert.equal(mode.imageDraft.items[0].state, "failed");
	} finally { mode.imageDraft.clear(); f.close(); }
});

test("same-text queued images retain identity and transfer back to draft without provider work", async () => {
	const f = await fixture(false, false);
	let calls = 0; f.session.agent.streamFunction = model => { calls++; return response(model, []); };
	try {
		for (let index = 0; index < 2; index++) await f.session.steer("same text", [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
		assert.equal(calls, 0);
		assert.equal(f.session.pendingMessageCount, 2);
		assert.notEqual(f.session.getSteeringMessages()[0], f.session.getSteeringMessages()[1]);
		const returned = f.session.clearQueue(); assert.equal(returned.imageMessages.length, 2);
		assert.equal(f.session.pendingMessageCount, 0); assert.equal(f.session.agent.hasQueuedMessages(), false);
		const draft = new ImageAttachmentDraft(() => {});
		for (const item of returned.imageMessages) draft.restore(item.images, item.submission);
		assert.match(draftAttachmentText(draft.items), /图片 2/); draft.clear(); assert.equal(draft.items.length, 0);
	} finally { f.close(); }
});

test("restoring queued submissions remaps duplicate attachment IDs for independent removal", () => {
	const first = snapshotImageSubmission([{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }]);
	const second = snapshotImageSubmission([{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }]);
	second.submission.attachments[0].id = first.submission.attachments[0].id;
	const draft = new ImageAttachmentDraft(() => {});
	try {
		draft.restore(first.images, first.submission);
		draft.restore(second.images, second.submission);
		assert.equal(new Set(draft.items.map(item => item.id)).size, 2);
		const firstId = draft.items[0].id;
		draft.remove(0);
		assert.equal(draft.items.length, 1);
		assert.notEqual(draft.items[0].id, firstId);
	} finally { draft.clear(); }
});

test("no-UI question returns requires_user_input and ends the SDK run", async () => {
	const f = await fixture(false, false);
	let calls = 0;
	f.session.agent.streamFunction = model => {
		calls++; return response(model, [{ type: "toolCall", id: "q", name: "ask_user", arguments: { question: "Choose", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }]);
	};
	try {
		await f.session.prompt("question"); assert.equal(calls, 1);
		assert.match(JSON.stringify(f.session.agent.state.messages), /requires_user_input/);
	} finally { f.close(); }
});

test("SDK tools, excludeTools and noTools keep ask_user disabled when requested", async () => {
	const f = await fixture(false, false);
	try {
		f.session.dispose(); await f.session.waitForSessionLeaseRelease();
		for (const options of [{ tools: ["read"] }, { excludeTools: ["ask_user"] }, { noTools: "all" as const }, { noTools: "builtin" as const }]) {
			await f.session.resourceLoader.reload();
			const { session } = await createAgentSession({ cwd: f.cwd, agentDir: join(f.root, "agent"), model: f.session.model,
				modelRuntime: f.session.modelRuntime, resourceLoader: f.session.resourceLoader, sessionManager: SessionManager.inMemory(f.cwd),
				settingsManager: f.settings, ...options });
			try { assert.equal(session.getActiveToolNames().includes("ask_user"), false); }
			finally { session.dispose(); await session.waitForSessionLeaseRelease(); }
		}
	} finally { f.close(); }
});

test("ask_user exposes bounded guidance and waits for a submitted text answer", async () => {
	const f = await fixture(false, false);
	let answer!: (value?: string) => void;
	let shown!: () => void;
	const visible = new Promise<void>(resolve => { shown = resolve; });
	let calls = 0;
	const runner = f.session.extensionRunner;
	runner.setUIContext({ ...runner.getUIContext(), input: async () => {
		shown();
		return new Promise(resolve => { answer = resolve; });
	} }, "tui");
	const tool = f.session.agent.state.tools.find(candidate => candidate.name === "ask_user") as any;
	assert.equal(tool?.interactionBoundary, true);
	assert.match(f.session.agent.state.systemPrompt, /Ask one bounded question and wait for an explicit user answer/);
	assert.match(f.session.agent.state.systemPrompt, /call ask_user and wait for its result/);
	try {
		f.session.agent.streamFunction = model => {
			calls++;
			return response(model, calls === 1
				? [{ type: "toolCall", id: "text-q", name: "ask_user", arguments: { question: "What should the title be?" } }]
				: [{ type: "text", text: "replanned" }]);
		};
		const run = f.session.prompt("need a preference");
		await visible;
		for (let index = 0; index < 4; index++) await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(calls, 1);
		assert.equal(f.session.agent.state.messages.filter(message => message.role === "toolResult").length, 0);
		answer("Use the compact title");
		await run;
		assert.equal(calls, 2);
		const result = f.session.agent.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "text-q") as any;
		assert.ok(result);
		assert.match(result.content[0].text, /Use the compact title/);
	} finally { f.close(); }
});

test("early Enter during clipboard preparation retains text and requires a new submit", async () => {
	const f = await fixture(false, false);
	const mode = interactive(f.session);
	f.session.agent.state.model = { ...f.session.model!, input: ["text", "image"] };
	let receive!: (value: any) => void, calls = 0;
	mode.readClipboardImageForPaste = () => new Promise(resolve => { receive = resolve; });
	f.session.agent.streamFunction = model => { calls++; return response(model, []); };
	try {
		const paste = mode.handleClipboardPaste();
		await mode.defaultEditor.onSubmit("keep this text");
		assert.match(mode.warning, /尚未就绪/); assert.equal(mode.editor.getText(), "keep this text");
		receive({ bytes: PNG, mimeType: "image/png" }); await paste;
		await turn(); assert.equal(calls, 0); assert.match(mode.defaultEditor.render(80).join("\n"), /未发送/);
		await mode.defaultEditor.onSubmit("keep this text"); assert.equal(calls, 1);
	} finally { mode.imageDraft.clear(); f.close(); }
});

test("blockImages does not call auxiliary vision or silently drop submitted attachments", async () => {
	let intercepted = 0, calls = 0;
	const f = await fixture(false, false, [pi => { pi.on("input", () => { intercepted++; return { action: "continue" }; }); }]);
	const mode = interactive(f.session);
	f.settings.setBlockImages(true);
	f.session.agent.streamFunction = model => { calls++; return response(model, []); };
	try {
		const item = mode.imageDraft.begin("private.png", "clipboard"); await mode.imageDraft.finish(item, PNG);
		await mode.defaultEditor.onSubmit("private question");
		assert.equal(calls, 0); assert.equal(intercepted, 0);
		assert.match(JSON.stringify(f.session.agent.state.messages), /blockImages/);
		assert.ok(f.session.agent.state.messages.some(m => m.role === "user" && (m as any).imageSubmission));
	} finally { f.close(); }
});

test("SDK ask_user pauses mixed batch, then replans; cancellation preserves pending queue", async () => {
	for (const cancel of [false, true]) {
		let reportEntered!: () => void, releaseReport!: () => void;
		const entered = new Promise<void>(resolve => { reportEntered = resolve; });
		const released = new Promise<void>(resolve => { releaseReport = resolve; });
		const f = await fixture(false, false, [pi => { pi.on("message_end", async event => {
			if (event.message.role === "custom" && event.message.content === "background report") {
				reportEntered(); await released;
			}
		}); }]);
		let choose!: (value?: string) => void, shown!: () => void;
		const visible = new Promise<void>(resolve => { shown = resolve; });
		let calls = 0, effects = 0;
		const runner = f.session.extensionRunner;
		runner.setUIContext({ ...runner.getUIContext(), select: async (_title, choices) => {
			shown(); return new Promise(resolve => { choose = value => resolve(value === "yes" ? choices[1] : undefined); });
		} }, "tui");
		const tool = f.session.agent.state.tools.find(t => t.name === "ask_user"); assert.ok(tool?.interactionBoundary);
		f.session.agent.state.tools.push({ name: "effect", label: "effect", description: "offline", parameters: { type: "object", properties: {} } as any,
			execute: async () => { effects++; return { content: [], details: {} }; } });
		f.session.agent.streamFunction = (model, context) => {
			calls++;
			if (calls > 1) assert.match(JSON.stringify(context.messages), /Not executed: user interaction boundary/);
			return response(model, calls === 1 ? [
				{ type: "toolCall", id: "e", name: "effect", arguments: {} },
				{ type: "toolCall", id: "q", name: "ask_user", arguments: { question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } },
			] : [{ type: "text", text: "replanned" }]);
		};
		const deliveries: Promise<void>[] = [];
		try {
			const run = f.session.prompt("question"); await visible;
			for (let index = 0; index < 4; index++) await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(calls, 1); assert.equal(effects, 0);
			if (cancel) await f.session.followUp("must stay queued");
			choose(cancel ? undefined : "yes"); choose("yes"); await run;
			assert.equal(effects, 0); assert.equal(calls, cancel ? 1 : 2);
			if (cancel) {
				assert.equal(f.session.pendingMessageCount, 1);
				const firstReport = f.session.sendCustomMessage({ customType: "subagent-completion", content: "background report", display: true },
					{ triggerTurn: true, deliverAs: "followUp" });
				deliveries.push(firstReport);
				await entered;
				assert.equal(f.session.isIdle, false, "a paused report owns persistence until its hooks finish");
				const drain = (f.session as any)._customMessageFlush;
				const secondReport = f.session.sendCustomMessage({ customType: "subagent-completion", content: "second report", display: true },
					{ triggerTurn: true, deliverAs: "followUp" });
				deliveries.push(secondReport);
				assert.equal((f.session as any)._customMessageFlush, drain, "concurrent reports share one drain owner");
				assert.equal(calls, 1, "a background report must not answer the cancelled question");
				assert.equal(f.session.pendingMessageCount, 1);
				const answer = f.session.prompt("Use A");
				deliveries.push(answer);
				await turn();
				assert.equal(calls, 1, "the user turn waits for report persistence before admission");
				assert.equal(f.session.sessionManager.getEntries().filter(e => e.type === "custom_message").length, 0);
				releaseReport();
				await Promise.all([firstReport, secondReport, answer]);
				assert.equal(calls, 3, "the explicit answer resumes first, then the preserved follow-up runs");
				assert.equal(f.session.pendingMessageCount, 0);
				const select = (messages: typeof f.session.messages) => messages.filter(m => m.role === "custom" || m.role === "user")
					.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
				const live = select(f.session.messages);
				assert.deepEqual(select(f.session.sessionManager.buildSessionContext().messages), live);
				assert.deepEqual(live.slice(1, 3), ["background report", "second report"]);
				assert.match(live[3], /Use A/);
				assert.equal((f.session as any)._customMessageFlush, undefined);
				assert.equal((f.session as any)._pendingCustomMessages.length, 0);
			}
		} finally { releaseReport(); await Promise.allSettled(deliveries); f.close(); }
	}
});

test("submitted vision needs explicit configuration and failure never auto-retries or drains follow-up", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-vision-failure-"));
	const configPath = join(root, "vision.json");
	try {
		assert.throws(() => loadConfig(configPath, true), /配置/);
		for (const value of ["{broken", "[]", "{}", '{"model":"missing-provider"}']) {
			writeFileSync(configPath, value); assert.throws(() => loadConfig(configPath, true), /配置/);
		}
		let vision = 0, main = 0;
		let entered!: () => void, reject!: (error: Error) => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const f = await fixture(false, false, [pi => {
			pi.on("input", event => {
				if (!event.submissionId) return { action: "continue" };
				vision++; entered(); return new Promise((_resolve, fail) => { reject = fail; });
			}, { phase: "image-processing" });
		}]);
		try {
			f.settings.setRetryEnabled(true);
			f.session.agent.streamFunction = model => { main++; return response(model, []); };
			const run = f.session.prompt("picture", { images: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] });
			await started; await f.session.followUp("keep queued"); reject(new Error("503 overloaded timeout")); await run;
			assert.equal(vision, 1); assert.equal(main, 0); assert.equal(f.session.pendingMessageCount, 1);
			assert.match(JSON.stringify(f.session.messages), /Image submission blocked/);
		} finally { f.close(); }
	} finally { rmSync(root, { recursive: true }); }
});

test("blockImages applies to inspect_image before execution and queue capacity remains bounded", async () => {
	const f = await fixture(false, false);
	try {
		let executed = 0;
		f.settings.setBlockImages(true);
		f.session.agent.state.tools.push({ name: "inspect_image", label: "image", description: "offline", parameters: { type: "object", properties: {} } as any,
			execute: async () => { executed++; return { content: [], details: {} }; } });
		await f.runCalls([{ name: "inspect_image", arguments: {} }]);
		assert.equal(executed, 0); assert.match(JSON.stringify(f.session.messages), /blockImages/);
		const image = { type: "image" as const, data: PNG.toString("base64"), mimeType: "image/png" };
		for (let i = 0; i < 4; i++) await f.session.followUp("queued", Array(8).fill(image));
		await assert.rejects(f.session.followUp("overflow", [image]), /queue/);
		assert.equal(f.session.getQueuedImageSize().count, 32);
		f.session.clearQueue(); assert.deepEqual(f.session.getQueuedImageSize(), { count: 0, bytes: 0 });
	} finally { f.close(); }
});
