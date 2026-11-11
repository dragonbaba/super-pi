import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { mxcFileFixture } from "./helpers/mxc-file-fixture.ts";
import { DIRECTORY_READ_BUFFER, FILE_LIMIT, TEXT_LIMIT, SEARCH_CLIPPED_MARK, SEARCH_ENTRIES, FILE_PROTOCOL_LIMIT } from "../packages/coding-agent/src/core/sandbox/mxc-file-limits.mjs";

test("MXC reports size/encoding gaps separately from a naturally completed scan", t => {
  const f = mxcFileFixture(t);
  fs.writeFileSync(path.join(f.input, "large"), "x".repeat(FILE_LIMIT) + "needle");
  fs.writeFileSync(path.join(f.input, "invalid"), Buffer.from([110, 255]));
  fs.writeFileSync(path.join(f.input, "nul"), "needle\0");
  fs.writeFileSync(path.join(f.input, "valid"), "needle\n");
  const result = f.invoke("grep", { pattern: "needle" }), s = result.search;
  assert.equal(result.ok, true); assert.equal(s.scanComplete, true); assert.equal(s.coverageComplete, false);
  assert.equal(s.outputTruncated, false); assert.equal(s.stopReason, "none");
  assert.equal(s.scannedFiles, 4); assert.equal(s.skippedTooLarge, 1); assert.equal(s.skippedNonUtf8, 1); assert.equal(s.skippedNul, 1);
  assert.match(result.text, /valid:1:needle/); assert.match(result.text, /Unchecked content remains/);
  const zero = f.invoke("grep", { path: "large", pattern: "needle" });
  assert.match(zero.text, /Inspect known skipped paths/);
  assert.doesNotMatch(zero.text, /Narrow the search scope/);
  assert.notEqual(zero.text, "(no matches)"); assert.match(zero.text, /no matches in scanned content; unchecked content remains/);
});

for (const count of [200, 201]) test(`MXC content observes the ${count} row boundary without fabricating totals`, t => {
  const f = mxcFileFixture(t); fs.writeFileSync(path.join(f.input, "hits"), "needle\n".repeat(count));
  const result = f.invoke("grep", { path: "hits", pattern: "needle" }), s = result.search;
  assert.equal(s.scanComplete, count === 200); assert.equal(s.outputTruncated, count === 201);
  assert.equal(s.observedRecords, count); assert.equal(s.returnedRecords, 200);
  assert.equal(s.stopReason, count === 200 ? "none" : "row-limit"); assert.equal(s.total, undefined);
});

test("MXC entry budget stops without claiming an observed omitted match", t => {
  const f = mxcFileFixture(t), io = Object.create(fs);
  const entry = { name: "empty", isSymbolicLink: () => false, isDirectory: () => false };
  let consumed = 0, closed = 0;
  io.opendirSync = (_file: string, options: fs.OpenDirOptions) => {
    assert.equal(options.bufferSize, DIRECTORY_READ_BUFFER);
    return { readSync() { return consumed++ < 80_000 ? entry : null; }, closeSync() { closed++; } };
  };
  const result = f.invoke("grep", { pattern: "needle" }, "read-only", io), s = result.search;
  assert.equal(s.visitedEntries, SEARCH_ENTRIES); assert.equal(s.stopReason, "entry-limit");
  assert.equal(s.scanComplete, false); assert.equal(s.coverageComplete, false);
  assert.equal(s.observedRecords, 0); assert.equal(s.outputTruncated, false); assert.match(result.text, /Unchecked content remains/);
  assert.equal(consumed, SEARCH_ENTRIES + 1); assert.equal(closed, 1);
});

test("MXC marks long prefixes, preserves Unicode boundaries and budgets serialized JSON", t => {
  const f = mxcFileFixture(t);
  for (const prefixLength of [251, 255]) {
    fs.writeFileSync(path.join(f.input, "late"), "a".repeat(prefixLength) + "😀" + "needle");
    const result = f.invoke("grep", { path: "late", pattern: "needle" });
    assert.equal(result.search.excerptTruncated, true); assert.equal(result.search.scanComplete, true);
    assert.equal(result.search.outputTruncated, false); assert.ok(result.text.split("\n")[1]?.endsWith(SEARCH_CLIPPED_MARK));
    assert.equal(result.text.isWellFormed(), true);
  }
  // Worst JSON escaping expands one UTF-16 unit to six bytes; no duplicate row payload.
  fs.writeFileSync(path.join(f.input, "escaped"), ("needle" + "\u0001\"\\😀".repeat(70) + "\n").repeat(200));
  const escaped = f.invoke("grep", { path: "escaped", pattern: "needle" });
  assert.equal(escaped.search.stopReason, "text-limit"); assert.equal(escaped.search.outputTruncated, true);
  assert.ok(escaped.search.outputUnits <= TEXT_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) + 1 <= FILE_PROTOCOL_LIMIT);
  assert.equal(escaped.rows, undefined); assert.equal(escaped.text.isWellFormed(), true);
});

test("MXC clipped rows keep the existing per-row output budget", t => {
  const f = mxcFileFixture(t);
  fs.writeFileSync(path.join(f.input, "long.txt"), ("x".repeat(400) + "needle\n").repeat(150));
  const result = f.invoke("grep", { path: "long.txt", pattern: "needle" });
  assert.equal(result.search.returnedRecords, 121);
  assert.equal(result.search.stopReason, "text-limit");
  assert.match(result.text, /^[\x00-\x7f]*$/);
  for (const row of result.text.split("\n").slice(1)) assert.ok(row.endsWith(SEARCH_CLIPPED_MARK));
});

test("MXC treats omitted LF and CRLF terminators as complete line bodies", t => {
  const f = mxcFileFixture(t);
  for (const separator of ["\n", "\r\n"]) for (const length of [TEXT_LIMIT - 1, TEXT_LIMIT]) {
    const line = "x".repeat(length);
    fs.writeFileSync(path.join(f.input, "text"), line + separator + "next");
    const first = f.invoke("read", { path: "text", limit: 1 });
    assert.equal(first.read.windowComplete, true);
    assert.equal(first.read.lineTruncated, false);
    assert.equal(first.read.returnedLines, 1);
    assert.equal(first.read.nextOffset, 2);
    const next = f.invoke("read", { path: "text", offset: first.read.nextOffset });
    assert.match(next.text, /^next\n\[Snapshot:/);
    assert.equal(next.snapshot, first.snapshot);
  }
});

test("MXC policy exclusions do not become coverage gaps or block explicit reads", t => {
  const f = mxcFileFixture(t);
  for (const directory of [".git", ".sp"]) {
    fs.mkdirSync(path.join(f.input, directory)); fs.writeFileSync(path.join(f.input, directory, "config"), "needle");
    assert.equal(f.invoke("read", { path: directory + "/config" }).ok, true);
  }
  const result = f.invoke("grep", { pattern: "needle" });
  assert.equal(result.text, "(no matches)"); assert.equal(result.search.coverageComplete, true); assert.equal(result.search.excludedProtected, 2);
});

for (const method of ["lstatSync", "opendirSync", "openSync"] as const) test(`MXC preserves ${method} failure as a read error`, t => {
  const f = mxcFileFixture(t); fs.writeFileSync(path.join(f.input, "hit"), "needle");
  const io = Object.create(fs), original = fs[method];
  io[method] = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(f.input)) throw new Error("fixture I/O failure");
    return (original as any)(...args);
  };
  const result = f.invoke("grep", { pattern: "needle" }, "read-only", io);
  assert.equal(result.ok, false); assert.equal(result.noEffects, true); assert.equal(result.phase, "read"); assert.match(result.error, /fixture I\/O failure/);
});

for (const exit of ["eof", "row-limit", "text-limit", "read-error", "close-error"] as const) test(`MXC closes its directory on ${exit}`, t => {
  const f = mxcFileFixture(t), io = Object.create(fs);
  const count = exit === "row-limit" ? 201 : exit === "text-limit" ? 200 : 1;
  const name = exit === "text-limit" ? "x".repeat(255) : "entry";
  let consumed = 0, closed = 0;
  io.opendirSync = () => ({
    readSync() {
      if (exit === "read-error") throw new Error("directory read failed");
      return consumed++ < count ? { name, isSymbolicLink: () => false, isDirectory: () => false } : null;
    },
    closeSync() { closed++; if (exit === "close-error") throw new Error("directory close failed"); },
  });
  const result = f.invoke("ls", {}, "read-only", io);
  assert.equal(closed, 1);
  if (exit.endsWith("error")) {
    assert.equal(result.ok, false); assert.equal(result.noEffects, true); assert.equal(result.phase, "read");
    assert.match(result.error, /directory (read|close) failed/);
  } else {
    assert.equal(result.ok, true); assert.equal(result.search.stopReason, exit === "eof" ? "none" : exit);
    assert.equal(result.search.scanComplete, exit === "eof");
  }
});

test("MXC releases real directory handles after EOF and row-limit exits", t => {
  const f = mxcFileFixture(t), io = Object.create(fs);
  const handles: fs.Dir[] = [];
  io.opendirSync = (file: string, options: fs.OpenDirOptions) => {
    const handle = fs.opendirSync(file, options); handles.push(handle); return handle;
  };
  assert.equal(f.invoke("ls", {}, "read-only", io).search.scanComplete, true);
  for (let index = 0; index < 201; index++) fs.writeFileSync(path.join(f.input, "file-" + index), "");
  assert.equal(f.invoke("ls", {}, "read-only", io).search.stopReason, "row-limit");
  assert.equal(handles.length, 2);
  for (const handle of handles) assert.throws(() => handle.readSync(), { code: "ERR_DIR_CLOSED" });
});

for (const text of ["", "one", "one\ntwo\nthree", "one\r\ntwo\r\nthree"]) test(`MXC read window/EOF facts: ${JSON.stringify(text)}`, t => {
  const f = mxcFileFixture(t); fs.writeFileSync(path.join(f.input, "text"), text);
  const result = f.invoke("read", { path: "text", offset: 1, limit: 1 });
  assert.equal(result.read.windowComplete, true); assert.equal(result.read.hasMore, text.includes("\n"));
  assert.equal(result.read.lineTruncated, false); assert.equal(result.read.nextOffset, text.includes("\n") ? 2 : undefined);
  assert.equal(result.snapshot, createHash("sha256").update(text).digest("hex"));
  const past = f.invoke("read", { path: "text", offset: 500, limit: 1 });
  assert.equal(past.read.returnedLines, 0); assert.equal(past.read.hasMore, false); assert.equal(past.read.nextOffset, undefined);
});

test("MXC read distinguishes exact budget, whole-line stops and clipped line suffixes", t => {
  const f = mxcFileFixture(t), file = path.join(f.input, "text");
  for (const size of [TEXT_LIMIT, TEXT_LIMIT + 1]) {
    fs.writeFileSync(file, "x".repeat(size));
    const r = f.invoke("read", { path: "text", limit: 1 });
    assert.equal(r.read.windowComplete, size === TEXT_LIMIT); assert.equal(r.read.lineTruncated, size > TEXT_LIMIT);
    assert.equal(r.read.incompleteLine, size > TEXT_LIMIT ? 1 : undefined); assert.equal(r.read.nextOffset, undefined);
    if (size > TEXT_LIMIT) assert.match(r.text, /^\[Read window incomplete:/);
  }
  fs.writeFileSync(file, "x".repeat(TEXT_LIMIT - 1) + "\nnext\n");
  const whole = f.invoke("read", { path: "text", limit: 2 });
  assert.equal(whole.read.windowComplete, false); assert.equal(whole.read.lineTruncated, false); assert.equal(whole.read.nextOffset, 2);
  fs.writeFileSync(file, "x".repeat(TEXT_LIMIT - 1) + "😀tail\nlast");
  const unicode = f.invoke("read", { path: "text", limit: 2 });
  assert.equal(unicode.read.lineTruncated, true); assert.equal(unicode.read.nextOffset, undefined); assert.equal(unicode.text.isWellFormed(), true);
});

test("MXC shared find/ls scopes, row budgets and metadata remain meaningful", t => {
  const f = mxcFileFixture(t); fs.mkdirSync(path.join(f.input, "nested"));
  fs.writeFileSync(path.join(f.input, "nested", "match.txt"), "text");
  assert.equal(f.invoke("find", { path: "nested", pattern: "match" }).search.coverageComplete, true);
  const ls = f.invoke("ls", { path: "nested" }); assert.equal(ls.text, path.join("nested", "match.txt"));
  assert.equal(ls.search.operation, "ls"); assert.equal(ls.search.returnedRecords, 1);
  assert.equal(f.invoke("find", { path: "nested", pattern: "absent" }).text, "(no matches)");
});
