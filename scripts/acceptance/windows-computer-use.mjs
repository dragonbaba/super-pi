// Interactive Windows acceptance with two private WinForms windows and a real stdio driver.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { McpBridgeRuntime } from "../../packages/mcp-bridge/src/bridge.js";
import { loadMcpConfig } from "../../packages/mcp-bridge/src/config.js";

const [driver, pwsh] = process.argv.slice(2);
assert.ok(process.platform === "win32" && driver && pwsh, "Pass the driver executable and PowerShell 7 executable on Windows");
assert.ok(statSync(driver).isFile() && statSync(pwsh).isFile(), "Executables must exist");
const project = fileURLToPath(new URL("../../", import.meta.url));
const scratch = join(project, ".task-tmp");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "desktop-acceptance-"));
const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
process.env.SP_CODING_AGENT_DIR = root;
const windows = [];
const clients = [];

function contents(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function until(check) {
  const deadline = Date.now() + 10000;
  do {
    if (check()) return;
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for " + check.toString());
}

async function fixture(label) {
  const directory = join(root, label);
  mkdirSync(directory);
  const title = basename(root) + "-" + label;
  const child = spawn(pwsh, ["-NoProfile", "-STA", "-File", join(import.meta.dirname, "windows-computer-use-fixture.ps1"), directory, title], { env, windowsHide: false, stdio: "inherit" });
  const exited = once(child, "exit");
  const window = { child, exited, title, directory };
  windows.push(window);
  const ready = join(directory, "window");
  await until(() => contents(ready).endsWith("}"));
  return Object.assign(window, JSON.parse(contents(ready)));
}

function client() {
  const tools = new Map();
  const runtime = new McpBridgeRuntime({ registerTool(tool) { tools.set(tool.name, tool); } }, root);
  clients.push(runtime);
  return { runtime, exec(name, args, signal) {
    return tools.get("mcp__desktop__" + name).execute(name, args, signal);
  } };
}

async function call(owner, name, args) {
  const result = await owner.exec(name, args);
  assert.ok(!result.details?.mcpError, JSON.stringify(result.content[0]?.text));
  const value = JSON.parse(result.content[0].text);
  assert.notEqual(value.success, false, JSON.stringify(value));
  return value;
}

async function rejected(owner, name, args) {
  const result = await owner.exec(name, args);
  assert.ok(result.details?.mcpError || JSON.parse(result.content[0].text).success === false, "Expected refusal from " + name);
}

async function find(owner, windowHandle, name) {
  const result = await call(owner, "ui_find", { windowHandle, name, requireUnique: true });
  assert.equal(result.items.length, 1);
  return result.items[0].id;
}

try {
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/mcp.json"), JSON.stringify({ version: 1, servers: { desktop: {
    command: resolve(pwsh), args: ["-NoProfile", "-NonInteractive", "-File", join(project, "packages/mcp-bridge/src/windows-desktop.ps1"), resolve(driver)],
    cwd: root, onDemand: true, env: { TEMP: root, TMP: root, TMPDIR: root },
  } } }));
  const config = loadMcpConfig(root, false).servers[0];
  const form = await fixture("target");
  const other = await fixture("other");
  const windowHandle = form.handle;
  const first = client(), second = client();
  await first.runtime.connect(config);
  await assert.rejects(second.runtime.connect(config), { code: "protocol-error" });
  const discovered = await call(first, "window_management", { action: "find", title: form.title });
  assert.ok(JSON.stringify(discovered).includes(windowHandle), JSON.stringify(discovered));
  const editor = await find(first, windowHandle, "Probe editor");
  const record = await find(first, windowHandle, "Record");
  const value = "  中文\r\nsecond line  ";
  await call(first, "ui_type", { windowHandle, elementId: editor, clearFirst: true, text: value, inputMode: "value" });
  assert.equal((await call(first, "ui_read", { windowHandle, elementId: editor })).text, value);
  const screenshot = await first.exec("screenshot_control", { action: "capture", target: "window", windowHandle, includeImage: true, imageFormat: "png", annotate: false, outputMode: "inline" });
  const image = screenshot.content.find(block => block.type === "image");
  assert.equal(Buffer.from(image.data, "base64").readUInt32BE(0), 0x89504e47);
  const mouse = { action: "click", windowHandle, x: form.x, y: form.y };
  await call(first, "window_management", { action: "activate", handle: other.handle });
  await rejected(first, "mouse_control", { ...mouse, expectedWindowTitle: other.title });
  assert.equal(contents(join(form.directory, "canvas")), "");
  await call(first, "window_management", { action: "activate", handle: windowHandle });
  await call(first, "mouse_control", { ...mouse, expectedWindowTitle: form.title });
  await until(() => contents(join(form.directory, "canvas")) === "1");
  assert.equal(contents(join(other.directory, "canvas")), "");
  const sample = join(form.directory, "sample.txt");
  writeFileSync(sample, value);
  const open = await find(first, windowHandle, "Open file");
  await call(first, "ui_click", { windowHandle, elementId: open });
  const dialog = await call(first, "window_management", { action: "wait_for", title: form.title + " open" });
  assert.equal(dialog.window.title, form.title + " open");
  assert.equal(dialog.window.pid, form.child.pid);
  const dw = dialog.window.handle;
  const combo = await call(first, "ui_find", { windowHandle: dw, automationId: "1148", controlType: "ComboBox", requireUnique: true });
  const found = await call(first, "ui_find", { windowHandle: dw, parentElementId: combo.items[0].id, controlType: "Edit", requireUnique: true });
  await call(first, "ui_type", { windowHandle: String(dw), elementId: found.items[0].id, inputMode: "value", text: sample, clearFirst: true });
  const ok = await call(first, "ui_find", { windowHandle: String(dw), automationId: "1", controlType: "Button", requireUnique: true });
  await call(first, "ui_click", { windowHandle: String(dw), elementId: ok.items[0].id });
  await until(() => contents(join(form.directory, "opened")) === sample);
  console.log("Passed window selection, Unicode, scoped image, focus check, canvas and native dialog");

  const cancel = new AbortController();
  const pending = first.exec("ui_batch", { windowHandle, stopOnError: true, steps: JSON.stringify([
    { action: "click", elementId: record }, { action: "wait", mode: "appear", name: "Absent control", timeoutMs: 5000 },
    { action: "click", elementId: record },
  ]) }, cancel.signal);
  const committed = join(form.directory, "records");
  await until(() => contents(committed) === value + "<END>");
  cancel.abort();
  assert.equal((await pending).details.mcpError, "aborted");
  const typing = new AbortController();
  const input = first.exec("ui_type", { windowHandle, elementId: editor, inputMode: "keyboard", text: "p".repeat(1000), clearFirst: true }, typing.signal);
  const length = () => Number(contents(join(form.directory, "length")));
  await until(() => length() > value.length && length() < 1000);
  typing.abort();
  assert.equal((await input).details.mcpError, "aborted");
  await delay(100);
  const afterCancellation = length();
  await delay(250);
  assert.ok(afterCancellation < 1000 && length() === afterCancellation, "Driver kept typing after cancellation");
  await first.runtime.close();
  await second.runtime.connect(config);
  const stopped = length();
  await delay(150);
  assert.ok(stopped < 1000 && length() === stopped);
  assert.equal(contents(committed), value + "<END>");
  await rejected(second, "ui_read", { windowHandle, elementId: editor });
  const fresh = await find(second, windowHandle, "Probe editor");
  await call(second, "ui_type", { windowHandle, elementId: fresh, inputMode: "keyboard", clearFirst: true, text: "next" });
  assert.equal((await call(second, "ui_read", { windowHandle, elementId: fresh })).text, "next");
  form.child.kill();
  await form.exited;
  await rejected(second, "ui_read", { windowHandle, elementId: fresh });
  assert.equal(contents(join(other.directory, "records")), "");
  console.log("Passed cancellation, partial input, exactly one committed click, exclusive ownership, handoff and stale window");
} finally {
  try { await Promise.all(clients.map(runtime => runtime.close())); }
  finally {
    for (const window of windows) if (window.child.exitCode === null && !window.child.signalCode) window.child.kill();
    await Promise.all(windows.map(window => window.exited));
    rmSync(root, { recursive: true, force: true });
  }
}
