import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";
import {estimateToolOutputTextRange,estimateToolOutputTokens} from "../packages/coding-agent/src/core/tool-output-budget.ts";
import {createToolResultPresentationOwner,ToolResultContinuationError} from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import {ToolResultBudgetComputationError} from "../packages/coding-agent/src/core/tool-result-budget-selection.ts";
import {toolResult} from "./codemode-recovery/fixture.ts";

test("R1.2 range diagnostics match complete estimates including sliced surrogate boundaries",()=>{
  const text="ABCdef001中あ한\n😀\ud800x\udfff\u0301👩‍💻\x1b[31m";
  for(let from=0;from<=text.length;from++)for(let to=from;to<=text.length;to++)
    assert.equal(estimateToolOutputTextRange(text,from,to),estimateToolOutputTokens([{type:"text",text:text.substring(from,to)}]).estimatedTokens,`${from}:${to}`);
});

test("R1.2 oversized atomic-line errors measure ranges without constructing the line",t=>{
  const huge="中".repeat(1024*1024);
  const first="1#1234|short\n",long="2#5678|"+huge+"\n";
  const source=[{type:"text" as const,readBoundary:"lines" as const,text:first+long+"3#7890|tail\n"},
    {type:"text" as const,readBoundary:"metadata" as const,text:"[Snapshot edit] snapshot=snap_0000000000000000000000; editable lines=1-3. Use the paired anchors."}];
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:512},"huge-line")!;
  try{
    const view=owner.create(source,"read")!;owner.release();assert.equal(view.version,2);
    if(view.version!==2)throw Error("expected a recovery view");
    assert.ok(view.modelContent.some(b=>b.type==="text"&&b.text===first));
    const before=owner.counters.boundedTextStringsCreated;
    const substring=String.prototype.substring;
    t.mock.method(String.prototype,"substring",function(this:string,start:number,end?:number){
      assert.ok((end??this.length)-start<100000||this.toString()!==source[0]!.text,"large diagnostic substring");
      return substring.call(this,start,end);
    });
    assert.throws(()=>owner.readContinuation(view.continuation.cursor,[toolResult("read",source)],1),e=>{
      assert.ok(e instanceof ToolResultContinuationError);assert.equal(e.code,"budget-too-small");
      assert.equal(e.minimumTokens,estimateToolOutputTokens([{type:"text",text:long}]).estimatedTokens);return true;
    });
    assert.equal(owner.counters.boundedTextStringsCreated,before);
  }finally{owner.dispose();}
});

test("R1.2 computation resource errors have a public SDK constructor and fields",async()=>{
  const sdk=await import("../packages/coding-agent/src/index.ts");
  assert.equal(sdk.ToolResultBudgetComputationError,ToolResultBudgetComputationError);
  const error=new sdk.ToolResultBudgetComputationError("states",5,10,2000000,8000000,10000);
  assert.ok(error instanceof ToolResultBudgetComputationError);
  assert.equal(error.checkedStates,5);assert.equal(error.stateLimit,1048576);
});

test("R1.2 diagnostic estimator and its scanner never slice or copy the input",()=>{
  const source=readFileSync("packages/coding-agent/src/core/tool-output-budget.ts","utf8");
  const ast=ts.createSourceFile("budget.ts",source,ts.ScriptTarget.Latest,true);
  const names=new Set(["estimateToolOutputTextRange","scanText","finishTokenEstimate"]);
  let found=0;
  for(const node of ast.statements)if(ts.isFunctionDeclaration(node)&&names.has(node.name?.text??"")){
    found++;
    function visit(n:ts.Node):void{
      assert.equal(ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isArrayLiteralExpression(n)||ts.isSpreadAssignment(n),false);
      if(ts.isCallExpression(n))assert.doesNotMatch(n.expression.getText(ast),/substring|slice|split|join|Buffer\.from|JSON\.stringify/);
      ts.forEachChild(n,visit);
    }
    visit(node);
  }
  assert.equal(found,3);
  const presentation=readFileSync("packages/coding-agent/src/core/tool-result-presentation.ts","utf8");
  const diagnostic=presentation.substring(presentation.indexOf("// Failure-only diagnostic:"),presentation.indexOf("const done = samePosition"));
  assert.match(diagnostic,/estimateToolOutputTextRange/);assert.doesNotMatch(diagnostic,/appendRegion|substring/);
});
