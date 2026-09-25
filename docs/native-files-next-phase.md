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
cleanup requires provable ownership; the portable implementation retains directories on failure because mkdir returns no creation identity. B must distinguish
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

A review round 1 (11 inline findings at `1a067894f`): final metadata revalidation
now follows policy/authority awaits; linked names and opened creation handles are
rebound before removal/write. Cancellation, verification flags, absolute creation
targets, budget categories, receipt tool/intent binding, cross-version order and
restored evidence invalidation are covered by regression tests. `not_started`
is accepted as a no-change terminal outcome for the shared contract.

Directory retention correction: portable asynchronous mkdir returns no handle
or creation identity. Post-mkdir lstat cannot exclude an external replacement.
This implementation therefore retains directories on failure instead of treating
the observed identity as proof of ownership for automatic removal. Residues are
reported as partial change. Tests verify concurrent contents and replacements
remain intact. This is within the requested retain-when-unprovable boundary.

Native moves use an exclusive destination hard link followed by source unlink
on the same filesystem. This is non-atomic; a failed unlink leaves both names
and reports partial completion. There is no automatic rollback, replay, recursive
deletion, cross-device copy or overwrite. Process queues are not cross-process
locks; last-check races with uncooperative external writers remain possible.

The accepted #43 limits (temporary CDPATH query prefixes and closed-subshell hash)
remain. No paid model experiment, automatic merge or deployment is authorized.

## B implementation candidate

B is stacked on `feat/native-file-operations`, dependency
`6079502889fef38cbe0e0f7c9ba6f74870f613a0`. A fixes were integrated by merge;
no source fork/cherry-picked implementation and no main merge was used.

`file_batch` prepares at most 16 independent items, reserves the existing real
operation/path/text budgets, obtains one current authorization when needed and
executes in input order under the existing sorted mutation queues. Create mode
is exclusive and distinct from overwrite. Shared missing parents are invocation
owned and deduplicated (case folded on Windows); all preflight remains read-only.
Exact and snapshot edit preparation/execution are extracted from their single-file
cores. Snapshot byte edits retain immutable coordinates and bounded fragments.

Item intents/results use the existing Session custom entries. Aggregate errors
preserve successful receipts; unknown persistence outcomes require verification.
No automatic replay, rollback, dependency inference or transaction is claimed.
Collapsed TUI shows counts and first reason; expanded results show each outcome.

The first 12 integration tests pass, including real Agent/permission calls,
multiple immutable snapshot edits across files, create/overwrite/delete/move,
shared parents/empty files, preflight zero side effects, conflicts, budget boundary,
runtime failure and lost result persistence, and Session reopen/deduplication.
The offline provider fixture uses actual Agent request turns and model serialization:
for 1/4/16 new files, sequential calls take 2/5/17 requests versus 2/2/2 batch
requests. Each request includes 1644 tokens of the same active schemas (o200k_base).
Observed cumulative input estimates are approximately 3.8k/11.5k/65.5k sequential
versus 3.9k/4.5k/7.0k batch. One-file batching is larger. No billing or real-model
speed claim: these are scripted offline turns, zero retries/supplemental reads.
Exact final-HEAD test/CI/review and allocation evidence remains required.

C is independent at PR #45, base `70e1d52c410e57fba8802df26f7c8c8b7dc16bc0`;
its first real Bash/PowerShell literal-cwd fixtures pass. All PRs remain unmerged.


B review round 1 addressed: overwrite disposition remains preflight-bound;
prospective targets conservatively reject case/Unicode-normalization aliases on
all filesystems (including case-sensitive volumes); ambiguous shared-parent
spellings require identical spelling outside Windows. Protected-root reasons are
preserved in approval/audit primitives. Missing-path queue keys resolve their
nearest existing ancestor, so native and batch operations share aliases too.
No case-sensitivity probe, filesystem cache or new platform abstraction is added.
The native Node strip-mode class compatibility failure is fixed; 96 related
batch/native/permission/recovery cases pass before final candidate publication.

`native-files-lifecycle.ts` exercises actual SDK, InteractiveMode, ProcessTerminal,
input dispatcher, extension assembly, batch execution and resource teardown with
synthetic streams and an offline model. Ten cycles (five each regular/fullscreen)
observed input-ready p50/p95 8.66/35.39 ms and first batch 7.85/19.52 ms. All final
pending tool, input listener and resize listener counts were zero. Windows CPU
accounting was coarse (p50 0, p95 16000 us); no claim of zero CPU. This fixture is
not a manual terminal/ConPTY measurement. Peak values are observed samples, not
an exhaustive allocation trace; existing allocation gates run separately.

Default full Markdown benchmark completed (5 processes, 20000 updates/process,
5000 warmup, 26 fixture/viewport cases). Its source/render caches returned to zero
after invalidation. A clean exact-final-HEAD rerun is being recorded in PR #44;
no Markdown renderer changes were made. The source/AST gates for the batch result
renderer prohibit per-render closures, temporary arrays/objects, regexes, promises
and abort controllers; real collapsed/expanded TUI results have regression coverage.


Review round 2 keeps conservative alias folding only for prospective paths;
existing distinct inode targets on case-sensitive filesystems remain independent.
Windows COM/LPT superscript digits are rejected before any mutation. Batch move
approval/audit records now include the shared non-atomic link/unlink primitive.
The corresponding tests cover refusal side effects and durable audit content.
An additional actual Windows PTY CLI baseline on c0e4f4e20 used isolated synthetic
configuration, no user credentials and no model request: input-ready 1123.567 ms,
all four mutation tools available 1133.170 ms, raw TTY input accepted, exit code 0.
The manually delayed diagnostic input is not startup latency. The exact recorded
synthetic root was removed after preserving timings; this is one observation,
separate from the ten-cycle synthetic terminal benchmark above.
