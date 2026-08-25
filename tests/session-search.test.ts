import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { SessionInfo } from "../packages/coding-agent/src/core/session-manager.ts";
import {
	filterAndSortSessions,
	parseSearchQuery,
} from "../packages/coding-agent/src/modes/interactive/components/session-selector-search.ts";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: "session.jsonl",
		id: "session-1",
		cwd: "D:/workspace",
		created: new Date("2026-01-01T00:00:00.000Z"),
		modified: new Date("2026-01-02T00:00:00.000Z"),
		messageCount: 2,
		firstMessage: "investigate terminal rendering",
		...overrides,
	};
}

test("session search treats former re: input as ordinary fuzzy text", () => {
	assert.deepEqual(parseSearchQuery("re:(a+)+$"), {
		tokens: [{ kind: "fuzzy", value: "re:(a+)+$" }],
	});
});

test("session search covers bounded metadata and exact phrases", () => {
	const sessions = [
		session({ id: "alpha", firstMessage: "investigate terminal rendering" }),
		session({ id: "beta", firstMessage: "review provider retries" }),
	];
	assert.deepEqual(
		filterAndSortSessions(sessions, '"terminal rendering"', "recent").map((value) => value.id),
		["alpha"],
	);
	assert.deepEqual(
		filterAndSortSessions(sessions, "provider", "recent").map((value) => value.id),
		["beta"],
	);
});

test("session selector search does not construct user-controlled regular expressions", () => {
	const file = "packages/coding-agent/src/modes/interactive/components/session-selector-search.ts";
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const constructors: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isNewExpression(node) || ts.isCallExpression(node)) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "RegExp"
		) {
			constructors.push(node.getText(source));
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	assert.deepEqual(constructors, []);
});
