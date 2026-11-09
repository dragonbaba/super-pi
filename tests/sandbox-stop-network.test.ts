import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { HOST_PATH_HOST_ONLY, HOST_PATH_TOOL, HOST_PATH_WORKSPACE, WorkspaceOperationError,
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
    ["powershell", "$r=Invoke-WebRequest https://example.test", "invoke-webrequest"], ["powershell", "1..3 | ForEach-Object { Invoke-WebRequest https://example.test }", "invoke-webrequest"],
    ["bash", "bash -euo pipefail -c 'npm install'", "npm install"], ["powershell", "pwsh -NoProfile -Command \"git clone https://example.test/r\"", "git clone"],
    ["powershell", "cmd /c npm ci", "npm ci"], ["bash", "npx create-vite@latest app", "npx"], ["bash", "npm create vite@latest app", "npm create"],
    ["bash", "npx tsc --noEmit", undefined], ["bash", "curl --version", undefined],
    ["bash", "CI=$CI npm install", "npm install"], ["powershell", "$r = @(Invoke-WebRequest https://example.test)", "invoke-webrequest"],
    ["bash", "curl -fsS http://127.0.0.1:3000/health", undefined], ["powershell", "Invoke-WebRequest http://localhost:5173", undefined],
    ["bash", "cat > fetch.sh <<'EOF'\ncurl https://example.test\nEOF\nchmod +x fetch.sh", undefined],
    // Ordinary offline commands never ask.
    ["bash", "npm test", undefined], ["bash", "npm run build", undefined], ["bash", "git commit -m 'pull request'", undefined],
    ["bash", "echo npm install", undefined], ["powershell", "Get-ChildItem", undefined],
    // An explicit offline flag never reaches the network; `--prefer-offline` still may.
    ["bash", "npm ci --offline", undefined], ["bash", "cargo build --offline", undefined], ["bash", "pip install --no-index -f wheels x", undefined],
    ["bash", "npm install --prefer-offline", "npm install"], ["bash", "pip install --no-index --find-links https://example.test/whl torch", "pip install"],
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
  const backend = (owner as any).backend, dialogs: string[] = [], statuses: (string | undefined)[] = [], invoked: string[] = [];
  let enabled = 0;
  backend.invoke = async (name: string, input: { command: string }) => {
    assert.equal(name, "powershell"); invoked.push(input.command); return { ok: true, text: "fixture" };
  };
  backend.enableSessionNetwork = async () => { enabled++; options.session!.enabled = true; };
  const ctx: any = { hasUI: options.hasUI ?? true, ui: {
    async select(title: string) { dialogs.push(title); return options.choice; },
    notify() {}, setStatus(_key: string, text: string | undefined) { statuses.push(text); } } };
  return { owner, runtime, backend, dialogs, statuses, invoked, get enabled() { return enabled; },
    run(command: string) { return owner.definition("powershell")!.execute("powershell", { command }, undefined, undefined, ctx); },
    async close() { await owner.close(); await runtime.executionBoundary.dispose(); } };
}

test("diagnostic paths distinguish search text and shell commands reach MXC unchanged", async () => {
  const f = fixture({ hasUI: false });
  try {
    for (const command of ["rg -F -e 'D:/outside' .", "rg --regexp=D:/outside .", "rg -F 'D:/outside' .", "grep -F -e 'D:/outside' .",
      "rg -FeD:/outside .", "rg -g D:/glob -e D:/pattern .", "rg --pre-glob D:/pattern -e needle .",
      "rg --context-separator D:/separator -e needle .", "rg -E utf-8 D:/pattern .", "grep -d recurse D:/pattern ."]) {
      await f.run(command);
      assert.equal(f.invoked.at(-1), command);
      assert.deepEqual((f.owner as any).commandFacts.paths, [], command);
    }
    await f.run("rg -F -e 'D:/pattern' D:/outside > D:/result.txt");
    assert.deepEqual((f.owner as any).commandFacts.paths, ["D:/outside", "D:/result.txt"]);
    await f.run("rg -f D:/patterns.txt D:/outside");
    assert.deepEqual((f.owner as any).commandFacts.paths, ["D:/patterns.txt", "D:/outside"]);
    await f.run("rg D:/outside -e needle");
    assert.deepEqual((f.owner as any).commandFacts.paths, ["D:/outside"]);
    // Search data is excluded without dropping real option paths or wrapper working directories.
    for (const command of ["rg --pre=D:/tools/filter.exe -e D:/pattern .", "rg --pre D:/tools/filter.exe -e D:/pattern ."]) {
      await f.run(command);
      assert.deepEqual((f.owner as any).commandFacts.paths, ["D:/tools/filter.exe"], command);
    }
    for (const command of ["env -C D:/outside rg -e D:/pattern .", "env --chdir=D:/outside rg -e D:/pattern ."]) {
      const facts: SandboxCommandFacts = { network: undefined, paths: [] };
      inspectSandboxCommand("bash", command, facts);
      assert.deepEqual(facts.paths, ["D:/outside"], command);
    }
    for (const command of ["rg --hostname-bin=D:/tools/hostname.exe needle .", "rg --hostname-bin D:/tools/hostname.exe needle ."]) {
      await f.run(command);
      assert.deepEqual((f.owner as any).commandFacts.paths, ["D:/tools/hostname.exe"], command);
    }
    // grep's color value is optional and attached; rg's color value is required.
    for (const command of ["grep --color needle D:/outside", "grep --color=auto needle D:/outside", "rg --color always needle D:/outside"]) {
      await f.run(command);
      assert.deepEqual((f.owner as any).commandFacts.paths, ["D:/outside"], command);
    }
    const facts: SandboxCommandFacts = { network: undefined, paths: [] };
    inspectSandboxCommand("powershell", "& 'D:\\tools\\rg.exe' -e 'D:\\pattern' D:\\outside", facts);
    assert.deepEqual(facts.paths, ["D:\\tools\\rg.exe", "D:\\outside"]);
  } finally { await f.close(); }
});

test("an offline sandbox asks once before a network command; consent lasts for the session, refusal does not run", async () => {
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

test("an observed outside-path failure pauses the turn without prechecking commands; offline failures name their cause", async () => {
  const f = fixture({ session: new SandboxNetworkSession() });
  // The Windows adapter recognizes Windows absolute operands. Its fake error
  // must use the same host resolver as failureNote, including on Linux CI.
  const argument = "D:/other/x.txt", outside = path.resolve(argument);
  f.backend.hostPathKind = async () => HOST_PATH_HOST_ONLY;
  f.backend.invoke = async (_name: string, input: { command: string }) => {
    f.invoked.push(input.command);
    return { ok: true, execution: { exitCode: 1, timedOut: false, closed: true, stdout: "", stderr: "Cannot find path " + outside } };
  };
  await assert.rejects(f.run(`Get-Content '${argument}'`), error => /SANDBOX_PATH_UNMAPPED/.test(String(error)) && /\/add-dir/.test(String(error)));
  assert.equal(f.invoked[0], `Get-Content '${argument}'`);
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

test("diagnostic path kinds distinguish workspace, tool installations and ungranted paths", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMP ?? process.cwd(), "r5-paths-")));
  try {
    const workspace = path.join(root, "workspace"), other = path.join(root, "other"), tools = path.join(root, "tools");
    for (const directory of [workspace, other, tools]) await fs.mkdir(directory);
    const backend = new WorkspaceSandboxBackend(workspace, root, "read-only", {});
    (backend as any).roots = [workspace];
    (backend as any).toolchains = { mountRoots: [tools] };
    assert.equal(await backend.hostPathKind(path.join(workspace, "src", "a.ts")), HOST_PATH_WORKSPACE);
    assert.equal(await backend.hostPathKind(root.toUpperCase()), HOST_PATH_HOST_ONLY);
    assert.equal(await backend.hostPathKind(path.join(tools, "bin")), HOST_PATH_TOOL);
    assert.equal(await backend.hostPathKind(other.replaceAll("\\", "/")), HOST_PATH_HOST_ONLY);
    assert.equal(await backend.hostPathKind(path.join(other, "missing")), HOST_PATH_HOST_ONLY);
  } finally { await fs.rm(root, { recursive: true }); }
});

test("session consent changes the next process policy without recreating workspace resources", async () => {
  const session = new SandboxNetworkSession();
  const backend = new WorkspaceSandboxBackend(process.cwd(), process.cwd(), "read-only", { networkSession: session });
  (backend as any).root = "fixture-owned-runtime";
  assert.equal(backend.networkEnabled, false);
  await backend.enableSessionNetwork();
  assert.equal(backend.networkEnabled, true); assert.equal(backend.diagnostics.root, "fixture-owned-runtime");
  // The global setting still enables networking without a session consent.
  assert.equal(new WorkspaceSandboxBackend(process.cwd(), process.cwd(), "read-only", { network: "enabled" }).networkEnabled, true);
});
