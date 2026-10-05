import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBashTool } from "../packages/coding-agent/src/core/tools/bash.ts";
import { inspectBashResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/core.ts";

const FIND = 'find . -maxdepth 3 -iname "nw.exe" -o -maxdepth 3 -iname "nw" -o -maxdepth 3 -iname "nwjs*"';

test("reported cd and find alternatives are inspectable without rewriting the script", () => {
	assert.equal(inspectBashResourceLifecycle({ command: `cd /d 2>/dev/null; ${FIND} | head; echo "--- exit ---"; echo "search done"` }), undefined);
	assert.equal(inspectBashResourceLifecycle({ command: `cd sub; find js -name '*.js' | sort -u` }), undefined);
	assert.match(inspectBashResourceLifecycle({ command: `cd sub; find js -name '*.js' | sort -o .git/config` }) ?? "", /SHELL_UNINSPECTABLE/);
});

for (const expression of [
	'-name "nw.exe" -o -name "nw"',
	'-type f -and -name "nw*"',
	'-not -type d -a -iname "NW.EXE" -print',
	'! -name "other" -print0',
	'\\( -name "nw.exe" -or -name "nw" \\) -type f',
	'-name "-delete" -o -name "-exec"',
]) test(`readonly find expression after independent cd: ${expression}`, () => {
	assert.equal(inspectBashResourceLifecycle({ command: `cd sub; find . ${expression} | head` }), undefined);
});

for (const expression of [
	'-name "nw*" -o -delete',
	'-name "nw*" -a -exec rm -f {} \\;',
	'-name "nw*" -or -execdir touch changed {} +',
	'-name "nw*" -fprint changed',
	'-name "nw*" -fprintf changed "%p"',
	'-name "nw*" -ok rm {} \\;',
	'-name "nw*" > changed',
	'-name "${CDPATH:=..}"',
]) test(`independent cd must still reject effectful or stateful find: ${expression}`, () => {
	assert.match(inspectBashResourceLifecycle({ command: `cd sub; find . ${expression}` }) ?? "", /SHELL_UNINSPECTABLE/);
});

test("accepting readonly alternatives does not accept a later independent mutation", () => {
	assert.match(inspectBashResourceLifecycle({ command: `cd sub; ${FIND}; printf data >.git/config` }) ?? "", /SHELL_UNINSPECTABLE/);
});

test("real Bash preserves both successful and failed cd semantics for readonly find", async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-cd-find-"));
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "nw.exe"), "parent fixture");
	writeFileSync(join(root, "sub", "nw"), "child fixture");
	const localBash = "D:/Git/bin/bash.exe";
	const tool = createBashTool(root, { exposeSessionEnvironment: false,
		shellPath: process.platform === "win32" && existsSync(localBash) ? localBash : undefined });
	try {
		for (const target of ["sub", "missing"]) {
			const command = `cd ${target} 2>/dev/null; find . -maxdepth 1 -name nw.exe -o -maxdepth 1 -name nw`;
			assert.equal(inspectBashResourceLifecycle({ command }), undefined);
			const result = await tool.execute(`cd-find-${target}`, { command, timeout: 10 });
			const text = result.content.map(block => block.type === "text" ? block.text : "").join("\n");
			assert.match(text, target === "sub" ? /\.\/nw\b/ : /\.\/nw\.exe/);
		}
	} finally {
		// Only this test's directly-created fixture directory is removed.
		rmSync(root, { recursive: true, force: true });
	}
});
