import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/coding-agent/src/core/shell-policy/core.ts";
import { inspectNativeShellMutations } from "../packages/coding-agent/src/core/shell-policy/native-mutations.ts";
import { inspectBashPermissionScope } from "../packages/coding-agent/src/core/shell-policy/permission-bash.ts";
import { ShellAnalysisOwner, shellAnalysisOwnership } from "../packages/coding-agent/src/core/shell-policy/shell-analysis.ts";
import { bashLexerCounters, fillBashSegment, lexBash } from "../packages/coding-agent/src/core/shell-policy/syntax/bash.ts";
import {
  SEGMENT_CONDITIONAL_MEMBER, SEGMENT_DYNAMIC, SEGMENT_PIPELINE_MEMBER, SEGMENT_SEPARATOR_TEXT, SEGMENT_SUBSHELL_CLOSED_AFTER, type SegmentWords,
} from "../packages/coding-agent/src/core/shell-policy/syntax/token-table.ts";

const cwd = resolve("/work/proj");
/** The reused fill buffer keeps emptied side arrays; holes read as 0. */
const dense = <T>(values: readonly T[] | undefined, hole: T): T[] | undefined => values?.length ? Array.from(values, value => value ?? hole) : undefined;

function segments(source: string) {
  const table = lexBash(source), words: SegmentWords = [], out: unknown[] = [];
  for (let segment = 0; segment < table.segmentCount; segment++) {
    fillBashSegment(table, segment, words);
    out.push({
      words: [...words], separator: SEGMENT_SEPARATOR_TEXT[table.segmentSeparators[segment]!], depth: table.segmentDepths[segment],
      source: source.slice(table.segmentSourceStarts[segment], table.segmentSourceEnds[segment]), meta: table.segmentMeta[segment],
      expansions: dense(words.expansions, 0), fds: dense(words.redirectionFds, undefined),
    });
  }
  return { out, unterminated: table.unterminated };
}

test("Bash words, separators and per-segment facts come from one table", () => {
  const { out } = segments(`a 'b c'"d" e\\ f $(g; h) 2>err | (cd x && rm "$y") ; [[ -f a* ]] || echo $'p\\tq'`);
  assert.deepEqual(out, [
    { words: ["a", "b cd", "e f", "$(g; h)", ">", "err"], separator: "|", depth: 0, source: `a 'b c'"d" e\\ f $(g; h) 2>err `,
      meta: SEGMENT_PIPELINE_MEMBER | SEGMENT_DYNAMIC, expansions: [0, 0, 0, 4], fds: ["2"] },
    // `(` starts a new buffer, so the subshell body is not itself the pipeline member.
    { words: ["cd", "x"], separator: "&&", depth: 1, source: "cd x ", meta: SEGMENT_CONDITIONAL_MEMBER, expansions: undefined, fds: undefined },
    // `;` after `)` replaces the closed subshell's separator: the list edge belongs to it.
    { words: ["rm", "$y"], separator: ";", depth: 1, source: ` rm "$y"`, meta: SEGMENT_CONDITIONAL_MEMBER | SEGMENT_DYNAMIC | SEGMENT_SUBSHELL_CLOSED_AFTER,
      expansions: [0, 1], fds: undefined },
    { words: ["[[", "-f", "a*", "]]"], separator: "||", depth: 0, source: " [[ -f a* ]] ", meta: SEGMENT_CONDITIONAL_MEMBER | 16, expansions: undefined, fds: undefined },
    { words: ["echo", "p\tq"], separator: undefined, depth: 0, source: ` echo $'p\\tq'`, meta: SEGMENT_CONDITIONAL_MEMBER, expansions: undefined, fds: undefined },
  ]);
  // The end of the script is not a list operator: `(a)` keeps its `)`.
  assert.equal((segments("(a)").out[0] as { separator: string }).separator, ")");
  // A `{name}` descriptor word is not argv; its brace bit stays with the operator.
  assert.deepEqual(segments("exec {fd}>out").out[0], { words: ["exec", ">", "out"], separator: undefined, depth: 0, source: "exec {fd}>out", meta: 0, expansions: [0, 8], fds: ["{fd}"] });
  assert.equal(segments("echo 'open").unterminated, true);
});

test("each Bash source is tokenized once per authorization by every scanner and released afterwards", () => {
  const command = `cd sub && rm -rf ../outside/a; echo "$(rm b.txt)" > out.txt; trap "$x" EXIT`;
  const owners = shellAnalysisOwnership.liveOwners, entries = shellAnalysisOwnership.liveEntries, bytes = shellAnalysisOwnership.liveBytes;
  // Root script plus the substitution body: lifecycle, mutation and scope scanners share both tables.
  let lexes = bashLexerCounters.lexes;
  const owner = new ShellAnalysisOwner(command, cwd, 1);
  try {
    inspectBashResourceLifecycle({ command }, false, owner);
    inspectHighRiskBashMutation({ command }, cwd, "bash", owner);
    inspectBashPermissionScope({ command }, cwd, owner);
  } finally { owner.release(); }
  assert.equal(bashLexerCounters.lexes - lexes, 2);
  // Without an owner every helper tokenizes the source again.
  lexes = bashLexerCounters.lexes;
  inspectHighRiskBashMutation({ command }, cwd, "bash");
  inspectBashPermissionScope({ command }, cwd);
  assert.ok(bashLexerCounters.lexes - lexes > 6, String(bashLexerCounters.lexes - lexes));
  lexes = bashLexerCounters.lexes;
  inspectNativeShellMutations("bash", { command }, cwd, 1);
  assert.equal(bashLexerCounters.lexes - lexes, 2);
  assert.equal(shellAnalysisOwnership.liveOwners, owners);
  assert.equal(shellAnalysisOwnership.liveEntries, entries);
  assert.equal(shellAnalysisOwnership.liveBytes, bytes);
});

test("the Bash lexer allocates no callbacks, literals or temporary containers", () => {
  const allowed = new Set(["charCodeAt", "slice", "push", "pushText", "closeSegment", "markSubshellClosed"]);
  const file = "packages/coding-agent/src/core/shell-policy/syntax/bash.ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let functions = 0;
  function audit(node: ts.Node): void {
    assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
      || ts.isRegularExpressionLiteral(node) || ts.isSpreadElement(node) || ts.isTemplateExpression(node), false, node.getText(source));
    if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "ShellTokenTable", node.getText(source));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.ok(allowed.has(node.expression.name.text), node.getText(source));
    ts.forEachChild(node, audit);
  }
  // newBashSegment returns the one array its caller owns; the shared callback audit covers it.
  for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.body && statement.name?.text !== "newBashSegment") {
    functions++; ts.forEachChild(statement.body, audit);
  }
  assert.ok(functions >= 5);
});
