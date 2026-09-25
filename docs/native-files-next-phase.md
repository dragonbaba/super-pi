# Native files, batch mutations, and explicit Shell cwd

Task baseline: `origin/main` refreshed 2026-09-25, actual SHA
`70e1d52c410e57fba8802df26f7c8c8b7dc16bc0` (PR #43 merged).

## Execution record

1. A: `feat/native-file-operations`, independent base above. Implement native
   delete/move and shared preparation, authority, queue, budget and receipt core.
2. B: `feat/batch-file-mutations`, stacked on A, with exact dependency SHA recorded
   when created. Implement bounded all-item preflight and serial execution of
   edit/write/delete/move, durable item outcomes, and task-cost fixtures.
3. C: `feat/shell-explicit-cwd`, independent base above. Bind literal cwd identity
   to analysis, permission and final spawn for Bash and PowerShell.
4. For each candidate: targeted regression, check, offline build, hot gates,
   full tests, required Linux/Windows CI, actual Codex review and feedback closure.
   Keep all PRs unmerged.

Original worktree: `D:/RMProjects/Pi`. Its seven untracked paths (six previously
present plus the supplied phase specification) are preserved. Task worktree A:
`D:/RMProjects/Pi-native-file-operations`. No credentials are copied or read.

## Status and evidence

Scope addition accepted during A: existing `write` must retain its creation
behavior while parent creation is prepared and authorized without side effects.
Missing directories have a bounded budget and identity-bearing ownership records;
cleanup is nonrecursive and only for recorded empty objects. B must distinguish
create-only from overwrite, allow shared missing parents, and emit real Added
summaries (including empty files). This is part of A/B, with no fourth PR.

Implementation is in progress. No test, benchmark, CI or review success is claimed
until its command and candidate SHA are recorded here.

A initial candidate checks: `npm run check` and 14 native integration tests pass;
combined native + existing mutation recovery run passed 57 cases before the final
TUI/Plan additions. An earlier full-suite run passed, but is not a final-HEAD gate.
Required branch checks were read from GitHub: `verify-linux`, `verify-windows`.

Hot-path audit: `executePreparedToolCall` -> `ToolProgressDelivery.flush` ->
`finalizeToolCall` -> Agent events -> AgentSession -> ToolExecutionComponent ->
registered result renderer -> Text -> retained TUI/frame queue. The Agent change
reads one optional boolean at completion, adding no update callbacks or wrappers.
The module-level native renderer reuses its Text component and reads already
bounded final text; it creates no per-render arrays, callbacks, regexes or promises.
New async callbacks belong to bounded file invocation/approval/queue lifetimes,
not delta/progress/frame delivery. No pool, global authorization cache or timer
was added. The receipt collector is on-demand (not Evidence Ledger hot lookup),
scans 512 Session entries and retains at most 512 primitive receipt records.

Preliminary same-machine existing progress allocation fixture (Node 26.4, Windows):
20,000 updates, 1 drain, 2 deliveries, high-water pending=1, active/pending tools
after completion=0, sampled 198.88 bytes/update; controlled-GC heap delta 337,624
bytes. This is sampling, not a zero-allocation or billing claim.

Platform basis: Node `fs.link`, Linux link no-replace semantics, and Windows
[CreateHardLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw)
support same-volume hard links. The executable destination-race fixture verifies
nonreplacement on the actual platform. Network and unusual reparse/filesystem
behavior is not certified; unsupported operations fail without copy fallback.

## Boundaries

Native moves use an exclusive destination hard link followed by source unlink
on the same filesystem. This is non-atomic; a failed unlink leaves both names
and reports partial completion. There is no automatic rollback, replay, recursive
deletion, cross-device copy or overwrite. Process queues are not cross-process
locks; last-check races with uncooperative external writers remain possible.

The accepted #43 limits (temporary CDPATH query prefixes and closed-subshell hash)
remain. No paid model experiment, automatic merge or deployment is authorized.
