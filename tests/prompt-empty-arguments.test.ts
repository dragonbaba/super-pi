import assert from "node:assert/strict";
import test from "node:test";
import { expandPromptTemplate, parseCommandArgs, substituteArgs, type PromptTemplate } from "../packages/coding-agent/src/core/prompt-templates.ts";

const cases: Array<[string, string[]]> = [
  ['"" next', ["", "next"]], ["'' next", ["", "next"]], ['first "" last', ["first", "", "last"]],
  ['last ""', ["last", ""]], ['"" \'\' ""', ["", "", ""]], ['""', [""]], ["''", [""]],
  ['a""b \'\'tail', ["ab", "tail"]], ['""\'\'', [""]], ['"hello world" \'single quote\'', ["hello world", "single quote"]],
  ['one\t two\nthree', ["one", "two", "three"]], ['\uFEFF""\u3000次\u00a0', ["", "次"]],
  ['" \t "', [" \t "]], ['"one\'two"', ["one'two"]], ['"unterminated', ["unterminated"]],
  ["'unterminated", ["unterminated"]], ['prefix"', ["prefix"]], ['"', []], ["'", []],
  ["", []], [" \t\n", []], ["plain text", ["plain", "text"]], ["back\\slash", ["back\\slash"]],
];
for (const [input, expected] of cases) test(`prompt arguments retain positions: ${JSON.stringify(input)}`, () => {
  assert.deepEqual(parseCommandArgs(input), expected);
});

test("empty prompt positions preserve defaults, slices and nonrecursive replacement", () => {
  const args = parseCommandArgs('"" next "" end');
  assert.equal(substituteArgs("[$1][$2][$3][$4]|${1:-fallback}|${3:-empty}|${@:2:2}|${@:0:2}|$@|$ARGUMENTS", args),
    "[][next][][end]|fallback|empty|next | next| next  end| next  end");
  assert.equal(substituteArgs("${@:-all-default}/${ARGUMENTS:-all-default}", parseCommandArgs('""')), "all-default/all-default");
  assert.equal(substituteArgs("$1/$2/${3:-$1}", parseCommandArgs('"" \'$1\'')), "/$1/$1");
});

test("actual prompt expansion uses explicit empty parameters", () => {
  const template: PromptTemplate = { name: "review", description: "fixture", content: "first=[$1] second=[$2] default=${1:-none} tail=${@:2}",
    filePath: "/synthetic/review.md", sourceInfo: { path: "/synthetic/review.md", source: "fixture", scope: "temporary", origin: "top-level" } };
  assert.equal(expandPromptTemplate('/review "" next ""', [template]), "first=[] second=[next] default=none tail=next ");
  assert.equal(expandPromptTemplate('/unknown "" next', [template]), '/unknown "" next');
  assert.equal(expandPromptTemplate('plain "" next', [template]), 'plain "" next');
});
