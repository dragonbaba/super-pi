import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { isUtf8 } from "node:buffer";
import { MAX_WRITE_BYTES } from "../packages/coding-agent/src/core/files/write-limits.ts";
import * as limits from "../packages/coding-agent/src/core/sandbox/mxc-file-limits.mjs";

test("permission history and Escape navigation avoid repeated branch arrays and callback creation", () => {
  const policy = ts.createSourceFile("execution-policy.ts", readFileSync("packages/coding-agent/src/core/execution-policy.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const owner = policy.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SessionExecutionPolicy") as ts.ClassDeclaration;
  function check(node: ts.Node): void {
    assert.equal(ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrowFunction(node)
      || ts.isFunctionExpression(node) || ts.isAwaitExpression(node), false, node.getText());
    if (ts.isCallExpression(node)) assert.doesNotMatch(node.expression.getText(), /\.(getBranch|getEntries)$/);
    ts.forEachChild(node, check);
  }
  for (const name of ["restoreHistory", "restoreRefusals"]) {
    const history = owner.members.find(node => node.name?.getText(policy) === name) as ts.MethodDeclaration;
    check(history.body!);
  }
  const source = ts.createSourceFile("interactive-mode.ts", readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const mode = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "InteractiveMode") as ts.ClassDeclaration;
  for (const name of ["returnToBottomOnEscape", "onCompactionEscape", "onRetryEscape"]) {
    const member = mode.members.find(node => node.name?.getText(source) === name)!;
    check(ts.isMethodDeclaration(member) ? member.body! : ((member as ts.PropertyDeclaration).initializer as ts.ArrowFunction).body);
  }
});

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXCLUDED_DIRECTORIES = new Set(["dist", "node_modules", "vendor"]);

function inspectFileScan(node: ts.Node): void {
  assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
    || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) || ts.isNewExpression(node)
    || ts.isAwaitExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText());
  if (ts.isCallExpression(node)) {
    assert.doesNotMatch(node.expression.getText(), /(?:\.(?:split|bind|then|catch|finally|map|filter|flatMap|flat|concat|toSorted|toReversed|toSpliced)|^RegExp|^Array\.(?:from|of)|^Object\.(?:keys|values|entries|getOwnPropertyNames)|^Promise\.)/);
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "slice") {
      assert.equal(node.expression.expression.getText(), "source", "Only the bounded source-string slice is permitted");
    }
  }
  ts.forEachChild(node, inspectFileScan);
}

test("file scan allocation guard rejects implicit array and Promise factories", () => {
  const worker = readFileSync("packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs", "utf8");
  for (const expression of ["rows.filter(Boolean)", "rows.map(String)", "rows.flatMap(String)", "rows.slice()",
    "Array.from(rows)", "Array.of(rows)", "Object.keys(state)", "Promise.resolve(state)"]) {
    const mutated = worker.replace("while (match >= 0 && start < source.length) {", "while (match >= 0 && start < source.length) { " + expression + ";");
    assert.notEqual(mutated, worker);
    const source = ts.createSourceFile("mutated.mjs", mutated, ts.ScriptTarget.Latest, true);
    const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "grepRows") as ts.FunctionDeclaration;
    assert.throws(() => inspectFileScan(helper.body!), { name: "AssertionError" }, expression);
  }
});

test("sandbox literal search scans monotonically and bounds rows without line arrays", t => {
  const source = ts.createSourceFile("workspace-worker.mjs", readFileSync("packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "grepRows") as ts.FunctionDeclaration;
  assert.ok(helper);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node)
    && ["grepRows", "appendSearchRow", "stopSearch", "safeTextEnd", "searchFacts"].includes(node.name?.text ?? "")) as ts.FunctionDeclaration[];
  assert.equal(functions.length, 5);
  for (const fn of functions) if (fn.name!.text !== "searchFacts") inspectFileScan(fn.body!);
  const window = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "readWindow") as ts.FunctionDeclaration;
  assert.ok(window);
  for (const statement of window.body!.statements) if (ts.isWhileStatement(statement) || ts.isForStatement(statement)) inspectFileScan(statement);
  const owner = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "search") as ts.FunctionDeclaration;
  assert.match(owner.getText(source), /finally\s*\{\s*pending\.length = 0;\s*rows\.length = 0;/);
  assert.doesNotMatch(owner.getText(source), /\.readdirSync\(|\.split\(|\.map\(|\.filter\(|JSON\.stringify|new (?:Map|Set|Promise|AbortController)/);
  assert.match(owner.getText(source), /finally\s*\{\s*directory\.closeSync\(\);/);
  let directoryLoops = 0;
  function inspectDirectory(node: ts.Node): void {
    if (ts.isWhileStatement(node) && node.expression.getText(source).includes("directory.readSync()")) {
      directoryLoops++; inspectFileScan(node.statement);
    } else ts.forEachChild(node, inspectDirectory);
  }
  inspectDirectory(owner); assert.equal(directoryLoops, 1);
  // Execute the actual pure worker helpers without starting an isolated process.
  const { grepRows: search, searchFacts } = new Function("limits", "const {SEARCH_ROWS,TEXT_LIMIT,SEARCH_EXCERPT,SEARCH_CLIPPED_MARK}=limits;\n"
    + functions.map(node => node.getText(source)).join("\n") + "\nreturn {grepRows,searchFacts};")(limits);
  function measure(text: string, pattern: string) {
    let patternScans = 0, lineScans = 0, slices = 0; const rows: string[] = [];
    const input = { length: text.length, indexOf(value: string, start?: number) {
      if (value === "\n") lineScans++; else patternScans++;
      return text.indexOf(value, start);
    }, charCodeAt(index: number) { return text.charCodeAt(index); }, slice(start: number, end: number) { slices++; return text.slice(start, end); } };
    const state = searchFacts("grep"); search(input, pattern, "file", rows, state); return { patternScans, lineScans, slices, rows, state };
  }
  const absent = measure("plain\n".repeat(100000), "missing");
  assert.equal(absent.patternScans, 1); assert.equal(absent.lineScans, 0); assert.equal(absent.slices, 0);
  const tail = measure("plain\n".repeat(100000) + "needle", "needle");
  assert.equal(tail.patternScans, 2); assert.equal(tail.lineScans, 100001); assert.deepEqual(tail.rows, ["file:100001:needle"]);
  const dense = measure("hit\n".repeat(1000), "hit");
  assert.equal(dense.rows.length, 200); assert.equal(dense.slices, 200); assert.equal(dense.lineScans, 201);
  assert.equal(dense.state.observedRecords, 201); assert.equal(dense.state.stopReason, "row-limit");
  t.diagnostic(JSON.stringify({ absentPatternScans: 1, tailPatternScans: 2, tailLineScans: 100001, maximumRows: 200, lineArrays: 0 }));
});

test("execution boundary admission checks have no normal-path allocation", () => {
  const file = "packages/coding-agent/src/core/execution-boundary.ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SessionExecutionBoundary") as ts.ClassDeclaration;
  const check = owner.members.find(node => node.name?.getText(source) === "assertCurrent") as ts.MethodDeclaration;
  function inspect(node: ts.Node): void {
    assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) || ts.isAwaitExpression(node), false, node.getText());
    if (ts.isNewExpression(node)) assert.equal(node.expression.getText(), "Error");
    ts.forEachChild(node, inspect);
  }
  inspect(check.body!);
  const pause = owner.members.find(node => node.name?.getText(source) === "requiresUserInput") as ts.GetAccessorDeclaration;
  inspect(pause.body!);
  const summary = ts.createSourceFile("supplemental-summary.ts", readFileSync("packages/coding-agent/src/core/supplemental-summary.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const summaryOwner = summary.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SupplementalSummaryScope") as ts.ClassDeclaration;
  for (const name of ["assertCurrent", "finishRequest"]) {
    const gate = summaryOwner.members.find(node => node.name?.getText(summary) === name) as ts.PropertyDeclaration;
    inspect((gate.initializer as ts.ArrowFunction).body);
  }
  let pricingHelpers = 0;
  for (const file of ["packages/openai-server-compaction/src/openai-ws-stream.ts", "packages/ai/src/api/openai-responses.ts"]) {
    const pricing = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of pricing.statements) {
      if (ts.isFunctionDeclaration(node) && ["applyServiceTierPricing", "getServiceTierCostMultiplier"].includes(node.name?.text ?? "")) { inspect(node.body!); pricingHelpers++; }
    }
  }
  assert.equal(pricingHelpers, 3);
  const wsSource = ts.createSourceFile("openai-ws-stream.ts", readFileSync("packages/openai-server-compaction/src/openai-ws-stream.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const tierGuard = wsSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "assertWsContinuationTier") as ts.FunctionDeclaration;
  inspect(tierGuard.body!);
  const stateSource = ts.createSourceFile("state.ts", readFileSync("packages/openai-server-compaction/src/state.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const stateOwner = stateSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CompactionState") as ts.ClassDeclaration;
  for (const name of ["assertMutable", "getContinuationState", "getTransportContextState", "getRemoteCompactionState", "getSessionConfig", "getResponsesRequestShapeState"]) {
    const read = stateOwner.members.find(node => node.name?.getText(stateSource) === name) as ts.MethodDeclaration;
    inspect(read.body!);
  }
  for (const owned of [stateSource, wsSource]) for (const statement of owned.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer && ts.isNewExpression(initializer)) assert.doesNotMatch(initializer.expression.getText(owned), /^(Map|Set|WeakMap|WeakSet)$/);
    }
  }
  const codex = ts.createSourceFile("openai-codex-responses.ts", readFileSync("packages/ai/src/api/openai-codex-responses.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const codexOwner = codex.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CodexTransportOwner") as ts.ClassDeclaration;
  for (const name of ["assertCurrent", "isActive"]) {
    const gate = codexOwner.members.find(node => node.name?.getText(codex) === name) as ts.MethodDeclaration;
    inspect(gate.body!);
  }
  for (const node of codex.statements) if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
    assert.doesNotMatch(declaration.name.getText(codex), /^(websocketSessionCache|websocketDebugStats|websocketSseFallbackSessions|successfulDispatchCommitments|consumedDispatchCommitments)$/);
  }
  const parseCodex = codex.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "parseWebSocket") as ts.FunctionDeclaration;
  for (const name of ["onMessage", "onDecoded", "onDecodeFailure", "finishDecode"]) {
    const declaration = parseCodex.body!.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
      .find(node => node.name.getText(codex) === name)!;
    const callback = declaration.initializer as ts.ArrowFunction;
    // Error diagnostics may allocate on malformed data. Normal text delivery has no inline closures/Promises.
    const inspectCallback = (node: ts.Node): void => {
      assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isAwaitExpression(node), false, node.getText(codex));
      if (ts.isNewExpression(node)) assert.ok(["Error", "CodexProtocolError"].includes(node.expression.getText(codex)));
      ts.forEachChild(node, inspectCallback);
    };
    inspectCallback(callback.body);
  }
  let capabilityGuards = 0;
  function findCapabilityGuard(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(codex) === "remoteCompactionEnabled") { inspect(node.initializer!); capabilityGuards++; }
    else ts.forEachChild(node, findCapabilityGuard);
  }
  findCapabilityGuard(codex); assert.equal(capabilityGuards, 1);
  const selection = owner.members.find(node => node.name?.getText(source) === "getToolSelectionMode") as ts.MethodDeclaration;
  inspect(selection.body!);
  const end = owner.members.find(node => node.name?.getText(source) === "endPreparation") as ts.MethodDeclaration;
  inspect(end.body!);
  const sessionSource = ts.createSourceFile("agent-session.ts", readFileSync("packages/coding-agent/src/core/agent-session.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const sessionOwner = sessionSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AgentSession") as ts.ClassDeclaration;
  const resume = sessionOwner.members.find(node => node.name?.getText(sessionSource) === "_canResumeAgentRun") as ts.MethodDeclaration;
  inspect(resume.body!);
  const sessionPause = sessionOwner.members.find(node => node.name?.getText(sessionSource) === "requiresUserInput") as ts.GetAccessorDeclaration;
  inspect(sessionPause.body!);
  const previewCheck = sessionOwner.members.find(node => node.name?.getText(sessionSource) === "_assertProviderPreviewCurrent") as ts.MethodDeclaration;
  inspect(previewCheck.body!);
  // The one closure is created at logical-summary admission; each later identity check allocates nothing.
  const summaryGuard = sessionOwner.members.find(node => node.name?.getText(sessionSource) === "_createSummarizationGuard") as ts.MethodDeclaration;
  const returnedGuard = summaryGuard.body!.statements.find(ts.isReturnStatement)!.expression as ts.ArrowFunction;
  inspect(returnedGuard.body);
  const loader = ts.createSourceFile("loader.ts", readFileSync("packages/coding-agent/src/core/extensions/loader.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let gates = 0;
  function findGate(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(loader) === "assertExecutionCurrent") { inspect(node.body!); gates++; }
    else ts.forEachChild(node, findGate);
  }
  findGate(loader); assert.equal(gates, 1);
  let dispatchAssertions = 0;
  function findDispatchAssertion(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(loader) === "dispatch" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const check = node.initializer.properties.find(member => member.name?.getText(loader) === "assertCurrent") as ts.MethodDeclaration;
      inspect(check.body!); dispatchAssertions++;
    } else if (ts.isPropertyAssignment(node) && node.name.getText(loader) === "codexDispatch" && ts.isObjectLiteralExpression(node.initializer)) {
      const check = node.initializer.properties.find(member => member.name?.getText(loader) === "assertCurrent") as ts.MethodDeclaration;
      inspect(check.body!); dispatchAssertions++;
    } else ts.forEachChild(node, findDispatchAssertion);
  }
  findDispatchAssertion(loader); assert.equal(dispatchAssertions, 2);
  const hooks = ts.createSourceFile("runner.ts", readFileSync("packages/coding-agent/src/core/extensions/runner.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const deadline = hooks.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ToolCallDeadline") as ts.ClassDeclaration;
  // Constructor/trackHandler/trackDialog/drain are invocation or shutdown
  // boundaries. The shared completion callbacks themselves allocate nothing.
  let completions = 0;
  for (const member of deadline.members) {
    if (!["onHandlerResult", "finishActual", "releaseReturnedAuthorization", "takeResult", "assertCurrent"].includes(member.name?.getText(hooks) ?? "")) continue;
    const body = ts.isPropertyDeclaration(member) ? (member.initializer as ts.ArrowFunction).body : (member as ts.MethodDeclaration).body!;
    inspect(body); completions++;
  }
  assert.equal(completions, 5);
  const grants = hooks.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "PendingToolAuthorization") as ts.ClassDeclaration;
  const release = grants.members.find(node => node.name?.getText(hooks) === "release") as ts.MethodDeclaration;
  inspect(release.body!);
  for (const name of ["add", "finishCollection", "hasChecks"]) {
    const member = grants.members.find(node => node.name?.getText(hooks) === name) as ts.MethodDeclaration;
    inspect(member.body!);
  }
  const runner = hooks.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ExtensionRunner") as ts.ClassDeclaration;
  const capabilityRead = runner.members.find(node => node.name?.getText(hooks) === "getCodexRemoteCompactionEnabled") as ts.MethodDeclaration;
  inspect(capabilityRead.body!);
  const dispatchRead = runner.members.find(node => node.name?.getText(hooks) === "getOpenAIResponsesDispatch") as ts.MethodDeclaration;
  inspect(dispatchRead.body!);
  const codexDispatchRead = runner.members.find(node => node.name?.getText(hooks) === "getOpenAICodexDispatch") as ts.MethodDeclaration;
  inspect(codexDispatchRead.body!);
  for (const name of ["hasHandlers", "assertCompactionCurrent"]) {
    const gate = runner.members.find(node => node.name?.getText(hooks) === name) as ts.MethodDeclaration;
    inspect(gate.body!);
  }
  const modelRuntime = ts.createSourceFile("model-runtime.ts", readFileSync("packages/coding-agent/src/core/model-runtime.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const modelOwner = modelRuntime.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ModelRuntime") as ts.ClassDeclaration;
  const dispatchGate = modelOwner.members.find(node => node.name?.getText(modelRuntime) === "usesBuiltinOpenAIResponses") as ts.MethodDeclaration;
  inspect(dispatchGate.body!);
  const codexDispatchGate = modelOwner.members.find(node => node.name?.getText(modelRuntime) === "usesBuiltinOpenAICodex") as ts.MethodDeclaration;
  inspect(codexDispatchGate.body!);
  for (const path of ["packages/coding-agent/src/core/agent-session.ts", "packages/openai-server-compaction/src/index.ts"]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /cleanupSessionResources\(|closeOpenAICodexWebSocketSessions\(/);
  }
  assert.doesNotMatch(readFileSync("packages/openai-server-compaction/src/index.ts", "utf8"), /pi\.registerProvider\(/);
  for (const path of ["packages/ai/src/api/openai-codex-responses.ts", "packages/openai-server-compaction/src/index.ts"]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /codex-remote-compaction-sessions|setOpenAICodexRemoteCompactionCapability|setTransportRemoteCompactionCapability/);
  }
  const finishHook = runner.members.find(node => node.name?.getText(hooks) === "finishHook") as ts.PropertyDeclaration;
  inspect((finishHook.initializer as ts.ArrowFunction).body);
  // beginOwnedHook is the existing idle-to-busy lifecycle allocation. One
  // emitToolCall reservation covers all sequential native/extension producers.
  const toolCall = runner.members.find(node => node.name?.getText(hooks) === "emitToolCall") as ts.MethodDeclaration;
  const toolText = toolCall.getText(hooks);
  assert.ok(toolText.indexOf("new PendingToolAuthorization") < toolText.indexOf("await "));
  assert.match(toolText, /authorization\.finishCollection\(handedOff\)/);
  assert.match(toolText, /finally\s*\{\s*this\.finishHook\(\)/);
  const ownedEvents = hooks.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(hooks) === "OWNED_HOOK_EVENTS")!;
  assert.doesNotMatch(ownedEvents.getText(hooks), /message_update|tool_execution_update|message_start|tool_execution_start/);
  const planOwner = ts.createSourceFile("execution-owner.ts", readFileSync("packages/plan-mode/src/execution-owner.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const planClass = planOwner.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "PlanExecutionOwner") as ts.ClassDeclaration;
  const track = planClass.members.find(node => node.name?.getText(planOwner) === "track") as ts.MethodDeclaration;
  const trackedTry = track.body!.statements.find(ts.isTryStatement)!;
  inspect(trackedTry.finallyBlock!);
  assert.match(track.getText(planOwner), /this\.pending >= 8/);
  // Constructor, context(), track() and drain are explicit UI/file/transition
  // boundaries; none is called from rendering, delta or tool progress.
  const plan = ts.createSourceFile("plan-mode.ts", readFileSync("packages/plan-mode/src/plan-mode.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let transitions = 0;
  function checkPlan(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["changeMode", "enterPlanMode", "enterPlanModeWithPrompt", "exitPlanMode", "savePlanForLater", "startImplementation", "startFreshImplementation"].includes(node.expression.text)) {
      assert.ok(ts.isAwaitExpression(node.parent) || ts.isReturnStatement(node.parent) || ts.isArrowFunction(node.parent), `Unobserved Plan transition: ${node.getText(plan)}`);
      transitions++;
    }
    ts.forEachChild(node, checkPlan);
  }
  checkPlan(plan); assert.ok(transitions >= 15);
});

test("delegation consumption reuses the invocation authority without allocating callback state", () => {
  for (const [path, names] of [
    ["packages/coding-agent/src/core/files/extension-permissions.ts", ["assertInvocationAuthority", "consumeSubagentWorkspaceDelegation", "consumeStructuredReadonlyWorkspaceDelegation", "consumeBrowserExecAuthorization", "assertBrowserExecAuthorization"]],
    ["packages/coding-agent/src/core/files/tool-path-authorization.ts", ["consumeToolPath"]],
    ["packages/lsp/src/fix-authorization.ts", ["consumeFixAuthorization", "assertFixAuthorization"]],
  ] as const) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  for (const name of names) {
    const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration;
    assert.ok(fn.body);
    function inspect(node: ts.Node): void {
      assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node), false, node.getText());
      if (ts.isNewExpression(node)) assert.equal(node.expression.getText(), "Error", "only rejection construction is allowed");
      ts.forEachChild(node, inspect);
    }
    inspect(fn.body);
  }
  }
});

test("native file execution reuses invocation callbacks through effect and release boundaries", () => {
  for (const [path, targets] of [
    ["packages/coding-agent/src/core/files/file-service.ts", [["FileExecution", ["run", "record"]], ["FileService", ["assertPrepared", "release", "clear", "dispose", "revalidate"]]]],
    ["packages/coding-agent/src/core/files/file-batch.ts", [["FileBatch", ["assertLive", "release", "dispose"]], ["BatchExecution", ["run", "assertCurrent", "record", "execute"]]]],
    ["packages/coding-agent/src/core/files/session-files.ts", [["NativeFileInvocation", ["assertCurrent", "record", "release", "revoke", "dispose"]], ["SessionFiles", ["assertCurrent", "finish", "ownsDefinition", "hasHandlers", "hasRevision"]]]],
  ] as const) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  for (const [name, methods] of targets) {
    const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name) as ts.ClassDeclaration;
    for (const methodName of methods) {
      const member = owner.members.find(node => node.name?.getText() === methodName)!;
      const body = ts.isMethodDeclaration(member) ? member.body : ts.isPropertyDeclaration(member) && member.initializer && ts.isArrowFunction(member.initializer) ? member.initializer.body : undefined;
      assert.ok(body);
      function inspect(node: ts.Node): void {
        assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText());
        if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController", "Map", "Set", "WeakSet"].includes(node.expression.getText()));
        ts.forEachChild(node, inspect);
      }
      inspect(body);
    }
  }
  }
});

test("native revision lookup and unretained compact lines do not allocate temporary state", () => {
  const revisionPath = "packages/coding-agent/src/core/files/snapshot-line-edit.ts";
  const revisions = ts.createSourceFile(revisionPath, readFileSync(revisionPath, "utf8"), ts.ScriptTarget.Latest, true);
  const owner = revisions.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "FileRevisions") as ts.ClassDeclaration;
  const compactPath = "packages/coding-agent/src/core/files/compact-snapshot-capture.ts";
  const compact = ts.createSourceFile(compactPath, readFileSync(compactPath, "utf8"), ts.ScriptTarget.Latest, true);
  function inspect(node: ts.Node): void {
    assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isArrayLiteralExpression(node)
      || ts.isObjectLiteralExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText());
    if (ts.isNewExpression(node)) assert.equal(node.expression.getText(), "Error", "only failure construction is allowed");
    ts.forEachChild(node, inspect);
  }
  for (const name of ["get", "latest", "invalidatePath", "assertCurrent", "clear", "dispose"]) {
    const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === name) as ts.MethodDeclaration;
    assert.ok(method.body); inspect(method.body);
  }
  let checked = false;
  function find(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText() === "finishLine") {
      const first = ((node.initializer as ts.ArrowFunction).body as ts.Block).statements[0] as ts.IfStatement;
      assert.equal(first.expression.getText(), "!captureCurrentLine"); inspect(first.thenStatement);
      assert.ok(ts.isReturnStatement((first.thenStatement as ts.Block).statements.at(-1)!));
      checked = true;
    }
    if (ts.isCallExpression(node) && node.expression.getText() === "appendLineBytes") {
      const gate = node.parent.parent as ts.IfStatement;
      assert.ok(ts.isIfStatement(gate) && gate.expression.getText().includes("captureCurrentLine"));
    }
    ts.forEachChild(node, find);
  }
  find(compact); assert.ok(checked);
});

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
    { path: "packages/coding-agent/src/core/files/change-preview.ts", owner: "BatchResultText", methods: ["setBatchText", "render", "invalidate", "releasePreview"] },
    { path: "packages/coding-agent/src/core/files/changes.ts", owner: "ChangeViewer", methods: ["render", "nextRow", "previousRow", "handleInput", "invalidate", "dispose"] },
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
      assert.equal(arrays, name === "render" ? 1 : 0, "only the bounded displayed-row array is allowed");
    }
  }
});

test("file-change preparation and recovery avoid captured scan/format callbacks", () => {
  for (const file of ["packages/coding-agent/src/core/files/change-preview.ts", "packages/coding-agent/src/core/files/changes.ts"]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let dialogFactories = 0;
    function inspect(node: ts.Node): void {
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        // Exact cold exemption: one factory passed to the explicit user dialog.
        // It retains the bounded body until the dialog closes, never per frame.
        assert.ok(ts.isFunctionExpression(node) && node.name?.text === "createChangeViewer", `${file}: ${node.getText(source)}`);
        assert.ok(ts.isCallExpression(node.parent) && node.parent.expression.getText(source) === "ctx.ui.custom");
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        assert.ok(owner && ts.isFunctionDeclaration(owner) && owner.name?.text === "showChangeViewer");
        dialogFactories++;
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    assert.equal(dialogFactories, file.endsWith("/changes.ts") ? 1 : 0);
  }
});

test("native worker actions and message dispatch use module functions with explicit inputs", () => {
  for (const file of ["packages/coding-agent/src/core/files/native-file-worker.mjs", "packages/coding-agent/src/core/files/file-commit-metadata.ts", "packages/coding-agent/src/core/files/native-file-client.ts"]) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function inspect(node: ts.Node): void {
    assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node), false, node.getText(source));
    if (ts.isFunctionDeclaration(node)) assert.ok(ts.isSourceFile(node.parent), "no per-operation nested function captures");
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  }
});

test("repeated native permission checks allocate no application wrappers", () => {
  const targets = [
    ["packages/coding-agent/src/core/execution-policy.ts", "SessionExecutionPolicy", ["assertWorkspace"]],
    ["packages/coding-agent/src/core/extensions/runner.ts", "OrdinaryToolEpoch", ["consume", "release"]],
  ] as const;
  for (const [file, className, members] of targets) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className) as ts.ClassDeclaration;
    assert.ok(owner, className);
    function inspect(node: ts.Node): void {
      assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node)
        || ts.isArrayLiteralExpression(node) || ts.isAwaitExpression(node) || ts.isForOfStatement(node), false, node.getText(source));
      if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Error", "only failing branches allocate an Error");
      ts.forEachChild(node, inspect);
    }
    for (const name of members) {
      const member = owner.members.find(node => node.name?.getText(source) === name)!;
      assert.ok(member, name);
      const body = ts.isMethodDeclaration(member) ? member.body : ((member as ts.PropertyDeclaration).initializer as ts.ArrowFunction).body;
      inspect(body!);
    }
    if (className === "SessionExecutionPolicy") {
      const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "insideCanonical") as ts.FunctionDeclaration;
      inspect(helper.body!);
    }
  }
});
