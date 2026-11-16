# @super-pi/tool-classification

Keeps Pi's initial model-visible tool surface small and deterministic, then activates conditional tools additively through `tool_search`.

An exact tool name (case-insensitive, with surrounding whitespace ignored) ranks
ahead of incidental description keywords. Normal activity and permission filters
still apply. Browser tools are selected by task and target profile, with a narrow
pause after an incomplete Browser Harness approval.

A leading category alias followed by whitespace or `:` scopes a longer query to
that category: `memory action add` searches memory tools. If all matching tools
are already active, the result is empty; generic verbs do not activate another
category as a fallback. Browser-debugging phrases retain precedence over a
shorter browser prefix, so `browser DOM inspection` selects DevTools.

## Classes

- Core: `read`, `bash`, `edit`, `write`, `structured_readonly_command`, `lsp_diagnostics`, `lsp_fix`, `lsp_navigate`, `tool_search`.
- Browser: `browser` discovers `browser_exec` for public-web reading and interaction in the user's browser.
- Browser debugging: `browser_debug`, `cdp`, local-preview queries, DOM/JavaScript inspection, UI validation and exact `chrome_devtools_*` names discover DevTools for those tasks. The model can activate these tools without a manual enable command. A missing endpoint may launch an isolated profile; choose the correct target and do not assume the user's login is present.
- Delegation: `subagent`.
- Memory/session: `memory`, `memory_search`, `session_search`.
- Skill management: `skill_manage`.
- MCP: `mcp_search_tools`.
- Other registered tools remain searchable by name and description, except policy-owned Goal, Plan-mode, and `inspect_image` tools. English and Chinese category aliases are supported.

Search activates inactive tools and reports an exact active-name match without
activating unrelated description matches. Exhausted categories report active
names too. Results include `alreadyActive` alongside `added` and `rejected`;
read the current full contract with `describeTools([name])` before unfamiliar use,
then use the exact accepted name with `callTool(name, args)` in the same script.
Search does not execute tools or grant authorization. An empty result does not establish that a tool
is missing: `subagent` may already be exposed directly to the model. Call that
top-level tool using its schema; CodeMode deliberately excludes orchestration
tools and now identifies them as `TOOL_DIRECT_ONLY` when documentation is requested.
Do not replace this route with an external agent CLI merely because it is absent
from CodeMode's `ALL_TOOLS`.

The session-start reset occurs before the first provider request. Later activation is additive. CodeMode's provider entry definition stays fixed across local/MCP tool activation, ordering and schema refresh. Current contracts are read on demand. Top-level controls and authoritative prompt guidelines still affect the actual request; a fixed entry does not guarantee provider cache hits.

Known conditional providers omit `promptSnippet` and `promptGuidelines`; their complete operating contracts stay in tool descriptions/schemas. Keep those instructions available through paged `describeTools`, rather than rebuilding the entry definition. The pinned Chrome DevTools npm package is patched in place and must be re-audited after package reinstall/update.

Generic browsing searches do not activate DevTools. An actual Browser Harness
permission-required result (or a timeout after a reported approval prompt) pauses
automatic Browser Harness retries and CDP discovery/calls, including already active tools, until new user
input or a successful explicit `/chrome-devtools enable`/tool selection in that
session. Selection must add an active tool; an explicit enable command/button can
resume even when tools were already active. Partial or complete deselection,
unchanged selections, canceled/failed selections and another session's selection
do not clear it. A selection submitted before a later approval failure cannot
clear that newer pause when its settings save finishes. Extension-generated
continuations do not clear this pause. New user input
allows task selection again; it does not approve Chrome or authorize bypassing a
still-pending prompt. The model must follow that input and the tools' instructions.
Other browser failures do not disable CDP. The pause owns a boolean, a generation counter, a session ID and stable
callbacks; it retains no tool result, browser reference, timer or listener per call.
Session replacement, branch switching and shutdown clear it; shutdown also releases
the one user-selection event subscription. Existing explicit
tool allowlists and Plan-mode restrictions still govern every activation.

A resumed restrictive Plan-mode tool set is preserved exactly. Active Goal tools and the model-driven `inspect_image` fallback are retained alongside the core pack instead of being erased by the final session-start reset.

Use `/tool-classes` to inspect the current active split. From the monorepo root,
run the maintained offline activation and search regressions:

```bash
node --experimental-strip-types --test tests/mcp-background-activation.test.ts tests/tool-search-hot-paths.test.ts
```

The former package-local RPC smoke command is not provided by this checkout.
These regressions do not substitute for a real RPC session audit. Restart Pi after
installation or settings changes.
