import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
test("body byte counting has no payload copies, callbacks, arrays, regexes or promises", () => {
  const file="packages/ai/src/utils/request-body-observer.ts", source=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==="requestBodyUtf8Bytes") as ts.FunctionDeclaration;
  function inspect(n:ts.Node):void {
    assert.equal(ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isNewExpression(n)||ts.isObjectLiteralExpression(n)||ts.isArrayLiteralExpression(n)||ts.isRegularExpressionLiteral(n)||ts.isAwaitExpression(n),false,n.getText(source));
    if(ts.isCallExpression(n)) assert.match(n.expression.getText(source),/^(?:text\.charCodeAt|NATIVE_UTF8_BYTES)$/);
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
test("presentation policy calls carry the original source without allocating context wrappers", () => {
  const file="packages/coding-agent/src/core/tool-result-presentation.ts", ast=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  let calls=0;
  function visit(node:ts.Node):void {
    if(ts.isCallExpression(node)&&node.expression.getText(ast)==="imagePolicy") {
      calls++; assert.equal(node.arguments[1]?.getText(ast),"message");
      if(node.arguments[0]?.getText(ast)==="probe") assert.equal(node.arguments[2]?.getText(ast),"index");
      else { assert.ok(node.arguments[3],"exact source range must survive sanitization"); assert.equal(ts.isObjectLiteralExpression(node.arguments[3]),false,"reuse the existing projection range"); }
    }
    ts.forEachChild(node,visit);
  }
  visit(ast); assert.equal(calls,11);
});

test("Codex metering uses primitive counters without per-delta allocations or diagnostic serialization",()=>{
  const file="packages/ai/src/api/openai-codex-responses.ts",source=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  for(const name of ["observeCodexRequestBody","webSocketRequestBytes","recordWebSocketBodyFailure"]){
    const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name) as ts.FunctionDeclaration;
    function inspect(n:ts.Node):void {
      assert.equal(ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isArrayLiteralExpression(n)||ts.isAwaitExpression(n),false,n.getText(source));
      if(ts.isNewExpression(n))assert.equal(n.expression.getText(source),"CodexBodyObserverError","only failure settlement may allocate an error");
      ts.forEachChild(n,inspect);
    }
    inspect(fn.body!);
  }
  const text=source.getFullText();
  assert.doesNotMatch(text,/new TextEncoder\(\)\.encode\((?:getBodyJson\(\)|bodyJson)/);
  assert.match(text,/requestBytes: webSocketRequestBytes\(error\)/);
  assert.match(text,/const WEBSOCKET_REQUEST_BYTES = new WeakMap<object, number>\(\)/);
  for(const name of ["processWebSocketStream","performCodexWebSocketCompaction"]){
    const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name) as ts.FunctionDeclaration;
    const body=fn.body!.getText(source);let serializations=0;
    function inspect(n:ts.Node):void {
      if(ts.isCallExpression(n)&&n.expression.getText(source)==="JSON.stringify")serializations++;
      ts.forEachChild(n,inspect);
    }
    inspect(fn.body!);assert.equal(serializations,1,"one final frame per attempt");
    assert.match(body,/finally\s*\{\s*frame = undefined;\s*\}\s*const result = await|finally\s*\{\s*frame = undefined;\s*\}\s*await/);
    assert.doesNotMatch(body,/Buffer\.from\(frame|TextEncoder|\.send\(JSON\.stringify/);
  }
});
