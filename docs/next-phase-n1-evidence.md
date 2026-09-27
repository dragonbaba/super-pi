# N1: preview and recovery evidence

Status: **实现中**. This record does not claim complete N1 acceptance.

## Baseline and environment

- Base: `4f547535b830c15d3a9605574c229a0641f94923`.
- Task worktree: `D:/RMProjects/Pi-next-phase-n1`.
- Windows host; default Node 26.4.0. Task-specific Node 22.19.0 downloaded from
  nodejs.org and used for checks; native SQLite ABI smoke test passed. Linux
  execution must be separately observed.
- Artifact directory: `D:/RMProjects/Pi-next-phase-artifacts`; raw logs stay outside
  the repository. No paid provider requests or user-project mutation fixtures.
- Pre-existing `file_batch` dryRun returns only a preflight summary; expanded
  renderer currently repeats the text summary and ignores per-item patches.

## Planned production path and ownership audit

`Agent.beforeToolCall` → extension runner → `BatchInvocation.prepare` → existing
Session permission controller → final authorization consume → sorted mutation
queue → revalidation → preview or existing commit cores → aggregate tool result
→ Agent/Session → `ToolExecutionComponent` → batch renderer → `Text` → TUI layout
→ terminal frame queue → terminal writer → component/session release.

Preparation owns reservations and temporary before/candidate values. The result
owns only bounded preview strings and existing receipt data. No preview is a
mutation receipt, snapshot, authorization attachment or read evidence. Progress
does not construct per-item trees. Completed presentation is computed once outside
render; component caches must release derived references on final unmount.

## Acceptance ledger

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Actual bounded dryRun previews; no effects/evidence | 已实现待验证 | Four new fixtures failed on baseline; five current cases pass locally |
| Per-file TUI expansion and bounded retained references | 已实现待验证 | 20k updates, ten releases, zero stable-render text changes |
| `/changes` Session pairing, verification and remaining draft | 已实现待验证 | Eight targeted cases, including real default SDK Session/reopen |
| Full Windows checks, minimum Node, allocation gates | 实现中 | Targeted tests/check/hot passed; full candidate checks pending |
| Linux checks and latest-head review | 实现中 | Initial slice CI passed both platforms; two P2 findings fixed; final-head rerun pending |

## Task-cost baseline fixture

`tests/next-phase-cost.test.ts` uses an offline OpenAI-compatible provider serializer
with a fake fetch transport. It loads the real extension bundle and tool-discovery
policy, executes actual SDK Session/Agent tools, and compares one call per response,
multiple calls per response and one batch at 1/4/16 files. Batch discovery is a real
request and is counted. Input is measured from serialized request bodies using
`o200k_base`; output is an estimate of fixture deltas, not provider billing/usage.
No live network provider or credentials are used. The initial fixture covers
successful creation only; it is not the complete N4 task matrix.

Five independent baseline processes passed before existing production paths were
modified. At 16 files, T1/T2/T3 sent 17/2/3 requests, with input estimates around
47,662/5,403/8,829 tokens respectively. T3 includes one discovery request. Thus
batching does not beat multiple single-file calls in one response on this fixture.
These are request-body estimates, not actual charges or a general performance claim.

## Initial slice verification

- `node --experimental-strip-types --test tests/file-change-preview.test.ts tests/file-batch.test.ts`:
  23 passed, 1 skipped (case-sensitive distinct-file test on Windows).
- Mutation contract, batch native evidence and actual SDK mixed Session suites:
  67 passed, zero skipped. Mixed Session exercised 25 calls, 13 approvals, both
  Windows Bash/PowerShell backends and disk reopen; pending tools and final
  authorizations were zero.
- `check` and `test:hot`: passed. No invariant was removed or weakened.
- Existing full tool-leaf allocation benchmark passed on the base; raw report is
  `baseline-tool-leaf.json` in the task artifact directory.
- `SP_PREVIEW_PROFILE=1 node --expose-gc --experimental-strip-types --test --test-name-pattern 20k tests/file-change-preview.test.ts`:
  20,000 updates, ten retained-owner releases, zero remaining derived characters;
  sampled allocation 472,032 bytes (23.60 bytes/update, including lifecycle work).
  Controlled-GC heap was 45,256,440 before and 45,840,704 after; this includes
  inspector/JIT/test ownership and is not a claim of zero whole-process retention.

The release hook uses a shared, versioned symbol because bundled extensions and
the source host load in different module scopes. It carries only derived UI
cleanup, never authorization. The stable render path allocates no inline closure,
Promise, AbortController, result wrapper, array, hash or diff. Width changes use
the existing Text layout cache. No pool or terminal-frame change was introduced.

Five independent Node 22.19.0 preview profile processes then passed. Sampled
bytes/update were 22.6984, 23.6732, 21.0092, 22.4976 and 20.9216 (median 22.4976).
Every run delivered 20,000 updates across ten owners, with zero stable-render text
changes and zero retained derived characters after release. Controlled-GC process
heap increased by 0.55–0.56 MiB including profiler/JIT/test lifetime. This is release
evidence for the measured owners, not a whole-process leak or speedup claim. The
existing full tool-leaf allocation benchmark and the added AST gate also passed.
These profiles measure the working candidate before its final commit.

The second slice adds `/changes` through the existing permission extension. Its
list is capped at 128 items from 512 Session entries. Viewing, verification and
drafting do not call a provider or execute a mutation. Verification checks current
scope/identity, hashes at most 32 MiB with a 64 KiB buffer, and persists a small
versioned Session entry. Partial/unknown outcomes require observation but never
become automatically replayable. Draft placement preserves concurrent user input.
The actual default SDK Session regression uses genuine offline Agent messages;
host-only dispatch deliberately redacts arguments and cannot serve as reconstruction
evidence. Missing or ambiguous original requests are refused.

Review of `7704a6e33c69389729fa165b261f912802c4f4b1` found two valid P2 issues:
overwrite preview growth could bypass the pre-stat bound, and planned parents were
not displayed. The candidate now opens a bounded handle, verifies its object/size,
reads at most initial size plus one sentinel byte, and renders deduplicated planned
parents. A deterministic handle-stat growth fault verifies rejection before any
post-growth read. The zero-mutation counter fixture now includes a real-create
positive control and synchronizes native module bindings so a detached mock cannot
falsely prove zero effects.

The initial full local suite passed, but source work continued while it ran, so it
is development feedback rather than final-head acceptance. Final N1 checks, both
platforms and review must be rerun against the completed candidate. Partial-read
exact diffs currently use an explicit bounded-summary fallback. Host-redacted
arguments and legacy alias paths without pairing remain unreconstructable; these
limitations are visible rather than guessed.

Draft PR: [#47](https://github.com/dragonbaba/super-pi/pull/47). Initial candidate
`7704a6e33c69389729fa165b261f912802c4f4b1` received an actual Codex review and
[successful Linux/Windows CI](https://github.com/dragonbaba/super-pi/actions/runs/36251336745).
The second slice's six targeted suites passed 99 tests, with one Windows
case-sensitivity skip. Check, offline build and hot-path gates passed locally.
This older CI does not validate the added recovery command.

The completed second slice `a7b5e41c11a7d9a410f722ecc7e00c792c062c34` then passed
Windows Node 22.19.0 check, offline build, hot gates and the full suite with the
worktree fixed at that commit. Its exact-head preview profile/tool-leaf gate and
[Linux/Windows CI](https://github.com/dragonbaba/super-pi/actions/runs/36253075251)
also passed. Actual review found three further P2 issues in recovery pairing and
observation. The follow-up requires a unique preceding call and ordered intervening
v2 intent/preparation, rechecks all observed identities/absence before accepting
verification, and refuses relative legacy receipts with unknown originating cwd.
New single-file results record canonical targets. Six regression suites now pass
102 tests with one Windows case-sensitivity skip; final-head gates and review are
pending for this follow-up. No completed review with findings is counted as approval.

`5986a5b4e56001491366073e98dc71d534c59a4b` passed fixed-head local check,
offline build, hot/full tests, preview profile and tool-leaf allocation gates. Its
next actual review found exact v2 item-ID coercion, a missing synchronous authority
gate after final observations, and missing/mislabelled committed patches in View.
The follow-up retains exact IDs, exposes the captured permission generation check
for final synchronous acceptance/persistence, retains standalone receipts for View,
and selects successful diff/provenance from the committed receipt together. Twenty
preview/recovery regressions pass, including real standalone exact/snapshot View
and actual batch edits prepared from partial evidence. Check passes; final candidate
gates and review remain required after this slice.

`905aa43981c3246c409d28bdf1b7090d862758de` passed fixed-head local check,
offline build, hot/full tests, allocation gates and
[both CI platforms](https://github.com/dragonbaba/super-pi/actions/runs/36256212100).
Its actual review identified six further recovery/display gaps. The next slice
retains confirmed bounded write differences when receipts have no patch, displays
standalone failure reasons, rejects later conflicting terminal outcomes that reuse
old intents, reconstructs request-bound prepared items without later intent as
unstarted, drafts absolute recorded targets across cwd changes, and observes up to
32 recorded parent side effects through the same permission/identity checks.
Twenty-five preview/recovery tests pass, including genuine partial-create failure,
interrupted receipt recording, forged later terminal status and changed-cwd drafts.
Display limits remain labelled independently of confirmed mutation status.

`1914ba15e65e300a0258affe449fcd26e6f3f690` passed all fixed-head local
gates, preview/tool-leaf allocation checks and both CI platforms
([run 36257817098](https://github.com/dragonbaba/super-pi/actions/runs/36257817098)).
Actual review identified three more bounded-history ambiguities. Recovery now
requires unique ordered request-hashed preparation plus matching per-item intent
for entered outcomes, refuses the entire draft when any receipt is unavailable,
and never invents a missing middle item as unstarted after later activity. Intent
is recorded before per-item revalidation, so genuine no-change failures retain
both phases; cancellation before entry and not-started items use unique preparation.
The recovery-only binding does not change the Evidence Ledger or grant authority.
Seventy-five focused tests pass, including six corrupted phase variants, an
unavailable purported success and a missing middle receipt after real execution.
Latest-head full gates/CI/re-review remain pending for this follow-up.

`b80f4752de35194e9fad97302b6d714b23c36a75` passed local check, offline
build, hot/full tests, allocation gates and both CI platforms
([run 36259129420](https://github.com/dragonbaba/super-pi/actions/runs/36259129420)).
Its actual review identified canonical standalone-intent binding and two malformed
history boundaries. V2 standalone recovery now uses one ordered canonical intent
instead of resolving old relative arguments in the reopened Session cwd. Negative
item indices and any same-call terminal aggregate preceding preparation invalidate
unstarted reconstruction. Twenty-three focused recovery tests pass, including
actual standalone write/delete/move, disk reopen with cwd override, a no-change
remaining draft, and malformed imported histories. Legacy v1 receipts still need
their older binding; no origin cwd is guessed. New-head full gates/CI/re-review are
required and not inferred from the preceding candidate.

`d1bad1788e620810caf60914dd330b78ea26981d` passed local check, offline
build, hot/full tests, allocation gates and both CI platforms
([run 36260785338](https://github.com/dragonbaba/super-pi/actions/runs/36260785338)).
The next actual review found malformed progress without item IDs, a terminal before
intent, incomplete/out-of-order verification records, and an unbounded draft ID.
Recovery now rejects malformed phase identities, requires intent before every
terminal mirror, and accepts only complete ordered observations bound to the exact
receipt/session, paths, identities, parents and derived comparison results. The
entire draft (including its quoted, control-free, 256-character source ID) fits
48 KiB. All 26 focused recovery tests pass, including actual command refusal of a
four-ID-only verification record. These checks do not authenticate arbitrary
externally forged Session files or grant execution authority. Final-head gates,
CI and re-review remain required.

`18aad3f9573ba36274f2fa83fc770df37b2e77b5` passed all fixed-head local
gates and both CI platforms ([run 36263232370](https://github.com/dragonbaba/super-pi/actions/runs/36263232370)).
Its actual review identified canonical v1 origins, silent per-file truncation and
multiline/control metadata in summaries. New standalone exact/snapshot/overwrite
results retain a preceding request-hashed canonical origin in the existing Session
progress entries (no second history store or authority). Legacy records without
that origin retain their conservative binding. Expanded patches now label per-file
omission and continue later item headings; metadata fields are escaped single-line
data, while source diffs retain their multiline layout. Thirty-six preview/recovery
tests pass, including actual parent aliases and cwd reopen, a committed 120-line
replacement followed by another success, and newline/bidi metadata. New-head full
gates and actual re-review remain required.

The user's regex/closure audit found seven consumer-side pattern sites (including
one adjacent snapshot pattern), a per-value display replacement callback, and
captured recovery scan callbacks. The expanded AST gate failed at those exact
seven locations before the correction. Patterns now live in the existing
`mutation-guard-write/regex.ts`; display escaping uses one module function.
Recovery uses explicit bounded scans rather than captured map/filter/some/sort
callbacks. The only function-expression exemption in the two new modules is the
named `createChangeViewer` factory inside `showChangeViewer`, once per explicit
user dialog. Render/input/release methods retain their zero-closure gate. The
permission observation callbacks remain one pair per user observation authority,
not per read chunk, render or progress event. No global mutable recovery state or
pool was introduced. Repeated/interleaved display-pattern tests seed `lastIndex`
and verify complete replacement/reset across independent preview owners.

Focused correction run: 48 tests passed before adding the interleaved regression;
the production ToolExecutionComponent fixture performed 20,000 running updates,
ten completion/expansion/resize/release cycles, zero stable-render text changes and
zero retained preview characters after release. Node 22.19 inspector sampling was
400,880 bytes (20.044/update), controlled heap 58,878,880→59,373,224 bytes. This
single lifecycle sample is compliance evidence, not a speedup or zero-allocation
claim. Final correction-head gates/CI/review must still complete.

`8ecd98981c231c12814488ee5847a17d27c46a5b` passed all local gates and
both platform jobs in [run 36265266005](https://github.com/dragonbaba/super-pi/actions/runs/36265266005).
Its actual review found three additional provenance/observation edges. New
standalone v2 write/delete/move intents now carry the full request hash, and
reconstruction requires it; older hashless v2 histories are view-only. Branch
slices use physical indexes, and duplicate entry IDs make recovery ambiguous
rather than authenticating earlier progress. Verification repeats the complete
asynchronous workspace scope/inode/realpath check after the final observations,
then checks synchronous Session/signal authority. This is still not an atomic
filesystem observation. Fifty-two focused tests pass. A real command test swaps
its owned workspace after the final absent-target read; it fails without the new
scope check and passes with it. That precise builtin interception runs in an owned
child to isolate Jiti's cached builtin namespace snapshots. No user workspace or
external process is touched. New-head full checks and review are still required.

The 85ea51676 review's remaining-draft findings are fixed: standalone create
drafts explicitly preserve `mode: create`; mirrored aggregate results must match
the durable custom result's bounded created-directory paths and identity fields;
snapshot location hints use the existing validated reference parser, including
copied `>>> LINE#ID|text` forms. No stale anchor or source text is copied into the
draft. Real partial batch creation plus separately decoded JSON mirror corruption
tests cover removed/path-changed/identity-changed parent metadata. The parser's
two patterns now live in the dedicated regex module and its consumer is added to
the AST gate. No per-event callback or persistent cache is introduced.

The f044d73 review adds six bounded-history regressions. Imported creation counts
must be nonnegative safe integers. Display directory lists visit at most 32 entries
and stop at the remaining presentation budget; verification reports explicitly mark
truncation while the full bounded observation stays in the Session. A failed terminal
append after real creation retains the successful hash and parent identities. A
unique ordered request-hashed standalone origin also binds its v2 partial outcome.
Exact-edit cancellation after real committed bytes now retains a partial terminal
receipt, including the known postimage, instead of losing the result in a thrown
diagnostic. Actual filesystem/Agent regressions cover creation, overwrite completion
failure, exact-edit cancellation and altered origin hashes. Forty-five focused tests,
twelve AST/source cases and check pass on Windows Node 22.19.0. Full checks and a
fresh actual review are required on the resulting commit; no pass is inferred.

The 34b46bed3 candidate passed all local gates and both platform CI jobs. Its next
actual review found six additional reconstruction/presentation boundaries. A later
conflicting terminal now marks the earlier collected item ambiguous; it cannot
silently retain a usable remaining draft. Snapshot post-publication readback failure
retains a verifiable partial terminal. Intent-only creation records preserve bounded
canonical planned parents for both standalone and batch operations. Imported risk
and omission labels are escaped as single-line metadata. Exact-edit drafts preserve
positive expectedLine values only as non-authoritative originalLineHint. Receipt
paths permit real POSIX newline filenames while still rejecting NUL; display remains
escaped and no execution-path restriction is relaxed.

Windows Node 22.19.0 focused validation: 50 pass, one POSIX-only skip; check and all
twelve relevant AST/source cases pass. The actual snapshot failure fixture isolates
its post-rename filesystem interception in an owned child, confirms changed bytes,
and reconstructs/verifies the resulting partial receipt. Intent-only regressions
cover actual standalone and batch creation, including canonical Windows parent
aliases. Final-head whole-project gates, Linux newline execution and actual review
remain required; earlier-head results are not substituted.

The 25be592c6 candidate passed all local gates and both platform CI jobs
([run 36272899767](https://github.com/dragonbaba/super-pi/actions/runs/36272899767)).
Its next review found an aggregate prefilter bypass and an unbound planned-parent
list. Same-call v2 aggregate operation/tool-name mismatches now mark prior receipts
ambiguous before filtering; malformed batch aggregate shapes/item IDs do likewise.
Standalone creation records a request-bound canonical origin with its planned
parents, and batch preparation includes the same list. Intent-only write recovery
requires bounded exact equality with that earlier plan; absent metadata is not an
empty list. Actual single/batch histories test omitted, empty, substituted, reordered
and missing-preparation lists and refuse verification/drafts. These consistency
checks do not authenticate arbitrarily forged Session files. Windows Node22.19:
check passes, 53 focused/source tests pass and one POSIX-only test skips. Fresh
whole-project gates, both CI jobs and actual review remain required.

The 197f5ff0c full local gates and Windows/Linux CI passed (run 36274583276).
Its review found empty/incomplete aggregate lists and an origin masquerading as a
terminal receipt. Collection now admits only intent or phase-result v2 custom
receipts, validates nonempty bounded aggregate items and outcomes, and marks prior
same-call receipts conflicting when they are omitted. A standalone origin must be
distinct from its terminal. Actual histories test empty/missing/truncated/invalid
aggregate lists and origin/prepared/unknown-phase records carrying forged outcome
fields; none can authorize a remaining draft. Targeted recovery tests pass; new
full checks and actual review are still required.

The 2f9b2d010 review found malformed later custom outcomes, forged preview item
status/receipts and unbounded nested assistant content. A call-owned conflict set
(bounded by the 512-entry scan) now retains ambiguity before and after valid
mirrors, including malformed item IDs/version/outcomes and missing timestamps.
Preview items must retain preview status, false stateChanged and no receipt.
Recovery scans at most 128 content blocks per assistant entry, 4096 blocks total
and 512 unique calls; overflow clears request bindings and refuses reconstruction.
Later aggregate activity checks also enforce the existing 16-item bound. Actual
histories and a million-element Proxy array test refusal without accessing its
elements. These are explicit-command/cold bounded collectors, with module-level
helpers and no new regex or callback. Current-head full gates/CI/review remain due.

Latest review corrections bound item IDs before slicing/parsing and inspect all
later call-owned activity, including new origin/preparation entries and unversioned
aggregates. The existing standalone create producer's single v2 durable result +
exact v1 success mirror remains compatible; changed/duplicate/unversioned mirrors
and every later standalone mutation custom entry refuse recovery. Actual histories
and a 2-million-character ID with a slice interception prove the boundary.

The explicit change viewer now prepares bounded numeric grapheme offsets once
(maximum 65,536 code units; 327,685 metadata bytes), then materializes only visible
rows. One viewport-sized cache is reused across unchanged renders and discarded
on replacement/disposal. Resize starts at the current grapheme offset; backward
scroll may scan the bounded current physical line, with no whole-document wrapped
string cache. Full call chain reviewed: explicit changes dialog -> ChangeViewer
render/input -> bounded nextRow/previousRow -> visible substring/truncateToWidth ->
custom component/TUI; no per-frame callback, regex, promise or full-text wrapping.
Constructor segmentation is the explicit-dialog lifetime boundary.

Windows Node22.19 serial allocation profile: 65,536-character input, 22 visible
content rows at width 1, 20,000 stable renders produce zero new rows, 200 changed
viewports produce 4,422 total rows (including initial 22), 136,200 sampled bytes.
Dispose releases body, 327,685-byte scroll metadata, cached rows and both lifecycle
references. GC heap 41,281,448 -> 41,476,440 bytes is an observed process value,
not a zero-allocation or leak proof by itself. Existing actual tool preview fixture:
20,000 progress updates/10 cycles, 380,800 sampled bytes, zero repeated render-text
changes and zero retained derived characters. Focused/source gates: 52 pass, one
platform skip; check passes. New full gates, both CI jobs and review remain required.

The next review closes three Unicode viewport boundaries. Cold preparation now
uses the existing uncached single-grapheme width function, normalizes tabs to
three spaces before indexing and bounds the resulting body to 65,536 code units.
Signed 32-bit widths distinguish newline (-1) from valid widths of 255/256/300;
numeric metadata is now bounded by 524,296 bytes. A 60,001-code-unit combining
cluster plus tabs proves no report key enters Map caches during viewer creation
or rendering; dispose clears its owned text/indices/viewport. Tests also verify
wide-cluster resize and both scroll directions preserve following characters.
This supersedes the earlier metadata-size/profile coordinate; a fresh serial
profile is required. The normal render/input methods introduce no new closure,
regex, promise or wrapper allocations; truncateToWidth's empty-ellipsis path
uses uncached grapheme widths too.

Standalone recovery now checks the complete same-call progress prefix, including
before the selected intent. Only the producer's ordered origin/intent/result
sequence with the bound item, target, operation and request hash is accepted.
Actual failed-delete histories reject extra origin/prepared/unknown/intent both
before the genuine intent and immediately before the terminal; filesystem bytes
remain the observed external change. Current check and focused/source tests pass
(57 pass, one platform skip). The prior Windows CI's responsiveness test failed
its frame-before-child-exit timing assertion; it is recorded as a failure, with
no assertion relaxed. Fresh complete local gates and both CI jobs remain due.

The next review bounds imported request arguments before hashing: fixed fields,
16 batch items, 20 edits, bounded nested lines/text and a 4 MiB scan-wide UTF-8
budget. The collector computes each accepted request hash once and never trusts
an imported hash. Million-element arrays and oversized strings refuse before
element traversal or large hash updates. Imported diffs enter PreviewBudget
without a complete prefixed copy; metadata objects are not coerced to strings.

Live BatchResultText now renders its own bounded plain-text rows instead of
delegating full-report wrapping to Text. A component owns at most 65,536 body
code units and 401 rendered rows, caches one width, and clears source/body/rows
on release. Stable renders create no rows; changed widths scan bounded graphemes
without global width-cache insertion. Actual ToolExecutionComponent coverage adds
20,000 narrow stable renders across ten release cycles. This is a display limit;
the explicit changes viewer remains available for the bounded full report.
No per-update closure, regex or promise was added. A fresh serial allocation
profile is still required for this implementation.

Exact mirrored retained-directory receipts can omit identity on both sides after
a real post-mkdir capture failure. Malformed or one-sided identities still refuse.
Creation records preparation-owned canonical paths even on capture failure, so
Windows short-name aliases do not prevent the actual changes command from
observing the retained parent. Older unproven noncanonical parent paths remain
explicitly unverifiable. Current Windows focused/source checks: 66 pass, one
platform skip; type check passes. Full gates, CI and actual review remain due.
