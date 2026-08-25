import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
	classifyTestFile,
	discoverTestFiles,
	normalizeTestPath,
} from "../scripts/test.mjs";

test("test discovery is stable and platform-neutral", () => {
	const root = mkdtempSync(join(tmpdir(), "super-pi-test-runner-"));
	try {
		mkdirSync(join(root, "provider-contract"), { recursive: true });
		writeFileSync(join(root, "zeta.test.ts"), "");
		writeFileSync(join(root, "alpha.test.ts"), "");
		writeFileSync(join(root, "stream-hot-paths.test.ts"), "");
		writeFileSync(join(root, "provider-contract", "tools.test.ts"), "");

		assert.deepEqual(discoverTestFiles(root), [
			"alpha.test.ts",
			"provider-contract/tools.test.ts",
			"stream-hot-paths.test.ts",
			"zeta.test.ts",
		]);
		assert.equal(normalizeTestPath("provider-contract\\tools.test.ts"), "provider-contract/tools.test.ts");
		assert.equal(classifyTestFile("stream-hot-paths.test.ts"), "hot");
		assert.equal(classifyTestFile("source-invariants.test.ts"), "hot");
		assert.equal(classifyTestFile("provider-contract/tools.test.ts"), "contract");
		assert.equal(classifyTestFile("runtime-utilities.test.ts"), "unit");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("test runner preserves a failing child exit code and names the exact file", () => {
	const root = mkdtempSync(join(tmpdir(), "super-pi-test-failure-"));
	try {
		writeFileSync(
			join(root, "failure.test.ts"),
			'import test from "node:test"; test("failure", () => { throw new Error("expected"); });\n',
		);
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				join(process.cwd(), "scripts", "test.mjs"),
				"--suite",
				"unit",
				"--root",
				root,
				"--skip-memory",
			],
			{ encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
		);

		assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
		assert.match(result.stderr, /failure\.test\.ts/);
		assert.match(result.stderr, /exit code 1/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
