import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { mutationFixture } from "./helpers/mutation-fixture.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { ExtensionRunner } from "../packages/coding-agent/src/core/extensions/runner.ts";

for (const phase of ["session_start", "session_shutdown"] as const) {
	test(`mutation fixture releases its root when ${phase} throws`, async () => {
		const original = ExtensionRunner.prototype.emit;
		const failure = new Error(`fixture ${phase} failed`);
		const cleanups: (() => unknown)[] = [];
		const context = { after: (fn: () => unknown) => cleanups.push(fn) } as unknown as TestContext;
		let root: string | undefined;
		ExtensionRunner.prototype.emit = async function (this: ExtensionRunner, event: Parameters<typeof original>[0]) {
			if (event.type === phase) {
				if (phase === "session_start") root = this.createContext().cwd;
				throw failure;
			}
			return original.call(this, event);
		} as typeof original;
		try {
			if (phase === "session_start") await assert.rejects(mutationFixture(context), error => error === failure);
			else root = (await mutationFixture(context)).cwd;
			assert.equal(cleanups.length, 1, "cleanup must be registered before initialization can fail");
			if (phase === "session_shutdown") await assert.rejects(async () => cleanups[0]!(), error => error === failure);
			else await cleanups[0]!();
			assert.ok(root);
			assert.equal(existsSync(root), false);
		} finally {
			ExtensionRunner.prototype.emit = original;
			if (root && existsSync(root)) removeOwnedFixture(root);
		}
	});
}
