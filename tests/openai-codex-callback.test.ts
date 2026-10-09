import assert from "node:assert/strict";
import { once, getEventListeners } from "node:events";
import { createHash } from "node:crypto";
import { createServer, Server, request } from "node:http";
import { connect, type Socket, type AddressInfo } from "node:net";
import { setImmediate as nextTask } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { openaiCodexOAuth } from "../packages/ai/src/auth/oauth/openai-codex.ts";
import type { AuthEvent, AuthPrompt } from "../packages/ai/src/auth/types.ts";

// loginOpenAICodex/startLocalOAuthServer allocate only for an explicit login lifecycle.
// Each fixture owns its server and sockets; release assertions run before fallback teardown.
const jwt = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.s`;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}
async function close(server: Server) {
	await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
}
async function connections(server: Server) {
	return new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
}

function fixture(t: TestContext, port = 0, listenError?: NodeJS.ErrnoException, onListening?: () => void) {
	const servers: Server[] = [], sockets: Socket[] = [], events: AuthEvent[] = [], prompts: AuthPrompt[] = [];
	const requests: Array<{ url: string; body: URLSearchParams }> = [];
	const originalListen = Server.prototype.listen;
	// Exercise real HTTP servers on owned ephemeral ports; never take a user's 1455 listener.
	t.mock.method(Server.prototype, "listen", function (this: Server, requested: number, host: string, callback: () => void) {
		assert.equal(requested, 1455);
		assert.ok(host);
		servers.push(this);
		if (listenError) { queueMicrotask(() => this.emit("error", listenError)); return this; }
		return Reflect.apply(originalListen, this, [port, "127.0.0.1", () => { onListening?.(); callback(); }]);
	});
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		assert.equal(new URL(url).origin, "https://auth.openai.com");
		requests.push({ url, body: new URLSearchParams(init.body as string) });
		return Response.json({ access_token: jwt, refresh_token: "fixture-refresh", expires_in: 3600 });
	});
	t.after(async () => { for (const socket of sockets) socket.destroy(); for (const server of servers) await close(server); });
	const caller = new AbortController(), ready = deferred<string>();
	let submit!: (input: string) => void;
	let fail!: (error: unknown) => void;
	let manualSignal: AbortSignal | undefined;
	const interaction = {
		signal: caller.signal,
		notify(event: AuthEvent) { events.push(event); if (event.type === "auth_url") ready.resolve(event.url); },
		async prompt(prompt: AuthPrompt): Promise<string> {
			prompts.push(prompt);
			if (prompt.type === "select") return "browser";
			manualSignal = prompt.signal;
			const input = deferred<string>();
			submit = input.resolve;
			fail = input.reject;
			const signal = prompt.signal!;
			const abort = () => input.reject(new Error("manual input cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			try { return await input.promise; }
			finally { signal.removeEventListener("abort", abort); }
		},
	};
	return { servers, sockets, events, prompts, requests, caller, ready, interaction,
		usePort: (value: number) => { port = value; },
		manualSignal: () => manualSignal,
		submit: (input: string) => submit(input),
		fail: (error: unknown) => fail(error),
		async spare() {
			const server = servers.at(-1)!;
			const accepted = once(server, "connection");
			const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
			sockets.push(socket);
			socket.on("error", () => {});
			await Promise.all([once(socket, "connect"), accepted]);
			// A browser may leave a connection with incomplete request headers during login.
			socket.write("GET /auth/callback HTTP/1.1\r\nHost: localhost\r\n");
			await nextTask();
			assert.equal(await connections(server), 1);
			return socket;
		},
		async callback(path: string) {
			const server = servers.at(-1)!;
			return new Promise<{ status: number; body: string }>((resolve, reject) => {
				const req = request({ hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path, agent: false }, (res) => {
					let body = "";
					res.setEncoding("utf8"); res.on("data", (chunk: string) => { body += chunk; });
					res.on("end", () => resolve({ status: res.statusCode!, body }));
					res.on("error", reject);
				});
				req.on("error", reject); req.end();
			});
		},
	};
}

test("occupied callback port fails before auth URL notification, manual prompt or token exchange", { timeout: 5000 }, async (t) => {
	const occupied = createServer();
	t.after(() => close(occupied));
	await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
	const f = fixture(t, (occupied.address() as AddressInfo).port);
	f.interaction.prompt = async (prompt) => { f.prompts.push(prompt); return prompt.type === "select" ? "browser" : "fixture-code"; };
	await assert.rejects(openaiCodexOAuth.login(f.interaction), /port 1455.*in use/i);
	assert.equal(f.events.length, 0);
	assert.deepEqual(f.prompts.map((prompt) => prompt.type), ["select"]);
	assert.equal(f.requests.length, 0);
	assert.equal(occupied.listening, true, "must not close the existing listener");
	assert.equal(getEventListeners(f.caller.signal, "abort").length, 0);
});

async function assertReleased(f: ReturnType<typeof fixture>) {
	await nextTask();
	assert.equal(f.servers.at(-1)!.listening, false);
	assert.equal(await connections(f.servers.at(-1)!), 0);
	assert.equal(getEventListeners(f.caller.signal, "abort").length, 0);
	if (f.manualSignal()) {
		assert.equal(f.manualSignal()!.aborted, true);
		assert.equal(getEventListeners(f.manualSignal()!, "abort").length, 0);
	}
}

test("cancelling callback wait releases manual input and incomplete connections without waiting for input", { timeout: 5000 }, async (t) => {
	const f = fixture(t), reason = new Error("fixture cancelled");
	const pending = assert.rejects(openaiCodexOAuth.login(f.interaction), (error) => error === reason);
	await f.ready.promise;
	await f.spare();
	f.caller.abort(reason);
	await pending;
	assert.equal(f.requests.length, 0);
	await assertReleased(f);
});

test("already cancelled browser login never binds or announces an auth URL", async (t) => {
	const f = fixture(t), reason = new Error("fixture cancelled");
	f.caller.abort(reason);
	await assert.rejects(openaiCodexOAuth.login(f.interaction), (error) => error === reason);
	assert.equal(f.servers.length, 0);
	assert.equal(f.events.length, 0);
	assert.equal(f.requests.length, 0);
});

test("cancellation during binding closes the new listener before announcing login", async (t) => {
	const reason = new Error("fixture cancelled");
	const f = fixture(t, 0, undefined, () => f.caller.abort(reason));
	await assert.rejects(openaiCodexOAuth.login(f.interaction), (error) => error === reason);
	assert.equal(f.events.length, 0);
	assert.deepEqual(f.prompts.map((prompt) => prompt.type), ["select"]);
	assert.equal(f.requests.length, 0);
	await assertReleased(f);
});

test("cancellation from auth URL notification does not start manual input", async (t) => {
	const f = fixture(t), reason = new Error("fixture cancelled");
	f.interaction.notify = () => f.caller.abort(reason);
	await assert.rejects(openaiCodexOAuth.login(f.interaction), (error) => error === reason);
	assert.deepEqual(f.prompts.map((prompt) => prompt.type), ["select"]);
	assert.equal(f.requests.length, 0);
	await assertReleased(f);
});

test("callback server errors after listening fail login and release its connections", { timeout: 5000 }, async (t) => {
	const f = fixture(t), reason = new Error("fixture server failed");
	const pending = assert.rejects(openaiCodexOAuth.login(f.interaction), (error) => error === reason);
	await f.ready.promise;
	await f.spare();
	f.servers[0]!.emit("error", reason);
	await pending;
	assert.equal(f.requests.length, 0);
	await assertReleased(f);
});

for (const format of ["code", "redirect", "fragment", "query"] as const) {
	test(`manual ${format} login preserves state validation and closes the callback listener`, async (t) => {
		const f = fixture(t), pending = openaiCodexOAuth.login(f.interaction);
		const state = new URL(await f.ready.promise).searchParams.get("state")!;
		await f.spare();
		const input = format === "code" ? "fixture-code"
			: format === "redirect" ? `http://localhost:1455/auth/callback?code=fixture-code&state=${state}`
			: format === "fragment" ? `fixture-code#${state}`
			: `code=fixture-code&state=${state}`;
		f.submit(input);
		assert.equal((await pending).accountId, "fixture");
		assert.equal(f.requests.length, 1);
		assert.equal(f.requests[0]!.body.get("code"), "fixture-code");
		await assertReleased(f);
	});
}

for (const failure of ["wrong state", "empty input", "rejected input"] as const) {
	test(`manual ${failure} releases callback resources without exchanging tokens`, async (t) => {
		const f = fixture(t);
		const expected = failure === "wrong state" ? /State mismatch/ : failure === "empty input" ? /Missing authorization code/ : /fixture input failed/;
		const pending = assert.rejects(openaiCodexOAuth.login(f.interaction), expected);
		await f.ready.promise;
		await f.spare();
		if (failure === "rejected input") f.fail(new Error("fixture input failed"));
		else f.submit(failure === "wrong state" ? "fixture-code#wrong-state" : "");
		await pending;
		assert.equal(f.requests.length, 0);
		await assertReleased(f);
	});
}

test("synchronous manual prompt failure closes the callback listener", async (t) => {
	const f = fixture(t), reason = new Error("fixture prompt failed");
	f.interaction.prompt = (prompt) => {
		if (prompt.type === "select") return Promise.resolve("browser");
		throw reason;
	};
	await assert.rejects(openaiCodexOAuth.login(f.interaction), (error) => error === reason);
	assert.equal(f.requests.length, 0);
	await assertReleased(f);
});

test("token exchange failure leaves no callback resources", async (t) => {
	const f = fixture(t);
	t.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
	const pending = assert.rejects(openaiCodexOAuth.login(f.interaction), /exchange failed.*invalid_grant/);
	await f.ready.promise;
	await f.spare();
	f.submit("fixture-code");
	await pending;
	await assertReleased(f);
});

test("completed browser logins release their port for the next login", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	let port = 0;
	for (let index = 0; index < 3; index++) {
		const ready = deferred<void>();
		f.interaction.notify = () => ready.resolve();
		const pending = openaiCodexOAuth.login(f.interaction);
		await ready.promise;
		const actualPort = (f.servers[index]!.address() as AddressInfo).port;
		if (index === 0) { port = actualPort; f.usePort(port); }
		assert.equal(actualPort, port);
		await f.spare();
		f.submit("fixture-code");
		await pending;
		await assertReleased(f);
	}
	assert.equal(f.servers.length, 3);
	assert.equal(f.requests.length, 3);
});

test("device code login works while the callback port is occupied", async (t) => {
	const occupied = createServer();
	t.after(() => close(occupied));
	await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
	const f = fixture(t, (occupied.address() as AddressInfo).port);
	f.interaction.prompt = async () => "device_code";
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
		const url = String(input);
		assert.equal(new URL(url).origin, "https://auth.openai.com");
		urls.push(url);
		if (url.endsWith("/api/accounts/deviceauth/usercode")) {
			return Response.json({ device_auth_id: "fixture-device", user_code: "123456", interval: 0 });
		}
		if (url.endsWith("/api/accounts/deviceauth/token")) {
			assert.deepEqual(JSON.parse(init.body as string), { device_auth_id: "fixture-device", user_code: "123456" });
			return Response.json({ authorization_code: "fixture-code", code_verifier: "fixture-verifier" });
		}
		assert.equal(new URLSearchParams(init.body as string).get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
		return Response.json({ access_token: jwt, refresh_token: "fixture-refresh", expires_in: 3600 });
	});
	assert.equal((await openaiCodexOAuth.login(f.interaction)).accountId, "fixture");
	assert.equal(f.servers.length, 0);
	assert.equal(occupied.listening, true);
	assert.deepEqual(f.events.map((event) => event.type), ["device_code"]);
	assert.deepEqual(urls.map((url) => new URL(url).pathname), ["/api/accounts/deviceauth/usercode", "/api/accounts/deviceauth/token", "/oauth/token"]);
	assert.equal(getEventListeners(f.caller.signal, "abort").length, 0);
});

test("other callback binding errors retain their cause and never open browser login", async (t) => {
	const error = Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
	const f = fixture(t, 0, error);
	f.interaction.prompt = async (prompt) => { f.prompts.push(prompt); return prompt.type === "select" ? "browser" : "fixture-code"; };
	await assert.rejects(openaiCodexOAuth.login(f.interaction), (reason) => reason === error);
	assert.equal(f.events.length, 0); assert.equal(f.requests.length, 0);
});

test("notification failure closes the callback listener and removes the login abort handler", async (t) => {
	const f = fixture(t), error = new Error("fixture notification failed");
	f.interaction.notify = () => { throw error; };
	await assert.rejects(openaiCodexOAuth.login(f.interaction), (reason) => reason === error);
	assert.equal(f.servers[0]!.listening, false);
	assert.equal(getEventListeners(f.caller.signal, "abort").length, 0);
});

test("successful callback closes spare browser connections and preserves PKCE", { timeout: 5000 }, async (t) => {
	const f = fixture(t), pending = openaiCodexOAuth.login(f.interaction);
	const authorization = new URL(await f.ready.promise);
	await f.spare();
	assert.equal((await f.callback("/wrong-route")).status, 404);
	assert.equal((await f.callback("/auth/callback?state=wrong&code=fixture-code")).status, 400);
	const state = authorization.searchParams.get("state")!;
	assert.equal((await f.callback(`/auth/callback?state=${state}`)).status, 400);
	assert.equal((await f.callback(`/auth/callback?state=${state}&code=fixture-code`)).status, 200);
	assert.equal((await pending).accountId, "fixture");
	await nextTask();
	assert.equal(await connections(f.servers[0]!), 0);
	assert.equal(f.servers[0]!.listening, false);
	assert.equal(f.manualSignal()?.aborted, true);
	assert.equal(getEventListeners(f.caller.signal, "abort").length, 0);
	assert.equal(f.requests.length, 1);
	assert.equal(f.requests[0]!.body.get("redirect_uri"), "http://localhost:1455/auth/callback");
	assert.equal(createHash("sha256").update(f.requests[0]!.body.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
});
