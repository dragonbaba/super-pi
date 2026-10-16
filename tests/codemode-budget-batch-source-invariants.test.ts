import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";

test("R1.3 two-pass helpers create no asynchronous state or unbounded scratch collections",()=>{
  const source=readFileSync("packages/coding-agent/src/core/tool-result-presentation.ts","utf8");
  const ast=ts.createSourceFile("presentation.ts",source,ts.ScriptTarget.Latest,true);
  const methods=new Set(["measureContextualMinimum","projectMessagesWithinContextualBudget","projectMessageWithinContextualBudget"]);
  const found=new Set<string>();
  function visit(node:ts.Node):void {
    if(ts.isMethodDeclaration(node)&&methods.has(node.name.getText(ast))) {
      found.add(node.name.getText(ast));
      const text=node.getText(ast);
      for(const forbidden of ["new Promise","new AbortController","new Map","new Set","new Array","Array.from","Buffer.from","JSON.stringify",".map(",".filter(",".slice(",".then("]) assert.equal(text.includes(forbidden),false,forbidden);
      function check(child:ts.Node):void {
        assert.equal(ts.isArrowFunction(child)||ts.isFunctionExpression(child),false);
        ts.forEachChild(child,check);
      }
      check(node);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  assert.deepEqual(found,methods);
  assert.match(source,/preparedCount < MAX_PROJECTION_RECORD_ENTRIES/);
  assert.match(source,/finally\s*\{\s*while \(preparedHead\)/);
  assert.match(source,/preparedHead\.contextualNext = undefined/);
  assert.match(source,/this\.counters\.contextualPreparedRecords = 0/);
});
