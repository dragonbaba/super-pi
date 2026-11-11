import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function member(path:string,owner:string,name:string) {
  const source=ts.createSourceFile(path,readFileSync(path,"utf8"),ts.ScriptTarget.Latest,true);
  const declaration=source.statements.find((node):node is ts.ClassDeclaration=>ts.isClassDeclaration(node)&&node.name?.text===owner)!;
  const method=declaration.members.find(node=>node.name?.getText(source)===name)!;
  const body=ts.isMethodDeclaration(method)?method.body!:(method as ts.PropertyDeclaration).initializer as ts.ArrowFunction;
  return {source,body};
}

test("critical observation cleanup adds no per-delivery closure, Promise or payload wrapper",()=>{
  const functions=[member("packages/agent/src/agent.ts","Agent","processEvents"),
    member("packages/coding-agent/src/core/files/snapshot-line-edit.ts","FileRevisions","forgetContinuations")];
  for(const {source,body} of functions) {
    function visit(node:ts.Node):void {
      assert.equal(ts.isArrowFunction(node)||ts.isFunctionExpression(node),false,node.getText(source));
      if(ts.isNewExpression(node)) assert.doesNotMatch(node.expression.getText(source),/Promise|AbortController|Buffer/);
      ts.forEachChild(node,visit);
    }
    visit(body);
    assert.doesNotMatch(body.getText(source),/JSON\.stringify|Buffer\.from|\.map\(|\.filter\(/);
  }
});

test("commit continuation retains the transferred bytes and verifies with a bounded scratch buffer",()=>{
  const {source,body}=member("packages/coding-agent/src/core/files/snapshot-line-edit.ts","FileRevisions","continueCommitted");
  const text=body.getText(source);
  assert.doesNotMatch(text,/Buffer\.from|\.readFile\(|bytes\.toString\(|strictUtf8Decoder\.decode\(|\.map\(|\.filter\(/);
  assert.match(text,/bytes\.length > MAX_SNAPSHOT_FILE_BYTES/);
  assert.match(text,/Buffer\.allocUnsafe\(Math\.min\(POSTIMAGE_VERIFY_BYTES/);
  assert.match(text,/finally \{ await handle\.close\(\); \}/);
  assert.match(text,/identity, bytes, sha256: expected/);
  const service=readFileSync("packages/coding-agent/src/core/files/file-service.ts","utf8");
  assert.match(service,/finally \{ this\.postimage = undefined; this\.publication = undefined; \}/);
  const session=readFileSync("packages/coding-agent/src/core/agent-session.ts","utf8");
  assert.match(session,/onToolObservationFailure === this\._handleToolObservationFailure\) this\.agent\.onToolObservationFailure = undefined/);
});
