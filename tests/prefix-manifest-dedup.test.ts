import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import ts from "typescript";
import { buildPrefixManifest, comparePrefixManifests, type PrefixManifestBuildInput } from "../packages/coding-agent/src/core/prefix-manifest.ts";

function input(): PrefixManifestBuildInput {
	return { provider: "fixture", model: "fixture", api: "fixture", transport: "sse", systemPrompt: "prompt\r\nbody\r",
		tools: [{ name: "read", schema: { type: "object", properties: { path: { type: "string" } } } }],
		persistentContext: [{ identifier: "workspace:a", content: "PF_CONTEXT_A\r\nbody\r", precedence: 0 },
			{ identifier: "workspace:b", content: "PF_CONTEXT_B\r\nbody\r", precedence: 1 }], previousResponseMode: "none" };
}

test("one build normalizes each prompt/context once and hashes the canonical context once", () => {
	const createHash = crypto.createHash, replace = String.prototype.replace;
	let contextVisits = 0, normalizations = 0;
	crypto.createHash = ((...args: Parameters<typeof createHash>) => {
		const hash = createHash(...args), update = hash.update;
		hash.update = function (value: Parameters<typeof update>[0], encoding?: Parameters<typeof update>[1]) {
			if (typeof value === "string" && value.startsWith('"PF_CONTEXT')) contextVisits++;
			return update.call(this, value, encoding ?? "utf8");
		};
		return hash;
	}) as typeof createHash;
	String.prototype.replace = function (this: string, pattern: any, replacement: any): string {
		if (pattern instanceof RegExp && pattern.source === "\\r\\n?") normalizations++;
		return replace.call(this, pattern, replacement);
	} as typeof replace;
	syncBuiltinESMExports();
	try {
		buildPrefixManifest(input());
		assert.equal(contextVisits, 2, "two context entries, each canonicalized once");
		assert.equal(normalizations, 3, "one prompt and two context entries");
	} finally { crypto.createHash = createHash; String.prototype.replace = replace; syncBuiltinESMExports(); }
});

test("same-object schema/context mutations remain visible on every manifest build", () => {
	const current = input();
	const first = buildPrefixManifest(current);
	(current.tools[0]!.schema as any).properties.path.type = "number";
	const schemaChanged = buildPrefixManifest(current);
	assert.equal(comparePrefixManifests(first, schemaChanged)?.reasonCode, "TOOL_SCHEMA_CHANGED");
	current.persistentContext![0]!.content = "changed body";
	const contextChanged = buildPrefixManifest(current);
	assert.equal(comparePrefixManifests(schemaChanged, contextChanged)?.reasonCode, "PROJECT_CONTEXT_CHANGED");
	assert.notEqual(contextChanged.persistentContextHash, schemaChanged.persistentContextHash);
	assert.equal(first.schemaVersion, contextChanged.schemaVersion);
});

test("normalized text hashing introduces no callbacks, arrays, wrappers or regexp per call", () => {
	const file = ts.createSourceFile("prefix-manifest.ts", readFileSync("packages/coding-agent/src/core/prefix-manifest.ts", "utf8"), ts.ScriptTarget.Latest, true);
	for (const name of ["normalizeText", "hashNormalizedText", "hashText"]) {
		const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration;
		assert.ok(declaration, name);
		function visit(node: ts.Node): void {
			assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isRegularExpressionLiteral(node) &&
				!ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node) && !ts.isNewExpression(node), node.getText(file));
			ts.forEachChild(node, visit);
		}
		visit(declaration.body!);
	}
});
