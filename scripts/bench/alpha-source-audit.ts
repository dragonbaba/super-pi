import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Source inventory, not an inferred dynamic allocation count. In particular,
// branches and helper invocation counts must be paired with fixture counters.
const files = [
  'packages/agent/src/agent-loop.ts',
  'packages/coding-agent/src/core/agent-session.ts',
  'packages/coding-agent/src/core/agent-session-runtime.ts',
  'packages/coding-agent/src/core/tool-result-presentation.ts',
  'packages/coding-agent/src/core/footer-data-provider.ts',
  'packages/coding-agent/src/modes/interactive/interactive-mode.ts',
  'packages/coding-agent/src/modes/interactive/components/assistant-message.ts',
  'packages/coding-agent/src/modes/interactive/components/footer.ts',
  'packages/coding-agent/src/modes/interactive/components/tool-execution.ts',
  'packages/tui/src/components/markdown.ts',
  'packages/tui/src/components/retained-item.ts',
  'packages/tui/src/tui.ts',
  'packages/tui/src/tui-main-screen.ts',
  'packages/tui/src/tui-alt-screen.ts',
  'packages/tui/src/render-instrumentation.ts',
  'packages/tui/src/terminal-frame-queue.ts',
  'packages/tui/src/terminal.ts',
];
const output: unknown[] = [];
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function inspect(node: ts.Node): void {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) {
      const counts: Record<string, number> = {};
      const sites: { category: string; line: number }[] = [];
      const calls = new Set<string>();
      function add(category: string, at: ts.Node) {
        counts[category] = (counts[category] ?? 0) + 1;
        sites.push({ category, line: source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1 });
      }
      function visit(child: ts.Node): void {
        if (ts.isArrowFunction(child)) add('ArrowFunction', child);
        if (ts.isFunctionExpression(child)) add('FunctionExpression', child);
        if (ts.isObjectLiteralExpression(child)) add('objectLiteral', child);
        if (ts.isArrayLiteralExpression(child)) add('arrayLiteral', child);
        if (ts.isSpreadAssignment(child)) add('objectSpread', child);
        if (ts.isSpreadElement(child)) add(ts.isArrayLiteralExpression(child.parent) ? 'arraySpread' : 'argumentSpread', child);
        if (ts.isNewExpression(child)) {
          const name = child.expression.getText(source);
          add(`new:${name}`, child);
          if (name === 'Promise' && child.arguments?.some(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) add('PromiseExecutor', child);
        }
        if (ts.isCallExpression(child)) {
          const expression = child.expression.getText(source);
          calls.add(expression);
          const method = ts.isPropertyAccessExpression(child.expression) ? child.expression.name.text : expression;
          if (['then', 'catch', 'finally', 'bind', 'map', 'filter', 'flatMap', 'slice', 'substring', 'substr', 'trim', 'trimEnd', 'trimStart', 'join', 'repeat', 'concat'].includes(method)) add(`call:${method}`, child);
          if (['JSON.stringify', 'Object.assign', 'Buffer.from', 'setTimeout', 'setInterval', 'queueMicrotask', 'process.nextTick'].includes(expression)) add(`call:${expression}`, child);
          if (['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'queueMicrotask', 'process.nextTick'].includes(method) && child.arguments.some(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) add('inlineScheduledCallback', child);
        }
        ts.forEachChild(child, visit);
      }
      visit(node.body);
      const name = ts.isArrowFunction(node)
        ? (ts.isPropertyDeclaration(node.parent) || ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : '<arrow>')
        : node.name?.getText(source) ?? '<anonymous>';
      output.push({ file, function: name,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        async: node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
        counts, sites, calls: [...calls].sort() });
      return;
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}
console.log(JSON.stringify({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  contract: 'Static syntactic sites per function, including nested callback bodies. Not dynamic allocations/update. String operations are candidates, not proof of full-size copying. Reference lifetimes and cross-await captures require manual ownership audit. Unresolved virtual/helper calls remain explicit in calls.',
  functions: output,
}));
