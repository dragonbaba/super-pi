# @super-pi/tool-classification

Keeps Pi's initial model-visible tool surface small and deterministic, then activates conditional tools additively through `tool_search`.

An exact tool name (case-insensitive, with surrounding whitespace ignored) ranks
ahead of incidental description keywords. Normal activity and permission filters
still apply. Browser tools are selected by task and target profile, with a narrow
pause after an incomplete Browser Harness approval.

## Classes

- Core: `read`, `bash`, `edit`, `write`, `structured_readonly_command`, `lsp_diagnostics`, `lsp_fix`, `lsp_navigate`, `tool_search`.
- Browser: `browser` discovers `browser_exec` for public-web reading and interaction in the user's browser.
- Browser debugging: `browser_debug`, `cdp`, local-preview queries, DOM/JavaScript inspection, UI validation and exact `chrome_devtools_*` names discover DevTools for those tasks. The model can activate these tools without a manual enable command. A missing endpoint may launch an isolated profile; choose the correct target and do not assume the user's login is present.
- Delegation: `subagent`.
- Memory/session: `memory`, `memory_search`, `session_search`.
- Skill management: `skill_manage`.
- Graph: `codegraph`.
- MCP: `mcp_search_tools`.
- Other registered tools remain searchable by name and description, except policy-owned Goal, Plan-mode, and `inspect_image` tools. English and Chinese category aliases are supported.

The session-start reset occurs before the first provider request. Later activation is additive. Claude 4.5+ and OpenAI 5.4+ can use Pi's native deferred-tool protocol; other providers receive one deliberate tool-surface cache reset when a conditional tool is first activated.

Known conditional providers omit `promptSnippet` and `promptGuidelines`; their complete operating contracts stay in tool descriptions/schemas. Therefore additive activation does not rebuild the system prompt. The pinned Chrome DevTools npm package is patched in place and must be re-audited after package reinstall/update.

Generic browsing searches do not activate DevTools. An actual Browser Harness
permission-required result (or a timeout after a reported approval prompt) pauses
automatic CDP discovery and calls, including already active tools, until new user
input or a successful explicit `/chrome-devtools enable`/tool selection in that
session. Selection must add an active tool; an explicit enable command/button can
resume even when tools were already active. Partial or complete deselection,
unchanged selections, canceled/failed selections and another session's selection
do not clear it. Extension-generated continuations do not clear this pause. New user input
allows task selection again; it does not approve Chrome or authorize bypassing a
still-pending prompt. The model must follow that input and the tools' instructions.
Other browser failures do not disable CDP. The pause owns one boolean, a session ID and stable
callbacks; it retains no tool result, browser reference, timer or listener per call.
Session replacement, branch switching and shutdown clear it; shutdown also releases
the one user-selection event subscription. Existing explicit
tool allowlists and Plan-mode restrictions still govern every activation.

A resumed restrictive Plan-mode tool set is preserved exactly. Active Goal tools and the model-driven `inspect_image` fallback are retained alongside the core pack instead of being erased by the final session-start reset.

Use `/tool-classes` to inspect the current active split. Run `npm run smoke:rpc -- <trusted-workspace>` for a real offline activation/prompt-stability audit. Restart Pi after installation or settings changes.
