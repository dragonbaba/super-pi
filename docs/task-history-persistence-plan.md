# Bounded task history across restarts

Base: merged PR #74 (`5cd30347f`). Next milestone after session-owned shell and
subagent management. This release restores observations, never executable work,
old permissions, verification success, credentials, prompts or command arguments.

Status: implemented; local functional and allocation evidence is recorded in
[the performance audit](performance/task-history-persistence.md). Cross-platform
CI and external review run on the new PR.

## Delivery and acceptance

1. Keep a lazy, session-local SQLite sidecar per task kind. Use Node's bundled
   SQLite runtime, bounded rows and payloads, and single-row lifecycle writes.
   New sessions with no tasks create no history database. In-memory sessions
   retain their existing nonpersistent behavior.
2. Commit admission and start before execution. Commit bounded terminal text and
   shell facts after cleanup. Retain at most the configured `maxTasks` unfinished
   records plus the latest `maxTasks` terminal records (hard ceilings 256/256).
   Do not rewrite all results or persist streaming output.
3. Claim one runtime writer transactionally. Refuse another live/uncertain writer;
   only a definitely absent local PID permits crash recovery. PID reuse fails
   closed. Never signal an old process other than the read-only existence check.
   A foreign host needs explicit reconciliation outside this release.
4. Restore bounded history with original IDs, workspace/branch labels and a
   historical marker. Unfinished observations become `interrupted`, with unknown
   side effects and explicit inspect-before-retry guidance. Do not recreate
   controllers, notify completion, replay commands, or grant execution authority.
5. Make `/tasks` and both task-control tools display history and storage failures.
   Wait/cancel on recovered terminal records never address a PID. Corrupt,
   replaced, oversized or unwritable storage fails clearly; a failed terminal
   save preserves the live result and blocks further admission.
6. Drain session/tree transitions, release database statements/handles on disposal,
   and keep forked sessions separate. Run focused persistence/lifecycle tests,
   exact source invariants and allocation/reference-release benchmarks. Self-review
   the final diff before committing, opening a new PR and requesting `@codex review`.

## Performance boundary

Follow `performance/hot-path-allocation-contract.md`. Audit the existing shell
accumulator and subagent ingestion through terminal task retention and explicit
task-query delivery. Storage calls occur only at admission/start/finish or session
initialization/disposal; no per-chunk writes, snapshots, promises or timers.
Measure lifecycle write counts, retained rows/bytes, allocation sites, open handles
and released references. No object pool, daemon, checkpoint replay or token-budget
policy belongs in this milestone.
