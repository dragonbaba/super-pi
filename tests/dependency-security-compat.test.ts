import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { globSync } from "glob";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { configureHttpDispatcher } from "../packages/coding-agent/src/core/http-dispatcher.ts";
import { DefaultPackageManager } from "../packages/coding-agent/src/core/package-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

test("production dispatcher uploads JSON, decodes gzip, rejects invalid bodies and honors cancellation", async t => {
  const oldDispatcher = getGlobalDispatcher();
  const globals = { fetch: globalThis.fetch, Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
    FormData: globalThis.FormData, WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource };
  const noProxy = process.env.NO_PROXY;
  process.env.NO_PROXY = "127.0.0.1";
  const body = gzipSync(JSON.stringify({ text: "正常中文响应" }));
  const server = createServer((request, response) => {
    if (request.url === "/upload") {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { text += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(text);
      });
    } else if (request.url === "/too-many-encodings") {
      response.writeHead(200, { "content-encoding": "gzip,gzip,gzip,gzip,gzip,gzip" });
      response.end(body);
    } else if (request.url === "/broken") {
      response.writeHead(200, { "content-length": 1000 });
      response.write("partial");
      setImmediate(() => response.destroy());
    } else {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(body);
    }
  });
  let dispatcher: ReturnType<typeof getGlobalDispatcher> | undefined;
  t.after(async () => {
    setGlobalDispatcher(oldDispatcher);
    Object.assign(globalThis, globals);
    if (noProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = noProxy;
    server.closeAllConnections();
    if (dispatcher) await dispatcher.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  configureHttpDispatcher();
  dispatcher = getGlobalDispatcher();
  assert.deepEqual(await (await fetch(url)).json(), { text: "正常中文响应" });
  const upload = { text: "正常中文请求", stream: true };
  assert.deepEqual(await (await fetch(`${url}/upload`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(upload),
  })).json(), upload);
  await assert.rejects(async () => (await fetch(`${url}/too-many-encodings`)).text(), /terminated|fetch failed/i);
  await assert.rejects(async () => (await fetch(`${url}/broken`)).text(), /terminated|socket|fetch failed/i);
  const reason = new Error("fixture cancelled");
  await assert.rejects(fetch(url, { signal: AbortSignal.abort(reason) }), error => error === reason);
});

test("package manifest glob discovery preserves brace matching and excludes dot files", async t => {
  const root = mkdtempSync(join(tmpdir(), "sp-dependency-package-"));
  t.after(() => removeOwnedFixture(root));
  const packageRoot = join(root, "fixture-package");
  mkdirSync(join(packageRoot, "extensions"), { recursive: true });
  for (const file of ["first.ts", "second.js", "notes.md", ".hidden.ts"]) {
    writeFileSync(join(packageRoot, "extensions", file), "export default function () {}\n");
  }
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-package", version: "1.0.0", pi: { extensions: ["extensions/**/*.{ts,js}"] } }));
  const manager = new DefaultPackageManager({ cwd: root, agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }) });
  const resolved = await manager.resolve();
  assert.deepEqual(resolved.extensions.map(value => basename(value.path)).sort(), ["first.ts", "second.js"]);
});

test("glob rejects an already cancelled walk before filesystem traversal", t => {
  const root = mkdtempSync(join(tmpdir(), "sp-dependency-glob-"));
  t.after(() => removeOwnedFixture(root));
  const reason = new Error("cancelled before traversal");
  assert.throws(() => globSync("**/*", { cwd: root, signal: AbortSignal.abort(reason) }), error => error === reason);
});
