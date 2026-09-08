# Phase 6B0 operation replay design gate

Task: `SUPER-PI-PHASE6B0-OPERATION-REPLAY-DESIGN-GATE`; E0 design only.
Governing document: `D:/RMProjects/Pi/SUPER_PI_CODEX_PHASED_OPTIMIZATION_PLAN.md`, v1.3, §§2.0, 3.5–3.14, Phase 6 §§6.0/6.2/6.6, §10.
Actual fetched base: `73390a81cf2b7bcfad19f7ccc121bf36a616e890`; main has not advanced beyond the supplied baseline.
Original workspace HEAD: `60b9ccfc670362ed37db8a8fcaf62c4788845a97`; its untracked governing plan is preserved.
Dedicated branch: `phase/6b0-operation-replay-design-gate`; worktree: `D:/RMProjects/Pi-phase6b0-operation-replay-design-gate`.
The target branch, worktree and document were absent before creation; no competing document was found.
6A1/PR #27 remains completed/merged/accepted-area frozen; no acceptance campaign was repeated.
Decision: one bounded session-sidecar operation journal, initially protecting only trusted local `write`.
Status: 6B0 Plan Gate complete / awaiting implementation authorization; this is not production acceptance.
Validation: **Not run; not applicable for E0.** Only documentation consistency, diff whitespace and status checks apply here.

## Source facts: execution and persistence

- `packages/agent/src/agent-loop.ts`: `executeToolCallsSequential` / `executeToolCallsParallel` emit `tool_execution_start` before preparation.
- `prepareToolCall` runs argument preparation/validation, then `beforeToolCall`; denial, throw or observed abort prevents execute.
- `packages/coding-agent/src/core/agent-session.ts`: `_installAgentToolHooks` connects this to `ExtensionRunner.emitToolCall` using the effective argument object.
- `packages/coding-agent/src/core/extensions/runner.ts`: `emitToolCall` propagates handler errors; parameters can change during interception.
- `executePreparedToolCall` awaits the registered tool and progress drain; exceptions become error results, not proof of no effect.
- `finalizeExecutedToolCall` invokes `afterToolCall`; escaping hook errors become error results after execution.
- `emitToolResult` reports ordinary handler errors and continues; hook timeouts escape. Neither behavior reverses a write.
- Execution-end events follow finalization; parallel result messages preserve tool-call order via `Promise.all` and ordered emission.
- `emitToolResultMessage` emits `message_start` then `message_end`; AgentSession performs final host handling/listeners before its two persistence tails.
- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`: `wrapToolDefinition` forwards execution into the definition; it is not a durable boundary.
- `tools/write.ts`: `createWriteToolDefinition` resolves the path, enters `withFileMutationQueue`, awaits recursive mkdir, then UTF-8 writeFile.
- It checks abort after each await; write may have succeeded before an abort error is returned. Its success text uses `content.length`, not UTF-8 byte count.
- `tools/edit.ts`: `createEditToolDefinition` additionally reads/decodes/matches/transforms content, writes it, then computes diff/patch details.
- Repeating write can overwrite intervening edits and change metadata; repeating edit can fail matching or affect a subsequent matching region. Neither is assumed idempotent.
- `tools/file-mutation-queue.ts`: `withFileMutationQueue` serializes registration and per-key promises, using realpath or a resolved missing-path fallback.
- That module's Map is process-local, allows different paths concurrently, and releases in finally only after the callback settles; it is not a process lock.
- `core/session-manager.ts`: `appendMessage` / `appendCustomEntry` -> `_appendEntry` updates fileEntries/byId/leafId before `_persist`.
- `_persist` may defer disk output until an assistant exists; ordinary flushed appends use `appendFileSync` without fsync.
- Initial publication and `_rewriteFile` instead call `writeSessionEntriesAtomically`; ordinary custom-entry append does not use that durability path.
- That helper writes an exclusive temporary file, fsyncs/closes it, publishes via link or rename, then calls `syncSessionDirectory`.
- Directory sync errors are swallowed; this is not a portable power-loss durability guarantee. Do not infer append durability from the import.
- `loadEntriesFromFile` streams bytes but accumulates all parsed entries; malformed lines are skipped and `_buildIndex` retains the session history.
- `createBranchedSession` copies selected entries into a new session/file; tree movement and compaction rebuild context, not external filesystem effects.
- Existing provider retry in AgentSession removes an error assistant from live state and waits; its attempt counter is not stable tool-operation identity.

## Two supported persistence seams; one selection

| Seam | Actual support and limitation | Decision |
| --- | --- | --- |
| Session custom entries | Existing `appendCustomEntry` is non-model metadata, but follows deferred/non-fsynced `_persist`, permissive recovery and whole-history retention. Making it authoritative changes ordinary session persistence semantics. | Reject for the first journal. |
| Session-file sidecar using the existing atomic publisher | `getSessionFile` / `isPersisted` supply the storage anchor; `writeSessionEntriesAtomically` already publishes small files. A narrow internal extraction can reuse it without routing through `_appendEntry`. Owner, strict codec and exclusion are new work. | Recommend this seam only. |

`packages/agent/src/harness/session/types.ts` has `OperationStartedRecord`, `OperationFinishedRecord`, `StepAttemptRecord` and `findOpenOperations`.
Those describe run/compaction/navigation and lane history, not this production write receipt protocol.
`harness/session/jsonl/storage.ts` serializes `appendMutation` through its filesystem append interface; that call does not establish fsync durability.
`harness/agent-harness.ts` exposes resume contracts and rejects some restore paths as not implemented. Do not migrate production execution to it for 6B1.

## First adapter and stable identity

Choose `createWriteToolDefinition` with exact host-built definition identity and `defaultWriteOperations`, not the name `write`.
Exclude custom operations, custom tools, remote paths and unsupported filesystem identity; protected requests fail explicitly rather than silently execute unprotected.
Initial protected payload cap: 256 KiB UTF-8; path metadata cap: 1024 UTF-8 bytes. Larger ordinary writes remain outside the opt-in contract.
Use an existing parent directory and a regular/new local file; reject symlink/reparse ambiguity and non-local filesystems for this first slice.
This narrow admission avoids broadening directory-creation recovery and avoids edit's full-file decoding and potentially large diff receipt.
The normal write algorithm remains unchanged; the adapter adds an internal callback inside the mutation queue before any mkdir/write call.
Create a host operation identity only for a newly accepted logical intent, never by hashing parameters to deduplicate calls.
`operationId = op1:<journalUUID>:<intentUUID>`; store origin session ID, assistant-entry ID/tool ordinal and branch anchor as provenance.
Mint intentUUID once at admission; publish planned before exposing a resumable ID. Repeated delivery of that host intent retains the same ID.
Bind the accepted assistant-entry ID plus tool ordinal to that UUID in the operation record; consult this binding before minting another ID for a redelivery.
The existing appendMessage return value supplies the entry anchor; add only a bounded host handoff. Lost/ambiguous anchors after resume require explicit recovery, not fresh minting.
Two explicitly separate intents receive different UUIDs even with identical parameters; provider toolCallId is only diagnostic provenance.
`attemptId = operationId + monotonic attempt number`; persist the increment with started. Lookup/result delivery does not create an execution attempt.
Retry/resume takes the persisted operationId explicitly; a new run, turn or provider tool-call ID cannot replace it.
Add a narrow host-side `AgentSession.resumeOperation` entry point in 6B1; its parameters must come from retained arguments or explicit resupply and match the stored digest.
After provider retry/process resume, an unbound reissued write cannot silently become a new operation: block until the host identifies resume versus explicit new intent.
Missing original arguments are an unavailable recovery request, not permission to regenerate them or run the model to guess a write.
Bind a versioned fixed-schema digest to exact effective content bytes, normalized addressed path, canonical parent/target and adapter version.
Scope also binds journal/session identity, canonical cwd and origin branch anchor; do not use volatile run/turn IDs as authority.
Reject an existing ID with conflicting parameters, trusted implementation/version or scope. Recheck path binding under the mutation queue.
Hash only the bounded write payload once per admission/resupplied request; no whole-file, repository or transcript hash.

## Owner, storage and declared durability

One optional AgentSession owner anchors `<session-file>.operations-v1/`; in-memory sessions cannot request protected execution.
Use one immutable versioned header and one bounded atomic state/receipt file per operation; this directory is the journal, not an event transcript.
Filenames derive from validated opaque IDs, never user paths. Initial operation creation is exclusive; transitions replace that same record atomically.
Strict records contain version, IDs, revision/attempt, state, scope/digests, bounded error enum and optional durable completion receipt.
Receipt contains adapter/version, operation/attempt IDs, target identity, intended byte count/digest, and a bounded execution-success summary, not file content.
Length framing/checksum detects malformed or accidental damage; it is not authentication against a user who can rewrite the journal.
Private local directory and mode-restricted files protect stored metadata; no content, credentials, permission decisions or progress/deltas are persisted.
Claim **process-crash recovery after acknowledged publication on supported local filesystems**, not portable power-loss/OS-crash or network-filesystem recovery.
New chain: current hooks/arguments -> owner claim/planned publication -> mutation queue -> target validation -> started publication -> normal write.
For started publication, await the extracted publisher's file write/fsync/close and atomic install before entering any side-effect-capable operation.
Then await write settlement -> publish completed with receipt -> return through the existing finalization/message/persistence ordering.
Existing writeFile has no explicit output fsync: completed certifies a successful OS-level write, not that target bytes survive power loss or remain current forever.
Unsupported durability environment rejects protected execution; the publisher's swallowed directory-sync failures must be documented, not upgraded rhetorically.
Any post-effect completion-publication failure poisons the owner and yields unknown; leave durable started and retain the exclusion marker if recording unknown also fails.
An installation/acknowledgment ambiguity is likewise unknown; do not automatically reinterpret an apparently completed file after that fault without explicit reconciliation.
Session append failure cannot turn a durable receipt into no-effect. Conversely, session append success cannot repair a missing operation receipt.

## State machine and crash windows

| Durable observation / interruption | State and permitted recovery |
| --- | --- |
| Before planned is published | No effect permitted; an unissued intent may be admitted, but a supplied missing resume ID is rejected. |
| planned, no started transition | planned: may start only after exclusive ownership, exact arguments/scope and current permission are revalidated. |
| started publication fails or acknowledgment is uncertain | No new effect begins; block the owner. Persisted started is conservatively unknown on recovery. |
| started published, crash before mkdir/write | unknown on recovery: indistinguishable from a crash after effect; never automatic replay. |
| mkdir/write pending, partial write, timeout, abort or throw | failed records observed failure, not no-effect; this adapter offers no automatic failed retry. Uncertain outcome is unknown. |
| Effect succeeded, completed publication absent/failed | unknown; never rerun to obtain a missing result. |
| completed receipt durably published, result event/session append lost | Revalidate receipt and current policy, deliver bounded historical completion without executing write. |
| Receipt missing, corrupt, unsupported or contradictory | Recovery unavailable/unknown; no successful reconstruction and no automatic side effect. |

Allowed normal progression is planned -> started -> completed or failed/unknown; observed unreconciled started becomes unknown after crash.
Pre-effect permission denial leaves planned unchanged (or creates no record); distinguish policy denial from an attempted execution failure.
6B1 intentionally has no automatic failed/unknown retry or compensation; explicit reconciliation is a separate host decision, not a fresh attempt by default.

## Permission, ordering and lifecycle

Normal tool_call permission/confirmation and argument resolution run for first execution and every receipt recovery; historical permission is never cached.
Validate the final arguments again for this adapter after hooks; a changed resume digest is a conflict, not a new operation.
Keep afterToolCall/tool_result and message events active on receipt delivery; hook errors may alter presentation but never authorize repeating the effect.
Persist the adapter's durable factual receipt before mutable result hooks; it is not a promise to restore arbitrary extension-mutated canonical messages.
Do not require or reuse a G2 resident artifact, 6A1 notice, or evidence durable fallback as an operation receipt.
Do not claim fewer model-issued calls or arbitrary token savings: write already has a short result; replay protection primarily avoids repeated effects.
Acquire an exclusive `wx` owner lock in the sidecar before protected work. A second writer fails busy; do not silently share a journal or steal a stale lock.
Crash recovery requires explicit stale-owner reconciliation proving the previous writer stopped; PID/timeout alone is insufficient. No background lock stealing.
Keep at most one active protected operation and zero queued duplicate waiters; concurrent duplicate requests get busy, then can query the completed receipt.
Lock order: journal ownership -> operation admission -> existing file mutation queue; no session-persistence callback may acquire these in reverse.
This does not exclude editors or unrelated processes touching the target; reject detected identity changes and do not claim a cross-resource transaction.
Resume of the same session reopens its journal independently of transcript pruning; a missing journal is unavailable, never an empty replacement for old IDs.
Tree navigation/compaction must not clear durable operation facts. Historical recovery retains origin scope rather than adopting a new branch generation.
Cross-branch reuse requires an explicit origin recovery request; fresh branch intent is distinct. Forks get a new authority and reject parent operation IDs in v1.
Do not copy parent started/completed facts into a fresh namespace as permission to execute. Renamed/moved session storage needs explicit rebinding, not automatic recreation.
On switch/fork/tree/dispose, stop new admissions; settle the active filesystem operation and terminal publication before releasing owner resources.
On poison/crash, keep the durable lock marker for reconciliation. Clean shutdown releases handles, callbacks, active arguments/receipt and caches.

## Bounds, corruption and compatibility

Resident cache: at most 128 metadata entries / 64 KiB accounted metadata; no complete history, payloads or receipt arrays retained by the cache.
Active work: one operation, at most 256 KiB borrowed effective input plus one <=8 KiB record buffer; detach all references after settlement.
Individual record <=8 KiB, receipt <=2 KiB, header/lock <=1 KiB each; one in-flight temporary record <=8 KiB.
Journal: at most 1024 operation files, <=9 MiB logical bytes including staging/header/lock; count files as well as bytes (filesystem block overhead is separate).
No disk eviction, TTL deletion or automatic rotation in v1. At capacity refuse new protected intents; reserve replacement space for existing operations' terminal states.
Memory LRU only drops lookup metadata; durable records remain authoritative. Missing resume IDs always reject, even if previously evicted from memory.
Recovery streams at most 1024 names and reads one bounded record at a time; reject oversize files before parsing and never load a transcript to rebuild this journal.
Unknown files/revisions, checksum failures, duplicate identity or impossible transitions fail closed; do not use SessionManager's skip-malformed parser.
An incomplete temporary publication or stale lock requires reconciliation; never delete evidence of uncertainty automatically to make startup succeed.
Journal deletion, rollback from backup, malicious replacement and cross-host replication are unsupported; no guarantee against removal of the durable authority itself.
Version `op1` is independent of session JSONL/provider schemas. Unknown major versions reject; additive fields require defined reader compatibility, not permissive casts.
Do not automatically migrate old records, recycle IDs, or reinterpret failed/unknown as planned. Any migration must preserve the deny-replay facts and receipts.

## Minimal 6B1 scope, authorization and rollback

Expected production files: new `core/operation-journal.ts`; `core/session-manager.ts` solely for internal publisher extraction/access to its existing anchor;
`core/agent-session.ts` for host intent/resume, exact trusted registration, receipt delivery and owner lifecycle; `core/tools/write.ts` for the queue-local boundary.
If extraction needs a shared file, use one internal `core/atomic-session-file.ts`, without changing existing SessionManager callers' behavior.
Expose opt-in through the existing SDK construction path in `core/sdk.ts`; default off, no settings UI, provider/tool-schema ID fields or general adapter framework.
Request narrow authorization for the new persistent sidecar/host resume API and additive write/session ownership seams before implementation.
The two accepted 6A1 persistence tails, fallback provenance, compaction semantics and mutation invalidation must remain behaviorally unchanged; broader changes need a new scope decision.
Rollback disables new admission, preserves the journal and blocks protected resume; old binaries cannot safely resume protected sessions merely by ignoring the sidecar.
Require an operational prohibition on resuming those sessions under an unaware binary until reconciliation; never delete the journal as rollback or fall through to ordinary write.

## Future minimum validation budget and non-goals

6B1 only: one focused deterministic red→green set using existing agent/session/tool fixtures plus a small journal fault-injection fixture; no Cartesian campaign.
Cover stable/new/conflicting intent IDs, same-ID concurrency, permission/argument changes, each crash window, missing/corrupt receipts, hook errors and result ordering.
Cover lock contention/stale ownership, resume/fork/tree/compaction, capacity refusal, terminal-space reservation, poison/disposal and disabled/read/progress zero feature work.
Run applicable check/build once the candidate stabilizes; use normal exact-head Linux/Windows CI for full tests, retaining all required steps without duplicating a green full suite locally.
As E2, require deterministic effect/record/attempt/allocation counters, one focused allocation profile and one lifecycle/controlled-GC fixture on the new ownership chain.
One bounded paired timing set for disabled, first protected write and receipt recovery; report fsync/metadata I/O cost and absolute latency, not presumed speedup.
Reuse unchanged frozen evidence only with explicit applicability; no phase-only CI, historical 6A1 campaign, repeated review on unchanged SHA or sampling until success.
Future Candidate review once plus one incremental closeout budget includes automatic reviews; unresolved reproducible B0/B1 still block acceptance.
Non-goals: edit adapter, 6A2, shell/network/MCP exactly-once, automatic unknown reconciliation, multi-host locks, Harness v2 migration, Phase 7/8, or progress persistence.
Retain `D-6A1-LINUX-IDENTITY-ELIGIBILITY` deferred. Stop here: no production changes, tests, dependency installation, commit, push or PR in E0.
