# @super-pi/lsp

Update-safe local compatibility fork of [`@narumitw/pi-lsp@0.49.3`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-lsp). It preserves configurable diagnostics and source fixes while adding bounded symbol navigation and session-local LSP client reuse.

## Why this fork

- Keep one navigation surface: `lsp_navigate` with `definition`, `references`, `implementation`, and `workspace_symbols` actions.
- Start servers lazily and permit only one live server per canonical workspace root. Concurrent calls may reuse the same server, but a different server is rejected while any lease is active and may replace it only after all leases are released. Pool identity includes command, environment, and initialization settings so configuration changes restart stale clients.
- Retire unleased clients after 10 minutes; active leases cannot be reaped by the idle timer. Close initialized and still-initializing owned clients on `session_shutdown`.
- Coalesce concurrent starts; cap failed-start backoff at 64 entries, published diagnostics at 256 documents, JSON-RPC messages at 8 MiB, source documents at 4 MiB, each diagnostics request at 200 paths/files, and recursive discovery at 100,000 paths/10,000 directories.
- Permit at most one diagnostics server per tool call; automatic ambiguity fails before client acquisition and requires narrower paths or one explicit server. File-document URI keys are canonicalized so Windows drive casing and `%3A` encoding variants cannot detach published diagnostics from their waiters.
- Keep the local change update-safe instead of modifying the npm package in place.

The pool and bounded action design follows patterns independently verified in Oh My Pi and Hermes Agent. The implementation remains based on the upstream MIT-licensed package; see [`LICENSE`](./LICENSE).

## Tools

The source `superpi` launcher selects this package's `src/index.ts` manifest entry by default. A plain SDK application must select the package or entry explicitly. Loading registers the three tools and one session execution owner; it does not start a language server. Session reload via `session.reload()` drains the old owner before publishing its replacement.

There is no dedicated `--no-lsp` switch. `--no-extensions` suppresses automatic extension sources while preserving explicit `--extension` entries. A package setting with `extensions: []` disables only that package source; it cannot cancel an explicit entry, including one supplied by the source launcher. Select one manifest entry per package: loading `src/pi-lsp.ts` as well selects a different file and is not path deduplication. `--no-mcp` does not disable LSP.

- `lsp_diagnostics`: targeted diagnostics for configured file routes.
- `lsp_fix`: preview or apply configured source code actions.
- `lsp_navigate`: symbol navigation through a reusable client.

`lsp_navigate` parameters:

- `action`: `definition`, `references`, `implementation`, or `workspace_symbols`.
- `path`: anchor file used to select the configured server.
- `root?`: workspace root; defaults to the current workspace.
- `line?` and `symbol?`: required for position actions. Lines are 1-indexed; use `name#N` only for repeated occurrences on that line. If the exact line is stale, one unique match within ±5 lines is adjusted and disclosed; ambiguous or distant matches return bounded candidate lines instead of guessing.
- `query?`: required for `workspace_symbols`.
- `includeDeclaration?`: defaults to `true` for references.
- `maxResults?`: defaults to 50 and is capped at 200.
- `server?`: one explicit configured server override.

Navigation output is normalized to project-relative `path:line:column` locations where possible and reports whether the call used a cold or warm client. Invalid query/line/symbol input is rejected before any LSP process starts; position anchors larger than 2 MiB are rejected. Immutable empty LSP results share one frozen readonly sentinel, and per-document published diagnostics are evicted on `didClose`.

Cold navigation waits for recognized project initialization progress and refreshes the read-only query after loading. The readiness deadline is bounded by the call timeout and at most 10 seconds; it is event driven, with no fixed sleep. `projectReady`, `projectReadiness` and `potentiallyIncomplete` describe the observed state separately from result truncation. If loading never finishes, or the server has no recognized readiness signal, output explicitly says that the project may still be loading and results may be incomplete. Currently the recognized signal is typescript-language-server's JS/TS initialization progress; unrelated work-done progress, such as document formatting, does not establish readiness. Progress metadata is client owned, bounded, and released on completion/failure/shutdown; capacity overflow remains unconfirmed.

This repository's LSP tsconfig resolves the internal file modules and Windows job types to their actual `.ts` sources for navigation. Runtime package exports continue to use built output. The public coding-agent package mapping retains its existing declaration boundary.

## Configuration

Configuration remains compatible with upstream and is resolved in this order:

1. `<workspace>/.sp/config/pi-lsp.json` for a trusted project
2. `~/.sp/agent/config/pi-lsp.json`
3. upstream built-in server defaults

A server entry contains `command`, `extensions`, and optional `env`, `initialization`, `skipDirectories`, and diagnostics grace settings. Global `timeout` defaults to 20 seconds.

`/lsp` reports configured commands and availability. `lsp_diagnostics` accepts only one `server` string and starts at most one server per call. If requested paths match multiple routes, split the request or choose one server explicitly. LSP results are targeted development feedback; repository-native typechecks, builds, and tests remain authoritative.

Command availability is not proof of service startup or language coverage. Diagnostics
default to the session workspace, report the number of submitted files and the file
limit, and label zero submitted files `not_checked`. A missing route, unavailable
service, missing pull report, or push server that publishes nothing does not establish
a validation pass. For `lsp_diagnostics`, `pushDiagnosticsGraceMs` bounds the wait
for a publication; silence returns an unconfirmed-diagnostics error. An actual empty
report is still valid diagnostic feedback. Validation requests do not send a previous
result ID, so their pull responses must contain a full `items` report. Source fixes
retain the previous bounded empty diagnostic context for code actions on silent-clean
servers; computing a code action does not establish a validation pass.

Diagnostics calls sharing a client take turns. Each call uses a sliding window:
it opens at most 16 documents and replaces a completed document immediately,
keeping the same server bound across
overlapping diagnostics calls. The 200-file collection limit remains the total requested
scope, independent of this batch size. A missing report, cancellation, or server
exit makes the call unsuccessful; completed reports remain available for inspection.
Cold projects may need a longer configured diagnostics grace window. Batching
limits simultaneous open documents; it does not guarantee a bound on the server's
retained project memory.

`lsp_diagnostics` accepts optional `waitMs` (integer milliseconds, 1–120,000).
For push servers it overrides the configured `pushDiagnosticsGraceMs`; without
either setting, the global request timeout bounds the first report. Pull requests
keep their global timeout unless `waitMs` is supplied. The effective wait never
exceeds global `timeout`, including when reusing a client created with an older
timeout. Global `timeout` defaults to 20 seconds: set a larger `timeout` in
`pi-lsp.json` before requesting `waitMs` above 20,000. Supplying `waitMs` makes
clean push-diagnostic files wait the full observation window, even if an empty
report arrives immediately. Authoritative pull reports and non-empty push reports
retain their existing completion behavior. Existing post-pull grace and non-empty
push quiet periods remain bounded by the remaining request time.

The result includes `elapsedMs`, `batchCount`, `batches` (file count, elapsed time,
project readiness), `effectiveWaitMs`, `scheduling`, `peakOpenDocuments`, and
per-file `outcomes`. With sliding scheduling, batches are logical groups of up to
16 inputs in collection order. Their `startedMs` and elapsed spans may overlap;
they are observation groups, not barriers. Each outcome reports
`status`, `receivedReport`, `completion` (`report`, `window_expired`, or
`server_error`, or `read_error`), `elapsedMs`, `projectReady` when its report
arrived, and `projectReadyAtCompletion`/`projectReadyForMs` at completion (the
deadline for `window_expired`). Confirmed
diagnostics stay in `files`; `unconfirmedFiles` lists every path that still needs
checking, including a suffix not opened after server exit. Missing reports return
`partial` with `isError: true`; an individual read failure also returns `partial`
and its error while the remaining files continue. Server exit returns `failed`. Retry only those
paths explicitly; the tool never retries internally. Cancelling a queued call
removes only its admission entry and releases its lease, preserving the server
and the active call. Active cancellation retains its existing client-discard
behavior.

Project readiness from the navigation client is context, not proof that push
diagnostics are final. Real TypeScript traces showed empty reports after readiness
followed by diagnostics more than 800 ms later. This version therefore keeps the
observation window for empty push reports; it does not claim that project readiness
removes repeated windows or makes cold startup a one-time wait. Sliding scheduling
is selected from an equivalent 88-file measurement. At expiry an empty report is
accepted if the project was ready when that report arrived, or is currently ready
and has stayed ready for the shared 4,000 ms margin. A new loading cycle resets
that age while retaining a ready report's confirmation at expiry. The margin exceeds the observed 1.4–3.3 second late-update
gaps; it is a bounded observation policy, not a finality guarantee. Only when both
conditions fail does the empty report remain unconfirmed. Calls without report
observations retain their existing current-readiness check. Servers without a readiness signal retain the
existing window behavior. Receiving a report is targeted feedback, not a promise
that the server will never publish a later update. See the
[timing and signal evidence](../../docs/evidence/post-review-lsp-diagnostics-2026-11-14.md)
for the proposed `geterr/requestCompleted` completion barrier.

Explicit relative roots are resolved from the session workspace; trimmed-empty roots
use that workspace as well. Nonblank roots preserve their original whitespace.
Mixed requests return `partial` with `isError: true` and
the matching skipped `uncoveredFiles` when an unavailable default server leaves scope
uncovered. Missing defaults for unrelated file types do not mark a request partial.
If a skipped route stops with unvisited scope, `skippedScopeLimited` preserves the
uncertainty even when every collected file overlaps a live route. Available routes
with unvisited scope set `routedScopeLimited` and also return `partial`; reaching the
cap exactly after exhausting the requested scope remains complete. These states do
not invent an overflow count or perform an additional directory scan. An initial
empty push publication stays provisional during its configured grace window so a
later non-empty publication can still supply the result.

Prefer existing project checks and an already known applicable LSP route. Use focused
checks only to fill specific gaps, such as self-contained assets or reference
consistency. State actual match/file counts and untested scope; zero script matches
cannot validate JavaScript. A registered HTML route does not prove embedded JavaScript
coverage, and finite regex checks cannot establish complete HTML/JS or browser behavior.
No service is automatically installed or started after each write.

## Verification

```bash
npm test
npm run typecheck
```
