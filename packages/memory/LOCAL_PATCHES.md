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
- The only startup exception is completion of an already-detected legacy
  SQLite migration before database access.
- Shutdown performs no model call, session parse, indexing, backfill, or
  cleanup sweep. It closes only an opened SQLite manager and exact-owner
  Markdown coordinators.
- Memory review is explicit through `/memory-review [project|global]`, uses the
  current model, displays the complete proposal, requires confirmation, and
  revalidates the source snapshot before publication.
- Recovery artifact cleanup and Markdown reconciliation are explicit through
  `/memory-cleanup` and `/memory-sync-markdown`.

## Skills and search

- Project skill discovery is provided through `resources_discover` and the
  `/memory-skills` TUI remains lazy-loaded.
- No background hook extracts skills from turns or tool calls.
- Legacy session search queries only an existing SQLite index. It does not
  register background indexing.
- The opt-in `anchors` variant streams session JSONL files and returns source
  line ranges. Discovery entries, files, lines, line length, event traversal,
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
