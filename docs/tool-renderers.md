# Independent tool renderers

`pi.registerToolRenderer((toolName, next) => renderers)` chooses how a tool row
looks, including historical tools whose extension or MCP server is unavailable.
It does not add tools to the execution registry, activate tools, expose tools to
the model, bypass tool selection, or enable MCP.

```ts
import type { ExtensionAPI, ToolRenderers } from "@super-pi/coding-agent";
import { Text } from "@super-pi/tui";

export default function (pi: ExtensionAPI) {
  const fallback: ToolRenderers = {
    renderCallStability: "args-only",
    renderCall(_args, _theme, context) {
      return context.lastComponent ?? new Text("Archived MCP call", 0, 0);
    },
    renderResult(result, _options, _theme, context) {
      const text = context.lastComponent as Text | undefined ?? new Text("", 0, 0);
      text.setText(result.content.filter(part => part.type === "text")
        .map(part => part.text).join("\n"));
      return text;
    },
  };
  pi.registerToolRenderer((toolName, next) =>
    next() ?? (toolName.startsWith("mcp__") ? fallback : undefined));
}
```

Resolvers run in extension load order, then registration order within each
extension. `next()` returns the remaining resolvers' choice, falling back to the
registered tool definition. `next() ?? fallback` fills a missing tool; returning
your renderer before calling `next()` overrides the existing choice. Returned
objects are used as supplied; spread `next()` explicitly if you want to inherit
its rendering fields. Existing built-in per-slot fallbacks still apply.

The public `ToolRenderers` type includes `renderCall`, `renderResult`,
`renderShell`, `renderCallStability` and `collapseCallOnResult`. Call/result
contexts, shared row state and `lastComponent` have the same behavior as on
`registerTool`. Call rendering is dynamic unless marked `args-only`; only opt
in when execution state, result changes and presentation settings cannot change
the call component. Reuse components and avoid repeating expensive work on
progress updates.

Resolvers must be synchronous. Call `next` only during the current resolver
invocation; do not save it for later. Nested resolution and repeated `next()`
calls are supported. A throwing or invalid async resolver emits an extension
error and falls back to the registered tool. An extension can register up to 64
resolvers; recursive resolution is bounded to 128 frames. Registration after a
failed load or invalidated session is rejected.

Resolution occurs when a tool row is created or history/export is rebuilt, not
on each progress update or frame. Existing rows keep their selected renderer;
new registrations apply to subsequent rows and rebuilds. An explicit `read`
override uses an individual tool row instead of the compact read group. A
Codemode override replaces its specialized tree; otherwise nested calls retain
the existing compact tree presentation.

`session.getToolRenderers(name)` is the presentation lookup.
`session.getToolDefinition(name)` retains its execution-registry semantics.
HTML exports use the same resolver chain; the legacy `getToolDefinition` option
on `createToolHtmlRenderer` remains supported. Explicit overrides also supersede
the built-in bash/read/write/edit/ls HTML templates; without an override those
tools keep their existing templates. Call-only and result-only overrides work.
Each exported tool-call ID selects its renderer once; override detection, call
and result rendering share that selection, including an undefined selection.
