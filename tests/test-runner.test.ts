import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("default runner executes GC integration once with isolated cwd, home and offline data", () => {
	const root = mkdtempSync(join(tmpdir(), "super-pi-test-isolation-"));
	const report = join(root, "observed.json");
	try {
		writeFileSync(join(root, "alpha-assistant-update.test.ts"), `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
test('isolated GC fixture', () => {
  assert.equal(typeof global.gc, 'function');
  assert.equal(process.env.SP_OFFLINE, '1');
  assert.equal(process.env.SP_TUI_WRITE_LOG, '');
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) assert.equal(process.env[key], process.cwd());
  assert.equal(process.env.SP_CODING_AGENT_DIR, resolve(process.cwd(), 'agent'));
  assert.equal(process.env.SP_CODING_AGENT_SESSION_DIR, resolve(process.cwd(), 'sessions'));
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ cwd: process.cwd() }));
});
`);
		const child = spawnSync(process.execPath, [join(process.cwd(), "scripts", "test.mjs"),
			"--root", root, "--skip-memory"], {
			encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined },
		});
		assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
		assert.equal(child.stdout.match(/\[test\] START alpha-assistant-update.test.ts/g)?.length, 1);
		assert.match(child.stdout, /\[test\] END alpha-assistant-update.test.ts ms=\d+ exit=0 signal=none/);
		const observed = JSON.parse(readFileSync(report, "utf8"));
		assert.notEqual(observed.cwd, process.cwd());
		assert.equal(existsSync(observed.cwd), false, "runner releases only its owned fixture directory");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
