# Pi Hermes Memory Extension

## Architecture

- TypeScript is authoritative; Pi loads deterministic `dist/index.js`.
- Canonical memory is Markdown under `@super-pi/memory/` and `projects-memory/<project>/`.
- SQLite FTS is a derived search index, never the canonical source.
- `src/index.ts` registers tools, explicit commands, and constant-time lifecycle hooks.
- Normal startup reads only active canonical memory and skill roots.

## Active behavior

- Tools: `memory`, `memory_search`, `session_search`, and `skill_manage`.
- Reviewed extraction: `/memory-review [project|global]` uses the current model, previews fully, requires confirmation, and revalidates the source snapshot.
- Explicit maintenance: `/memory-cleanup`, `/memory-index-sessions`, and `/memory-sync-markdown`.
- Skills UI: `/memory-skills`; its TUI implementation must stay lazy-loaded.
- Shutdown closes only the opened SQLite manager and exact-owner Markdown coordinators.

## Safety constraints

- Keep project facts and failures project-scoped; global memory requires a supported cross-project category tag.
- Never restore automatic background review, correction extraction, compaction/shutdown flush, live/startup indexing, or capacity consolidation.
- Do not create persistent review previews or a second canonical memory index.
- Keep recovery cleanup bounded, sequential, identity-safe, and explicitly confirmed.
- Preserve lazy better-sqlite3 loading and avoid package-local Pi runtime imports for trivial helpers.
- Do not commit, push, or publish without explicit approval.

## Verification

```bash
npm run check
npm test
npm run benchmark:lifecycle
npm run smoke:rpc
```

Also run LSP diagnostics and verify no temp review, benchmark, RPC, WAL/SHM, lock, child process, listener, or coordinator remains.

## Upstream

This is an update-safe derivative of `@super-pi/memory` v0.9.2 (`5aafe2ca04cb55b62204b159389c8381894038ce`). Read `LOCAL_PATCHES.md` before adopting upstream changes.
