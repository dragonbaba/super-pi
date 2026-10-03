import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
	classifyTestFile,
	defaultJobs,
	discoverTestFiles,
	normalizeTestPath,
	run,
	scheduleTestFiles,
} from "../scripts/test.mjs";

function runRunner(root: string, ...extra: string[]) {
	return spawnSync(process.execPath, [join(process.cwd(), "scripts", "test.mjs"),
		"--suite", "unit", "--root", root, "--skip-memory", ...extra], {
		encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, SP_TEST_JOBS: undefined },
	});
}

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

test("runner schedules known slow files first and bounds the default width", async () => {
	assert.deepEqual(
		scheduleTestFiles(["a.test.ts", "codemode-session.test.ts", "tool-lifecycle-postmerge.test.ts", "b.test.ts", "alpha-cli.test.ts"]),
		{
			exclusive: ["tool-lifecycle-postmerge.test.ts"],
			pooled: ["alpha-cli.test.ts", "codemode-session.test.ts", "a.test.ts", "b.test.ts"],
		},
	);
	assert.equal(defaultJobs({ SP_TEST_JOBS: "3" }), 3);
	assert.ok(defaultJobs({}) >= 1 && defaultJobs({}) <= 8);
	assert.throws(() => defaultJobs({ SP_TEST_JOBS: "0" }), /positive integer/);
	for (const jobs of [0, -1, Number.NaN, 1.5]) {
		await assert.rejects(run({ suite: "unit", root: join(tmpdir(), "super-pi-runner-never-discovered"), skipMemory: true, list: false, jobs }), /positive integer/);
	}
});

test("wall-clock gated files run with no pooled peer", () => {
	const root = mkdtempSync(join(tmpdir(), "super-pi-test-exclusive-"));
	const events = join(root, "events.log");
	const recorder = (name: string, holdMs: number) => `
import { appendFileSync } from 'node:fs';
import test from 'node:test';
test('${name}', async () => {
  appendFileSync(${JSON.stringify(events)}, 'start ${name}\\n');
  await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
  appendFileSync(${JSON.stringify(events)}, 'end ${name}\\n');
});
`;
	try {
		writeFileSync(join(root, "a-pooled.test.ts"), recorder("a-pooled", 50));
		writeFileSync(join(root, "bash-running-responsiveness.test.ts"), recorder("bash-running-responsiveness", 300));
		writeFileSync(join(root, "z-pooled.test.ts"), recorder("z-pooled", 50));
		const result = runRunner(root, "--jobs", "4");
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const lines = readFileSync(events, "utf8").trim().split("\n");
		assert.deepEqual(lines.slice(0, 2), ["start bash-running-responsiveness", "end bash-running-responsiveness"]);
		assert.equal(lines.length, 6);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parallel runner overlaps files and keeps each file's output in one block", () => {
	const root = mkdtempSync(join(tmpdir(), "super-pi-test-parallel-"));
	try {
		// Each file waits for the other's marker, so both pass only when they run concurrently.
		for (const [self, other] of [["left", "right"], ["right", "left"]]) {
			writeFileSync(join(root, `${self}.test.ts`), `
import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';
test('${self} overlaps ${other}', async () => {
  writeFileSync(${JSON.stringify(join(root, self))}, '');
  const deadline = Date.now() + 20000;
  while (!existsSync(${JSON.stringify(join(root, other))})) {
    if (Date.now() > deadline) throw new Error('${other} never started');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  console.log('${self}-output');
});
`);
		}
		const result = runRunner(root, "--jobs", "2");
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		for (const name of ["left", "right"]) {
			// The file's own output sits between its START and END lines, never after another END.
			const start = result.stdout.indexOf(`[test] START ${name}.test.ts`);
			const output = result.stdout.indexOf(`${name}-output`);
			const end = result.stdout.indexOf(`[test] END ${name}.test.ts ms=`);
			assert.ok(start >= 0 && start < output && output < end, result.stdout);
			assert.equal(result.stdout.slice(output, end).includes("[test] END"), false, result.stdout);
			assert.equal(result.stdout.split(`[test] START ${name}.test.ts`).length, 2);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runner starts no new file after the first failure", () => {
	const root = mkdtempSync(join(tmpdir(), "super-pi-test-stop-"));
	try {
		writeFileSync(join(root, "a-failure.test.ts"), "process.exit(7);\n");
		writeFileSync(join(root, "b-later.test.ts"), 'import test from "node:test"; test("later", () => {});\n');
		const result = runRunner(root, "--jobs", "1");
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /a-failure\.test\.ts failed with exit code 1/);
		assert.doesNotMatch(result.stdout, /START b-later/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
