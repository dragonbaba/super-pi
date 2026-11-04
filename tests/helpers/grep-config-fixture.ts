import assert from "node:assert/strict";
import childProcess, { type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { rgPath } from "@vscode/ripgrep";

const root = process.argv[2]!, scene = process.argv[3]!, custom = process.argv[4] === "custom";
assert.equal(tmpdir(), root); assert.equal(process.env.TMP, root);
assert.equal(process.env.TEMP, root); assert.equal(process.env.TMPDIR, root);
assert.equal(process.env.SP_CODING_AGENT_DIR, root); assert.equal(process.env.SP_OFFLINE, "1");
// Only this isolated child resolves the test dependency before the user's PATH.
process.env.PATH = dirname(rgPath) + delimiter + (process.env.PATH ?? "");
const searchRoot = join(root, "data"), configPath = join(root, "ripgrep-config");
mkdirSync(searchRoot);
writeFileSync(join(searchRoot, "sample.txt"), "alpha42\nalpha[0-9]+\nALPHA99\nunchanged\n");
writeFileSync(join(searchRoot, "excluded.log"), "alpha77\n");
writeFileSync(configPath, "--fixed-strings\n");
if (scene !== "no-config") assert.equal(process.env.RIPGREP_CONFIG_PATH, configPath);
else assert.equal(process.env.RIPGREP_CONFIG_PATH, "");
const version = childProcess.spawnSync("rg", ["--version"], { encoding: "utf8" });
assert.ifError(version.error); assert.equal(version.status, 0, "Install ripgrep to run this integration test");
const manifest: { root: string; resources: string[]; processes: Array<{ pid: number; startedAt: string; purpose: string; code: number | null }>; args: string[] } = {
  root, resources: [searchRoot, join(searchRoot, "sample.txt"), join(searchRoot, "excluded.log"), configPath],
  processes: [{ pid: version.pid, startedAt: new Date().toISOString(), purpose: "rg version", code: version.status }], args: [] as string[] };
const manifestPath = join(root, "children.json");
manifest.resources.push(manifestPath);
writeFileSync(manifestPath, JSON.stringify(manifest));
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = ((command: string, args: string[], options: SpawnSyncOptions) => {
  const startedAt = new Date().toISOString();
  const result = originalSpawnSync(command, args, options);
  manifest.processes.push({ pid: result.pid, startedAt, purpose: "rg availability", code: result.status });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return result;
}) as typeof originalSpawnSync;
let searchChild: ReturnType<typeof originalSpawn> | undefined;
childProcess.spawn = ((command: string, args: string[], options: SpawnOptions) => {
  const startedAt = new Date().toISOString();
  const child = originalSpawn(command, args, options);
  searchChild = child;
  manifest.args = args.slice();
  const record = { pid: child.pid!, startedAt, purpose: "actual builtin grep", code: null as number | null };
  manifest.processes.push(record);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  child.once("close", code => { record.code = code; writeFileSync(manifestPath, JSON.stringify(manifest)); });
  return child;
}) as typeof originalSpawn;
syncBuiltinESMExports();
const { createGrepTool } = await import("../../packages/coding-agent/src/core/tools/grep.ts");
const { attachToolPath } = await import("../../packages/coding-agent/src/core/files/tool-path-authorization.ts");
let directoryChecks = 0, reads = 0, authorityChecks = 0;
const operations = custom ? { isDirectory(absolutePath: string) { directoryChecks++; return statSync(absolutePath).isDirectory(); },
  readFile(absolutePath: string) { reads++; return readFileSync(absolutePath, "utf8"); } } : undefined;
const tool = createGrepTool(root, { operations });
const input = { pattern: "alpha[0-9]+", path: "./data", literal: scene === "literal", ignoreCase: scene === "ignore-case",
  glob: "*.txt", context: custom ? 1 : 0 };
attachToolPath(input, "grep", "fixture", searchRoot, () => { authorityChecks++; });
const controller = new AbortController();
const result = await tool.execute("fixture", input, controller.signal);
await new Promise<void>(resolve => setImmediate(resolve));
assert.ok(searchChild);
assert.equal(searchChild.exitCode, 0);
assert.equal(searchChild.stdout?.destroyed, true); assert.equal(searchChild.stderr?.destroyed, true);
assert.equal(getEventListeners(controller.signal, "abort").length, 0);
const details = result.details as { matchCount?: number };
assert.equal(details.matchCount, scene === "ignore-case" ? 2 : 1);
const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
assert.ok(text.includes(scene === "literal" ? "sample.txt:2: alpha[0-9]+" : "sample.txt:1: alpha42"), text);
assert.equal(text.includes("excluded.log"), false);
assert.equal(authorityChecks, 1);
assert.equal(directoryChecks, custom ? 1 : 0); assert.equal(reads, custom ? 1 : 0);
if (scene === "regex") assert.equal(manifest.args.filter(arg => arg === "--no-config").length, 1);
assert.ok(manifest.args.includes("--hidden"));
assert.equal(manifest.args.includes("--fixed-strings"), scene === "literal");
assert.equal(manifest.args.includes("--ignore-case"), scene === "ignore-case");
assert.deepEqual(manifest.args.slice(-3), ["--", input.pattern, searchRoot]);
assert.equal(readFileSync(configPath, "utf8"), "--fixed-strings\n");
console.log(JSON.stringify({ scene, custom, matches: details.matchCount, reads, directoryChecks, authorityChecks,
  searchProcesses: 1, closed: true, listeners: 0, rgVersion: version.stdout.split("\n")[0] }));
