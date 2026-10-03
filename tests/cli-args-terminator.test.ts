import assert from "node:assert/strict";
import test from "node:test";
import { hasOption, parseArgs, validateModelSelectionArgs } from "../packages/coding-agent/src/cli/args.ts";

// `--` ends option parsing so messages that look like flags reach the model verbatim.
for (const [name, argv, messages, fileArgs] of [
	["flag-like message", ["--model", "m", "--", "--explain this flag"], ["--explain this flag"], []],
	["short-option-like message", ["--", "-h", "-v"], ["-h", "-v"], []],
	["file references stay files", ["--", "@notes.md", "review"], ["review"], ["notes.md"]],
	["second terminator is a message", ["--", "--"], ["--"], []],
] as const) test(`parseArgs treats arguments after -- as positional: ${name}`, () => {
	const result = parseArgs([...argv]);
	assert.deepEqual(result.messages, messages);
	assert.deepEqual(result.fileArgs, fileArgs);
	assert.equal(result.unknownFlags.size, 0);
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.help, undefined);
	assert.equal(result.version, undefined);
});

test("parseArgs still parses options before --", () => {
	const result = parseArgs(["--model", "m", "-c", "--", "hello"]);
	assert.equal(result.model, "m");
	assert.equal(result.continue, true);
	assert.deepEqual(result.messages, ["hello"]);
});

test("startup option prescan ignores options after --", () => {
	assert.equal(hasOption(["--offline", "hi"], "--offline"), true);
	assert.equal(hasOption(["--", "--offline"], "--offline"), false);
	assert.equal(hasOption(["--offline", "--", "--offline"], "--offline"), true);
	assert.equal(hasOption(["hi"], "--offline"), false);
});

test("session model selection requires --model for an explicit provider", () => {
	const providerOnly = parseArgs(["--provider", "fixture", "hello"]);
	assert.match(validateModelSelectionArgs(providerOnly) ?? "", /--provider requires --model/);
	assert.equal(validateModelSelectionArgs(parseArgs(["--provider", "fixture", "--model", "chosen"])), undefined);
	assert.equal(validateModelSelectionArgs(parseArgs(["--model", "fixture/chosen"])), undefined);
	assert.equal(validateModelSelectionArgs(parseArgs(["--", "--provider", "fixture"])), undefined);
	// Parsing remains reusable for auth/catalog commands; session validation is explicit.
	assert.deepEqual(providerOnly.diagnostics, []);
});
