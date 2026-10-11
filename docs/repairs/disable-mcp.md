# Disable MCP for a session (F01.2)

## Design gate

Baseline: `92cbab2d3480c6636d02157cf4d527d9cc75584b`. User selected F01.
This change covers `--no-mcp`; selection expressions are F01.1 / PR #113.
The PR is stacked on F01.1 to resolve shared SDK/CLI additions before delivery;
its review diff contains only the MCP switch. Merge #113 before this PR.

Hiding MCP tool names currently leaves session_start configuration loading,
cache migration, connection/discovery and history activation running. A session
boolean must reach the bridge before any of those operations. CLI `--no-mcp`
and SDK `noMcp: true` apply for the session lifetime, including reload, resume
and tree navigation. It is not a persisted setting; a new enabled session can
use the existing configuration and credentials.

Audited chain: CLI args → session services → SDK → AgentSession → extension
runner session_start event → MCP lifecycle/cache/config/activation key →
runtime connections/discovery → registry → search/history activation → shutdown.
The host removes definitions tagged `requiresMcp`, including the bridge search
and remote tools, before registry construction. This uses explicit tool metadata,
not a name prefix. Other extensions can honor the same startup flag and tag.
Arbitrary third-party code that ignores the flag is not sandboxed by this switch.

The session and bridge each retain one primitive. Only the startup/reload event
carries that primitive; recurring context/event creation is unchanged. Registry
filtering only adds a scalar predicate at startup/refresh. The disabled bridge
shuts down an existing lifecycle before
returning, without creating a runtime, reading cache/config/history, connecting,
launching auth, or modifying persistent MCP state. There is no new collection,
cache, pool, listener, timer or resource owner. Existing lifecycle cancellation
and runtime close remain the only shutdown owners.

## Verification

Five focused behavior checks pass: CLI parsing/terminator; real SDK registry,
cached activation history and reload; invalid config/cache left unread and
unchanged; existing enabled same-script Codemode discovery/call and persisted
reopen; and a built offline CLI with a configured stdio server. The disabled
SDK phase adds zero HTTP initialize/list/call requests after one enabled warmup;
CLI starts zero fixture subprocesses and creates no MCP key/schema cache, even
with `read,+mcp*`; SDK `*` cannot override the lifecycle switch either. Tagged
tools with ordinary names are denied even by explicit activation; an ordinary
tool named `mcp__local__helper` remains available. A new enabled session restores
the prior history without reconnecting the cached server. Config/cache/key bytes
and activation entries remain unchanged across disabled startup and reload.

Twelve existing Codemode/global source invariants, type check and coding-agent
build pass. Local verification: Windows/Node 26.4.0; CI supplies Linux/Node 22.
Fixtures close sessions, HTTP connections/listener and exact temporary roots.
No new reference owner or high-frequency path was introduced, so no unrelated
allocation benchmark, GC soak or full local suite was run. Startup adds one
bounded event copy for caller isolation and primitive policy fields; reload adds
one primitive to its existing event. This is not a zero-allocation claim for
the unchanged extension lifecycle implementation.

Raw evidence: `.git/f01-2-disable-mcp-20261011/`. No real external server,
OAuth login or interactive-terminal acceptance is claimed.
