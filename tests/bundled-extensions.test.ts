import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import tps from "../.sp/extensions/tps.ts";
import { captureBundledArguments } from "./helpers/bundled-launcher.ts";
import { VERSION } from "../packages/coding-agent/src/config.ts";

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

test("bundled reports are removed while retained extensions keep their loading order and accept the host", async () => {
  assert.deepEqual(json(join(extensionRoot, "package.json")).pi.extensions, retainedEntries);
  for (const entry of retainedEntries) assert.ok(existsSync(resolve(extensionRoot, entry)), entry);
  for (const name of removed) assert.equal(existsSync(join(extensionRoot, name, "index.ts")), false);
  assert.ok(json(join(root, ".sp/config/settings.json")).packages.includes("../../packages/extensions"));
  for (const relative of [
    "extensions/subagent/regex.ts", "extensions/session-memory-manager/regex.ts",
    "mcp-bridge/src/regex.js", "project-context/src/regex.js", "statusline/src/regex.ts",
    "openai-server-compaction/src/regex.ts", "openai-fast-mode/src/regex.ts",
  ]) {
    const { SUPPORTED_SP_VERSION_PATTERN: supported } = await import(pathToFileURL(join(root, "packages", relative)).href);
    assert.equal(supported.test(VERSION), true, `${relative} must accept the current host`);
    assert.equal(supported.test("0.84.1"), true, `${relative} must preserve legacy compatibility`);
    for (const version of ["0.83.1", "0.85.0", "2.0.0", "unknown"]) {
      assert.equal(supported.test(version), false, `${relative} must reject ${version}`);
    }
  }
});

test("the real launcher assembles default resources and honors explicit isolation flags", t => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-bundled-extensions-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const allResources = ["--extension", "--skill", "--prompt-template"];
  const childGuard = join(extensionRoot, "subagent/child-guard.ts");
  const dynamicRoot = join(root, "packages/dynamic-instructions");
  const dynamicEntries = json(join(dynamicRoot, "package.json")).pi.extensions;
  assert.equal(dynamicEntries.length, 1);
  const dynamicEntry = resolve(dynamicRoot, dynamicEntries[0]);
  const cases = [
    { args: ["--help"], omitted: [] },
    { args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--extension", childGuard, "--help"], omitted: allResources },
    { args: ["-ne", "-ns", "-np", "--help"], omitted: allResources },
    { args: ["--no-extensions", "--help"], omitted: ["--extension"] },
    { args: ["--system-prompt", "--no-extensions", "--help"], omitted: [] },
    { args: ["--", "--no-extensions", "list"], omitted: [] },
    { args: ["--model", "list", "--help"], omitted: [] },
    { args: ["list"], omitted: allResources },
    { args: ["--no-extensions", "--extension", dynamicEntry, "--help"], omitted: ["--extension"] },
  ];
  const results = captureBundledArguments(root, fixture, cases.map(entry => entry.args));
  const args = results[0]!;
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
  for (const [index, entry] of cases.entries()) {
    const bundled = expected.filter((_, i) => !entry.omitted.includes(expected[i - i % 2]!));
    assert.deepEqual(results[index], [...bundled, ...entry.args], JSON.stringify(entry.args));
  }
  for (let index = 1; index < expected.length; index += 2) assert.ok(existsSync(expected[index]), expected[index]);
  const paths = args.filter((_, index) => index > 0 && args[index - 1] === "--extension");
  assert.equal(paths.filter(path => path === dynamicEntry).length, 1);
  assert.equal(results[3]!.includes(dynamicEntry), false);
  assert.equal(results.at(-1)!.filter(path => path === dynamicEntry).length, 1);
  assert.equal(paths.filter(path => path === join(root, ".sp/extensions/tps.ts")).length, 1);
  assert.ok(paths.includes(join(root, ".sp/extensions/prompt-url-widget.ts")));
  assert.deepEqual(paths.filter(path => path.startsWith(extensionRoot + "/") || path.startsWith(extensionRoot + "\\")),
    retainedEntries.map(entry => resolve(extensionRoot, entry)));
  for (const name of removed) assert.ok(paths.every(path => !path.includes(name)));
});

test("the built launcher loads zero extensions or only explicit child/task providers", t => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-minimal-launcher-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const agent = join(fixture, "agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  writeFileSync(join(agent, "extensions/unwanted.js"), 'throw new Error("User discovery must be disabled");');
  const probe = join(fixture, "probe.mjs");
  writeFileSync(probe, `
    import { DefaultResourceLoader } from ${JSON.stringify(pathToFileURL(join(root, "packages/coding-agent/dist/core/resource-loader.js")).href)};
    const reload = DefaultResourceLoader.prototype.reload;
    DefaultResourceLoader.prototype.reload = async function (...args) {
      const result = await reload.apply(this, args);
      const loaded = this.getExtensions();
      process.stderr.write('MINIMAL_RESOURCES:' + JSON.stringify({
        paths: loaded.extensions.map(extension => extension.resolvedPath),
        errors: loaded.errors, factories: this.extensionFactories.length,
      }) + '\\n');
      return result;
    };
  `);
  const childGuard = join(extensionRoot, "subagent/child-guard.ts");
  for (const explicit of [[], ["--extension", childGuard], ["--extension", join(extensionRoot, "resource-lifecycle-guard/index.ts"), "--extension", join(extensionRoot, "subagent/index.ts")]]) {
    const child = spawnSync(process.execPath, [
      "--import", pathToFileURL(join(root, "tests/fixtures/native-offline-preload.mjs")).href,
      "--import", pathToFileURL(probe).href, join(root, "scripts/superpi.mjs"),
      "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-context-files", "--no-mcp", ...explicit, "--help",
    ], { cwd: fixture, encoding: "utf8", timeout: 20_000, maxBuffer: 512 * 1024, windowsHide: true,
      env: { ...process.env, HOME: fixture, USERPROFILE: fixture, SP_CODING_AGENT_DIR: agent } });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.match(child.stderr, /NATIVE_NETWORK_ATTEMPTS:0/);
    const records = [...child.stderr.matchAll(/^MINIMAL_RESOURCES:(.+)$/gm)];
    assert.equal(records.length, 1, child.stderr);
    assert.deepEqual(JSON.parse(records[0]![1]!), { paths: explicit.filter((_, index) => index % 2 === 1), errors: [], factories: 0 });
  }
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

test("source-loaded extensions name their real .ts files in relative imports", () => {
  // jiti probes about 60 candidate paths before it retries "./x.js" as "./x.ts".
  // One extension written that way cost 6,384 failed stat calls and ~75 ms at startup.
  const sourcePackages = new Map<string, string>();
  for (const name of readdirSync(join(root, "packages"))) {
    const manifestPath = join(root, "packages", name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = json(manifestPath);
    if (typeof manifest.main === "string" && manifest.main.endsWith(".ts")) sourcePackages.set(manifest.name, resolve(root, "packages", name, manifest.main));
  }
  const pending: string[] = [];
  for (const packagePath of json(join(root, ".sp/config/settings.json")).packages) {
    const packageRoot = resolve(root, ".sp/config", packagePath);
    for (const entry of json(join(packageRoot, "package.json")).pi?.extensions ?? []) if (entry.endsWith(".ts")) pending.push(resolve(packageRoot, entry));
  }
  for (const name of readdirSync(join(root, ".sp/extensions"))) if (name.endsWith(".ts")) pending.push(join(root, ".sp/extensions", name));
  const visited = new Set<string>();
  const mismatched: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const { fileName: specifier } of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
      if (!specifier.startsWith(".")) {
        const source = sourcePackages.get(specifier);
        if (source) pending.push(source);
        continue;
      }
      const target = resolve(file, "..", specifier);
      if (existsSync(target)) {
        if (target.endsWith(".ts")) pending.push(target);
      } else if (specifier.endsWith(".js") && existsSync(`${target.slice(0, -3)}.ts`)) {
        mismatched.push(`${file.slice(root.length)} imports "${specifier}"`);
        pending.push(`${target.slice(0, -3)}.ts`);
      }
    }
  }
  assert.ok(visited.size > 150, `walked only ${visited.size} extension source files`);
  assert.deepEqual(mismatched, [], 'write the relative import with its ".ts" extension');
});
