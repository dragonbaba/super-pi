import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RpcClient } from "../packages/coding-agent/src/modes/rpc/rpc-client.ts";

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
