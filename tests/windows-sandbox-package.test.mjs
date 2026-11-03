import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { windowsSandboxConfig, prepareWindowsSandboxPackage, readWindowsSandboxResult, sha256 } from "../scripts/acceptance/windows-sandbox-package.mjs";
import { BoundedFileSink, NODE_VERSION, PROTOCOL, STREAM_LIMIT, STDOUT, STDERR, validateRequest, runFixedProbe } from "../scripts/acceptance/windows-sandbox-guest.mjs";

function ownedRoot(t) {
	const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, "super-pi-wsb-protocol-"));
	const identity = fs.statSync(root, { bigint: true });
	t.after(() => {
		const actual = fs.lstatSync(root, { bigint: true });
		assert.equal(actual.isSymbolicLink(), false);
		assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
		assert.equal(path.dirname(fs.realpathSync(root)), parent);
		fs.rmSync(root, { recursive: true });
		assert.equal(fs.existsSync(root), false);
	});
	return root;
}

function request(mode = "node") { return { protocol: PROTOCOL, nodeVersion: NODE_VERSION, taskId: randomUUID(), mode }; }

test("Windows Sandbox preparation admits only fixed tasks and explicit isolated mappings", () => {
	const config = windowsSandboxConfig("C:\\temp\\a & b\\input", "C:\\temp\\a & b\\output");
	for (const field of ["Networking", "ClipboardRedirection", "AudioInput", "VideoInput", "PrinterRedirection", "vGPU"]) {
		assert.ok(config.includes(`<${field}>Disable</${field}>`));
	}
	assert.equal(config.match(/<MappedFolder>/g).length, 2);
	assert.equal(config.match(/<ReadOnly>true<\/ReadOnly>/g).length, 1);
	assert.equal(config.match(/<ReadOnly>false<\/ReadOnly>/g).length, 1);
	assert.match(config, /a &amp; b/); assert.doesNotMatch(config, /LogonCommand/);
	assert.throws(() => windowsSandboxConfig("C:\\project", "C:\\project\\output"));
	assert.throws(() => windowsSandboxConfig("C:\\temp\\%USERPROFILE%\\input", "C:\\temp\\%USERPROFILE%\\output"));
	assert.throws(() => windowsSandboxConfig("C:\\temp\\..\\input", "C:\\temp\\..\\output"));
	assert.throws(() => windowsSandboxConfig("\\\\server\\share\\input", "\\\\server\\share\\output"));
	assert.throws(() => validateRequest({ ...request(), command: "whoami" }));
	assert.throws(() => validateRequest({ ...request(), env: {} }));
	assert.throws(() => validateRequest(request("custom")));
	assert.throws(() => validateRequest({ ...request(), nodeVersion: "unknown" }));
	for (const taskId of [[randomUUID()], null, 1, true, {}, undefined]) {
		assert.throws(() => validateRequest({ ...request(), taskId }));
	}
});

test("bounded data writer and reader preserve bytes and reject corrupt or aliased results", t => {
	const root = ownedRoot(t), req = request(), file = path.join(root, "stdout.bin");
	const sink = new BoundedFileSink(file), block = Buffer.alloc(STREAM_LIMIT, 0xa5);
	sink.write(block); assert.equal(sink.truncated, false);
	sink.write(Buffer.from([0xff])); sink.close(); sink.close();
	assert.equal(sink.fd, undefined); assert.equal(sink.written, STREAM_LIMIT);
	assert.equal(sink.truncated, true); assert.equal(sink.failed, false); assert.equal(sink.chunks, 2);
	assert.deepEqual(fs.readFileSync(file), block);
	fs.writeFileSync(path.join(root, "stderr.bin"), Buffer.from([0x00, 0xff, 0x80]));
	const result = { protocol: PROTOCOL, taskId: req.taskId, mode: req.mode, termination: "output-limit", exitCode: null,
		stdoutBytes: STREAM_LIMIT, stderrBytes: 3, stdoutTruncated: true, stderrTruncated: false };
	const metadata = path.join(root, "result.json");
	fs.writeFileSync(metadata, JSON.stringify(result));
	const read = readWindowsSandboxResult(root, req);
	assert.deepEqual(read.stdout, block); assert.deepEqual(read.stderr, Buffer.from([0x00, 0xff, 0x80]));
	assert.throws(() => readWindowsSandboxResult(root, request()), /mismatched/);
	fs.writeFileSync(metadata, JSON.stringify({ ...result, termination: "exit", exitCode: 0 }));
	assert.throws(() => readWindowsSandboxResult(root, req), /truncated/);
	fs.writeFileSync(metadata, " ".repeat(4097));
	assert.throws(() => readWindowsSandboxResult(root, req), /bounded/);
	fs.writeFileSync(metadata, JSON.stringify(result));
	fs.appendFileSync(file, "x"); assert.throws(() => readWindowsSandboxResult(root, req), /bounded/);
	fs.truncateSync(file, STREAM_LIMIT);
	fs.linkSync(file, path.join(root, "alias"));
	assert.throws(() => readWindowsSandboxResult(root, req), /bounded/);
	fs.unlinkSync(path.join(root, "alias"));
	fs.unlinkSync(metadata); assert.throws(() => readWindowsSandboxResult(root, req), /ENOENT/);
});

test("host-only transport check: copied project Node and fixed PowerShell preserve stdout, stderr, and nonzero exit", {
	skip: process.platform !== "win32" || process.version !== NODE_VERSION, timeout: 30_000,
}, async t => {
	const root = ownedRoot(t), prepared = prepareWindowsSandboxPackage(root, "node");
	assert.equal(prepared.lifecycle, "prepared-not-started"); assert.equal(prepared.arbitraryCommands, false);
	assert.equal(prepared.writableShareQuota, false);
	assert.equal(sha256(path.join(prepared.input, "node.exe")), prepared.nodeSha256);
	assert.equal(sha256(path.join(prepared.input, "guest.mjs")), prepared.guestSha256);
	assert.deepEqual(fs.readdirSync(prepared.input).sort(), ["guest.mjs", "node.exe", "request.json"]);
	for (const mode of ["node", "powershell", "overflow"]) {
		const out = path.join(root, mode); fs.mkdirSync(out);
		const req = request(mode);
		const result = await runFixedProbe(req, prepared.input, out);
		const captured = readWindowsSandboxResult(out, req);
		assert.deepEqual(captured.result, { protocol: PROTOCOL, taskId: req.taskId, mode, ...result });
		if (mode === "overflow") {
			assert.equal(result.termination, "output-limit"); assert.equal(result.stdoutTruncated, true);
			assert.equal(captured.stdout.length, STREAM_LIMIT);
		} else {
			assert.equal(result.termination, "exit"); assert.equal(result.exitCode, mode === "node" ? 23 : 17);
			assert.equal(captured.stdout.toString("utf8"), STDOUT); assert.equal(captured.stderr.toString("utf8"), STDERR);
		}
		// Closed result handles permit exclusive deletion before the next fixed task.
		for (const name of ["stdout.bin", "stderr.bin", "result.json"]) fs.unlinkSync(path.join(out, name));
		fs.rmdirSync(out);
	}
});
