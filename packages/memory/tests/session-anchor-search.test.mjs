import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchSessionAnchors } from "../dist/store/session-anchor-search.js";
import { createExtensionHarness, emitAll } from "./extension-harness.mjs";

const agentDirectory = await mkdtemp(join(tmpdir(), "super-pi-session-search-"));
process.env.SP_CODING_AGENT_DIR = agentDirectory;
const { default: extension } = await import("../dist/index.js");
const { DatabaseManager } = await import("../dist/store/db.js");
test.after(async () => { await rm(agentDirectory, { recursive: true, force: true }); });

test("registered history search reads JSONL without an index for default and retired variant settings", async () => {
  const sessionsDir = join(agentDirectory, "sessions");
  const configDir = join(agentDirectory, "config");
  await mkdir(sessionsDir);
  await mkdir(configDir);
  const sessionPath = join(sessionsDir, "history.jsonl");
  await writeFile(sessionPath, [
    JSON.stringify({ type: "session", id: "history-1", cwd: agentDirectory }),
    JSON.stringify({ timestamp: "2026-08-24T10:00:00.000Z", message: { role: "user", content: "historyprobe" } }),
  ].join("\n") + "\n");
  const originalGetDb = DatabaseManager.prototype.getDb;
  DatabaseManager.prototype.getDb = () => { throw new Error("history search must not open SQLite"); };
  try {
    for (const config of [{}, { sessionSearch: { variant: "legacy" } }, { sessionSearch: { variant: "anchors" } }]) {
      await writeFile(join(configDir, "hermes-memory-config.json"), JSON.stringify(config));
      const harness = createExtensionHarness();
      extension(harness.api);
      try {
        const tool = harness.tools.get("session_search");
        const result = await tool.execute("history", { markdown: "all:\n- historyprobe" });
        assert.equal(result.details.success, true, JSON.stringify(config));
        assert.equal(result.details.count, 1);
        assert.equal(result.details.ranges[0].path, sessionPath);
        assert.equal(result.details.ranges[0].startLine, 2);
        assert.ok(result.content[0].text.includes(`${sessionPath}:2-2`));
        assert.equal((await tool.execute("missing", { markdown: "all:\n- missingprobe" })).details.count, 0);
      } finally {
        await emitAll(harness, "session_shutdown", {}, {});
      }
    }
  } finally {
    DatabaseManager.prototype.getDb = originalGetDb;
  }
});

async function withSessionDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "super-pi-memory-anchor-"));
  try {
    const sessionPath = join(directory, "session.jsonl");
    const events = [
      { type: "session", id: "session-1", cwd: directory },
      { timestamp: "2026-08-24T10:00:00.000Z", message: { role: "user", content: "alpha first" } },
      { timestamp: "2026-08-24T10:01:00.000Z", message: { role: "assistant", content: "alpha second" } },
      { timestamp: "2026-08-24T10:02:00.000Z", message: { role: "user", content: "beta danger" } },
    ];
    await writeFile(sessionPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    await run({ directory, sessionPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("anchor search merges adjacent matches and keeps source metadata", async () => {
  await withSessionDirectory(async ({ directory, sessionPath }) => {
    const result = await searchSessionAnchors("limit: 5\nall:\n- alpha", { sessionsDir: directory });
    assert.equal(result.success, true);
    assert.equal(result.ranges.length, 1);
    assert.deepEqual(result.ranges[0], {
      path: sessionPath,
      startLine: 2,
      endLine: 3,
      sessionId: "session-1",
      cwd: directory,
      startTime: "2026-08-24T10:00:00.000Z",
      endTime: "2026-08-24T10:01:00.000Z",
      score: 4,
      reason: "matched all: alpha",
    });
  });
});

test("concurrent searches keep parser and text scratch isolated", async () => {
  await withSessionDirectory(async ({ directory }) => {
    const [alpha, beta] = await Promise.all([
      searchSessionAnchors("all:\n- alpha", { sessionsDir: directory }),
      searchSessionAnchors("any:\n- beta\nexclude:\n- danger", { sessionsDir: directory }),
    ]);
    assert.equal(alpha.success, true);
    assert.equal(alpha.ranges.length, 1);
    assert.equal(beta.success, true);
    assert.equal(beta.ranges.length, 0);
  });
});

test("anchor search rejects malformed requests and bounded scan overflow", async () => {
  await withSessionDirectory(async ({ directory }) => {
    const malformed = await searchSessionAnchors("limit: 1\nlimit: 2\nall:\n- alpha", { sessionsDir: directory });
    assert.equal(malformed.success, false);
    assert.equal((malformed.message ?? "").includes("Duplicate field"), true);

    const overflow = await searchSessionAnchors("all:\n- alpha", { sessionsDir: directory, maxLines: 1 });
    assert.equal(overflow.success, false);
    assert.equal((overflow.message ?? "").includes("scan cap"), true);
  });
});
