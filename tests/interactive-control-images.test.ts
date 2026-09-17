import { tmpdir } from "node:os";
import { stream as responsesStream } from "../packages/ai/src/api/openai-responses.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as turn } from "node:timers/promises";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";
import { response } from "./helpers/selected-integration-fixture.ts";
import { ImageAttachmentDraft, draftAttachmentText, parseImagePaths, localImagePath, attachmentLabel, attachmentDescription } from "../packages/coding-agent/src/core/image-attachments.ts";
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
initTheme("dark");

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
		for (const options of [{ tools: ["read"] }, { excludeTools: ["ask_user"] }, { noTools: "all" as const }, { noTools: "builtin" as const }]) {
			const { session } = await createAgentSession({ cwd: f.cwd, agentDir: join(f.root, "agent"), model: f.session.model,
				modelRuntime: f.session.modelRuntime, resourceLoader: f.session.resourceLoader, sessionManager: SessionManager.inMemory(f.cwd),
				settingsManager: f.settings, ...options });
			try { assert.equal(session.getActiveToolNames().includes("ask_user"), false); }
			finally { session.dispose(); }
		}
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
		const f = await fixture(false, false);
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
		try {
			const run = f.session.prompt("question"); await visible;
			await turn(); assert.equal(calls, 1); assert.equal(effects, 0);
			if (cancel) await f.session.followUp("must stay queued");
			choose(cancel ? undefined : "yes"); choose("yes"); await run;
			assert.equal(effects, 0); assert.equal(calls, cancel ? 1 : 2);
			if (cancel) assert.equal(f.session.pendingMessageCount, 1);
		} finally { f.close(); }
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
