/**
 * Worker thread entry. Each script runs inside a fresh QuickJS VM
 * (a separate wasm instance), relays tool calls and output to the host, and
 * reports the result after VM disposal. The host may reuse a healthy thread;
 * failures, timeout and cancellation terminate it so spinning scripts never
 * block the host thread.
 *
 * Importing this module starts the worker. Hosts that bundle their code (for
 * example a Bun compiled executable) add a file that imports
 * `@earendil-works/pi-codemode/worker` as a separate entrypoint and pass its URL
 * or embedded-module string specifier as `workerUrl`.
 */
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import { BridgeBudget, isHostToWorkerMessage, type WorkerData, type WorkerToHostMessage } from "./protocol.ts";
import { MAX_ERROR_CHARS } from "../limits.ts";

/**
 * QuickJS writes engine diagnostics to fd 1 and 2, which the default shim
 * forwards to the host's stdout and stderr. That output belongs to the host
 * application (for example a TUI), so it is discarded. Reporting every byte as
 * written keeps libc from retrying.
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}
			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	};
}

function describeException(error: JSException): string {
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({ name: error.name, message: error.message.slice(0, MAX_ERROR_CHARS), stack: (stack ? `${head}\n${stack}` : head).slice(0, MAX_ERROR_CHARS) });
}

async function main(data: WorkerData, port: MessagePort): Promise<void> {
	const budget = new BridgeBudget();
	let terminal: WorkerToHostMessage | undefined;
	let timers: Map<number, ReturnType<typeof setTimeout>> | undefined;
	// Error-path primitives only, bounded by the existing host-call limit. The
	// private prelude owns errors until VM disposal, preventing identity reuse.
	let origins: Map<number, { id: number; unhandled: number }> | undefined;
	let unhandledRejections = 0, uncaughtCallId = 0;
	const interrupt = new Int32Array(data.interrupt);
	let memory: { readonly buffer: ArrayBufferLike } | undefined;
	const captureMemory = (value: { readonly buffer: ArrayBufferLike }) => {
		memory = value;
		return discardOutput(value);
	};
	function post(message: WorkerToHostMessage): void {
		if (terminal) return;
		if (!budget.consume(message)) {
			terminal = { type: "crash", message: "Codemode bridge limit exceeded" };
			Atomics.store(interrupt, 0, 1);
		} else if (message.type === "done" || message.type === "crash") terminal = message;
		else port.postMessage(message);
	}
	function crash(error: unknown): void {
		// Completion cancels unawaited VM jobs; their interrupt must not replace the result.
		if (terminal) return;
		terminal = { type: "crash", message: (error instanceof Error ? `${error.name}: ${error.message}` : "VM failure").slice(0, MAX_ERROR_CHARS) };
	}
	const vm = await QuickJS.create({
		wasm: data.wasm,
		onUnhandledRejection(_promise: JSValueHandle, reason: JSValueHandle, handled: boolean) {
			unhandledRejections += handled ? -1 : 1;
			const origin = origins?.get(reason.identity);
			if (origin) origin.unhandled += handled ? -1 : 1;
		},
		memoryLimit: data.memoryLimitBytes,
		// Without a guard, deep recursion overflows the wasm stack and traps instead of throwing a
		// catchable RangeError.
		maxStackSize: MAX_STACK_SIZE,
		interruptHandler: () => terminal !== undefined || Atomics.load(interrupt, 0) !== 0,
		wasi: captureMemory,
	});
	let onMessage: ((message: unknown) => void) | undefined;
	function finish(): void {
		if (!terminal) return;
		if (terminal.type === "done") {
			if (terminal.ok && unhandledRejections > 0) terminal = { type: "done", ok: false,
				error: JSON.stringify({ name: "Error", message: "Codemode ended with unhandled Promise rejections" }), reusable: false };
			if (origins) {
				const handledCallIds: number[] = [];
				for (const origin of origins.values()) if (origin.unhandled === 0 && origin.id !== uncaughtCallId) handledCallIds.push(origin.id);
				terminal.handledCallIds = handledCallIds;
			}
		}
		if (onMessage) port.removeListener("message", onMessage);
		onMessage = undefined;
		if (timers) { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); timers = undefined; }
		// Never dispose from a VM callback: wait until run/delivery and its job drain unwind.
		if (terminal.type === "done") terminal.reusable = memory!.buffer.byteLength <= 64 * 1024 * 1024;
		if (origins) { origins.clear(); origins = undefined; }
		vm.dispose();
		memory = undefined;
		port.postMessage(terminal);
		port.close();
	}
	try {

		// The private prelude supplies primitives and original host-rejection errors.
		const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
			switch (kind.toString()) {
				case "rejection": {
					origins ??= new Map();
					origins.set(b.identity, { id: a.toNumber(), unhandled: 0 });
					break;
				}
				case "uncaught":
					uncaughtCallId = origins?.get(a.identity)?.id ?? 0;
					break;
				case "timer":
					timers ??= new Map();
					timers.set(a.toNumber(), setTimeout(fireTimer, b.toNumber(), a.toNumber()));
					break;
				case "clearTimer":
					clearTimeout(timers?.get(a.toNumber()));
					timers?.delete(a.toNumber());
					break;
				case "call":
				case "global":
					post({
						type: "call",
						id: a.toNumber(),
						target: kind.toString() === "call" ? "tool" : "global",
						name: b.toString(),
						args: c === undefined || c.isUndefined ? undefined : c.toString(),
					});
					break;
				case "output":
					post({
						type: "output",
						item:
							a.toString() === "image"
								? { type: "image", data: b.toString(), mimeType: c.toString() }
								: { type: "text", text: b.toString() },
					});
					break;
				case "done":
					if (a.toBoolean()) {
						post({
							type: "done",
							ok: true,
							value: b === undefined || b.isUndefined ? undefined : b.toString(),
							writes: c.toString(),
							reusable: false,
						});
					} else {
						post({ type: "done", ok: false, error: b.toString(), reusable: false });
					}
					break;
			}
			return vm.undefined;
		});

		// All escaped handles belong to this VM; disposal releases them before completion is sent.
		const api = vm.withScope((scope) =>
			scope.escape(
				vm.callFunction(
					vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
					vm.undefined,
					bridge,
					vm.newString(JSON.stringify(data.tools)),
					vm.newString(JSON.stringify(data.globals)),
					vm.newString(JSON.stringify(data.store)),
				),
			),
		);
		const settle = api.getProp("settle");
		const run = api.getProp("run");
		const stalled = api.getProp("stalled");
		const fire = api.getProp("fireTimer");
		let receivedResults = 0;
		// One owner per VM. postMessage clones before returning, so this record is
		// safe to reuse; no per-result callbacks, arrays or Promise boundaries.
		const idleMessage = { type: "idle" as const, received: 0 };
		/** Run queued jobs, then fail a script that waits on nothing that can ever resume it. */
		const drain = () => {
			vm.executePendingJobs();
			vm.callFunction(stalled, api).dispose();
			// Timer waits consume the script budget, even alongside a host call.
			if (data.pauseTimeoutWhileWaiting && !terminal && !timers?.size) {
				idleMessage.received = receivedResults;
				post(idleMessage);
			}
		};
		let firingId = 0;
		const deliverTimer = () => { vm.callFunction(fire, api, vm.newNumber(firingId)); };
		function fireTimer(id: number): void {
			if (terminal || !timers?.delete(id)) return;
			try { firingId = id; vm.withScope(deliverTimer); drain(); }
			catch (error) { crash(error); }
			finally { firingId = 0; finish(); }
		}

		let incoming: import("./protocol.ts").HostToWorkerMessage | undefined;
		// One scope callback per VM, not per incoming tool result. Delivery is synchronous.
		const deliver = () => {
			const message = incoming!;
			vm.callFunction(settle, api, vm.newNumber(message.id), message.ok ? vm.true : vm.false,
				message.payload === undefined ? vm.undefined : vm.newString(message.payload));
		};
		onMessage = (message: unknown) => {
			if (!isHostToWorkerMessage(message)) return;
			receivedResults++;
			try {
				incoming = message;
				vm.withScope(deliver);
				drain();
			} catch (error) {
				crash(error);
			} finally {
				incoming = undefined;
				finish();
			}
		};
		port.on("message", onMessage);

		// The prefix shares the first line with the script so reported line numbers
		// match the script as written.
		let fn: JSValueHandle;
		try {
			fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
		} catch (error) {
			if (!(error instanceof JSException)) throw error;
			post({ type: "done", ok: false, error: describeException(error), reusable: false });
			return;
		}
		vm.callFunction(run, api, fn).dispose();
		fn.dispose();
		drain();
	} catch (error) {
		crash(error);
	} finally {
		finish();
	}
}

if (parentPort) {
	// Bootstrap retains no source, store, catalog or interrupt buffer in pooled workers.
	if (workerData.pooled) parentPort.on("message", start);
	else start({ data: workerData as WorkerData, port: parentPort });
}

/** Trusted host startup only; a dedicated port physically fences each lease. */
function start({ data, port }: { data: WorkerData; port: MessagePort }): void {
	void main(data, port).catch((error: unknown) => {
		port.postMessage({ type: "crash", message: (error instanceof Error ? error.message : "VM startup failure").slice(0, MAX_ERROR_CHARS) });
		port.close();
	});
}
