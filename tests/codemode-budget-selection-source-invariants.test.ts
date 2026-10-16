import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";

test("R1.3 exact search uses bounded scalar storage without callbacks, sources or clocks",()=>{
  const source=readFileSync("packages/coding-agent/src/core/tool-result-budget-selection.ts","utf8");
  const ast=ts.createSourceFile("selection.ts",source,ts.ScriptTarget.Latest,true);
  const constructions:string[]=[];
  function visit(node:ts.Node):void {
    assert.equal(ts.isArrowFunction(node)||ts.isFunctionExpression(node),false);
    if(ts.isNewExpression(node))constructions.push(node.expression.getText(ast));
    ts.forEachChild(node,visit);
  }
  visit(ast);
  assert.deepEqual(constructions.sort(),["ArrayBuffer","Float64Array","Float64Array","ToolResultBudgetComputationError","Uint8Array"].sort());
  for(const term of ["new Map","new Set","new Array(","JSON.stringify","Buffer.from",".slice(",".map(","setTimeout","Date.now","performance.now","sourceContent","ToolResultMessage","ObjectPool"])assert.equal(source.includes(term),false,term);
  assert.ok(source.indexOf('this.fail("memory", 0, 0, requiredBytes)')<source.indexOf("this.costs = new Float64Array"));
  assert.ok(source.indexOf('this.fail("memory", states, steps, requiredBytes)')<source.indexOf("this.workspace = new ArrayBuffer"));
  assert.match(source,/this\.costs = undefined/);assert.match(source,/this\.workspace = undefined/);
  assert.match(source,/RESULT_SELECTION_MAX_STATES = 1_048_576/);
  assert.match(source,/RESULT_SELECTION_MAX_STEPS = 4_194_304/);
  assert.match(source,/RESULT_SELECTION_MAX_BYTES = 1_048_576/);
});

test("R1.3 common allocation path cannot construct the exact selector and every exit disposes it",()=>{
  const source=readFileSync("packages/coding-agent/src/core/tool-result-presentation.ts","utf8");
  const ast=ts.createSourceFile("presentation.ts",source,ts.ScriptTarget.Latest,true);
  let calls=0;
  function visit(node:ts.Node):void {
    if(ts.isNewExpression(node)&&node.expression.getText(ast)==="ToolResultBudgetSelection") {
      let parent:ts.Node|undefined=node.parent;
      while(parent&&!ts.isIfStatement(parent))parent=parent.parent;
      assert.ok(parent&&ts.isIfStatement(parent));
      assert.equal(parent.expression.getText(ast),"!keepFullBatch && (minimumToolTokens > remainingToolTokens || minimumContextTokens > remainingContextTokens)");
      calls++;
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);assert.equal(calls,1);
  assert.match(source,/finally\s*\{\s*exactSelection\?\.dispose\(\);\s*while \(preparedHead\)/);
});
