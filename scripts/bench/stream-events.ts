import { setImmediate as yieldToEventLoop, setTimeout as wait } from "node:timers/promises";
import { Agent } from "../../packages/agent/src/agent.ts";
import type { AgentEvent } from "../../packages/agent/src/types.ts";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@super-pi/ai";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createAssistantDeltas } from "./fixtures.ts";

const paced16ms = process.argv.includes("--paced-16ms");
const deltaCount = readIntegerOption("--updates", process.argv.includes("--remote-client") ? 1 : paced16ms ? 30 : 100_000);
const legacyDelivery = process.argv.includes("--legacy-delivery");
const deliveryMode = legacyDelivery ? "legacy" : "latest";
const deltas = createAssistantDeltas(deltaCount);

function createStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const text = { type: "text" as const, text: "" };
	const message = {
		role: "assistant" as const,
		content: [text],
		api: "benchmark",
		provider: "benchmark",
		model: "benchmark",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: 0,
	};
	void (async () => {
		stream.push({ type: "start", partial: message as never });
		stream.push({ type: "text_start", contentIndex: 0, partial: message as never });
		for (let index = 0; index < deltas.length; index++) {
			const delta = deltas[index]!;
			text.text += delta;
			stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message as never });
			if (paced16ms) await wait(16);
			else if ((index & 511) === 511) await yieldToEventLoop();
		}
		stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message as never });
		stream.push({ type: "done", reason: "stop", message: message as never });
	})();
	return stream;
}

if (process.argv.includes("--remote-client")) await remoteClientBenchmark();
else await runBenchmarkMain({
	name: "stream-events",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:assistant-deltas:${deltaCount}:delivery-${deliveryMode}:${paced16ms ? "paced-16ms" : "burst"}`,
	run: async () => {
		let deliveredUpdates = 0;
		let snapshots = 0;
		const agent = new Agent({
			streamFn: () => createStream(),
			eventInstrumentation: { onAssistantSnapshot: () => { snapshots++; } },
		});
		const countUpdate = (event: AgentEvent) => {
			if (event.type === "message_update") deliveredUpdates++;
		};
		if (legacyDelivery) agent.subscribe(countUpdate);
		else agent.subscribeObserver(countUpdate, { minIntervalMs: paced16ms ? 16 : 60_000 });
		await agent.prompt("benchmark");
		return {
			updates: deltaCount,
			eventsDelivered: deliveredUpdates,
			snapshots,
			coalesced: agent.eventDeliveryStats.coalesced,
			maxPendingKeys: agent.eventDeliveryStats.maxPendingKeys,
			legacyDelivery: legacyDelivery ? 1 : 0,
			producerPaceMs: paced16ms ? 16 : 0,
		};
	},
});

/** CBOR client delivery is separate from Agent coalescing; opt in for OC07 only. */
async function remoteClientBenchmark(): Promise<void> {
	if (!globalThis.gc) throw new Error("Use --expose-gc for remote-client reference evidence.");
	const { Session } = await import("node:inspector/promises");
	const { PiClient } = await import("../../packages/client/src/client.ts");
	const { ClientMessageDecoder, encodeServerMessage } = await import("@super-pi/protocol");
	let inbound: import("../../packages/client/src/transport.ts").ByteTransportHandlers | undefined;
	let transports = 0, closed = 0, deliveries = 0;
	const client = new PiClient({ transportFactory(handlers) {
		inbound = handlers; transports++;
		const decoder = new ClientMessageDecoder();
		return { send(chunk) {
			for (const message of decoder.push(chunk)) if (message.type === "hello") handlers.onData(encodeServerMessage({
				type: "hello", version: 1, connectionId: "fixture", snapshot: { serverId: "fixture", revision: 0, protocolVersion: 1, sessions: [], models: [] },
			}));
			return Promise.resolve();
		}, close() { closed++; } };
	} });
	const references: WeakRef<object>[] = [];
	const retainedOwners: object[] = [];
	await client.connect();
	const listener = () => { deliveries++; };
	const unsubscribe = client.onEvent(listener);
	const frame = encodeServerMessage({ type: "event", event: { type: "session_progress", sessionId: "fixture",
		progress: { type: "assistant_delta", messageId: "message", contentIndex: 0, kind: "text", delta: "fixture" } } });
	for (let i = 0; i < 100; i++) inbound!.onData(frame);
	deliveries = 0;
	const heapBefore = (globalThis.gc(), process.memoryUsage().heapUsed);
	const inspector = new Session(); inspector.connect();
	let sampled: import("node:inspector").HeapProfiler.StopSamplingReturnType;
	try {
		await inspector.post("HeapProfiler.enable");
		await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		for (let i = 0; i < 5000; i++) inbound!.onData(frame);
		sampled = await inspector.post("HeapProfiler.stopSampling");
	} finally { inspector.disconnect(); unsubscribe(); await client.dispose(); }
	let sampledBytes = 0;
	const sites: { function: string; bytes: number }[] = [];
	function walk(node: typeof sampled.profile.head): void {
		sampledBytes += node.selfSize;
		if (node.selfSize) sites.push({ function: node.callFrame.functionName, bytes: node.selfSize });
		for (const child of node.children) walk(child);
	}
	walk(sampled.profile.head); sites.sort((a, b) => b.bytes - a.bytes);
	// Returned unsubscribe functions intentionally own their listener until callers release them.
	async function lifecycle(): Promise<void> {
		const { ClientState } = await import("../../packages/client/src/state.ts");
		for (const mode of ["unsubscribe", "dispose"]) {
			const state = new ClientState();
			retainedOwners.push(state);
			const observer = () => {};
			const snapshot = { serverId: "lifecycle", revision: 0, protocolVersion: 1 as const, sessions: [], models: [] };
			references.push(new WeakRef(observer), new WeakRef(snapshot));
			const off = state.onSessionEvent("session", observer);
			state.applyServerSnapshot(snapshot);
			if (mode === "unsubscribe") off();
			state.dispose();
		}
		let handlers: import("../../packages/client/src/transport.ts").ByteTransportHandlers | undefined;
		const remote = new PiClient({ transportFactory(next) {
			handlers = next; references.push(new WeakRef(next)); transports++;
			const decoder = new ClientMessageDecoder();
			return { send(chunk) {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") next.onData(encodeServerMessage({ type: "hello", version: 1, connectionId: "lifecycle",
						snapshot: { serverId: "fixture", revision: 0, protocolVersion: 1, sessions: [], models: [] } }));
					else if (message.request.command === "attach") next.onData(encodeServerMessage({ type: "response", id: message.id, ok: true,
						result: { command: "attach", session: { id: "session", cwd: "/fixture", createdAt: 0, updatedAt: 0, phase: "idle",
							model: { provider: "fixture", id: "fixture" }, thinkingLevel: "off", attached: true, locked: true, revision: 0, transcript: [], queuedSteer: [], queuedSteerCount: 0 } } }));
				}
				return Promise.resolve();
			}, close() { closed++; } };
		} });
		retainedOwners.push(remote);
		for (const mode of ["disconnect", "failure", "dispose"]) {
			await remote.connect();
			const lease = await remote.attachSession("session");
			const observer = () => {};
			lease.subscribe(observer);
			references.push(new WeakRef(lease), new WeakRef(lease.snapshot!), new WeakRef(remote.snapshot!), new WeakRef(observer));
			if (mode === "disconnect") remote.disconnect();
			else if (mode === "failure") handlers!.onError(new Error("fixture transport failure"));
			else await remote.dispose();
			await lease.dispose();
		}
		handlers = undefined;
	}
	await lifecycle();
	inbound = undefined;
	for (let i = 0; i < 8; i++) { await yieldToEventLoop(); globalThis.gc(); }
	const liveReferences = references.filter(ref => ref.deref()).length;
	if (deliveries !== 5000 || closed !== transports || liveReferences !== 0) throw new Error("Remote-client delivery/reference counters failed.");
	console.log(JSON.stringify({ mode: "remote-client", node: process.version, platform: process.platform, updates: 5000, deliveries, frameBytes: frame.byteLength,
		sampledBytes, sampledBytesPerUpdate: sampledBytes / 5000, topSites: sites.slice(0, 8), heapBefore, heapAfterGc: process.memoryUsage().heapUsed,
		transports, closed, retainedOwners: retainedOwners.length, trackedReferences: references.length, liveReferences,
		coverage: "Actual Connection CBOR decode -> PiClient -> ClientState delivery. ClientState unsubscribe/dispose and real PiClient attach/disconnect/failure/reconnect/dispose references, owners strongly held. Lease listeners remain registered until unsubscribe or client.dispose by existing API. No server runtime, model or UI claims." }, null, 2));
}
