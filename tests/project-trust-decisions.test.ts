import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME, getConfigDir } from "../packages/coding-agent/src/config.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { resolveProjectTrusted, type ResolveProjectTrustedOptions } from "../packages/coding-agent/src/core/project-trust.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../packages/coding-agent/src/core/trust-manager.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

function unexpectedUI(): never { assert.fail("This trust decision must not prompt"); }

function fixture(t: TestContext, resources = false) {
  const root = mkdtempSync(join(tmpdir(), "sp-trust-decision-"));
  t.after(() => removeOwnedFixture(root));
  const cwd = join(root, "project", "child"), agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "Fixture instructions\n");
  if (resources) mkdirSync(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
  assert.equal(hasTrustRequiringProjectResources(cwd), resources);
  const store = new ProjectTrustStore(agentDir);
  const read = t.mock.method(store, "get");
  const options: ResolveProjectTrustedOptions = {
    cwd, trustStore: store, defaultProjectTrust: "ask",
    projectTrustContext: { cwd, mode: "rpc", hasUI: false,
      ui: { select: unexpectedUI, confirm: unexpectedUI, input: unexpectedUI, notify: unexpectedUI } },
  };
  return { cwd, agentDir, store, read, options };
}

for (const decision of [false, true, null]) {
  test(`AGENTS-only project honors saved ${decision} without a UI`, async t => {
    const f = fixture(t);
    if (decision !== null) f.store.set(f.cwd, decision);
    // Defaults must not replace a saved decision or the established no-resource behavior.
    f.options.defaultProjectTrust = decision === false ? "always" : "never";
    assert.equal(await resolveProjectTrusted(f.options), decision ?? true);
    assert.equal(f.read.mock.callCount(), 1);
  });
}

test("saved denial also avoids prompting when a UI is available", async t => {
  const f = fixture(t);
  f.store.set(f.cwd, false);
  f.options.projectTrustContext.mode = "tui";
  f.options.projectTrustContext.hasUI = true;
  assert.equal(await resolveProjectTrusted(f.options), false);
  assert.equal(f.read.mock.callCount(), 1);
});

test("nearest saved decision controls inherited denial and child overrides", async t => {
  const f = fixture(t);
  f.store.set(dirname(f.cwd), false);
  assert.equal(await resolveProjectTrusted(f.options), false);
  f.store.set(f.cwd, true);
  assert.equal(await resolveProjectTrusted(f.options), true);
  f.store.set(f.cwd, null);
  assert.equal(await resolveProjectTrusted(f.options), false);
  assert.equal(f.read.mock.callCount(), 3, "one lookup per resolution");
});

for (const override of [false, true]) {
  test(`explicit ${override} overrides a saved decision without reading the store`, async t => {
    const f = fixture(t);
    f.store.set(f.cwd, !override);
    assert.equal(await resolveProjectTrusted({ ...f.options, trustOverride: override }), override);
    assert.equal(f.read.mock.callCount(), 0);
    assert.equal(f.store.getEntry(f.cwd)?.decision, !override, "override remains session-only");
  });
}

for (const hookDecision of ["yes", "no", "undecided"] as const) {
  test(`resource-bearing project preserves ${hookDecision} hook precedence`, async t => {
    const f = fixture(t, true);
    f.store.set(f.cwd, hookDecision === "no");
    const runtime = createExtensionRuntime();
    t.after(async () => { await runtime.disposeProviderOwners(); runtime.invalidate(); });
    let hooks = 0;
    const extension = await loadExtensionFromFactory(pi => {
      pi.on("project_trust", () => { hooks++; return { trusted: hookDecision }; });
    }, f.cwd, createEventBus(), runtime);
    f.options.extensionsResult = { extensions: [extension], errors: [], runtime };
    assert.equal(await resolveProjectTrusted(f.options), hookDecision === "yes");
    assert.equal(hooks, 1);
    assert.equal(f.read.mock.callCount(), hookDecision === "undecided" ? 1 : 0);
    assert.equal(await resolveProjectTrusted({ ...f.options, trustOverride: true }), true);
    assert.equal(hooks, 1, "explicit override bypasses hooks");
  });
}

test("resource-bearing project with no decision still denies without a UI", async t => {
  const f = fixture(t, true);
  assert.equal(await resolveProjectTrusted(f.options), false);
  assert.equal(f.read.mock.callCount(), 1);
});

test("corrupt trust data propagates its error and releases the existing lock", async t => {
  const f = fixture(t);
  f.store.set(f.cwd, false);
  const path = join(getConfigDir(f.agentDir), "trust.json");
  const saved = readFileSync(path, "utf8");
  writeFileSync(path, "{broken");
  await assert.rejects(resolveProjectTrusted(f.options), /Failed to read trust store/);
  assert.equal(existsSync(`${path}.lock`), false);
  writeFileSync(path, saved);
  assert.equal(await resolveProjectTrusted(f.options), false);
  assert.equal(f.read.mock.callCount(), 2);
  assert.equal(existsSync(`${path}.lock`), false);
});
