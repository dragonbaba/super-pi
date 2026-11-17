import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { releaseComponentRenderCaches } from "@super-pi/tui";
import { createBashToolDefinition } from "../packages/coding-agent/src/core/tools/bash.ts";
import { CodemodeTreeComponent } from "../packages/coding-agent/src/modes/interactive/components/codemode-tree.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { body, sessionFixture } from "./codemode-recovery/fixture.ts";

test("retained file metadata is automatically reported without failing or replaying the script", async t => {
	const f = await sessionFixture(t, { g2: false, customTools: [{ name: "fixture_noop", label: "Fixture", description: "Fixture", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] });
	await mkdir(join(f.root, "source/.git"), { recursive: true });
	await writeFile(join(f.root, "source/.git/config"), "protected"); await writeFile(join(f.root, "source/file"), "ordinary");
	f.session.setActiveToolsByName(["file_batch"]);
	const { result } = await f.run('await tools.file_batch({operations:[{operation:"copy",path:"source",destination:"destination"}]});store("retention-completed",true);text("SCRIPT_CONTINUED");');
	assert.equal(result.isError, false, body(result.content));
	assert.match(body(result.content), /Retained protected metadata: 1/);
	assert.match(body(result.content), /SCRIPT_CONTINUED/);
	assert.equal(result.details.codemode.calls.filter((call: any) => call.toolName === "file_batch").length, 1);
	assert.equal(await readFile(join(f.root, "destination/file"), "utf8"), "ordinary");
	assert.equal(await readFile(join(f.root, "source/.git/config"), "utf8"), "protected");
	assert.match(body((await f.run('text(load("retention-completed"));')).result.content), /true/);
});

test("a child refusal after truncated successful output keeps one cause and no unrelated parse advice", async t => {
	let producers = 0, refusals = 0;
	const shell = createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false, operations: { async exec(_command, cwd, options) {
		producers++; options.onData(Buffer.from("truncated text\n".repeat(10000)));
		return { exitCode: 0, termination: "exit", observation: { started: true, cwd, exitCode: 0, signal: null, outputDrained: true } };
	} } });
	const f = await sessionFixture(t, { g2: false, customTools: [shell, { name: "refuse", label: "Refuse", description: "Synthetic refusal", parameters: Type.Object({}),
		execute: async () => { refusals++; return { content: [{ type: "text", text: "[POLICY_BLOCKED] EXPECTED_CHILD_REFUSAL\nNo item executed." }], isError: true, details: {} }; } }] });
	const { result } = await f.run('await tools.bash({command:"synthetic"});await tools.refuse({});');
	assert.equal(result.isError, true); assert.equal(producers, 1); assert.equal(refusals, 1);
	assert.equal(result.details.codemode.calls[0].outputTruncated, true);
	assert.doesNotMatch(body(result.content), /successful bash output is truncated/);
	initTheme("dark"); const tree = new CodemodeTreeComponent();
	try {
		for (const expanded of [false, true]) {
			tree.updateParent("fixture", result, false, true, expanded);
			const text = stripVTControlCharacters(tree.render(160).join("\n"));
			assert.equal(text.split("EXPECTED_CHILD_REFUSAL").length - 1, 1);
			assert.doesNotMatch(text, /Script ×/);
		}
  } finally { releaseComponentRenderCaches(tree); }
});
