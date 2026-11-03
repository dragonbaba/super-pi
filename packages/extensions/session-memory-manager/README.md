# Session Memory Manager

Keeps Pi session files and Hermes Memory's SQLite session index consistent.

## Commands

- `/memory-sessions` — choose and delete one historical Session in TUI.
- `/memory-sessions status` — show file/index/message counts plus session-trash count, bytes, oldest age, bounded candidates, and the exact next cleanup batch.
- `/memory-sessions clean` — preview and confirm stale/orphan index cleanup; session-trash files require a separate second irreversible-deletion confirmation listing every exact file in the bounded batch.
- `/memory-sessions delete <session-id>` — delete one historical Session by its full unique ID.

## Deletion semantics

Deletion moves the JSONL file to:

`~/.sp/agent/@super-pi/memory/session-trash/`

It then removes only the corresponding rows from SQLite tables `sessions`, `messages`, and `session_files`.

The trash retention envelope keeps the newest managed files within 10 files, 32 MiB, and 30 days. Status is always read-only. Clean considers only exact manager-generated names and ordinary unchanged files, deletes at most 16 per confirmation, and never removes lookalikes, symlinks, or unlisted files. Existing trash is never permanently deleted without the second confirmation.

It intentionally does **not** modify:

- `MEMORY.md`
- `USER.md`
- project memory
- skills
- SQLite `memories` entries

This manager refuses to delete an active Session. The native host publishes one PID-backed lease per active AgentSession, including zero-extension SDK sessions, under the configured agent directory's `@super-pi/memory/session-leases/`. The v1 path/ID format is unchanged. Reload keeps the same owner; replacement holds a separate target reservation until the new session publishes its record. Heartbeats run every 30 seconds, never per message or delta. Normal release waits for registered execution and provider owners to finish. A failed drain or unlink is reported to the host and leaves conservative live-PID protection; dead-process records are reclaimed during deletion checks. Raw SDK callers use `dispose()` followed by `await waitForSessionLeaseRelease()` to observe completion or failure. The extension owns only management/index workflows and consumes the host's checks through a compatibility entry point.

The manager checks both the current process path and all live cross-process leases before opening the transaction, then repeats both checks immediately before moving the file. Native startup `--resume` and interactive `/resume` selectors also check canonical-path leases, holding the publication lock through trash or synchronous unlink. The interactive selector uses its runtime's agent directory; startup uses the default agent directory. This protects leases published in that configured domain, not arbitrary other agent directories or every third-party deletion entry point. A timeout, output-limit failure or signal termination of trash reports failure without permanent-deletion fallback. Arbitrary third-party background work that only listens for `session_shutdown` does not acquire a new raw-SDK cleanup guarantee.

There is no modification-age gate: a newly written but unoccupied Session is deletable immediately. Busy/inaccessible files and operational filesystem/database errors still fail safely without deleting the index. Deletion validates the Hermes schema/version first and coordinates the database transaction with the file move; failures roll both back when possible. The confirmed `session_id + old path` mapping is revalidated under the transaction lock, and cleanup never uses an `OR path` delete.

Every manager SQLite connection applies a 256-page WAL autocheckpoint, a 2 MiB journal limit, a passive checkpoint before close, and an unconditional close in `finally`; it never truncates another live Pi writer's WAL.

Hermes live indexing can temporarily create `sessions/messages` before a JSONL path is available. The clean command therefore excludes every Session ID found on disk, the current Session ID, and every ID held by a live-process lease before removing unmapped orphan rows; it repeats the ID lease and no-mapping checks inside the transaction. Native deletion through `/resume` remains available; stale Hermes rows left by native deletion are cleaned only through the explicit, confirmed `/memory-sessions clean` command. All Session-derived terminal text and errors are stripped of ANSI/OSC/control sequences and length-bounded.
