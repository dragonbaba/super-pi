# Pi Hermes Memory Extension

## Architecture

- TypeScript is authoritative; Pi loads deterministic `dist/index.js`.
- Canonical memory is Markdown under `@super-pi/memory/` and `projects-memory/<basename>--<canonical-root-hash>/`. Same-repository worktrees share identity; unrelated same-name projects do not.
- SQLite FTS is a derived search index, never the canonical source.
- `src/index.ts` registers tools, explicit commands, and constant-time lifecycle hooks.
- Normal startup reads only active canonical memory and skill roots.

## Active behavior

- Tools: `memory` (including paginated canonical `list`), `memory_search`, `session_search`, and `skill_manage`. Search defaults to global plus current project; `project: null` is global-only, `project: "*"` is explicit cross-project search.
- Prompt (`digest` mode, default): constant trigger-based policy in the system prompt; one hidden `hermes-memory-digest` message (≤2,000 chars) built at session start and sent once per session context. Never put saved memory, dates, or per-turn data in the system prompt, and never add per-turn nudges.
- Unified management: `/memory` is the sole command registered by this package. Its menu reuses handlers for viewing, scoped review, skills, sync, and artifact cleanup. Old import and standalone maintenance commands are retired.
- Bulk cleanup: `/memory` → 批量清理记忆 is terminal-only and lazy, with editable presets and final confirmation. Preserve unselected raw bytes; bind selections to canonical path, ordinal/fragment hash and whole-file fingerprint. A changed file is skipped without rematching/retry. No automatic expiry or model bulk-remove action.
- Reviewed extraction: select a review scope in `/memory`; it uses the current model, previews fully, requires confirmation, and revalidates the source snapshot. User entries are global; global failure review preserves legacy project-tagged records.
- Digest sources share the fixed budget: user, global, current project, and scoped failures/corrections. Multiline conditions remain in shortened lines. Durable corrections do not expire with the temporary-failure window; canonical originals remain available through `list`.
- Explicit maintenance: `/memory` → artifact cleanup or search-index sync. Sync reads current global files and hashed project identities only; it never migrates legacy roots or basename directories. There is no session indexer; `session_search` directly reads bounded JSONL history and returns source ranges for `read`. The retired `sessionSearch.variant` setting is ignored; `memory_search` still uses SQLite.
- Skills UI: `/memory` → skills; its TUI implementation must stay lazy-loaded. Skills use `<slug>/SKILL.md`; no flat-file conversion or legacy skill migration runs at startup.
- Shutdown closes only the opened SQLite manager and exact-owner Markdown coordinators.

## Safety constraints

- Keep project facts and failures project-scoped; global memory requires a supported cross-project category tag.
- Failure FIFO eviction must stay within the incoming entry's scope; reject without mutation if preserving other scopes leaves insufficient capacity.
- Never restore automatic background review, correction extraction, compaction/shutdown flush, live/startup indexing, or capacity consolidation.
- Legacy root/database/project/skill migrations are retired. Leave old files and recovery artifacts untouched; ownership review and manual recovery must precede moving old data into canonical storage. The old `memoryDir` root spelling remains a configuration alias for the current root, not an import source.
- Do not create persistent review previews or a second canonical memory index.
- Keep recovery cleanup bounded, sequential, identity-safe, and explicitly confirmed.
- Bulk cleanup reuses checked Markdown publication and write locks. Close only its owned coordinator connections; never close an active store's shared connection through a transient store. Reconcile changed project scopes only, and report index failure without rolling back committed Markdown.
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
