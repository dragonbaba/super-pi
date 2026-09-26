import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { protectWindowsFixture } from "./helpers/native-metadata-fixture.ts";
const execute = promisify(execFile);
const offlinePreload = pathToFileURL(resolve("tests/fixtures/native-offline-preload.mjs")).href;

test("N2 built formal source launcher runs default exact/overwrite/snapshot native commits", { timeout: 60000 }, async t => {
  const temporary = await realpath(tmpdir()), root = await mkdtemp(join(temporary, "sp-source-native-"));
  t.after(async () => { assert.equal(dirname(root), temporary); await rm(root, { recursive: true, force: true }); });
  const cwd = join(root, "work"), agent = join(root, "agent"); await mkdir(cwd); await mkdir(agent);
  await writeFile(join(cwd, "中文.txt"), "before\n");
  await protectWindowsFixture(join(cwd, "中文.txt"));
  const running = execute(process.execPath, ["--import", offlinePreload, resolve("scripts/superpi.mjs"), "--offline", "--mode", "json", "--print", "--no-session",
    "--provider", "native-source-fixture", "--model", "fixture", "--extension", resolve("tests/fixtures/native-source-entry.mjs"), "Run the isolated native delivery fixture."],
    { cwd, windowsHide: true, timeout: 55000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, SP_CODING_AGENT_DIR: agent, SP_OFFLINE: "1" } });
  running.child.stdin?.end();
  const { stdout, stderr } = await running;
  assert.match(stderr, /NATIVE_NETWORK_ATTEMPTS:0/);
  assert.match(stdout, /NATIVE_SOURCE_COMPLETE/, stderr);
  assert.equal(await readFile(join(cwd, "中文.txt"), "utf8"), "snapshot\n");
  const events = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  const mutations = events.filter(event => event.type === "tool_execution_end" && ["edit", "write"].includes(event.toolName));
  assert.equal(mutations.length, 3, stdout);
  for (const event of mutations) {
    assert.equal(event.isError, false); assert.equal(event.result.details.commit.outcome, "committed");
    assert.equal(event.result.details.commit.strategy, "staged_replace", JSON.stringify(event.result));
  }
  t.diagnostic(JSON.stringify({ entry: "scripts/superpi.mjs", builtCli: true, defaultResources: true, provider: "offline fixture", mutations: mutations.length, node: process.version, platform: process.platform }));
});

test("N2 packed runtime extension includes worker and resolves installed platform binary", { timeout: 60000 }, async t => {
  const temporary = await realpath(tmpdir()), root = await mkdtemp(join(temporary, "sp-packed-native-"));
  t.after(async () => { assert.equal(dirname(root), temporary); await rm(root, { recursive: true, force: true }); });
  const npm = process.env.npm_execpath;
  assert.ok(npm, "Run delivery checks through npm so the installed npm entry is explicit.");
  const packed = await execute(process.execPath, [npm, "pack", "--workspace", "@super-pi/mutation-guard-write", "--ignore-scripts", "--json", "--pack-destination", root], { windowsHide: true });
  const manifest = JSON.parse(packed.stdout)[0];
  for (const name of ["native-file-worker.mjs", "native-file-client.ts", "file-commit.ts", "file-commit-metadata.ts"]) assert.ok(manifest.files.some((file: any) => file.path === name));
  await execute("tar", ["-xzf", join(root, manifest.filename), "-C", root], { windowsHide: true });
  const runtimeManifest = JSON.parse(await readFile(join(root, "package/package.json"), "utf8"));
  assert.equal(runtimeManifest.dependencies.koffi, "3.3.1");
  // Installed-runtime packaging check, with no installation/download in the smoke.
  // The repository ships source workspaces; this private extension pack is not a standalone CLI release.
  const modules = join(root, "node_modules"); await mkdir(join(modules, "@koromix"), { recursive: true });
  await cp(resolve("node_modules/koffi"), join(modules, "koffi"), { recursive: true });
  const platform = `koffi-${process.platform}-${process.arch}`;
  await cp(resolve("node_modules/@koromix", platform), join(modules, "@koromix", platform), { recursive: true });
  const { stdout, stderr } = await execute(process.execPath, ["--import", offlinePreload, "--experimental-strip-types", "--input-type=module", "-e",
    "import {nativeFileRequest,disposeNativeFileWorker} from './package/native-file-client.ts'; console.log(JSON.stringify(await nativeFileRequest('stats'))); await disposeNativeFileWorker();"],
    { cwd: root, windowsHide: true });
  assert.equal(JSON.parse(stdout).activeHandles, 0);
  assert.match(stderr, /NATIVE_NETWORK_ATTEMPTS:0/);
  t.diagnostic(JSON.stringify({ packageBytes: manifest.size, packageUnpackedBytes: manifest.unpackedSize, installedPlatform: platform, offlineRuntime: true }));
});
