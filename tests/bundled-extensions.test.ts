import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import tps from "../.sp/extensions/tps.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const extensionRoot = join(root, "packages", "extensions");
const removed = ["session-tool-errors", "tool-input-repair-telemetry"];
const retainedEntries = [
  "./auxiliary-vision/index.ts",
  "./browser-use/index.ts",
  "./false-success-guard/index.ts",
  "./mutation-guard-write/index.ts",
  "./resource-lifecycle-guard/index.ts",
  "./session-memory-manager/index.ts",
  "./structured-readonly-command/index.ts",
  "./subagent/index.ts",
  "./tool-loop-guardrails/index.ts",
];

function json(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("bundled reports are removed while retained extensions keep their loading order", () => {
  assert.deepEqual(json(join(extensionRoot, "package.json")).pi.extensions, retainedEntries);
  for (const entry of retainedEntries) assert.ok(existsSync(resolve(extensionRoot, entry)), entry);
  for (const name of removed) assert.equal(existsSync(join(extensionRoot, name, "index.ts")), false);
  assert.ok(json(join(root, ".sp/config/settings.json")).packages.includes("../../packages/extensions"));
});

test("the real launcher still assembles TPS and every retained bundled resource", t => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-bundled-extensions-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const cliPath = join(root, "packages/coding-agent/dist/cli.js");
  const launcher = pathToFileURL(join(root, "scripts/superpi.mjs")).href;
  // Intercept only the final CLI import: execute the actual launcher without
  // reading credentials, opening a Session, or invoking a model or extension.
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      if (url === ${JSON.stringify(pathToFileURL(cliPath).href)}) {
        return { format: 'module', shortCircuit: true, source: 'console.log(JSON.stringify(process.argv.slice(2)))' };
      }
      return nextLoad(url, context);
    } });
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(launcher))}, '--help'];
    await import(${JSON.stringify(launcher)});
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fixture,
    env: { SystemRoot: process.env.SystemRoot, TEMP: fixture, TMP: fixture, SP_AGENT_DIR: join(fixture, "agent") },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const args: string[] = JSON.parse(child.stdout);
  const expected: string[] = [];
  const settingsDir = join(root, ".sp/config");
  for (const packageSource of json(join(settingsDir, "settings.json")).packages) {
    const packageDir = resolve(settingsDir, packageSource);
    const manifest = json(join(packageDir, "package.json"));
    for (const [field, flag] of [["extensions", "--extension"], ["skills", "--skill"], ["prompts", "--prompt-template"]]) {
      for (const entry of manifest.pi?.[field] ?? []) expected.push(flag, resolve(packageDir, entry));
    }
  }
  for (const entry of readdirSync(join(root, ".sp/extensions"), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|ts)$/u.test(entry.name)) expected.push("--extension", join(root, ".sp/extensions", entry.name));
  }
  for (const [directory, flag] of [["skills", "--skill"], ["prompts", "--prompt-template"]]) {
    const path = join(root, ".sp", directory);
    if (existsSync(path)) expected.push(flag, path);
  }
  assert.deepEqual(args, [...expected, "--help"]);
  for (let index = 1; index < expected.length; index += 2) assert.ok(existsSync(expected[index]), expected[index]);
  const paths = args.filter((_, index) => index > 0 && args[index - 1] === "--extension");
  assert.equal(paths.filter(path => path === join(root, ".sp/extensions/tps.ts")).length, 1);
  assert.ok(paths.includes(join(root, ".sp/extensions/prompt-url-widget.ts")));
  assert.deepEqual(paths.filter(path => path.startsWith(extensionRoot + "/") || path.startsWith(extensionRoot + "\\")),
    retainedEntries.map(entry => resolve(extensionRoot, entry)));
  for (const name of removed) assert.ok(paths.every(path => !path.includes(name)));
});

test("runtime source no longer registers either report command", () => {
  const pending = [join(root, "packages"), join(root, ".sp/extensions")];
  const registrations: string[] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", "tests", "vendor"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(path); continue; }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name)) continue;
      const text = readFileSync(path, "utf8");
      if (!text.includes("registerCommand")) continue;
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "registerCommand") {
          const name = node.arguments[0];
          if (name && ts.isStringLiteralLike(name)) registrations.push(name.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  assert.ok(registrations.length > 0, "registration scan must inspect active extensions");
  assert.equal(registrations.includes("tool-errors"), false);
  assert.equal(registrations.includes("tool-repairs"), false);
});

test("TPS retains agent listeners, usage totals, elapsed time, and UI notification", t => {
  const handlers = new Map<string, (...args: any[]) => void>();
  tps({ on(name: string, handler: (...args: any[]) => void) { handlers.set(name, handler); } } as never);
  assert.deepEqual([...handlers.keys()], ["agent_start", "agent_end"]);
  t.mock.method(Date, "now", () => 1000);
  handlers.get("agent_start")!();
  t.mock.method(Date, "now", () => 3000);
  const notices: unknown[][] = [];
  handlers.get("agent_end")!({ messages: [
    { role: "user" },
    { role: "assistant", usage: { input: 10, output: 20, cacheRead: 2, cacheWrite: 3, totalTokens: 35 } },
    { role: "assistant", usage: { input: 15, output: 30, cacheRead: 3, cacheWrite: 4, totalTokens: 52 } },
  ] }, { hasUI: true, ui: { notify(...args: unknown[]) { notices.push(args); } } });
  assert.deepEqual(notices, [["TPS 25.0 tok/s. out 50, in 25, cache r/w 5/7, total 87, 2.0s", "info"]]);
});
