# Session Memory Manager

Manages session files through the existing `/memory-sessions` command. It no longer depends on the retired SQLite session index.

## Commands

- `/memory-sessions` — use arrows to move, Space to check/uncheck, and Delete or the configured session-delete key to delete checked sessions after one confirmation. Enter does not delete. An empty selection does nothing. Esc closes the list.
- `/memory-sessions status` — show session and occupied-session counts, plus existing legacy trash and cleanup candidates.
- `/memory-sessions clean` — preview and confirm the exact bounded batch of legacy trash files eligible for cleanup.
- `/memory-sessions delete <session-id>` — delete one historical session by its full unique ID after confirmation.

## Selection and deletion

Current and other live owners' sessions are marked as in use and cannot be checked. Occupancy is read once when opening or refreshing the list and again on explicit checkbox input, never during navigation or rendering. The native publication lock covers the final path/ID occupancy checks and direct file deletion. A session activated after selection is skipped and reported as a failure.

Deletion creates no backup, recovery copy, or new database. Each file has an independent result; a failure does not prevent later selected files from being processed. The refreshed list removes successful deletions and shows failures with their reason. Failed unoccupied sessions remain checked for retry; occupied sessions become disabled. Canceling confirmation preserves the checked paths.

`clean` only considers existing manager-generated files in `~/.sp/agent/@super-pi/memory/session-trash/`. It does not clear ordinary session history. The existing eligibility limits are 10 files, 32 MiB and 30 days, with at most 16 candidates per confirmation. Changed files, occupied sessions, symlinks and unlisted files are preserved; partial failures are reported individually. New session deletions no longer add anything to this old directory.

## Occupancy lifecycle

The native host publishes one PID-backed lease per active AgentSession, including zero-extension SDK sessions, under the configured agent directory's `@super-pi/memory/session-leases/`. Reload keeps the owner. Successful resume waits for the old session's execution/provider owners to finish and its lease to be released, then activates the replacement while a target reservation protects the transition. The old owner clears its heartbeat, reservation timer and path/ID getters. Failed cleanup remains conservatively protected and is reported by the host; it is not silently treated as released.

Raw SDK callers use `dispose()` followed by `await waitForSessionLeaseRelease()` to observe completion or failure. Protection covers the configured lease domain, not arbitrary third-party deletion entry points. Native `/resume` commands and their existing deletion behavior are unchanged.

The manager does not modify memory Markdown, project memory, skills or SQLite memory entries. Session-derived terminal text is sanitized, and the list renders only its bounded viewport and active detail cache.
