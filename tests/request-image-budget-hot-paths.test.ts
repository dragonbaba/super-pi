import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
test("body byte counting has no payload copies, callbacks, arrays, regexes or promises", () => {
  const file="packages/ai/src/utils/request-body-observer.ts", source=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==="requestBodyUtf8Bytes") as ts.FunctionDeclaration;
  function inspect(n:ts.Node):void {
    assert.equal(ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isNewExpression(n)||ts.isObjectLiteralExpression(n)||ts.isArrayLiteralExpression(n)||ts.isRegularExpressionLiteral(n)||ts.isAwaitExpression(n),false,n.getText(source));
    if(ts.isCallExpression(n)) assert.match(n.expression.getText(source),/^text\.charCodeAt$/);
    ts.forEachChild(n,inspect);
  }
  inspect(fn.body!);
});
test("image projection never encodes or copies payloads in apply/layout loops", () => {
  const file="packages/coding-agent/src/core/request-image-budget.ts", source=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  const cls=source.statements.find(ts.isClassDeclaration)!;
  for(const name of ["apply","applyMessages"]) {
    const member=cls.members.find(m=>m.name?.getText(source)===name)!;
    const body=ts.isMethodDeclaration(member)?member.body!:(member as ts.PropertyDeclaration).initializer as ts.ArrowFunction;
    const text=body.getText(source);
    assert.doesNotMatch(text,/JSON\.stringify|Buffer\.from|TextEncoder|\.map\(|\.filter\(|new (?:Promise|AbortController)|resizeImage/);
  }
  const prepare=cls.members.find(m=>m.name?.getText(source)==="prepare")!.getText(source);
  assert.doesNotMatch(prepare,/\.map\(|\.filter\(|Promise\.all|new Set|new Map/);
  assert.match(prepare,/generation === this\.generation/);
});
