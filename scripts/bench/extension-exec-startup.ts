import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { release } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { windowsShellJobDiagnostics } from "../../packages/coding-agent/src/utils/windows-shell-job.ts";

const index = process.argv.indexOf("--exec-module");
const modulePath = resolve(index < 0 ? "packages/coding-agent/src/core/exec.ts" : process.argv[index + 1]);
const { execCommand } = await import(pathToFileURL(modulePath).href);
const rows = [];
for (const [name, command, args] of [
	["empty-node", process.execPath, ["-e", ""]],
	["git-status", "git", ["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"]],
] as const) {
	const samples: number[] = [], outputBytes: number[] = [];
	for (let i = 0; i < 21; i++) {
		const start = performance.now();
		const result = await execCommand(command, args, process.cwd(), { timeout: 3000 });
		samples.push(performance.now() - start);
		assert.equal(result.code, 0, result.stderr); assert.equal(result.killed, false);
		outputBytes.push(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr));
		const state = windowsShellJobDiagnostics(); assert.equal(state.handles, 0); assert.equal(state.processHandles, 0);
	}
	const warm = samples.slice(1).sort((a, b) => a - b);
	rows.push({ name, firstMilliseconds: samples[0], warmP50Milliseconds: warm[10], warmP95Milliseconds: warm[19], samples, outputBytes });
}
console.log(JSON.stringify({ node: process.version, os: `${process.platform} ${release()}`, modulePath,
	sourceHash: createHash("sha256").update(readFileSync(modulePath, "utf8").replaceAll("\r\n", "\n")).digest("hex"),
	// Only the very first invocation includes native binding initialization. Import time is excluded.
	rows, finalOwnership: windowsShellJobDiagnostics() }));
