# @super-pi/tool-classification

Keeps Pi's initial model-visible tool surface small and deterministic, then activates conditional tools additively through `tool_search`.

## Classes

- Core: `read`, `bash`, `edit`, `write`, `structured_readonly_command`, `lsp_diagnostics`, `lsp_fix`, `lsp_navigate`, `tool_search`.
- Browser: `browser_exec`, `chrome_devtools_*`.
- Delegation: `subagent`.
- Memory/session: `memory`, `memory_search`, `session_search`.
- Skill management: `skill_manage`.
- Graph: `codegraph`.
- MCP: `mcp_search_tools`.
- Other registered tools remain searchable by name and description, except policy-owned Goal, Plan-mode, and `inspect_image` tools. English and Chinese category aliases are supported.

The session-start reset occurs before the first provider request. Later activation is additive. Claude 4.5+ and OpenAI 5.4+ can use Pi's native deferred-tool protocol; other providers receive one deliberate tool-surface cache reset when a conditional tool is first activated.

Known conditional providers omit `promptSnippet` and `promptGuidelines`; their complete operating contracts stay in tool descriptions/schemas. Therefore additive activation does not rebuild the system prompt. The pinned Chrome DevTools npm package is patched in place and must be re-audited after package reinstall/update.

A resumed restrictive Plan-mode tool set is preserved exactly. Active Goal tools and the model-driven `inspect_image` fallback are retained alongside the core pack instead of being erased by the final session-start reset.

Use `/tool-classes` to inspect the current active split. Run `npm run smoke:rpc -- <trusted-workspace>` for a real offline activation/prompt-stability audit. Restart Pi after installation or settings changes.
