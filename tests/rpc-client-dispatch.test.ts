import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { RpcClient } from "../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { PiClient, PiDisconnectedError, PiSessionDetachedError, PiSessionOwnershipError, type ByteTransportHandlers } from "../packages/client/src/index.ts";
import { ClientMessageDecoder, encodeServerMessage, type RequestEnvelope, type ServerMessage, type SessionSnapshot } from "@super-pi/protocol";

// Each event is delivered to the listeners subscribed when its dispatch started.
function dispatch(client: RpcClient, type: string): void {
	(client as any).handleLine(JSON.stringify({ type }));
}

test("a listener unsubscribing itself during dispatch does not make the next listener miss the event", () => {
	const client = new RpcClient();
	const seen: string[] = [];
	const offA = client.onEvent(event => { seen.push(`a:${event.type}`); offA(); });
	client.onEvent(event => seen.push(`b:${event.type}`));
	dispatch(client, "one");
	dispatch(client, "two");
	assert.deepEqual(seen, ["a:one", "b:one", "b:two"]);
});

test("subscription changes during dispatch apply from the next event, including reentrant dispatch", () => {
	const client = new RpcClient();
	const seen: string[] = [];
	let offB = () => {};
	client.onEvent(event => {
		seen.push(`a:${event.type}`);
		if ((event as { type: string }).type === "one") {
			client.onEvent(next => seen.push(`c:${next.type}`));
			offB();
			dispatch(client, "nested");
		}
	});
	offB = client.onEvent(event => seen.push(`b:${event.type}`));
	dispatch(client, "one");
	dispatch(client, "two");
	assert.deepEqual(seen, ["a:one", "a:nested", "c:nested", "b:one", "a:two", "c:two"]);
	offB();
});

test("steady-state dispatch keeps one listener array and allocates no copies", () => {
	const client = new RpcClient();
	let count = 0;
	const off = client.onEvent(() => { count++; });
	client.onEvent(() => { count++; });
	const listeners = (client as any).eventListeners;
	for (let index = 0; index < 1000; index++) dispatch(client, "delta");
	assert.equal(count, 2000);
	assert.equal((client as any).eventListeners, listeners);
	off();
	off();
	assert.equal((client as any).eventListeners.length, 1);
	const source = readFileSync(new URL("../packages/coding-agent/src/modes/rpc/rpc-client.ts", import.meta.url), "utf8");
	const handleLine = source.slice(source.indexOf("private handleLine("), source.indexOf("private createProcessExitError("));
	assert.doesNotMatch(handleLine, /\[\.\.\.|\.slice\(|Array\.from|\.filter\(|\.map\(|for \(const /);
});

test("dispatch keeps the existing exception behavior and unsubscribing releases listeners", () => {
	const client = new RpcClient();
	const seen: string[] = [];
	const offA = client.onEvent(() => { seen.push("a"); throw new Error("fixture"); });
	const offB = client.onEvent(() => { seen.push("b"); });
	dispatch(client, "one");
	assert.deepEqual(seen, ["a"], "an exception stops this dispatch, as before copy-on-write");
	offA();
	dispatch(client, "two");
	assert.deepEqual(seen, ["a", "b"]);
	offB(); offB();
	assert.equal((client as any).eventListeners.length, 0);
	dispatch(client, "three");
	assert.deepEqual(seen, ["a", "b"]);
});

// Experimental CBOR client: exercise real framing/state with a controllable ordered peer.
function remotePeer(t: test.TestContext) {
	const peers: { handlers: ByteTransportHandlers; requests: RequestEnvelope[]; send(message: ServerMessage): void }[] = [];
	const client = new PiClient({ transportFactory(handlers) {
		const decoder = new ClientMessageDecoder();
		const peer = { handlers, requests: [] as RequestEnvelope[], send(message: ServerMessage) { handlers.onData(encodeServerMessage(message)); } };
		peers.push(peer);
		return { send(chunk) {
			for (const message of decoder.push(chunk)) {
				if (message.type === "hello") peer.send({ type: "hello", version: 1, connectionId: `connection-${peers.length}`, snapshot: { serverId: "server", protocolVersion: 1, revision: 0, sessions: [], models: [] } });
				else peer.requests.push(message);
			}
			return Promise.resolve();
		}, close() {} };
	} });
	t.after(() => client.dispose());
	return { client, peers };
}

function remoteSnapshot(revision = 0): SessionSnapshot {
	return { id: "session", cwd: "/fixture", createdAt: 0, updatedAt: revision, phase: "idle", model: { provider: "fixture", id: "model" }, thinkingLevel: "off",
		attached: true, locked: true, revision, transcript: [], queuedSteer: [], queuedSteerCount: 0 };
}

test("CBOR reconnect during a coalesced delivery ignores the remaining old connection frames", async t => {
	const { client, peers } = remotePeer(t); await client.connect();
	let reconnect: Promise<unknown> | undefined; let events = 0;
	client.onEvent(() => { events++; client.disconnect(); reconnect = client.reconnect(); void reconnect.catch(() => {}); });
	const frame = encodeServerMessage({ type: "event", event: { type: "session_removed", sessionId: "old" } });
	const coalesced = new Uint8Array(frame.length * 2); coalesced.set(frame); coalesced.set(frame, frame.length);
	peers[0].handlers.onData(coalesced);
	await reconnect;
	assert.equal(client.connected, true); assert.equal(events, 1); assert.equal(peers.length, 2);
});

test("CBOR attach response cannot resurrect a lease after its connection is invalidated", async t => {
	const { client, peers } = remotePeer(t); await client.connect();
	const acquiring = client.attachSession("session");
	const failed = assert.rejects(acquiring, error => error instanceof PiDisconnectedError || error instanceof PiSessionDetachedError);
	const request = peers[0].requests[0];
	peers[0].send({ type: "response", id: request.id, ok: true, result: { command: "attach", session: remoteSnapshot(90) } });
	client.disconnect();
	await client.reconnect();
	const replacement = client.attachSession("session");
	const next = peers[1].requests[0]; assert.ok(next, "new acquisition sends its own attach request");
	peers[1].send({ type: "response", id: next.id, ok: true, result: { command: "attach", session: remoteSnapshot(1) } });
	const current = await replacement; await failed;
	assert.equal(current.active, true); assert.equal(current.snapshot?.revision, 1);
	await assert.rejects(client.acquireSession("session", { mode: "exclusive" }), PiSessionOwnershipError);
});

test("CBOR reconnect recovers authoritative snapshots while old handles and progress stay non-authoritative", async t => {
	const { client, peers } = remotePeer(t); await client.connect();
	const attached = client.attachSession("session");
	peers[0].send({ type: "response", id: peers[0].requests[0].id, ok: true, result: { command: "attach", session: remoteSnapshot(90) } });
	const old = await attached; let staleNotifications = 0; old.subscribe(() => staleNotifications++);
	client.disconnect(); await client.reconnect();
	const attaching = client.attachSession("session");
	const snapshot = remoteSnapshot(1); snapshot.transcript.push({ id: "completed-while-away", role: "user", content: [{ type: "text", text: "persisted fact" }], timestamp: 1 });
	peers[1].send({ type: "response", id: peers[1].requests[0].id, ok: true, result: { command: "attach", session: snapshot } });
	const current = await attaching;
	peers[1].send({ type: "event", event: { type: "session_progress", sessionId: "session", progress: { type: "assistant_delta", messageId: "transient", contentIndex: 0, kind: "text", delta: "uncommitted" } } });
	peers[1].send({ type: "event", event: { type: "session_snapshot", snapshot: remoteSnapshot(0) } });
	assert.equal(current.snapshot?.revision, 1); assert.equal(current.snapshot?.transcript[0].id, "completed-while-away");
	assert.equal(old.active, false); assert.equal(old.snapshot, undefined); assert.equal(staleNotifications, 0);
	await assert.rejects(old.prompt("must not run"), PiSessionDetachedError);
	await old.dispose(); assert.equal(peers[1].requests.length, 1, "old release cannot detach the replacement");
});

test("CBOR failed old acquisition cannot consume replacement capacity during reconnect callbacks", async t => {
	const { client, peers } = remotePeer(t); await client.connect();
	const failed = assert.rejects(client.attachSession("session"), PiDisconnectedError);
	let replacement: ReturnType<PiClient["attachSession"]> | undefined;
	client.onConnectionStateChange(change => {
		if (change.state === "connected" && peers.length === 2) { replacement = client.attachSession("session"); void replacement.catch(() => {}); }
	});
	client.disconnect(); await client.reconnect(); await failed;
	const request = peers[1].requests[0]; assert.ok(request, "replacement cannot join the failed old attachment");
	peers[1].send({ type: "response", id: request.id, ok: true, result: { command: "attach", session: remoteSnapshot(1) } });
	const current = await replacement!; assert.equal(current.active, true);
	await assert.rejects(client.acquireSession("session", { mode: "exclusive" }), PiSessionOwnershipError);
	const release = current.dispose();
	assert.equal(peers[1].requests.length, 2);
	peers[1].send({ type: "response", id: peers[1].requests[1].id, ok: true, result: { command: "detach", sessionId: "session" } });
	await release;
});

test("CBOR create completion is rejected after disconnect, while shared leases release only the last owner", async t => {
	const { client, peers } = remotePeer(t); await client.connect();
	const creating = client.createSession(); const failed = assert.rejects(creating, PiDisconnectedError);
	peers[0].send({ type: "response", id: peers[0].requests[0].id, ok: true, result: { command: "create", session: remoteSnapshot() } });
	client.disconnect(); await client.reconnect(); await failed;
	const a = client.attachSession("session"), b = client.attachSession("session");
	assert.equal(peers[1].requests.length, 1);
	peers[1].send({ type: "response", id: peers[1].requests[0].id, ok: true, result: { command: "attach", session: remoteSnapshot() } });
	const first = await a, last = await b;
	await first.dispose(); assert.equal(peers[1].requests.length, 1); assert.equal(last.active, true);
	const detach = last.detach();
	peers[1].send({ type: "response", id: peers[1].requests[1].id, ok: false, error: { code: "busy", message: "fixture cleanup blocked" } });
	await assert.rejects(detach, /fixture cleanup blocked/); assert.equal(last.active, true);
	const retry = last.detach();
	peers[1].send({ type: "response", id: peers[1].requests[2].id, ok: true, result: { command: "detach", sessionId: "session" } });
	await retry; assert.equal(last.active, false);
});

test("CBOR application event delivery introduces no callbacks, promises or temporary listener arrays", () => {
	const methods = new Map([
		["connection", new Set(["#handleData", "#handleMessage", "#isCurrent"])],
		["client", new Set(["#handleMessage", "#takePendingRequest", "#isSessionLeaseCurrent"])],
		["state", new Set(["applyEvent", "#notify", "#reportListenerError", "getEventSessionId"])],
	]);
	for (const [file, expected] of methods) {
		const source = ts.createSourceFile(file, readFileSync(new URL(`../packages/client/src/${file}.ts`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const found = new Set<string>();
		function inspect(node: ts.Node): void {
			assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isArrayLiteralExpression(node), `${file}: per-delivery closure/array`);
			if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController", "Set", "Map", "Array"].includes(node.expression.getText(source)));
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.ok(!["then", "catch", "finally", "bind", "map", "filter", "slice"].includes(node.expression.name.text));
			ts.forEachChild(node, inspect);
		}
		function visit(node: ts.Node): void {
			if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && node.body && expected.has(node.name.getText(source))) {
				found.add(node.name.getText(source)); inspect(node.body);
			}
			ts.forEachChild(node, visit);
		}
		visit(source); assert.deepEqual([...found].sort(), [...expected].sort());
	}
});

test("CBOR session removal isolates pending attach responses and cleanup from a new attachment", async t => {
	const { client, peers } = remotePeer(t); await client.connect(); const peer = peers[0];
	const failed = assert.rejects(client.attachSession("session"), PiSessionDetachedError);
	peer.send({ type: "event", event: { type: "session_removed", sessionId: "session" } });
	const attaching = client.attachSession("session"); assert.equal(peer.requests.length, 2);
	peer.send({ type: "response", id: peer.requests[1].id, ok: true, result: { command: "attach", session: remoteSnapshot(1) } });
	const current = await attaching;
	peer.send({ type: "response", id: peer.requests[0].id, ok: true, result: { command: "attach", session: remoteSnapshot(90) } });
	await failed; assert.equal(current.snapshot?.revision, 1); assert.equal(current.active, true);
	await assert.rejects(client.acquireSession("session", { mode: "exclusive" }), PiSessionOwnershipError);
});

test("CBOR create removal before its continuation cannot grant a lease", async t => {
	const { client, peers } = remotePeer(t); await client.connect(); const peer = peers[0];
	const failed = assert.rejects(client.createSession(), PiSessionDetachedError);
	peer.send({ type: "response", id: peer.requests[0].id, ok: true, result: { command: "create", session: remoteSnapshot() } });
	peer.send({ type: "event", event: { type: "session_removed", sessionId: "session" } });
	await failed; assert.equal(client.connected, true); assert.equal(client.snapshot?.sessions.length, 0);
});

test("CBOR a response for another session fails the connection instead of granting ownership", async t => {
	const { client, peers } = remotePeer(t); await client.connect();
	const failed = assert.rejects(client.attachSession("requested"), /Response session does not match request/);
	peers[0].send({ type: "response", id: peers[0].requests[0].id, ok: true, result: { command: "attach", session: remoteSnapshot() } });
	await failed; assert.equal(client.connected, false); assert.equal(client.snapshot?.sessions.length, 0);
});

test("CBOR cleanup reconciliation invalidated during reconnect cannot release the replacement lease", async t => {
	const { client, peers } = remotePeer(t); await client.connect(); const peer = peers[0];
	const attaching = client.attachSession("session");
	peer.send({ type: "response", id: peer.requests[0].id, ok: true, result: { command: "attach", session: remoteSnapshot() } });
	const old = await attaching;
	const cleanup = assert.rejects(old.dispose(), /fixture cleanup blocked/);
	peer.send({ type: "response", id: peer.requests[1].id, ok: false, error: { code: "busy", message: "fixture cleanup blocked" } });
	await cleanup; assert.equal(old.active, false);
	const failed = assert.rejects(client.attachSession("session"), PiDisconnectedError);
	assert.equal(peer.requests[2].request.command, "detach");
	peer.send({ type: "response", id: peer.requests[2].id, ok: true, result: { command: "detach", sessionId: "session" } });
	let replacement: ReturnType<PiClient["attachSession"]> | undefined;
	client.onConnectionStateChange(change => {
		if (change.state === "connected") { replacement = client.attachSession("session"); void replacement.catch(() => {}); }
	});
	client.disconnect(); await client.reconnect(); await failed;
	assert.equal(peers[1].requests[0].request.command, "attach");
	peers[1].send({ type: "response", id: peers[1].requests[0].id, ok: true, result: { command: "attach", session: remoteSnapshot(1) } });
	assert.equal((await replacement!).active, true);
	await assert.rejects(client.acquireSession("session", { mode: "exclusive" }), PiSessionOwnershipError);
});
