# MCP interactive manager (F02.2)

## Design gate

Baseline: 0486f3b04c34532f106f97f2e99812be2ec5d24a (PR #115 merged).
The registered commands expose separate status/tools/auth/reload operations but
no interactive manager. The baseline probe confirms that `/mcp` is absent.

Add `/mcp` as an explicit-command facade over existing capabilities: bounded
server selection with connection state/source/transport/tool counts, refreshed
snapshots, per-server tool inspection, OAuth sign-in/sign-out, and resource
reload. Configuration editing, persistent enable/disable and CIMD remain separate;
this goal does not change trust, configuration, tool activation or reconnect rules.
Use the existing cancellable `ui.select` and bounded details viewport, with no
custom renderer, polling, event subscriptions or recurring status timer.

Manager menu ownership is one controller and one promise per extension instance.
Duplicate opening is rejected. Startup/shutdown abort and await the menu; its
owner is cleared before dispatching auth/reload to avoid self-wait during reload.
Auth remains on the existing generation/controller/operation boundary shared with
standalone commands. Its progress dialog belongs to that operation; Cancel/escape
aborts auth, waits for cleanup, and suppresses late completion notifications and
reload. The authorization URL replaces the progress details, dismissing the old
selector before opening the next. Completion closes the selector before reload.
All async continuation points recheck cancellation or generation; failed dialogs
abort and drain owned operations. No automatic login or remote tool execution.

Audited chain: command dispatch → manager selectors → existing ExtensionSelector
and its abort/dispose handlers → auth ownership → McpOAuth login/logout → callback,
fetch and storage cleanup → command reload → session shutdown/start. Menu refresh
reads already-owned runtime state without network requests. At most 16 server
rows and 128 sanitized names for one server are materialized per explicit choice.
Progress owns one active selector, one view controller and one auth operation;
only the initial state and authorization URL cause replacement. Each reference
is local or extension-owned and released after completion/failure/abort/shutdown.
Existing selector rendering and terminal paths are unchanged. New allocations
are confined to named command/start/stop boundaries; no new hot-path allocation,
pool, persistent cache or worker. Run relevant source invariants, lifecycle and
focused real bridge/OAuth checks; no unrelated allocation benchmark or full local
suite. Prove one-live-operation and cleanup counters, not timing thresholds.

## Verification

Windows x64 / Node v26.4.0; local evidence:
`.git/f02-2-mcp-manager-20261011/`. Final local validation covered 22 distinct
behavior/lifecycle checks plus 4 source invariants; `npm run check` passed. An
initial test-fixture excess-property type error was corrected before the final
type check. New manager cases cover menu ownership/reopen, invalid configuration
reload, noninteractive/noMcp gates, auth cancellation and shutdown, failure/retry,
real logout, real callback/reservation cleanup, and real background discovery.
Existing auth and selector checks were selected by the changed call chain.

```powershell
node --experimental-strip-types --test --test-name-pattern 'MCP manager' tests/mcp-auth-lifecycle.test.ts tests/mcp-background-activation.test.ts
node --experimental-strip-types --test --test-name-pattern 'MCP manager URL progress|MCP shutdown|MCP replacement|MCP successful|real AgentSession reload|MCP auth releases owner' tests/mcp-auth-lifecycle.test.ts
node --experimental-strip-types --test --test-name-pattern 'MCP manager URL progress' tests/mcp-auth-lifecycle.test.ts
node --experimental-strip-types --test --test-name-pattern 'MCP manager recovers|real interactive selection isolates|details cache survives navigation' tests/mcp-auth-lifecycle.test.ts tests/permission-interaction.test.ts
node --experimental-strip-types --test tests/source-invariants.test.ts
npm run check
```

The focused re-run verified newly added late-URL/shutdown assertions; overlapping
cases are counted once. No full local suite or unrelated allocation benchmark.
Commands reproduced after all test additions may match more cases than the
historical per-command logs; the final distinct total is 22.

Deterministic evidence:

- Manager progress has maximum 1 live selector, exactly 2 views for initial/URL
  state, 0 selectors after completion/cancel, 1 closed OAuth owner, and 0 late
  notifications/reloads. Shutdown waits for gated auth cleanup. Duplicate menu
  opening creates no second selector; reopening succeeds after cleanup.
- Real MCP discovery has initialize/list/call counts 1/1/0, with 0 activated tools
  and unchanged configuration bytes after inspection and refresh.
- Real OAuth cancellation closes the callback listener and clears its stored
  login reservation. Real logout writes only the fixture credential store and
  invokes reload after the selector closes. Existing real AgentSession reload
  and file-lock cleanup checks also pass.
- The existing auth GC regression passes with the extension still reachable:
  9 owner/signal/context WeakRefs, 0 retained after controlled task-boundary GC.
  This is the shared auth owner check, not a new rendering allocation measurement.
- The reused actual interactive selector passes cancellation/late-click/dispose
  and details-cache release checks. No renderer or terminal hot path was edited.

All fixture after/finally hooks close owned hosts/connections/auth work, remove
their exact temporary directories and restore environment/entrypoint values.
No external MCP provider/browser authorization or manual terminal session is
claimed. Standard Linux/Windows CI and Codex review follow on the final PR head.
