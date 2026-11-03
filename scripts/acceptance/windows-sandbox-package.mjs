// Preparation and data validation only. This module cannot start/stop a sandbox,
// enable Windows features, execute host commands, or change production defaults.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL, NODE_VERSION, STREAM_LIMIT, RESULT_LIMIT, GUEST_INPUT, GUEST_OUTPUT, validateRequest } from "./windows-sandbox-guest.mjs";

const SOURCE = fileURLToPath(new URL("./windows-sandbox-guest.mjs", import.meta.url));
// Fixed local project runtime observed for this acceptance, not a project engine minimum.
export const NODE_SHA256 = "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5";
function xmlPath(value) {
	if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || /[%\x00-\x1f]/.test(value)
		|| path.win32.normalize(value) !== value || value.length > 240) throw new Error("Expected a canonical local Windows path");
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function windowsSandboxConfig(input, output) {
	const safeInput = xmlPath(input), safeOutput = xmlPath(output);
	if (path.win32.dirname(input).toLowerCase() !== path.win32.dirname(output).toLowerCase()
		|| path.win32.basename(input) !== "input" || path.win32.basename(output) !== "output") throw new Error("Only the two dedicated sibling directories may be mapped");
	return `<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <vGPU>Disable</vGPU>
  <MemoryInMB>2048</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>${safeInput}</HostFolder><SandboxFolder>${GUEST_INPUT}</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${safeOutput}</HostFolder><SandboxFolder>${GUEST_OUTPUT}</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
</Configuration>
`;
}

export function sha256(file) {
	const fd = fs.openSync(file, "r"), buffer = Buffer.allocUnsafe(64 * 1024), digest = createHash("sha256");
	try {
		for (;;) { const count = fs.readSync(fd, buffer); if (!count) break; digest.update(buffer.subarray(0, count)); }
		return digest.digest("hex");
	} finally { fs.closeSync(fd); }
}

export function prepareWindowsSandboxPackage(parent, mode) {
	if (process.platform !== "win32" || process.version !== NODE_VERSION) throw new Error(`Preparation requires Windows ${NODE_VERSION}`);
	const request = validateRequest({ protocol: PROTOCOL, taskId: randomUUID(), mode, nodeVersion: NODE_VERSION });
	const nodeSha256 = sha256(process.execPath);
	if (nodeSha256 !== NODE_SHA256) throw new Error("Project Node digest differs from the fixed acceptance runtime");
	const parentPath = fs.realpathSync(parent);
	if (!fs.lstatSync(parentPath).isDirectory() || fs.lstatSync(parentPath).isSymbolicLink()) throw new Error("Package parent must be a regular directory");
	const root = fs.mkdtempSync(path.join(parentPath, "super-pi-wsb-"));
	try {
		const input = path.join(root, "input"), output = path.join(root, "output");
		fs.mkdirSync(input); fs.mkdirSync(output);
		fs.copyFileSync(process.execPath, path.join(input, "node.exe"), fs.constants.COPYFILE_EXCL);
		fs.copyFileSync(SOURCE, path.join(input, "guest.mjs"), fs.constants.COPYFILE_EXCL);
		if (sha256(path.join(input, "node.exe")) !== nodeSha256) throw new Error("Copied Node digest mismatch");
		const guestSha256 = sha256(path.join(input, "guest.mjs"));
		fs.writeFileSync(path.join(input, "request.json"), JSON.stringify(request), { flag: "wx" });
		fs.writeFileSync(path.join(root, "sandbox.wsb"), windowsSandboxConfig(input, output), { flag: "wx" });
		const record = { protocol: PROTOCOL, root, input, output, request, nodeSource: process.execPath, nodeSha256, guestSha256,
			lifecycle: "prepared-not-started", arbitraryCommands: false, writableShareQuota: false };
		fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify(record, null, 2), { flag: "wx" });
		return record;
	} catch (error) {
		throw Object.assign(new Error("Package preparation failed; retain this exact directory for cleanup", { cause: error }), { fixturePath: root });
	}
}

function boundedFile(directory, name, maximum) {
	const file = path.join(directory, name), before = fs.lstatSync(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)
		|| fs.realpathSync(file) !== file) throw new Error(`Invalid bounded result file: ${name}`);
	const fd = fs.openSync(file, "r");
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Result file changed while opening");
		const bytes = Buffer.alloc(Number(opened.size));
		let offset = 0;
		while (offset < bytes.length) {
			const count = fs.readSync(fd, bytes, offset, bytes.length - offset);
			if (!count) throw new Error("Result file was truncated while reading");
			offset += count;
		}
		if (fs.fstatSync(fd, { bigint: true }).size !== opened.size) throw new Error("Result file size changed while reading");
		return bytes;
	} finally { fs.closeSync(fd); }
}

// Caller must first confirm the owned VM has stopped. This function reads claims,
// never supplies instance-exit or host-integrity evidence itself.
export function readWindowsSandboxResult(directory, request) {
	validateRequest(request);
	const resolved = fs.realpathSync(directory);
	if (path.resolve(directory) !== resolved || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Result directory must not be a link");
	const result = JSON.parse(boundedFile(resolved, "result.json", RESULT_LIMIT).toString("utf8"));
	if (!result || Object.keys(result).sort().join(",") !== "exitCode,mode,protocol,stderrBytes,stderrTruncated,stdoutBytes,stdoutTruncated,taskId,termination"
		|| result.protocol !== PROTOCOL || result.taskId !== request.taskId || result.mode !== request.mode
		|| !["exit", "launch-error", "timeout", "output-limit", "write-error"].includes(result.termination)
		|| !(result.exitCode === null || Number.isInteger(result.exitCode) && result.exitCode >= -2147483648 && result.exitCode <= 4294967295)
		|| result.termination === "exit" && result.exitCode === null) throw new Error("Invalid or mismatched result metadata");
	for (const name of ["stdout", "stderr"]) {
		if (!Number.isSafeInteger(result[name + "Bytes"]) || result[name + "Bytes"] < 0 || result[name + "Bytes"] > STREAM_LIMIT
			|| typeof result[name + "Truncated"] !== "boolean") throw new Error("Invalid stream metadata");
	}
	if (result.termination === "exit" && (result.stdoutTruncated || result.stderrTruncated)) throw new Error("Successful transport cannot be truncated");
	const stdout = boundedFile(resolved, "stdout.bin", STREAM_LIMIT), stderr = boundedFile(resolved, "stderr.bin", STREAM_LIMIT);
	if (stdout.length !== result.stdoutBytes || stderr.length !== result.stderrBytes) throw new Error("Stream lengths do not match result");
	return { result, stdout, stderr };
}
