import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";

test("R1.1 capability cost counting never materializes a normalized result copy",()=>{
  const source=readFileSync("packages/ai/src/utils/estimate.ts","utf8");
  const ast=ts.createSourceFile("estimate.ts",source,ts.ScriptTarget.Latest,true);
  const expected=new Set(["estimateMessageTokens","getLastAssistantUsageInfo","estimateMessages","estimateContextTokens","estimateContextTokensFromParts"]);
  const found=new Set<string>();
  function visit(node:ts.Node):void {
    if(ts.isFunctionDeclaration(node)&&node.name&&expected.has(node.name.text)){
      found.add(node.name.text);
      const text=node.getText(ast);
      for(const forbidden of [".map(",".join(",".slice(",".filter(","new Array","new Map","new Set","Array.from","Buffer.from","contextForModelCapabilities("])
        assert.equal(text.includes(forbidden),false,`${node.name.text}: ${forbidden}`);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);assert.deepEqual(found,expected);
});
