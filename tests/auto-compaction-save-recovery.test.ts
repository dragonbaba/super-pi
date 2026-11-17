import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager, type SettingsStorage } from "../packages/coding-agent/src/core/settings-manager.ts";
import { autoCompactionSettingKey } from "../packages/agent/src/compaction-policy.ts";

function fixture() {
	let contents = JSON.stringify({ modelAutoCompactionPercentages: { [autoCompactionSettingKey("p", "m")]: 85 } });
	let remainingFailures = 0;
	const error = new Error("fixture write rejected");
	const storage: SettingsStorage = { withLock(scope, callback) {
		const next = callback(scope === "global" ? contents : "{}");
		if (next === undefined || scope !== "global") return;
		if (remainingFailures > 0) { remainingFailures--; throw error; }
		contents = next;
	} };
	return { storage, manager: SettingsManager.fromStorage(storage), failNext() { remainingFailures++; }, error };
}

test("failed percentage save cannot change active policy or leak into the next unrelated save", async () => {
	const f = fixture(); f.failNext();
	assert.equal((await f.manager.setAutoCompactionPercentage("p", "m", 1))?.error, f.error);
	assert.equal(f.manager.getCompactionSettings({ provider: "p", id: "m" }).autoCompactPercentage, 85);
	f.manager.setTheme("light"); await f.manager.flush(); await f.manager.reload();
	assert.equal(f.manager.getTheme(), "light");
	assert.equal(f.manager.getAutoCompactionPercentage("p", "m"), 85);
});

test("an unrelated save queued before percentage failure cannot commit the rejected value", async () => {
	const f = fixture(); f.failNext();
	const rejected = f.manager.setAutoCompactionPercentage("p", "m", 1);
	f.manager.setTheme("light");
	assert.equal((await rejected)?.error, f.error); await f.manager.flush();
	assert.equal(f.manager.getAutoCompactionPercentage("p", "m"), 85);
	await f.manager.reload(); assert.equal(f.manager.getAutoCompactionPercentage("p", "m"), 85);
});

test("a failed older edit preserves a newer successful edit on the same or another model", async () => {
	for (const id of ["m", "other"]) {
		const f = fixture(); f.failNext();
		const older = f.manager.setAutoCompactionPercentage("p", "m", 1);
		const newer = f.manager.setAutoCompactionPercentage("p", id, 70);
		assert.equal(f.manager.getAutoCompactionPercentage("p", "m"), 85, "uncommitted edits do not alter the active policy");
		assert.equal((await older)?.error, f.error); assert.equal(await newer, undefined);
		assert.equal(f.manager.getAutoCompactionPercentage("p", "m"), id === "m" ? 70 : 85);
		assert.equal(f.manager.getAutoCompactionPercentage("p", id), 70);
		await f.manager.reload();
		assert.equal(f.manager.getAutoCompactionPercentage("p", "m"), id === "m" ? 70 : 85);
		assert.equal(f.manager.getAutoCompactionPercentage("p", id), 70);
	}
});

test("percentage failure retains unrelated dirty settings for their normal recovery", async () => {
	const f = fixture(); f.failNext();
	f.manager.setTheme("light"); await f.manager.flush();
	f.failNext(); await f.manager.setAutoCompactionPercentage("p", "m", 1);
	f.manager.setCompactionEnabled(false); await f.manager.flush(); await f.manager.reload();
	assert.equal(f.manager.getTheme(), "light");
	assert.equal(f.manager.getCompactionEnabled(), false);
	assert.equal(f.manager.getAutoCompactionPercentage("p", "m"), 85);
});

test("a successful percentage save does not clear unrelated failed-write bookkeeping", async () => {
	const f = fixture(); f.failNext();
	f.manager.setTheme("light"); await f.manager.flush();
	assert.equal(await f.manager.setAutoCompactionPercentage("p", "m", 70), undefined);
	f.manager.setCompactionEnabled(false); await f.manager.flush(); await f.manager.reload();
	assert.equal(f.manager.getTheme(), "light");
	assert.equal(f.manager.getAutoCompactionPercentage("p", "m"), 70);
});
