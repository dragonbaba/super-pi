import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createProviderAwareCompactionExtension } from "../packages/provider-aware-compaction/src/index.ts";

test("provider-aware presets require explicit configuration independent of data-sharing permission", async () => {
  const root = mkdtempSync(join(tmpdir(), "compaction-policy-"));
  const cwd = join(root, "project"), globalFile = join(root, "config", "provider-aware-compaction.json");
  const projectFile = join(cwd, ".sp", "config", "provider-aware-compaction.json");
  const names = ["SP_CODING_AGENT_DIR", "SP_PORTABLE_COMPACTION_FALLBACK", "SP_PORTABLE_COMPACTION_TARGET_PROVIDER",
    "SP_PORTABLE_COMPACTION_FALLBACK_MODEL", "SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER"];
  const previous = names.map(name => process.env[name]);
  for (const name of names) delete process.env[name];
  process.env.SP_CODING_AGENT_DIR = root;
  mkdirSync(join(root, "config"), { recursive: true }); mkdirSync(join(cwd, ".sp", "config"), { recursive: true });
  const kimi = "kimi-self-preserve-32k-v1", claude = "claude-deepseek-fallback-v1", deepseek = "deepseek-self-preserve-v1";
  const models = [
    { provider: "kimi-coding", id: "k3-256k", api: "openai-completions" },
    { provider: "superapi-claude", id: "claude-test", api: "anthropic-messages" },
    { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" },
  ];
  let trusted = true, queries = 0, summaries = 0, notices = 0;
  const context: any = { cwd, model: models[0], isProjectTrusted: () => trusted, hasUI: true, ui: { notify() { notices++; } },
    modelRegistry: { find: () => models[2], getApiKeyAndHeaders: async () => { queries++; return { ok: true, apiKey: "synthetic" }; } } };
  const event: any = { preparation: { firstKeptEntryId: "entry", tokensBefore: 10, settings: { reserveTokens: 128 } }, signal: new AbortController().signal };
  const install = (options: any = {}, legacy = false) => {
    let strategy: any, hook: any;
    const api: any = { getThinkingLevel: () => "off", appendEntry() {}, on: (_name: any, handler: any) => { hook = handler; } };
    if (!legacy) api.registerCompactionStrategy = (value: any) => { strategy = value; };
    createProviderAwareCompactionExtension({ compactFn: async preparation => {
      summaries++; return { summary: "synthetic", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore };
    }, ...options })(api);
    return { strategy, hook };
  };
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
  try {
    const { strategy } = install();
    for (const model of models) { context.model = model; assert.equal(strategy.prepare(context), undefined); }
    write(projectFile, { allowCrossProviderSummary: true });
    assert.equal(strategy.prepare(context), undefined, "permission alone never enables a preset");
    process.env.SP_PORTABLE_COMPACTION_FALLBACK = "1";
    assert.equal(install({ fallbackModel: "deepseek/deepseek-v4-flash" }).strategy.prepare(context), undefined);
    context.model = models[0]; write(globalFile, { policies: [kimi] });
    assert.equal(typeof strategy.prepare(context), "function", "missing project policies inherit global selection");
    write(projectFile, { policies: [] }); assert.equal(strategy.prepare(context), undefined);
    trusted = false; assert.equal(typeof strategy.prepare(context), "function", "untrusted project cannot disable or enable global presets");
    writeFileSync(projectFile, "invalid JSON"); assert.equal(typeof strategy.prepare(context), "function", "untrusted project file is not read");
    trusted = true; assert.throws(() => strategy.prepare(context), /Invalid JSON/);
    assert.deepEqual(install({}, true).hook(event, context), { cancel: true }, "old hosts receive explicit cancellation instead of a swallowed parse error");
    assert.equal(notices, 1); assert.equal(queries, 0); assert.equal(summaries, 0);
    for (const policies of [null, {}, ["unknown"], [kimi, kimi], [42], [kimi, claude, deepseek, kimi]]) {
      write(projectFile, { policies }); assert.throws(() => strategy.prepare(context), /Compaction policies/);
    }
    write(projectFile, []); assert.throws(() => strategy.prepare(context), /must be an object/);
    rmSync(projectFile); mkdirSync(projectFile);
    assert.throws(() => strategy.prepare(context), /Cannot read/);
    rmSync(projectFile, { recursive: true }); write(projectFile, { policies: [claude, deepseek, kimi] });
    for (const model of models) { context.model = model; assert.equal(typeof strategy.prepare(context), "function"); }
    context.model = models[0];
    const presets = [kimi]; const explicit = install({ policies: presets }).strategy; presets.length = 0;
    write(projectFile, { policies: [] }); assert.equal(typeof explicit.prepare(context), "function", "options use an internal snapshot");
    assert.equal(install({ policies: [] }).strategy.prepare(context), undefined);
    assert.throws(() => install({ policies: ["unknown"] }), /Compaction policies/);
    write(projectFile, { policies: [kimi] });
    const selected = strategy.prepare(context);
    write(projectFile, { policies: [] });
    assert.ok((await selected({ ...event, auth: { model: context.model, apiKey: "captured" } }, context)).compaction);
    assert.equal(summaries, 1); assert.equal(queries, 0, "selection and self auth remain captured");
    context.model = models[1];
    write(globalFile, { policies: [claude], allowCrossProviderSummary: true });
    write(projectFile, { policies: [claude] });
    assert.deepEqual(await strategy.prepare(context)(event, context), { cancel: true }, "preset and global permission field do not grant project data sharing");
    assert.equal(queries, 0); assert.equal(summaries, 1);
    trusted = false; process.env.SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER = "1";
    assert.ok((await strategy.prepare(context)(event, context)).compaction, "existing explicit process permission still works");
    assert.equal(queries, 1); assert.equal(summaries, 2);
    process.env.SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER = "0";
    const custom = install({ targetProvider: "superapi-claude", fallbackModel: "deepseek/deepseek-v4-flash", policies: [] }).strategy;
    assert.equal(typeof custom.prepare(context), "function", "explicit target retains precedence over presets");
    assert.deepEqual(await custom.prepare(context)(event, context), { cancel: true });
    process.env.SP_PORTABLE_COMPACTION_FALLBACK = "0";
    assert.equal(install({ policies: [claude] }).strategy, undefined);
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
});
