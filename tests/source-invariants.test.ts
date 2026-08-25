import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXCLUDED_DIRECTORIES = new Set(["dist", "node_modules", "vendor"]);

function extensionOf(path: string): string {
	const separator = path.lastIndexOf(".");
	return separator < 0 ? "" : path.slice(separator);
}

function collectSourceFiles(root: string, output: string[]): void {
	const entries = readdirSync(root, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(root, entry.name);
		if (entry.isDirectory()) {
			if (!EXCLUDED_DIRECTORIES.has(entry.name)) collectSourceFiles(fullPath, output);
			continue;
		}
		if (entry.isFile() && SOURCE_EXTENSIONS.has(extensionOf(entry.name))) output.push(fullPath);
	}
}

test("project source avoids V8-hostile and locale-dependent syntax", () => {
	const files: string[] = [];
	collectSourceFiles(join(process.cwd(), "packages"), files);
	collectSourceFiles(join(process.cwd(), "scripts"), files);
	const violations: string[] = [];

	for (const file of files) {
		const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			let reason: string | undefined;
			if (ts.isForInStatement(node)) reason = "for...in";
			else if (ts.isDeleteExpression(node)) reason = "property delete";
			else if (
				ts.isNewExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "String"
			) {
				reason = "new String";
			} else if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "toLocaleString"
			) {
				reason = "toLocaleString";
			}
			if (reason) {
				const location = source.getLineAndCharacterOfPosition(node.getStart(source));
				violations.push(`${file}:${location.line + 1}:${location.character + 1} ${reason}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}

	assert.deepEqual(violations, []);
});
