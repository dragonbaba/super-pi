import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { HOST_PATH_HOST_ONLY, HOST_PATH_MISSING, HOST_PATH_TOOL, HOST_PATH_VM, HOST_PATH_WORKSPACE, WorkspaceOperationError, WorkspacePathStop,
  WorkspaceSandboxBackend } from "../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { SandboxNetworkSession } from "../packages/coding-agent/src/core/sandbox/network-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { inspectSandboxCommand, type SandboxCommandFacts } from "../packages/coding-agent/src/core/shell-policy/sandbox-command.ts";

test("sandbox command facts: common network commands and static absolute paths, read from one tokenization", () => {
  const facts: SandboxCommandFacts = { network: undefined, paths: [] };
  const network: [("bash" | "powershell"), string, string | undefined][] = [
    ["bash", "cd pkg && npm ci", "npm ci"], ["bash", "CI=1 pnpm install --frozen-lockfile", "pnpm install"], ["bash", "python -m pip install requests", "pip install"],
    ["bash", "git -C repo pull", "git pull"], ["bash", "curl -fsSL https://example.test", "curl"], ["bash", "yarn", "yarn"],
    ["powershell", "& npm.cmd install", "npm install"], ["powershell", "$r = Invoke-WebRequest https://example.test", "invoke-webrequest"],
    // Ordinary offline commands never ask.
    ["bash", "npm test", undefined], ["bash", "npm run build", undefined], ["bash", "git commit -m 'pull request'", undefined],
    ["bash", "echo npm install", undefined], ["powershell", "Get-ChildItem", undefined],
  ];
  for (const [tool, command, expected] of network) {
    inspectSandboxCommand(tool, command, facts);
    assert.equal(facts.network, expected, command);
  }
  const paths: [("bash" | "powershell"), string, string[]][] = [
    ["powershell", "Get-Content D:\\other\\x.txt", ["D:\\other\\x.txt"]], ["bash", "ls D:/other/x", ["D:/other/x"]],
    ["bash", "node build.js --out=D:/dist", ["D:/dist"]], ["powershell", "Write-Output hi > D:\\out.txt", ["D:\\out.txt"]],
    // Text arguments and dynamic words are not paths.
    ["powershell", "Write-Output 'see D:\\other\\x'", []], ["bash", "echo 'D:/x'", []], ["bash", "cat $DIR/x src/a.ts", []],
  ];
  for (const [tool, command, expected] of paths) {
    inspectSandboxCommand(tool, command, facts);
    assert.deepEqual(facts.paths, expected, command);
  }
});

function fixture(options: { session?: SandboxNetworkSession; hasUI?: boolean; choice?: string } = {}) {
  const runtime = createExtensionRuntime();
  const owner = new WorkspaceSandboxTools(process.cwd(), process.cwd(), "read-only", () => runtime, { networkSession: options.session });
  const backend = (owner as any).backend, dialogs: string[] = [], statuses: (string | undefined)[] = [], invoked: (readonly string[] | undefined)[] = [];
  let enabled = 0;
  backend.invoke = async (_name: string, _input: object, _signal: AbortSignal, hostPaths?: readonly string[]) => {
    invoked.push(hostPaths ? [...hostPaths] : undefined); return { ok: true, text: "fixture", changes: [] };
  };
  backend.releaseCandidates = async () => {};
  backend.enableSessionNetwork = async () => { enabled++; options.session!.enabled = true; };
  const ctx: any = { hasUI: options.hasUI ?? true, ui: {
    async select(title: string) { dialogs.push(title); return options.choice; },
    notify() {}, setStatus(_key: string, text: string | undefined) { statuses.push(text); } } };
  return { owner, runtime, backend, dialogs, statuses, invoked, get enabled() { return enabled; },
    run(command: string) { return owner.definition("bash")!.execute("bash", { command }, undefined, undefined, ctx); },
    async close() { await owner.close(); await runtime.executionBoundary.dispose(); } };
}

test("an offline sandbox asks once before a network command; consent rebuilds for the session, refusal does not run", async () => {
  const session = new SandboxNetworkSession();
  const allowed = fixture({ session, choice: "允许本会话联网" });
  await allowed.run("npm test");
  assert.equal(allowed.dialogs.length, 0);
  await allowed.run("npm install");
  assert.equal(allowed.dialogs.length, 1); assert.equal(allowed.enabled, 1); assert.equal(session.enabled, true);
  assert.deepEqual(allowed.statuses, ["沙箱已联网（本会话）"]);
  await allowed.run("git fetch origin");
  assert.equal(allowed.dialogs.length, 1, "consent lasts for the session");
  assert.equal(allowed.invoked.length, 3); await allowed.close();

  const declined = fixture({ session: new SandboxNetworkSession(), choice: "拒绝" });
  await assert.rejects(declined.run("curl https://example.test"), /SANDBOX_NETWORK_DECLINED/);
  assert.equal(declined.invoked.length, 0); assert.equal(declined.enabled, 0);
  // A refusal is not remembered: the next network command asks again.
  await assert.rejects(declined.run("npm install"), /SANDBOX_NETWORK_DECLINED/);
  assert.equal(declined.dialogs.length, 2); await declined.close();

  // Without a dialog the command runs offline as before.
  const headless = fixture({ session: new SandboxNetworkSession(), hasUI: false });
  await headless.run("npm install");
  assert.equal(headless.dialogs.length, 0); assert.equal(headless.invoked.length, 1); await headless.close();
});

test("an unmapped host path stops the command and pauses the turn; offline failures name their cause", async () => {
  const f = fixture({ session: new SandboxNetworkSession() });
  f.backend.invoke = async (_name: string, _input: object, _signal: AbortSignal, hostPaths?: readonly string[]) => {
    f.invoked.push(hostPaths); throw new WorkspacePathStop("0".repeat(32), "D:\\other\\x.txt");
  };
  await assert.rejects(f.run("cat D:/other/x.txt"), error => /SANDBOX_PATH_UNMAPPED/.test(String(error)) && /\/add-dir/.test(String(error)));
  assert.deepEqual(f.invoked[0], ["D:/other/x.txt"]);
  await assert.rejects(f.run("ls"), /PAUSED|new user instruction/i);
  await f.close();

  const offline = fixture({ session: new SandboxNetworkSession(), hasUI: false });
  offline.backend.invoke = async () => {
    throw new WorkspaceOperationError({ id: "x", ok: false, phase: "execution", error: "Command failed (1)",
      execution: { exitCode: 1, timedOut: false, closed: true, stdout: "", stderr: "node:internal getaddrinfo ENOTFOUND registry.npmjs.org" } });
  };
  const result: any = await offline.run("node fetch.js");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /SANDBOX_NETWORK_DISABLED/);
  await offline.run("node fetch.js"); // not paused
  await offline.close();
});

test("host path kinds: workspace, its parents, tool mounts, host-only and missing paths", async () => {
  const root = await fs.mkdtemp(path.join(process.env.TMP ?? process.cwd(), "r5-paths-"));
  try {
    const workspace = path.join(root, "workspace"), other = path.join(root, "other"), tools = path.join(root, "tools");
    for (const directory of [workspace, other, tools]) await fs.mkdir(directory);
    const backend = new WorkspaceSandboxBackend(workspace, root, "read-only", {});
    (backend as any).toolRoots = [tools.toLowerCase()];
    assert.equal(await backend.hostPathKind(path.join(workspace, "src", "a.ts")), HOST_PATH_WORKSPACE);
    assert.equal(await backend.hostPathKind(root.toUpperCase()), HOST_PATH_VM);
    assert.equal(await backend.hostPathKind(path.join(tools, "bin")), HOST_PATH_TOOL);
    assert.equal(await backend.hostPathKind(other.replaceAll("\\", "/")), HOST_PATH_HOST_ONLY);
    assert.equal(await backend.hostPathKind(path.join(other, "missing")), HOST_PATH_MISSING);
    assert.equal(await backend.hostPathKind("C:\\Windows\\System32\\cmd.exe"), HOST_PATH_VM);
  } finally { await fs.rm(root, { recursive: true }); }
});

test("session consent closes a running offline VM so the next call starts with networking", async () => {
  const session = new SandboxNetworkSession();
  const backend = new WorkspaceSandboxBackend(process.cwd(), process.cwd(), "read-only", { networkSession: session });
  let discarded = 0;
  (backend as any).vm = {}; (backend as any).discardSnapshot = async () => { discarded++; };
  assert.equal(backend.networkEnabled, false);
  await backend.enableSessionNetwork();
  assert.equal(backend.networkEnabled, true); assert.equal(discarded, 1);
  // The global setting still enables networking without a session consent.
  assert.equal(new WorkspaceSandboxBackend(process.cwd(), process.cwd(), "read-only", { network: "enabled" }).networkEnabled, true);
});
