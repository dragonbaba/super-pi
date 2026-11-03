import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { getEventListeners, once } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { TUI } from "@super-pi/tui";
import { createRadiusOAuth } from "../packages/ai/src/auth/oauth/radius.ts";
import { LoginDialogComponent } from "../packages/coding-agent/src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

// Radius deliberately loads this builtin lazily for browser compatibility.
await import("node:http");

for (const failure of ["progress", "auth_url"] as const) {
	test(`Radius releases its callback server when ${failure} notification fails`, async t => {
		const controller = new AbortController();
		const originalCreateServer = http.createServer;
		let callbackServer: http.Server | undefined;
		let closed: Promise<unknown> | undefined;
		let port = 0;
		let closeCalls = 0;
		const create = t.mock.method(http, "createServer", ((...args: Parameters<typeof http.createServer>) => {
			const server = Reflect.apply(originalCreateServer, http, args) as http.Server;
			callbackServer = server;
			closed = once(server, "close");
			const originalClose = server.close;
			const originalListen = server.listen;
			t.after(async () => {
				controller.abort();
				server.closeAllConnections();
				if (server.listening) {
					originalClose.call(server);
					await closed;
				}
			});
			t.mock.method(server, "close", function (this: http.Server, ...closeArgs: Parameters<typeof server.close>) {
				closeCalls++;
				return Reflect.apply(originalClose, this, closeArgs) as http.Server;
			});
			t.mock.method(server, "listen", ((requestedPort: number, host: string, listening: () => void) => {
				assert.equal(requestedPort, 1456);
				assert.equal(host, "127.0.0.1");
				return Reflect.apply(originalListen, server, [0, host, () => {
					port = (server.address() as AddressInfo).port;
					listening();
				}]) as http.Server;
			}) as typeof server.listen);
			return server;
		}) as typeof http.createServer);
		const launcher = t.mock.method(childProcess, "spawn", () => {
			throw new Error("Fixture must never launch a browser");
		});
		syncBuiltinESMExports();
		t.after(() => { create.mock.restore(); launcher.mock.restore(); syncBuiltinESMExports(); });
		const requests: string[] = [];
		t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
			requests.push(String(input));
			assert.equal(String(input), "https://gateway.invalid/v1/oauth");
			return Response.json({ authorizationEndpoint: failure === "auth_url" ? "file:///tmp/login.html" : "https://example.invalid/authorize" });
		});
		initTheme("dark", false);
		const dialog = new LoginDialogComponent({ requestRender() {} } as TUI, "fixture", () => {});
		t.after(() => dialog.cancel());
		let notificationError: unknown;
		const oauth = createRadiusOAuth({ name: "Fixture", gateway: "https://gateway.invalid" });
		await assert.rejects(oauth.login({
			signal: controller.signal,
			async prompt() { return "browser"; },
			notify(event) {
				assert.equal(callbackServer?.listening, true);
				assert.equal(getEventListeners(controller.signal, "abort").length, 1);
				try {
					if (event.type === "progress" && failure === "progress") throw new Error("Fixture progress rejected");
					if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
				} catch (error) {
					notificationError = error;
					throw error;
				}
			},
		}), error => error === notificationError);
		assert.ok(callbackServer);
		const abortListeners = getEventListeners(controller.signal, "abort").length;
		t.diagnostic(JSON.stringify({ failure, listening: callbackServer.listening, closeCalls, abortListeners, fetches: requests.length }));
		assert.equal(callbackServer.listening, false);
		assert.equal(closeCalls, 1);
		assert.equal(abortListeners, 0);
		assert.equal(controller.signal.aborted, false, "cleanup must not depend on later cancellation");
		assert.equal(requests.length, 1, "notification failure must not reach token exchange");
		assert.equal(launcher.mock.callCount(), 0);
		if (failure === "auth_url") assert.match(String(notificationError), /Login URL must be an absolute HTTP or HTTPS URL/);
		await closed;

		// A real bind to the exact released port proves the next login can listen.
		const probe = originalCreateServer();
		t.after(async () => {
			if (probe.listening) await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
		});
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", resolve);
		});
		assert.equal((probe.address() as AddressInfo).port, port);
		await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
	});
}
