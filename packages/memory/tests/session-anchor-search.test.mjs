import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchSessionAnchors } from "../dist/store/session-anchor-search.js";

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
