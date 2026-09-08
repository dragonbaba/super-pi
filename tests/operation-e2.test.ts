import { operationFixtureSupported } from './helpers/operation-write-fixture.ts';
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("one native Linux paired timing/profile/controlled-GC operation set", { skip: !operationFixtureSupported }, () => {
	const run = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types",
		fileURLToPath(new URL("../scripts/bench/operation-journal.ts", import.meta.url))], { encoding: "utf8", timeout: 60000 });
	assert.equal(run.status, 0, run.stderr + run.stdout);
	const line = run.stdout.split("\n").find(line => line.startsWith("OPERATION_JOURNAL_E2 "));
	assert.ok(line); console.log(line);
});
