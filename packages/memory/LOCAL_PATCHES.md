# Local Patches

This package is an update-safe derivative of `@super-pi/memory` v0.9.2 at
`5aafe2ca04cb55b62204b159389c8381894038ce`. This document records the local
behavioral invariants visible in the current source. It is not a reconstructed
commit-by-commit history.

## Canonical storage

- Markdown under `@super-pi/memory/` and `projects-memory/<project>/` remains
  canonical. SQLite is a derived search store and must not become a second
  canonical memory source.
- Project facts and failures stay project-scoped. Global memory accepts only
  supported cross-project categories.
- Canonical Markdown mutations use canonical path identities and the shared
  atomic lock coordinator. Stale reviewed proposals fail closed.

## Explicit lifecycle

- Normal startup reads only active canonical memory and skill roots. It does
  not run review, cleanup, reconciliation, session indexing, or capacity
  consolidation.
- Legacy extension-root/SQLite, basename-project, and flat/legacy-skill
  migrations are retired. Startup has no migration exception and does not
  alter old files, migration markers, or backups. An unfinished old migration
  requires manual recovery before upgrading; it is not resumed by this build.
- Shutdown performs no model call, session parse, indexing, backfill, or
  cleanup sweep. It closes only an opened SQLite manager and exact-owner
  Markdown coordinators.
- Memory review is explicit through the scoped `/memory` menu, uses the
  current model, displays the complete proposal, requires confirmation, and
  revalidates the source snapshot before publication.
- Recovery artifact cleanup and Markdown reconciliation are explicit actions
  in `/memory`, the sole command registered by this package. Old standalone
  commands and `/memory import` are removed. Index sync reads canonical global
  files and hashed project identities; it cannot recreate basename directories.

## Prompt memory

- Default `digest` mode keeps the system prompt byte-stable: only the constant
  trigger-based memory policy is appended. Saved memory is summarized into one
  hidden `hermes-memory-digest` custom message (≤2,000 characters), frozen at
  session start, sent once per session context, and re-sent only when
  compaction or tree navigation removes it from the context.
- No nudge, flush, or background extraction drives memory writes; the policy
  names the moments the model should save.

## Skills and search

- Project skill discovery is provided through `resources_discover` and the
  `/memory` skills TUI remains lazy-loaded.
- No background hook extracts skills from turns or tool calls.
- Session search reads JSONL directly without opening SQLite. The retired
  `sessionSearch.variant` setting is ignored, including explicit `legacy`.
  The old index query and snippet tool schema are removed; no session indexer
  is registered. Memory search still uses the derived SQLite memory index.
- The automatic consolidator hook, direct review application, and review
  transport switch were removed. `memoryOverflowStrategy: "auto-consolidate"`
  rejects like `reject`; reviewed menu actions are the only consolidation path.
- Session search streams JSONL files and returns source line ranges for `read`.
  Discovery entries, files, lines, line length, event traversal,
  query size, and retained results are bounded.
- Anchor matching normalizes query terms once, reuses synchronous parser
  scratch state, and retains at most the requested result limit.

## Runtime and safety patches

- `better-sqlite3` remains lazy-loaded and may perform one explicit ABI rebuild
  attempt when loading fails for the active Node runtime.
- Recovery cleanup is bounded, sequential, identity-safe, and confirmation
  gated. Canonical files, symlinks, lookalikes, and deeper user directories are
  not cleanup targets.
- Memory writes scan for credential and prompt-injection content before
  persistence.
- Hot paths avoid property `delete`, `for...in`, locale-dependent lowercase
  matching, and avoid retaining large temporary arrays in object pools.

## Validation

Run the package check from this directory:

```powershell
npm run check
```

Regression and lifecycle checks live under `tests/` and are intentionally
excluded from the published package. Runtime artifacts must use an isolated
temporary agent directory, wait for the exact child process to exit, clean up
only the resources they created, and leave no lock, WAL, or SHM artifacts.

## Upstream adoption checklist

Before adopting upstream changes:

1. Compare changes against every invariant above.
2. Reject automatic review, extraction, indexing, cleanup, reconciliation, or
   shutdown work unless the project policy is explicitly changed first.
3. Preserve Markdown canonicality, confirmation gates, path identity checks,
   bounded scans, and lazy native loading.
4. Run the package check and the relevant bounded regression and lifecycle
   checks without adding test artifacts to this repository.
