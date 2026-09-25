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

## Exact edit final commit boundary follow-up

Remote baseline rechecked: main 70e1d52c410e57fba8802df26f7c8c8b7dc16bc0;
A 6079502889fef38cbe0e0f7c9ba6f74870f613a0; B
2d4e59bc4890329f8450303d7418016beeccbf6f; C
5dcf34934ef987a55c9ede614212235cf19988f3. No merge is authorized.

The real Agent/ExtensionRunner/permission/mutation fixture reproduces an exact
edit write issued after authority revocation or cancellation during the final
hash read. A test-only filesystem barrier holds the completed read before its
promise returns; the core and filesystem operations remain real. The baseline
single and batch controls pass; each revoked/cancelled case issues one forbidden
write (four expected failures). No sleeps or production fault hooks are used.

The shared core now checks the current signal and approval after the final hash
read, immediately before issuing writeFile, and records a no-change failure with
reservation release. Ordinary exact edits also carry the existing one-call
permission sequence/generation binding; previously it was absent for ordinary
paths. Single edit passes its signal through the per-invocation execution owner.
No new authorization cache, global production state, regex or per-progress
closure is introduced. Test dispatchers are confined to the test process and
release active barrier references at teardown. The exact-boundary tests include
real Session persistence, receipt collection and inactive Agent/runner checks.
Batch signal threading belongs to B after merging this actual A commit.

Verification and A+B+C temporary integration results are recorded in the existing
PRs. This follow-up does not authorize merging, deploying, or a fourth PR.


B final-boundary follow-up merges A 5b2cb7be891169059b42aa0ae651450a6e58edca
via merge commit 620f86823. Permission binding retains both edit and batch
conditions. B passes its invocation signal into the same shared exact core.
The extracted real Agent fixture now serves the existing batch suite and both
boundary suites. Before the fix, batch authority/cancel each issued one write;
after the fix both issue zero, preserve the first successful item/receipt, mark
the current item failed_no_change/cancelled and leave the last not_started.
Same-turn dry-run budget probes accept 15 additional targets and reject 16,
proving the completed target remains charged while unused reservations release.
Session reopen collects the first receipt once and does not change any target.


## Batch path semantics follow-up (PR #46)

Formal integration has merged A into main at
8f31b54086799359a737f6c0cdc4b2ecdecc7bbe. B was retargeted to main and
normally updated to c7f724112b6d68f56998a2e2f42703fc4e43c8ef. Review thread
https://github.com/dragonbaba/super-pi/pull/46#discussion_r4105310369 stopped
its merge; the user subsequently authorized this repair and conditional B -> C
integration. Earlier no-merge statements above describe earlier authorization.

The real Agent/ExtensionRunner/guard/permission/filesystem fixture reproduces
four distinct baseline outcomes with matching file contents and prior reads:

- create `@new/file.txt`: preflight and approval name literal `@new/file.txt`;
  mkdir actually creates `@new`, then the canonical-target check rejects before
  opening a file. The directory remains and the result correctly reports partial.
- overwrite and exact `@name.txt`: preflight/approval/outer receipt name
  `@name.txt`, but the actual write changes `name.txt`; `@name.txt` stays intact.
  Equal initial bytes avoid hiding the mismatch behind a hash failure.
- snapshot `@name.txt`: the existing snapshot path check rejects during
  preparation. Neither file changes and no write-side filesystem call occurs.
  This is a rejected request, not a reproduced wrong-file snapshot commit.

The minimal production change belongs entirely to B's file-batch.ts. Each
edit/write item resolves its original syntax once with the single-file
resolveToolPath function and retains that absolute lexical executionPath.
All preparation and execution core calls use it. The original frozen input,
request hash and approval binding remain unchanged. Absolute lexical paths
cannot strip `@@` twice and retain parent aliases for identity revalidation;
they are not substituted with canonical strings. Native delete/move retain
literal source/destination semantics. Before execution, the resolved target,
approval target and creation plan must agree, using the existing Windows path
comparison rule. Existing ancestor/file identities are still rechecked.
No shared single-file production core, parser, global cache, regex or hot-path
callback was added. Single-file controls did not reproduce the batch mismatch.

The new cross-platform suite has 86 cases: four traced reproductions plus
single/batch create/overwrite/exact/snapshot controls for relative, absolute,
leading @, @@, ./@, middle @scope, Chinese/space and @absolute paths; literal
native source/destination controls; alias conflicts; refusal/dry-run/invalid
snapshot/existing target/later preflight failure; changed request; approval-time
junction/symlink drift; partial completion, cancellation, directory retention,
budget release and Session reopen without duplicate receipts or replay.
The device-path case is explicitly Windows-only; the remaining 85 execute on
Linux too. Actual Windows drive/@drive paths are the platform absolute cases.
Tracing wraps real mkdir/open/write/link/unlink/rename calls, captures prepared
and approval targets, and verifies real contents, not only error strings.
Test-process instrumentation is restored and its active owner released.

At the initial repaired working tree, the combined path/batch/exact/native
regression has 136 passes, one case-sensitive-filesystem skip on Windows,
and zero failures; check passes. Final committed-HEAD complete tests, allocation,
Linux/Windows CI and actual review evidence are recorded in the PR, not inferred
from c7f724's old green checks. Existing exact final authority/signal gates and
single-file production cores are unchanged.


## R1–R5 review repair ledger (#46)

Re-fetched main 8f31b54086799359a737f6c0cdc4b2ecdecc7bbe, B
7f569fe62adaff5fab4bf9ee5554932492b1a7f8 and C
1ba7fd16d337436ce937c1539e3d520045420148. SSH transport closed twice;
HTTPS fetch confirmed the refs without changing credential/remote configuration.
This repair is authorized to continue through same-scope feedback; merges remain
gated on all valid findings, latest-head local checks, CI and actual review.

| Finding | Real baseline evidence | Current repair / validation |
| --- | --- | --- |
| R1 4105911145 | intent-hook alias redirection changes the other equal-content file for exact/overwrite; snapshot/create/delete/move already reject this intent-time case | prepared identities reach the shared commit cores; final authority/signal checks retained; same-content file/parent replacement and ordinary/protected targets under deterministic tests |
| R2 4105911157 | directory alias switched after initial assessment; actual delete/move use the second source while outer receipt names the first | require prepared source/identity to agree with initial assessment before budget/queue/permission acceptance |
| R3 4105911170 | actual native @ delete/move invalidates unrelated unprefixed read evidence, including restore | pair original call/item with bounded durable preparation/intent targets; invalidate canonical keys directly without resolving a deleted source; preserve unrelated evidence |
| R4 4105911183 | shipped default extension manifest + SDK Agent accepts completion and goal_complete after preflight failure, partial/unknown/cancel and native failure (six failing controls); success/preview pass | bounded item outcome consumption and existing obligations; execution-end observation covers authorization vetoes without a tool_result hook; started targets are bound to durable preparation/intent |
| R5 4105911198 | real Runner scheduler deadline during last-item filesystem read leaves 3 items/paths and attached authority; earlier-item controls clean up | abort checks after async preparation/before reserve and attachment; preparation owns cleanup until transfer; release handles attachment failure and is idempotent |

The actual default extension loader disables per-module caches. Separate loaded
mutation and permission extensions therefore previously disagreed on the batch
preparation Symbol despite passing inline-factory tests. The preparation key now
uses a stable Symbol.for key, like other private cross-extension contracts; no
new global authorization state/cache was introduced. Actual default-manifest
success/preview now execute. Per-invocation authority remains private and bound
to raw request hash and Session/permission state.

The false-success producer chain audited is Agent tool start/result/end -> SDK
extension bridge -> false-success consumer -> existing completion intervention;
TUI and progress/render callbacks are unchanged. The new input references are
bounded to 128 active native/batch calls and released on end/session reset or
shutdown; overflow creates a conservative obligation. Bounded preparation
metadata records at most 16 target identities, no file bodies, and is not an
intent or proof of mutation. Dry-run records no prepared mutation metadata.
Final committed-head tests/allocation/CI and per-thread replies remain pending;
this working record does not claim review closure or merged B/C.

The repaired working tree passes 174 targeted tests, with one explicit
case-sensitive-filesystem skip on Windows, plus a separate late-cleanup test.
R5 covers actual Runner deadlines and cancellation at each of three positions
for exact and snapshot preparation: all 12 pass, with prepared items/paths,
attachments, snapshot fragments, scheduler tasks and pending calls released.
Attach failure, preparation error and normal handoff also pass. A following
14-file successful call can complete while old I/O is held; late cleanup then
preserves all 14 charges and only the two remaining file slots are available.

R3 tests successful, partial (actual link then cancellation), unknown (durable
result failure), and definite no-change native moves. Live and reopened Sessions
invalidate changed-source evidence, retain unrelated literal-@ evidence, and
retain source evidence for definite no-change. Recreated equal-content sources
do not regain read authority. Unpaired result targets cannot invalidate another
file. R4 uses the shipped default extension manifest and real SDK Agent, covers
completion text and goal_complete, and requires both move scopes to be verified
after a real partial move. Honest incomplete reports remain intact; unrelated
success cannot clear obligations, and retry alone cannot clear unknown state.

Working-tree check/build:offline/test:hot and allocation gates passed. The progress
lane delivered 2 events for 20,000 updates, drain/high-water 1, final active and
pending tools 0; sampled 198.22 B/update and controlled-GC delta 328,424 B.
Native lifecycle ran ten SDK/InteractiveMode/ProcessTerminal cycles, all final
pending tools/input/resize listeners zero. Four production tool-leaf allocation
fixtures passed. These sampled values include existing allocations; no pool,
per-progress callback, timer platform or large result-body parse was added.
The invocation-level result consumer is bounded (16 items, 512 metadata entries),
while streaming producer/event/TUI/render behavior remains under the existing
AST and allocation gates. Final committed-head results and remote review/CI are
tracked on #46; working-tree observations do not substitute for those gates.

The complete result lookup audit found that a bounded consumer still called
SessionManager.getBranch(), which materialized an unbounded ancestor array
first. Result consumers now read at most 512 entries through the existing
indexed getLeafId/getEntry API. A 1,024-entry actual Session fixture forbids
getBranch and measures exactly 512 indexed reads in chronological order.
This is invocation-local scratch with no cache or retained Session references.

## Subsequent review of 488c21725: result boundaries

Three same-scope findings remain merge gates until the follow-up candidate's
full/CI/review checks complete:

- 4106726173: eight real Agent result-hook tests (create/overwrite/exact/snapshot,
  success/unknown) reproduce wrong evidence grants or invalidation after an
  ancestor alias redirects. A direct symlink-parent fixture is rejected by the
  existing native-parent defense before mutation; the supported ancestor-alias
  fixture reproduces the finding without removing that defense. All batch
  outcomes now require prepared call/item/target pairing. Successful evidence
  reads the authoritative canonical target and refuses a newly redirected
  canonical name; failures invalidate only that key. Raw request semantics and
  transcript parameters remain unchanged. Live and reopened Sessions agree.
- 4106726183: actual default SDK/Agent TypeBox numeric-to-string path repair
  reproduces missing batch partial and batch/single-native preflight obligations;
  single-native partial was already blocked by its durable intent. Tracking now
  uses validated tool_call/tool_result arguments when available. Vetoed/invalid
  raw paths conservatively retain a workspace obligation instead of silently
  disappearing. The input reference is still released exactly once at end.
- 4106726187: actual exact/snapshot batch results duplicate large diff/patch
  strings in durable progress entries. Progress results now persist only bounded
  identity/status/reason and created-directory metadata; aggregate tool results
  retain their original diff/patch and TUI behavior. Both 32,000-character line
  fixtures assert metadata under 4 KiB, full patch still available, correct
  bytes, one recovered receipt and no replay. Directory side-effect records are
  retained, including partial failure. No large-body stringify/parse was added.

The first follow-up regression run passes all 26 cases (12 previous completion
guard controls plus 14 new cases). Original path, identity/deadline, native
receipt, exact final-gate and shared-core tests are rerun on the final commit.

A further actual default-Agent negative test confirms an invalid raw batch
operation previously produced no target obligation. It now uses the same
workspace fallback as other unparseable preflight failures. A null-argument
control already blocked completion and remains unchanged. No schema or repair
semantics were changed.

## R3 ancestor-alias read restoration follow-up

Two additional real Agent/native batch/Session regressions reproduce a live vs
reopen discrepancy: after delete/move finishes, an ancestor alias is redirected
to an unread equal-content file. Live overwrite is rejected, but replaying the
old read previously resolved its raw alias again and granted that other file
read evidence. This is evidence reconstruction, not automatic tool replay.

The existing read-result hook now records its accepted canonical evidence target
with the actual call ID and path/offset/limit binding in small result metadata.
Restore uses that bound target, with a canonical agreement check, rather than
reinterpreting the alias. It does not create another read tool, global registry,
cache or content copy. Ordinary legacy reads retain compatibility; legacy alias
reads with no provable original target require a fresh read. Four explicit
new/legacy and plain/alias controls verify this conservative compatibility rule.
Existing mutation receipt collection and deduplication formats are unchanged.

Both reproduced cases and the four compatibility controls pass. Combined native,
read evidence and mutation-contract controls: 91/91 pass. The full retained path
matrix and result-boundary suite also pass (130/130 in that run). Final-HEAD
complete tests, CI and actual review remain required before merging.


## Read producer / restoration review follow-up (4106958282, 4106958292, 4106958301)

The actual Agent read-to-result barrier reproduces two equal-content identity
errors: redirecting an ancestor alias, or replacing the addressed file after
read completes. Binding only at the result hook accepted an object that did not
produce the text. Read now exports a small source descriptor from the existing
validated read-window/small-file producer. The unique read wrapper opts in;
mutation evidence and snapshot issuance compare that source with the object
being accepted. No new content read/copy is needed to capture the descriptor.
Windows remains ineligible for precise Evidence Ledger cache hits; this source
proof does not claim a filesystem CAS, cache generation or cross-process lock.
Additional deterministic descriptor-close barriers verify both drift cases
before snapshot annotation, including unchanged content and ordinary paths.

Numeric and out-of-range-offset reads reproduce restoration failure with raw
transcript matching. A corrected supported Markdown fixture
`[123](https://123)` also fails against the previous restoration consumer after
a successful real read. Version-2 read evidence retains the paired call ID and
actual repaired execution parameters, leaving original transcript arguments
unchanged. Rejected modern reads cannot fall back to legacy restoration.
The unmerged version-1 hook-time binding is not accepted as producer proof.
Mutation receipt versions and collection/deduplication are unchanged.

Legacy plain reads now inspect bounded lexical ancestors with lstat and compare
filesystem identities, rather than treating canonical spelling differences as
links. Actual symlink/junction traversals still require a new read. The native
Windows case-spelling control passes; NFC/NFD skips explicitly when the volume
distinguishes those names. Native macOS execution is not available; that review
finding is supported by the identity-based implementation and portable control,
not claimed as a reproduced macOS run. Linux/Windows CI execute the new tests
and report their filesystem-specific spelling skips individually.


## Final read/snapshot review boundaries (4107163019/3038/3044/3053)

- Legacy root and ancestor junction redirects reproduce equal-content unread
  evidence grants on real Session restoration. Bounded lexical traversal now
  checks the workspace root and all ancestors through the filesystem root;
  no early workspace match skips links. Actual legacy link traversals require a
  fresh read, including linked workspace roots. Ordinary filesystem case/Unicode
  spelling remains identity-based. This is conservative legacy compatibility,
  not a claim of reconstructing historical link targets.
- Removing the source precisely when the snapshot capture descriptor closes
  reproduces a failed otherwise-completed read. Source revalidation failure
  now omits the optional annotation; no snapshot or mutation evidence is granted.
- Actual SDK Sessions with only mutation + required permission extensions
  reproduce READ_REQUIRED for both exact edit and overwrite following a valid
  built-in read. Descriptor source capture now belongs to the built-in local
  read itself, so the optional loop guard is not required. Its private ledger
  attachment still follows the existing capture request and precision rules.
  No duplicate read tool, hook-time fallback or authority registry is added.
- A real single-file snapshot edit deterministically overwrites an in-place
  concurrent edit made during the final asynchronous path gate. The batch
  counterpart already rejects that exact window through prepared identity;
  its first success/failed current/not-started tail remain intact. The shared
  snapshot core now performs a final content hash after asynchronous path and
  identity checks, immediately followed by synchronous authority/signal gates
  and rename issuance. The additional bounded disk read is necessary to close
  the demonstrated asynchronous content window, and does not enter model context.
  Existing post-read alias/object/parent checks are retained; no OS CAS or
  cross-process lock is claimed.


The complete-suite privacy gate caught serializable source-generation metadata
when capture became built-in. The descriptor proof is now a non-enumerable
invocation-private symbol property, shared by stable symbol identity across
extension loaders. Snapshot/guard consume it before result persistence; only
the accepted target/call/argument binding is durable. No global object map or
source body is retained. The existing independent-session/disposal/disabled-
ledger privacy assertion is retained unchanged and passes with the correction.

The ordinary small-read compatibility assertion also requires unchanged
`details: undefined`. Private source metadata therefore rides the existing
content array (non-enumerable symbol) instead of allocating a new details
object. The optional snapshot wrapper transfers that same descriptor when it
replaces the content array; it does not copy file text or create another proof.
Both original read-output equality and Session privacy gates remain unchanged.
