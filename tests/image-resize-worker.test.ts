import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { ExtensionContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import { resizeImage } from "../packages/coding-agent/src/utils/image-resize.ts";
import { pngFixture } from "./helpers/image-acceptance-fixtures.ts";

const png = pngFixture(8, 4);
const postMessage = Worker.prototype.postMessage;

function interceptWorker(t: TestContext, send: (worker: Worker, args: Parameters<Worker["postMessage"]>) => void) {
	let worker: Worker | undefined;
	let exits = 0;
	t.mock.method(Worker.prototype, "postMessage", function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
		assert.equal(worker, undefined, "one worker per attempt");
		worker = this;
		this.once("exit", () => { exits++; });
		send(this, args);
	});
	t.after(async () => { if (worker && worker.threadId !== -1) await worker.terminate(); });
	return () => {
		assert.ok(worker);
		assert.equal(worker.threadId, -1, "worker stopped before returning");
		assert.equal(exits, 1);
		for (const event of ["message", "error", "exit"]) assert.equal(worker.listenerCount(event), 0, `${event} listeners released`);
	};
}

test("resize ignores unrelated and malformed messages before the real worker result", async t => {
	let actualResponse: unknown;
	const released = interceptWorker(t, (worker, args) => {
		for (const message of [
			{ type: "load", url: "node:internal/worker" }, null, "diagnostic", [],
			{ result: null }, { error: "unrelated" }, { type: "image-resize-result" },
			{ type: "image-resize-result", result: {} },
			{ type: "image-resize-result", result: { data: "", mimeType: "image/png", originalWidth: 8, originalHeight: 4, width: NaN, height: 2, wasResized: true } },
			{ type: "image-resize-result", error: 1 },
			{ type: "image-resize-result", result: null, error: "ambiguous" },
		]) worker.emit("message", message);
		worker.on("message", response => { actualResponse = response; });
		postMessage.apply(worker, args);
	});
	const before = Buffer.from(png);
	const result = await resizeImage(png, "image/png", { maxWidth: 4 });
	assert.ok(result, "extra worker messages must not omit the image");
	assert.equal(result.width, 4);
	assert.equal(result.height, 2);
	assert.equal(result.wasResized, true);
	assert.deepEqual(actualResponse, { type: "image-resize-result", result });
	assert.deepEqual(png, before, "the transfer must not detach or mutate caller bytes");
	released();
});

test("an explicit null result remains null and releases the worker", async t => {
	const released = interceptWorker(t, (worker, args) => postMessage.apply(worker, args));
	assert.equal(await resizeImage(png, "image/png", { maxBytes: 1 }), null);
	released();
});

for (const failure of ["response", "runtime", "exit", "post"] as const) {
	test(`worker ${failure} failure cleans up before fallback and ignores late results`, async t => {
		const released = interceptWorker(t, worker => {
			worker.emit("message", { type: "load" });
			if (failure === "response") worker.emit("message", { type: "image-resize-result", error: "" });
			if (failure === "runtime") worker.emit("error", new Error("fixture worker failure"));
			if (failure === "exit") { void worker.terminate(); return; }
			if (failure === "post") throw new Error("fixture post failure");
			worker.emit("message", { type: "image-resize-result", result: null });
		});
		const result = await resizeImage(png, "image/png");
		assert.equal(result?.data, png.toString("base64"), "fallback must return the original small image");
		released();
	});
}

test("real worker sends a typed error for an invalid request", async () => {
	const worker = new Worker(new URL("../packages/coding-agent/src/utils/image-resize-worker.ts", import.meta.url));
	try {
		const response = once(worker, "message");
		worker.postMessage(null);
		assert.deepEqual((await response)[0], { type: "image-resize-result", error: "Invalid image resize worker request" });
	} finally {
		await worker.terminate();
		worker.removeAllListeners();
	}
});

test("cancelled read stays rejected while its real image worker finishes and releases listeners", async t => {
	const { createReadToolDefinition } = await import("../packages/coding-agent/src/core/tools/read.ts");
	const controller = new AbortController();
	let resume: (() => void) | undefined;
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	let exited: Promise<unknown> | undefined;
	const released = interceptWorker(t, (worker, args) => {
		exited = once(worker, "exit");
		resume = () => postMessage.apply(worker, args);
		worker.emit("message", { type: "load" });
		entered();
	});
	const tool = createReadToolDefinition(process.cwd(), {
		operations: { access: async () => {}, readFile: async () => png, detectImageMimeType: async () => "image/png" },
	});
	let completions = 0;
	const reading = tool.execute("cancel-image", { path: "fixture.png" }, controller.signal, undefined, {} as ExtensionContext);
	const observed = reading.then(() => { completions++; }, error => { completions++; throw error; });
	const rejected = assert.rejects(observed, /Operation aborted/);
	try {
		await started;
		controller.abort();
		await rejected;
		resume!();
		await exited;
		await nextTurn();
		released();
		assert.equal(completions, 1, "late image completion cannot complete the cancelled read again");
	} finally {
		controller.abort();
	}
});
