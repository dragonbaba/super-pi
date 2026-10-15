import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { stripVTControlCharacters } from "node:util";
import { releaseComponentRenderCaches } from "@super-pi/tui";
import { CodemodeTreeComponent } from "../packages/coding-agent/src/modes/interactive/components/codemode-tree.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { codemodeFailureReason, codemodeTextDigest, codemodeOutputDigests } from "../packages/coding-agent/src/core/codemode-display.ts";
import { alphaSession, ALPHA_MODEL } from "./helpers/alpha-session.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";

initTheme("dark");
function plain(component: { render(width: number): string[] }, width = 160): string { return stripVTControlCharacters(component.render(width).join("\n")); }
function result(text: string) { return { content: [{ type: "text", text }] }; }
function fact(id: string, name: string, text: string, failed = false) {
	return { toolCallId: id, toolName: name, inputSummary: `command-${id}`, preview: text, isError: failed, outputDigests: codemodeOutputDigests(result(text).content) };
}
function parent(calls: any[], text: string[], failed = false) {
	const summary = `[CODEMODE_${failed ? "FAILED" : "OK"}] Child calls: ${calls.length}.`;
	return { content: [result(summary).content[0], ...text.map(value => result(value).content[0])], isError: failed,
		details: { codemode: { version: 1, calls, summaryDigest: codemodeTextDigest(summary) } } };
}

test("tree groups two calls, decodes exact content JSON and renders each output once", () => {
	const tree = new CodemodeTreeComponent();
	tree.startChild("p:1", "bash", { command: "echo first" });
	tree.startChild("p:2", "bash", { command: "echo second" });
	tree.updateChild("p:1", result("first-output"), false, false);
	tree.updateChild("p:2", result("second-output"), false, false);
	const final = parent([fact("p:1", "bash", "first-output"), fact("p:2", "bash", "second-output")],
		[JSON.stringify(result("first-output").content), JSON.stringify(result("second-output").content), "calculated total: 2"]);
	tree.updateParent("await tools.bash(args)", final, false, false, false);
	assert.match(plain(tree), /Codemode \(2 child calls\)/);
	assert.match(plain(tree), /├─ • 1\. bash/); assert.match(plain(tree), /└─ • 2\. bash/);
	assert.doesNotMatch(plain(tree), /first-output|CODEMODE_OK/);
	tree.updateParent("await tools.bash(args)", final, false, false, true);
	const view = plain(tree);
	assert.equal(view.split("first-output").length - 1, 1); assert.equal(view.split("second-output").length - 1, 1);
	assert.match(view, /calculated total: 2/); assert.doesNotMatch(view, /\[\{"type":"text"/);
	assert.equal(tree.getLifecycleCounts().outputProjections, 1, "expansion does not rehash/reparse results");
	const printedSummary = "[CODEMODE_OK] Child calls: 0.";
	const summaryTree = new CodemodeTreeComponent();
	summaryTree.updateParent("", parent([], [printedSummary]), false, false, true);
	assert.equal(plain(summaryTree).split(printedSummary).length - 1, 1, "only the host's first summary block is hidden; identical script output is preserved");
});

test("all collapsed calls hide output equally, including the final script return and shared output", () => {
	const tree = new CodemodeTreeComponent();
	const texts = ["first detail\n".repeat(10), "middle detail\n".repeat(10), "last detail\n".repeat(10)];
	const facts = texts.map((text, index) => ({ ...fact(`p:${index}`, "read", text), durationMs: 0 }));
	const final = parent(facts, [...texts, "last script return\n".repeat(10)]);
	const canonical = JSON.stringify(final);
	for (let index = 0; index < facts.length; index++) {
		tree.startChild(facts[index]!.toolCallId, "read", { path: `file-${index}.txt` });
		tree.updateChild(facts[index]!.toolCallId, result(texts[index]!), true, false);
		assert.doesNotMatch(plain(tree), /first detail|middle detail|last detail/);
		tree.updateChild(facts[index]!.toolCallId, result(texts[index]!), false, false);
	}
	tree.updateParent("source", final, false, false, false);
	const collapsed = plain(tree);
	assert.doesNotMatch(collapsed, /first detail|middle detail|last detail|last script return|Script output/);
	assert.equal(collapsed.split("\n").filter(line => /[├└]─/.test(line)).length, 3);
	assert.equal(collapsed.split("\n").filter(line => line.trim()).length, 5, "header + three equal rows + expansion hint");
	tree.updateParent("source", final, false, false, true);
	for (const text of ["first detail", "middle detail", "last detail", "last script return"]) assert.ok(plain(tree).includes(text));
	tree.updateParent("source", final, false, false, false);
	assert.equal(plain(tree), collapsed);
	tree.invalidate(); assert.equal(plain(tree), collapsed);
	releaseComponentRenderCaches(tree);
	tree.updateParent("source", final, false, false, false);
	assert.equal(plain(tree), collapsed);
	assert.equal(JSON.stringify(final), canonical);
	releaseComponentRenderCaches(tree);
	const shared = parent([fact("s:1", "read", "shared detail"), fact("s:2", "read", "shared detail")], ["shared detail"]);
	tree.updateParent("", shared, false, false, false);
	assert.doesNotMatch(plain(tree), /shared detail/);
	tree.updateParent("", shared, false, false, true);
	assert.equal(plain(tree).split("shared detail").length - 1, 1);
	releaseComponentRenderCaches(tree);
});

test("first and last failed rows use the same compact error layout without output-file details", () => {
	const tree = new CodemodeTreeComponent();
	const error = "reason\nnext action\nextra diagnostic";
	const final = parent([0, 1, 2].map(index => ({ ...fact(`p:${index}`, "bash", error, true), outputPath: `output-${index}.log` })), [], true);
	tree.updateParent("source", final, false, true, false);
	const collapsed = plain(tree);
	assert.equal(collapsed.split("\n").filter(line => line.trim() === "reason").length, 3);
	assert.doesNotMatch(collapsed, /output-[012]\.log|next action|extra diagnostic/);
	tree.updateParent("source", final, false, true, true);
	for (let index = 0; index < 3; index++) assert.ok(plain(tree).includes(`output-${index}.log`));
	releaseComponentRenderCaches(tree);
});

test("missing path renders only the failed instruction and one reason, including budgeted history", () => {
	const error = "[SHELL_RUNTIME_FAILED]\n2026-10-15 07:21\nls: cannot access ''$'\\350\\247\\206': No such file or directory\nCommand exited with code 2";
	const calls = [fact("p:1", "browser_exec", "browser succeeded"),
		{ ...fact("p:2", "bash", error, true), inputSummary: "date && ls -d 视频创意", executionStatus: "exited", exitCode: 2 }];
	const final = parent(calls, ["[CODEMODE_SCRIPT] [p:2] " + error, "browser succeeded",
		"[Path recovery] codemode should verify the parent directory before retrying; do not guess another path."], true);
	const canonical = JSON.stringify(final);
	const component = new ToolExecutionComponent("codemode", "p", { code: "source" }, {}, undefined, { requestRender() {} } as never, process.cwd());
	component.updateResult(final);
	component.setToolResultPresentation("p", { version: 2, continuation: { version: 1, cursor: "fixture" },
		truncation: { originalEstimatedTokens: 4674, modelEstimatedTokens: 542 } } as any);
	const collapsed = plain(component);
	assert.match(collapsed, /browser_exec — completed/);
	assert.match(collapsed, /2\. bash  date && ls -d 视频创意 ×\s*\n\s*Path does not exist\./);
	assert.equal(collapsed.split("×").length - 1, 1);
	assert.doesNotMatch(collapsed, /CODEMODE_|SHELL_RUNTIME|Script error|Path recovery|not rolled back|bounded view|exit=2|07:21/);
	const tree = (component as any).codemodeTree as CodemodeTreeComponent;
	const projections = tree.getLifecycleCounts().failureProjections;
	for (let index = 0; index < 32; index++) { component.setExpanded(true); component.setExpanded(false); plain(component); }
	assert.equal(tree.getLifecycleCounts().failureProjections, projections, "redraw and expansion reuse the concise reason");
	component.setExpanded(true);
	const expanded = plain(component);
	for (const detail of ["SHELL_RUNTIME_FAILED", "exit=2", "Path recovery", "bounded view", "not rolled back"]) assert.ok(expanded.includes(detail));
	component.setExpanded(false);
	releaseComponentRenderCaches(component); component.invalidate();
	assert.equal(plain(component), collapsed);
	assert.equal(JSON.stringify(final), canonical);
	releaseComponentRenderCaches(component);
	assert.equal(tree.getLifecycleCounts().textChars, 0);
});

test("failure reasons prefer actual diagnostics and never turn arbitrary missing-path prose into a diagnosis", () => {
	assert.equal(codemodeFailureReason("[SHELL_RUNTIME_FAILED]\n0\nCommand exited with code 2"), "Command exited with code 2");
	for (const cause of ["fatal: not a git repository (or any of the parent directories): .git", "curl: (6) Could not resolve host: example.invalid", "src/main.ts(2,3): error TS2304: Cannot find name 'missing'."]) {
		for (const audience of ["display", "model"] as const) {
			for (const output of [`${cause}\nCommand exited with code 2`, `0\n${cause}\nCommand exited with code 2`, `Command exited with code 2\n${cause}`]) {
				assert.equal(codemodeFailureReason(`[SHELL_RUNTIME_FAILED]\n${output}`, audience), cause);
			}
		}
	}
	assert.equal(codemodeFailureReason("[BROWSER_EXEC_FAILED] Traceback (most recent call last):\n  File \"runner.py\", line 2\nRuntimeError: connection refused\nmore details"), "RuntimeError: connection refused");
	assert.equal(codemodeFailureReason("report contains: No such file or directory\nPermission denied"), "report contains: No such file or directory");
	assert.equal(codemodeFailureReason("ENOENT: no such file or directory, open 'missing.txt'"), "Path does not exist.");
	assert.equal(codemodeFailureReason("Get-Item : Cannot find path 'missing' because it does not exist."), "Path does not exist.");
	assert.equal(codemodeFailureReason("Unknown failure\n" + "x".repeat(10 * 1024 * 1024)), "Unknown failure");
	assert.ok(codemodeFailureReason("x".repeat(4096)).length <= 160);
	assert.equal(codemodeFailureReason("ENOENT: no such file or directory, open 'missing.txt'", "model"), "ENOENT: no such file or directory, open 'missing.txt'");
	assert.equal(codemodeFailureReason("Error: " + "x".repeat(4096), "model").length, 512);
});

test("npm preambles and policy headings do not hide actionable causes or model recovery", () => {
	const cause = "src/winter/WinterVideo.tsx(153,10): error TS2657: JSX expressions must have one parent element.";
	const errors = cause + "\nsrc/winter/WinterVideo.tsx(162,95): error TS1003: Identifier expected.\nCommand exited with code 1";
	const prettyCause = "src/winter/WinterVideo.tsx:153:10 - error TS2657: JSX expressions must have one parent element.";
	assert.equal(codemodeFailureReason(`npm notice run tsc --noEmit\n${prettyCause}\nError: typecheck failed\nCommand exited with code 1`), prettyCause);
	for (const audience of ["display", "model"] as const) {
		assert.equal(codemodeFailureReason(`${cause}\nTimeoutError: compiler server did not respond\nError: typecheck failed`, audience), "TimeoutError: compiler server did not respond");
		assert.equal(codemodeFailureReason(`${cause}\nENOENT: no such file or directory, open 'input.ts'`, audience), audience === "display" ? "Path does not exist." : "ENOENT: no such file or directory, open 'input.ts'");
	}
	for (const banner of ["npm notice run remotion-video-project@1.0.0 typecheck\nnpm notice run tsc --noEmit", "> project@1.0.0 typecheck\n> tsc --noEmit", "npm info run project@1.0.0 typecheck", "> @scope/project@1.0.0-dev typecheck\n> tsc --noEmit"]) {
		for (const audience of ["display", "model"] as const) {
			assert.equal(codemodeFailureReason(`[SHELL_RUNTIME_FAILED]\n${banner}\n\u001b[31m${errors}\u001b[0m`, audience), cause);
			assert.equal(codemodeFailureReason(`${banner}\nCommand exited with code 1`, audience), "Command exited with code 1");
		}
	}
	for (const audience of ["display", "model"] as const) {
		for (const header of ["> check", "> project check", "> @scope/project check"]) {
			assert.equal(codemodeFailureReason(`${header}\n\n> missing-command\nsh: missing-command: not found\nCommand exited with code 127`, audience), "sh: missing-command: not found");
			assert.equal(codemodeFailureReason(`${header}\n> tsc --noEmit\n${errors}`, audience), cause);
		}
		assert.equal(codemodeFailureReason("> denied", audience), "> denied");
		assert.equal(codemodeFailureReason("> denied\nCommand exited with code 1", audience), "> denied");
		assert.equal(codemodeFailureReason("> authentication failed\nCommand exited with code 1", audience), "> authentication failed");
		assert.equal(codemodeFailureReason("> authentication failed\n> token expired\nCommand exited with code 1", audience), "> authentication failed > token expired");
		assert.equal(codemodeFailureReason("> authentication failed\n> token expired", audience), "> authentication failed > token expired");
		for (const tail of ["> refresh denied", "> refresh denied\n> contact the administrator"]) {
			const run = `> authentication failed\n> token expired\n${tail}`;
			assert.equal(codemodeFailureReason(`${run}\nCommand exited with code 1`, audience), "> authentication failed > token expired");
			assert.equal(codemodeFailureReason(`${run}\nError: account disabled\nCommand exited with code 1`, audience), "Error: account disabled");
		}
		assert.equal(codemodeFailureReason("$ authentication failed\nCommand exited with code 1", audience), "$ authentication failed");
		assert.equal(codemodeFailureReason("> project@1.0.0 check\n> checker\n> authentication failed\nCommand exited with code 1", audience), "> authentication failed");
	}
	const policy = '[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED] Not executed:\nBash analysis cannot inspect the `powershell.exe` launcher.\nNext: Use tool_search with query "powershell", then read its schema; normal authorization still applies.';
	assert.equal(codemodeFailureReason(policy), "Bash analysis cannot inspect the `powershell.exe` launcher.");
	assert.match(codemodeFailureReason(policy, "model"), /cannot inspect.*Next: Use tool_search.*normal authorization/);
	for (const code of ["SHELL_BACKGROUND", "SHELL_UNINSPECTABLE", "SHELL_DYNAMIC_EXECUTABLE", "SHELL_INSPECTION_LIMIT"]) {
		const refusal = `[${code}] PowerShell not executed: fixture reason.\nNext: submit a literal foreground command for normal authorization; do not retry the same blocked call.`;
		assert.equal(codemodeFailureReason(refusal), "fixture reason.");
		assert.match(codemodeFailureReason(refusal, "model"), /PowerShell not executed: fixture reason.*Next: submit a literal foreground command.*do not retry/);
	}
	const http = "aiohttp.client_exceptions.WSServerHandshakeError: 403, message='Invalid response status', url='wss://example.invalid/long'";
	assert.equal(codemodeFailureReason(http), "HTTP 403: Invalid response status.");
	assert.equal(codemodeFailureReason(http, "model"), http);
	for (const nonHttp of ["DatabaseError: 123, message='constraint failed'", "DatabaseError: 403, message='constraint failed'", "ClientResponseError: 123, message='invalid code'"]) {
		assert.equal(codemodeFailureReason(nonHttp), nonHttp);
	}
	assert.equal(codemodeFailureReason("ModuleNotFoundError: No module named 'win32com'"), "ModuleNotFoundError: No module named 'win32com'");
	const final = parent([fact("p:1", "bash", `[SHELL_RUNTIME_FAILED]\nnpm notice run project typecheck\n${errors}`, true)], [], true);
	const canonical = JSON.stringify(final), tree = new CodemodeTreeComponent();
	tree.updateParent("await tools.bash(args)", final, false, true, false);
	assert.match(plain(tree), /bash.*×\s*\n\s*src\/winter\/WinterVideo.tsx.*TS2657/);
	assert.doesNotMatch(plain(tree), /npm notice|TS1003|Not executed|Script output/);
	const projections = tree.getLifecycleCounts().failureProjections;
	for (let i = 0; i < 32; i++) { tree.updateParent("await tools.bash(args)", final, false, true, i % 2 === 0); plain(tree); }
	assert.equal(tree.getLifecycleCounts().failureProjections, projections);
	tree.updateParent("await tools.bash(args)", final, false, true, true);
	assert.match(plain(tree), /npm notice/); assert.match(plain(tree), /TS1003/);
	assert.equal(JSON.stringify(final), canonical);
	const terminalResult = parent([fact("p:1", "bash", `${errors}\nTimeoutError: compiler server did not respond`, true)], [], true);
	tree.updateParent("await tools.bash(args)", terminalResult, false, true, false);
	assert.match(plain(tree), /TimeoutError: compiler server did not respond/);
	assert.doesNotMatch(plain(tree), /TS2657/);
	const terminalProjections = tree.getLifecycleCounts().failureProjections;
	for (let i = 0; i < 32; i++) { tree.updateParent("await tools.bash(args)", terminalResult, false, true, false); plain(tree); }
	assert.equal(tree.getLifecycleCounts().failureProjections, terminalProjections);
	releaseComponentRenderCaches(tree);
	assert.equal(tree.getLifecycleCounts().resultReferences, 0);
});

test("browser IPC timeout and inactive tool errors stay concise while expansion shows each stack once", () => {
	const error = "[BROWSER_EXEC_FAILED] TimeoutError: timed out\nTraceback (most recent call last):\n  File \"helpers.py\", line 57\n" +
		"browser_harness.helpers._IPCResponseTimeout: Page.navigate timed out after 5s waiting for the daemon";
	assert.equal(codemodeFailureReason(error), "Page.navigate timed out after 5s; result unconfirmed.");
	assert.match(codemodeFailureReason(error, "model"), /Page.navigate.*5s.*inspect list_tabs\(\).*Do not automatically retry/);
	const final = parent([fact("p:1", "browser_exec", error, true)], ["[CODEMODE_SCRIPT] [p:1] " + error.slice(0, 512)], true);
	const canonical = JSON.stringify(final);
	const tree = new CodemodeTreeComponent();
	tree.updateParent("await tools.browser_exec(args)", final, false, true, false);
	const collapsed = plain(tree);
	assert.match(collapsed, /browser_exec.*×\s*\n\s*Page.navigate timed out after 5s; result unconfirmed\./);
	assert.doesNotMatch(collapsed, /Traceback|TimeoutError|Script output|not rolled back/);
	tree.updateParent("await tools.browser_exec(args)", final, false, true, true);
	assert.equal(plain(tree).split("Traceback (most recent call last):").length - 1, 1);
	assert.doesNotMatch(plain(tree), /CODEMODE_SCRIPT|Script output/);
	assert.equal(JSON.stringify(final), canonical);
	releaseComponentRenderCaches(tree);
	tree.updateParent("", parent([], ["[CODEMODE_SCRIPT] tools.browser_exec does not exist. Available: read, bash, tool_search. Filter ALL_TOOLS..."], true), false, true, false);
	assert.match(plain(tree), /Script ×\s*\n\s*Tool browser_exec is unavailable in this script; check tool discovery\./);
	assert.doesNotMatch(plain(tree), /Available:|ALL_TOOLS/);
	releaseComponentRenderCaches(tree);
});

test("collapsed progress reuses stable previews and labels without retaining full results", () => {
	const tree = new CodemodeTreeComponent();
	tree.updateParent("script", undefined, true, false, false);
	tree.startChild("p:1", "bash", { command: "fixture" });
	const prefix = "x".repeat(2048);
	for (let index = 0; index < 1024; index++) tree.updateChild("p:1", result(prefix + index + "y".repeat(4096)), true, false);
	let counts = tree.getLifecycleCounts();
	assert.equal(counts.labelMaterializations, 1);
	assert.equal(counts.previewMaterializations, 1);
	assert.equal(counts.resultReferences, 0);
	assert.ok(counts.textChars < 2200);
	tree.updateChild("p:1", result("latest" + "y".repeat(4096)), true, false);
	tree.updateParent("script", undefined, true, false, true);
	assert.match(plain(tree), /latest/);
	assert.match(plain(tree), /preview truncated/);
	tree.updateChild("p:1", result("short"), false, false);
	assert.match(plain(tree), /short/);
	assert.doesNotMatch(plain(tree), /preview truncated/);
	tree.updateParent("script", undefined, false, false, true);
	releaseComponentRenderCaches(tree);
	counts = tree.getLifecycleCounts();
	assert.equal(counts.rows, 0); assert.equal(counts.textChars, 0);
});

test("failed child remains visible collapsed and hooks/unrecognized output are retained", () => {
	const tree = new CodemodeTreeComponent();
	const final = parent([{ ...fact("p:1", "bash", "0\nCommand exited with code 1", true), executionStatus: "exited", exitCode: 1 }], ["custom hook output"], true);
	tree.updateParent("query", final, false, true, false);
	assert.match(plain(tree), /1\. bash.*×/);
	assert.match(plain(tree), /Command exited with code 1/); assert.doesNotMatch(plain(tree), /custom hook output|exit=1/);
	tree.updateParent("query", final, false, true, true);
	assert.match(plain(tree), /custom hook output|exit=1/);
	const legacy = result("[CODEMODE_FAILED] legacy error");
	tree.updateParent("query", legacy, false, true, false);
	assert.match(plain(tree), /legacy error/);
});

test("collapsed preflight failure shows one concise error and no partial-effects warning", () => {
	const tree = new CodemodeTreeComponent();
	const error = "[POLICY_BLOCKED:DYNAMIC_TARGET] Not executed:\nThe target cannot be verified from this request.\nNext: Submit a literal target for authorization.";
	const wrapped = "[CODEMODE_SCRIPT] [p:1] " + error + "\n[Permission recovery] Resolve this exact operation before retrying.";
	const final = parent([{ ...fact("p:1", "bash", error, true), executionStatus: "not_executed", exitCode: null }], [wrapped], true);
	const canonical = JSON.stringify(final);
	tree.updateParent("await tools.bash(args)", final, false, true, false);
	const collapsed = plain(tree);
	assert.equal(collapsed.split("target cannot be verified").length - 1, 1);
	assert.doesNotMatch(collapsed, /Script output|Permission recovery|not rolled back|exit=unknown/);
	assert.match(collapsed, /target cannot be verified/);
	tree.updateParent("await tools.bash(args)", final, false, true, true);
	assert.match(plain(tree), /Permission recovery/);
	assert.equal(JSON.stringify(final), canonical);
});

test("independent script failures stay visible while partial-effects guidance requires expansion", () => {
	const tree = new CodemodeTreeComponent();
	const final = parent([{ ...fact("p:1", "bash", "done"), executionStatus: "exited", exitCode: 0 }],
		["prior output\n".repeat(60), "[CODEMODE_SCRIPT] independent failure\n" + "verbose line\n".repeat(60)], true);
	tree.updateParent("script", final, false, true, false);
	const collapsed = plain(tree);
	assert.match(collapsed, /independent failure/);
	assert.doesNotMatch(collapsed, /not rolled back|verbose line|prior output/);
	assert.ok(collapsed.split("\n").length < 15);
	tree.updateParent("script", final, false, true, true);
	assert.match(plain(tree), /not rolled back/);
	assert.equal(plain(tree).split("verbose line").length - 1, 60);
	tree.updateParent("script", parent([fact("p:1", "bash", "done")], [], true), false, true, false);
	assert.match(plain(tree), /Script ×\s*\n\s*Execution failed; no diagnostic was returned\./);
});

test("compact failed child bounds long diagnostics and releases the extra preview on restore", () => {
	const tree = new CodemodeTreeComponent();
	const final = parent([{ ...fact("p:1", "bash", "primary error\n" + "detail\n".repeat(100), true), inputSummary: "x".repeat(500) }], [], true);
	tree.updateParent("", final, false, true, false);
	assert.ok(plain(tree).split("\n").length < 14);
	assert.match(plain(tree), /primary error/);
	assert.doesNotMatch(plain(tree), /x{100}/);
	tree.updateParent("", final, false, true, true);
	assert.equal(plain(tree).split("detail").length - 1, 100);
	releaseComponentRenderCaches(tree);
	assert.equal(tree.getLifecycleCounts().textChars, 0);
	tree.updateParent("", final, false, true, false);
	assert.match(plain(tree), /primary error/);
	releaseComponentRenderCaches(tree);
});

test("identical outputs remain explicitly unassigned instead of guessing a child owner", () => {
	const tree = new CodemodeTreeComponent();
	tree.updateParent("same", parent([fact("p:1", "one", "same-output"), fact("p:2", "two", "same-output")], [JSON.stringify(result("same-output").content)]), false, false, true);
	const view = plain(tree);
	assert.equal(view.split("same-output").length - 1, 1); assert.match(view, /Script output/);
	assert.equal(view.split("Identical output is shown").length - 1, 2);
});

test("completion order is reconciled to recorded call order and invalidation preserves styles", () => {
	const tree = new CodemodeTreeComponent(); tree.startChild("p:2", "second", {}); tree.startChild("p:1", "first", {});
	tree.updateParent("", parent([fact("p:1", "first", "one"), fact("p:2", "second", "two")], []), false, false, true);
	const before = plain(tree); assert.ok(before.indexOf("1. first") < before.indexOf("2. second"));
	tree.invalidate(); assert.equal(plain(tree), before);
});

test("live suspension clears the timer and resume retains bounded child state", () => {
	const tree = new CodemodeTreeComponent(() => {}); tree.startChild("p:1", "read", { path: "live.txt" });
	tree.updateChild("p:1", result("progress"), true, false);
	assert.equal(tree.getLifecycleCounts().timers, 1);
	releaseComponentRenderCaches(tree); assert.equal(tree.getLifecycleCounts().timers, 0);
	tree.updateParent("", undefined, true, false, true);
	assert.match(plain(tree), /live.txt/); assert.match(plain(tree), /progress/); assert.equal(tree.getLifecycleCounts().timers, 1);
	tree.updateParent("", result("cancelled"), false, true, false); releaseComponentRenderCaches(tree);
	assert.equal(tree.getLifecycleCounts().rows, 0); assert.equal(tree.getLifecycleCounts().timers, 0);
});

test("restore rebuilds a bounded tree; release drops sources and subsequent invalidation can rebuild", () => {
	const final = parent([fact("p:1", "read", "restored-output")], ["restored-output"]);
	const component = new ToolExecutionComponent("codemode", "p", { code: "await tools.read({path:'file'})" }, {}, undefined, { requestRender() {} } as never, process.cwd());
	component.updateResult(final); component.setExpanded(true);
	const before = plain(component);
	assert.match(before, /read/); assert.equal(before.split("restored-output").length - 1, 1);
	const tree = (component as any).codemodeTree as CodemodeTreeComponent;
	releaseComponentRenderCaches(component);
	assert.equal(tree.getLifecycleCounts().rows, 0); assert.equal(tree.getLifecycleCounts().resultReferences, 0); assert.equal(tree.getLifecycleCounts().textChars, 0);
	component.invalidate(); assert.equal(plain(component), before);
});

test("progress reuses row/Text owners and bounds huge partial output; completion/cancel settles running rows", () => {
	const tree = new CodemodeTreeComponent(); tree.startChild("p:1", "read", { path: "file.txt" });
	const huge = result("x".repeat(1024 * 1024));
	for (let index = 0; index < 1000; index++) tree.updateChild("p:1", huge, true, false);
	assert.equal(tree.getLifecycleCounts().rowCreations, 1); assert.ok(tree.getLifecycleCounts().textChars < 3000);
	tree.updateParent("read", result("Operation aborted"), false, true, false);
	assert.match(plain(tree), /interrupted \/ result unavailable/); assert.match(plain(tree), /Operation aborted/);
	releaseComponentRenderCaches(tree); assert.equal(tree.getLifecycleCounts().textChars, 0);
});

test("large/unknown/image output is bounded honestly, preserves recovery paths and never parses extra JSON fields away", () => {
	const tree = new CodemodeTreeComponent();
	const contentArray = JSON.stringify([{ type: "text", text: "same", extra: "must-remain" }]);
	const final = parent([{ ...fact("p:1", "read", "same"), outputPath: "saved-output.txt" }], [contentArray, "z".repeat(100_000)]);
	final.content.unshift({ type: "image" } as any);
	tree.updateParent("source", final, false, false, true);
	const view = plain(tree);
	assert.match(view, /image output/); assert.match(view, /must-remain/); assert.match(view, /display truncated/); assert.match(view, /saved-output.txt/);
	assert.ok(tree.getLifecycleCounts().textChars < 70_000);
	assert.equal(final.content.at(-1)!.text.length, 100_000, "canonical model content remains untouched");
});

test("grammar source is visible and stale progress cannot restart a completed child timer", () => {
	const component = new ToolExecutionComponent("codemode", "p", "text(42)", {}, undefined, { requestRender() {} } as never, process.cwd());
	component.startNestedTool("p:1", "bash", { command: "true" }); component.updateNestedTool("p:1", result("done"), false, false);
	component.updateNestedTool("p:1", result("stale"), true, false); component.setExpanded(true);
	assert.match(plain(component), /text\(42\)/); assert.doesNotMatch(plain(component), /stale/);
	assert.equal((component as any).codemodeTree.getLifecycleCounts().timers, 0);
	component.updateResult(result("done")); releaseComponentRenderCaches(component);
});

test("real SDK + InteractiveMode retains one parent card, no child protocol results, and restores the same tree", async t => {
	let executions = 0;
	const f = await alphaSession({ codemode: true, g2: false, customTools: [{ name: "probe", label: "probe", description: "offline query", parameters: Type.Object({ path: Type.String() }),
		execute: async (_id: string, args: any, _signal: unknown, onUpdate: any) => { executions++; onUpdate?.(result("pending")); return result(`value-${args.path}`); } }] });
	t.after(() => f.release());
	await f.mode.init();
	let turns = 0;
	f.session.agent.streamFunction = () => {
		const code = 'const a=await tools.probe({path:"first"});text(a.content);const b=await tools.probe({path:"second"});text(b.content);';
		const message: any = { role: "assistant", api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id, timestamp: 1,
			content: turns++ === 0 ? [{ type: "toolCall", id: "parent", name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }],
			stopReason: turns === 1 ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
	};
	await f.session.prompt("run offline");
	assert.equal(executions, 2);
	assert.equal(f.session.messages.filter(message => message.role === "toolResult").length, 1);
	let cards = f.internal.chatContainer.children.filter((child: unknown) => child instanceof ToolExecutionComponent);
	assert.equal(cards.length, 1, "nested tools must not become standalone cards");
	cards[0].setExpanded(true);
	const live = plain(cards[0]);
	assert.equal(live.split("value-first").length - 1, 1); assert.equal(live.split("value-second").length - 1, 1);
	assert.match(live, /1\. probe.*first/); assert.match(live, /2\. probe.*second/);
	f.internal.rebuildChatFromMessages();
	cards = f.internal.chatContainer.children.filter((child: unknown) => child instanceof ToolExecutionComponent);
	assert.equal(cards.length, 1); cards[0].setExpanded(true); assert.equal(plain(cards[0]), live);
	assert.equal(f.internal.pendingTools.size, 0); assert.equal(f.internal.pendingToolResultDiscoveries?.size ?? 0, 0);
});

test("real Codemode preflight error stays compact live and after history reconstruction", async t => {
	let executions = 0;
	const f = await alphaSession({ codemode: true, g2: false,
		extensions: [(pi: any) => pi.on("tool_call", (event: any) => event.toolName === "bash" ? ({ block: true, reason: JSON.stringify({
			category: "POLICY_BLOCKED", stateChanged: false, policyReason: "unverifiable_target",
		}) }) : undefined)],
		customTools: [{ name: "bash", label: "bash", description: "blocked fixture", parameters: Type.Object({ command: Type.String() }),
			execute: async () => { executions++; return result("should not execute"); } }] });
	t.after(() => f.release());
	await f.mode.init();
	let turns = 0;
	f.session.agent.streamFunction = () => {
		const first = turns++ === 0;
		const message: any = { role: "assistant", api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id, timestamp: 1,
			content: first ? [{ type: "toolCall", id: "blocked-parent", name: "codemode", arguments: { code: 'await tools.bash({command:"fixture"})' } }] : [{ type: "text", text: "done" }],
			stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
	};
	await f.session.prompt("blocked fixture");
	assert.equal(executions, 0);
	const messages = JSON.stringify(f.session.messages);
	const card = f.internal.chatContainer.children.find((child: unknown) => child instanceof ToolExecutionComponent);
	const collapsed = plain(card);
	assert.equal(collapsed.split("target cannot be verified").length - 1, 1);
	assert.doesNotMatch(collapsed, /CODEMODE_SCRIPT|Script output|not rolled back|exit=unknown/);
	card.setExpanded(true);
	assert.match(plain(card), /target cannot be verified/);
	assert.doesNotMatch(plain(card), /CODEMODE_SCRIPT/);
	f.internal.rebuildChatFromMessages();
	const restored = f.internal.chatContainer.children.find((child: unknown) => child instanceof ToolExecutionComponent);
	restored.setExpanded(false);
	assert.equal(plain(restored), collapsed);
	assert.equal(JSON.stringify(f.session.messages), messages);
});
