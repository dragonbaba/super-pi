# Tool selection expressions (F01.1)

## Design gate

Baseline: `92cbab2d3480c6636d02157cf4d527d9cc75584b`. F01 was selected by the
user after T01–T10. This PR covers selection expressions; `--no-mcp` is F01.2.

Existing CLI lists are exact names, so globs and signed names match no tools.
The SDK's `tools` and `excludeTools` remain exact-name policy boundaries. A
separate optional `toolSelection` input carries expression lists from the CLI.
When combined with SDK exact lists, expressions cannot widen those lists.

Rules: whole-name, case-sensitive `*` (zero or more characters) and `?` (one
character); other characters are literal. Bare positive terms select a strict
base; positive `+` terms add to it. Only signed terms retain current defaults.
An explicitly empty tools list selects nothing. Minus terms and exclude-tools
patterns always win, independent of ordering. No matches means no additions,
without falling back to all tools; later registrations are matched afresh.
No startup warning is emitted for an unmatched name that may arrive later.
The required Codemode transport cannot be excluded, including by a pattern;
use no-tools to start empty. A wildcard must not override an unavailable
PowerShell status; only an exact positive `powershell` enables another attempt.

The expression owner is created once during session startup. At most 256 terms,
1,024 characters per term and 16,384 characters total are accepted. The matching
loop uses primitive offsets, no RegExp or per-match arrays/closures. Input lists
are copied into bounded owner arrays; no names/results cache or pool is added.
Dispose releases the session's owner. Tool selection is evaluated at startup,
explicit activation and registry refresh, never per provider delta or tool
progress update. Dynamic registration and reload retain the same policy.

Audited chain: CLI parse/options → session services → SDK/default and PowerShell
selection → AgentSession registry refresh → extension/custom/built-in registry
filter → active tools → Codemode child descriptors/model tools/system prompt →
ordinary execution and existing permission checks → refresh/reload/dispose.
Normal calls continue to use the filtered registry, without re-matching every
call or changing authorization. Registry refresh already builds maps, wrapper
arrays, prompt metadata and bounded tool catalogs; the new work matches names
and retains only the startup rule owner, not a second tool catalog.

## Usage

Quote expression arguments to prevent shell expansion:

```sh
superpi --tools 'read,grep,mcp__docs__*' --exclude-tools '*__delete*'
superpi --tools '+grep,-bash,-powershell'
superpi --no-tools --tools '+read'
```

Selection applies to built-in, custom and extension registrations, including
late MCP catalogs. It does not disable MCP connections; F01.2 owns that switch.
SDK callers opt in with `toolSelection: { tools: ["rea*", "+grep"] }`.
The existing SDK `tools: ["read"]` and `excludeTools` still use literal names.

## Verification

Eight targeted behavior checks cover glob/literal syntax, signed defaults,
deny precedence, empty matches, bounded inputs, the unchanged SDK allowlist,
real Codemode calls to dynamically registered MCP tools, reload, PowerShell
availability and built offline CLI forwarding through session services.
Twelve Codemode/global source invariants, type check and coding-agent build pass.
The matching methods are included in the existing allocation AST gate; only
the bounded startup constructor is exempt. No full local suite was repeated.

The on-demand `scripts/bench/tool-selection.ts` samples 2,560,000 production
policy checks (1,280,000 accepted), then builds a real SDK catalog of 256 custom
tools: 128 active children plus Codemode, zero workers started. The selector
owner is collected after disposal with the session still alive, after four
controlled-GC task boundaries. Initial iterator-based sampling varied from zero
to 1,130,792 bytes; the captured site report attributed 998,488 bytes to `adds`
and 14,944 to `excludes`. Index loops remove those iterator sites and the strict
path avoids a duplicate exclusion scan. The final sample reports 25,856 bytes
in `allows` across 2,560,000 checks. These are JIT/sampling-dependent observations,
not a zero-allocation or stable throughput claim. The source gate rules out new
explicit object/array/closure/Promise factories in matching. No pool or cache was
added. Registry construction retains its existing maps, wrappers and descriptors;
no selector work was added to streaming, progress, rendering or normal tool calls.

Environment: Windows, Node 26.4.0, same fixture and host. Raw local evidence is in
`.git/f01-1-tool-selection-20261011/`. CI supplies Linux and Node 22 coverage;
local validation does not claim a real remote MCP server or interactive terminal.
