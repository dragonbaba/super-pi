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

test("file-change renderer and viewport helpers retain bounded primitive hot state", () => {
  const targets = [
    { path: "packages/extensions/mutation-guard-write/change-preview.ts", owner: "BatchResultText", methods: ["setBatchText", "releasePreview"] },
    { path: "packages/extensions/mutation-guard-write/changes.ts", owner: "ChangeViewer", methods: ["render", "handleInput", "invalidate", "dispose"] },
  ];
  for (const target of targets) {
    const source = ts.createSourceFile(target.path, readFileSync(target.path, "utf8"), ts.ScriptTarget.Latest, true);
    const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === target.owner) as ts.ClassDeclaration;
    assert.ok(owner, target.owner);
    for (const name of target.methods) {
      const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name) as ts.MethodDeclaration;
      assert.ok(method?.body, `${target.owner}.${name}`);
      let arrays = 0;
      function inspect(node: ts.Node): void {
        assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isRegularExpressionLiteral(node), false, `${target.owner}.${name}: ${node.getText(source)}`);
        if (ts.isArrayLiteralExpression(node)) arrays++;
        if (ts.isCallExpression(node)) assert.doesNotMatch(node.expression.getText(source), /(?:\.map|\.filter|\.slice|\.then|\.catch|\.finally|\.bind|JSON\.stringify|Buffer\.from|generate.*Diff|generate.*Patch)$/);
        ts.forEachChild(node, inspect);
      }
      inspect(method.body!);
      assert.equal(arrays, target.owner === "ChangeViewer" && name === "render" ? 1 : 0, "only the caller-owned visible viewport array is allowed");
    }
  }
});
