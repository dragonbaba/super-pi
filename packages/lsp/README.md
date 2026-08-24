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

## Configuration

Configuration remains compatible with upstream and is resolved in this order:

1. `<workspace>/.sp/config/pi-lsp.json` for a trusted project
2. `~/.sp/agent/config/pi-lsp.json`
3. upstream built-in server defaults

A server entry contains `command`, `extensions`, and optional `env`, `initialization`, `skipDirectories`, and diagnostics grace settings. Global `timeout` defaults to 20 seconds.

`/lsp` reports configured commands and availability. `lsp_diagnostics` accepts only one `server` string and starts at most one server per call. If requested paths match multiple routes, split the request or choose one server explicitly. LSP results are targeted development feedback; repository-native typechecks, builds, and tests remain authoritative.

## Verification

```bash
npm test
npm run typecheck
```
