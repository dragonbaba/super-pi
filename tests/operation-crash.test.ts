import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, operationFixtureSupported } from "./helpers/operation-write-fixture.ts";
import { OperationJournal } from "../packages/coding-agent/src/core/operation-journal.ts";

test("real child termination at started, partial, unpublished and completed never replays uncertain writes", { skip: !operationFixtureSupported }, async () => {
	for (const cutpoint of ["started", "partial", "unpublished", "completed"]) {
		const f = await fixture(true);
		await f.session.agent.dispatchHostTool({ type: "toolCall", id: "seed", name: "missing", arguments: {} });
		f.session.dispose();
		const intentId = randomUUID();
		const child = spawnSync(process.execPath, [...process.execArgv.filter(arg => arg !== "--test"),
			fileURLToPath(new URL("./helpers/operation-write-fixture.ts", import.meta.url)), "--operation-crash",
			JSON.stringify({ cwd: f.cwd, agentDir: f.agentDir, file: f.file }), cutpoint, intentId], { encoding: "utf8", timeout: 15000 });
		assert.equal(child.signal, "SIGKILL", child.stderr);
		// Only this exact exited child is reconciled. Never infer stopped ownership from PID age.
		const token = OperationJournal.inspectWriter(f.file);
		const header = JSON.parse(JSON.parse(readFileSync(`${f.file}.operations-v1/header`, "utf8")).body);
		const id = `op1:${header.journal}:${intentId}`;
		const target = join(f.cwd, "target");
		const before = existsSync(target) ? readFileSync(target, "utf8") : undefined;
		if (cutpoint === "completed") writeFileSync(target, "later edit");
		const reopened = await fixture(true, f, token);
		try {
			const recovery = reopened.session.resumeOperation(id, { originBranch: null, path: "target", content: "complete intended bytes" });
			if (cutpoint === "completed") { assert.equal((await recovery).historical, true); assert.equal(readFileSync(target, "utf8"), "later edit"); }
			else {
				await assert.rejects(recovery, /unknown|Corrupt journal/);
				assert.equal(existsSync(target) ? readFileSync(target, "utf8") : undefined, before);
			}
			assert.equal(reopened.providers(), 0);
		} finally { reopened.session.dispose(); }
	}
});
