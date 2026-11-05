import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { getEventListeners } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubagentStream } from "../packages/coding-agent/src/modes/subagent-stream.ts";
import { SubagentProcessRun, failureDisplayText } from "../packages/extensions/subagent/index.ts";
import { StderrTail } from "../packages/extensions/subagent/stderr-tail.ts";
import { toJsonEvent } from "../packages/coding-agent/src/modes/json-event.ts";

test("child output shares backpressure and releases projections, callbacks and listeners", async t => {
    for (const outcome of ["complete", "failure", "dispose"]) {
        const callbacks: Array<(error?: Error | null) => void> = [], lines: string[] = [];
        const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { lines.push(chunk.toString()); callbacks.push(callback); } });
        const owner: any = new SubagentStream(output, output.write.bind(output));
        const message: any = { role: "toolResult", content: [{ type: "text", text: "unique-body" }] };
        owner.onEvent({ type: "message_end", message, toolResultPresentation: { duplicate: message } });
        assert.equal(owner.messageFrame.message, undefined);
        const wait = owner.waitForBackpressure(); assert.ok(wait); assert.equal(owner.waitForBackpressure(), wait); assert.equal(owner.flush(), wait);
        assert.equal(lines[0].match(/unique-body/g)?.length, 1);
        if (outcome === "complete") { callbacks.shift()!(); await wait; owner.dispose(); }
        else {
            const rejected = assert.rejects(wait, /fixture|disposed/);
            if (outcome === "failure") callbacks.shift()!(new Error("fixture"));
            else { owner.dispose(); callbacks.shift()!(); }
            await rejected; owner.dispose();
        }
        await tick(); // Writable emits an error after its write callback; retain its observer until then.
        assert.equal(owner.pendingWrites, 0); assert.equal(owner.waiting, undefined);
        assert.equal(owner.resolveWait, undefined); assert.equal(owner.rejectWait, undefined);
        assert.equal(owner.output, undefined); assert.equal(owner.write, undefined);
        for (const event of ["error", "drain", "close"]) assert.equal(getEventListeners(output, event).length, 0);
    }
    t.diagnostic("one shared busy-cycle wait; no retained message projection or stream listeners after completion/failure/disposal");
});

test("byte-tail stderr handles fragmented UTF-8, wraps and bounds the final failure summary", () => {
    const input = Buffer.from("prefix\n" + "日志🙂".repeat(12000) + "\n尾部🙂FINAL_ERROR_MARKER");
    const tail = new StderrTail(32768);
    for (let index = 0; index < input.length; index++) tail.push(input.subarray(index, index + 1));
    const stderr = tail.take(); assert.ok(Buffer.byteLength(stderr) <= 32768);
    assert.match(stderr, /truncated/); assert.match(stderr, /尾部🙂FINAL_ERROR_MARKER$/); assert.doesNotMatch(stderr, /�/);
    assert.equal((tail as any).buffer, undefined); assert.equal((tail as any).size, 0);
    const display = failureDisplayText({ exitCode: 1, errorMessage: "EXPLICIT_FAILURE", stderr, messages: [] })!;
    assert.ok(Buffer.byteLength(display) <= 4096); assert.match(display, /^EXPLICIT_FAILURE/); assert.match(display, /尾部🙂FINAL_ERROR_MARKER$/);
    assert.equal(failureDisplayText({ exitCode: 1, stderr: "short failure", messages: [] }), "short failure");
});

test("real child print stream completes 163 full reads while individual event limits remain active", { timeout: 20000 }, async t => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sp-child-stream-"))), previous = process.env.SP_SOURCE_LAUNCHER;
    process.env.SP_SOURCE_LAUNCHER = fileURLToPath(new URL("./fixtures/subagent-stream-child.mjs", import.meta.url));
    const owned: any[] = [];
    try {
        for (const scenario of ["long", "oversize"]) {
            const result: any = { messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, exitCode: -1 };
            const run: any = new SubagentProcessRun(["--mode", "json", "--subagent-stream", scenario], root, undefined, false, undefined, 10000, result);
            const record = { pid: run.proc.pid, started: new Date().toISOString(), scenario, exited: false }; owned.push(record);
            writeFileSync(join(root, "resources.json"), JSON.stringify({ root, children: owned }));
            result.exitCode = await run.run(); record.exited = true;
            assert.equal(run.proc.exitCode !== null || run.proc.signalCode !== null, true);
            assert.equal(run.buffer, ""); assert.equal(run.stderrTail.buffer, undefined);
            if (scenario === "long") {
                assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.errorMessage, undefined);
                assert.equal(result.usage.turns, 1); assert.equal(run.retainedJsonEventCount, 164);
                assert.equal(result.messages.length, 3); assert.equal(result.messages.at(-1).content[0].text, "FINAL_REPORT");
                assert.ok(run.jsonTransportBytes < 9 * 1024 * 1024);
                t.diagnostic(JSON.stringify({ scenario, pid: record.pid, retainedEvents: run.retainedJsonEventCount, retainedMessages: result.messages.length, bytes: run.jsonTransportBytes }));
            } else assert.match(result.errorMessage, /8 MiB/);
        }
        const markers = readdirSync(root).filter(name => name.startsWith("stream-"));
        for (const name of markers) assert.equal(realpathSync.native(JSON.parse(readFileSync(join(root, name), "utf8")).tmpdir), realpathSync.native(tmpdir()));
        const message = { role: "toolResult", content: [{ type: "text", text: "x".repeat(50 * 1024) }] };
        const event: any = { type: "agent_end", messages: new Array(164).fill(message), willRetry: false };
        assert.equal(toJsonEvent(event), event); assert.ok(Buffer.byteLength(JSON.stringify(toJsonEvent(event))) > 8 * 1024 * 1024, "public JSON still includes the aggregate payload");
    } finally {
        if (previous === undefined) delete process.env.SP_SOURCE_LAUNCHER; else process.env.SP_SOURCE_LAUNCHER = previous;
        writeFileSync(join(root, "resources.json"), JSON.stringify({ root, children: owned, files: readdirSync(root) }));
        assert.ok(owned.every(child => child.exited)); assert.equal(realpathSync.native(root), root); rmSync(root, { recursive: true });
    }
});
