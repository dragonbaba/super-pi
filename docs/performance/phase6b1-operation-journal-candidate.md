# Phase 6B1 operation journal / local write candidate

Task: `SUPER-PI-PHASE6B1-OPERATION-JOURNAL-LOCAL-WRITE`.
State: implementation candidate; exact native Linux evidence and Candidate Review pending.
Base and merge-base: `73390a81cf2b7bcfad19f7ccc121bf36a616e890`.
The initial fetch found no intervening main changes. PR #27 acceptance was not repeated.
Branch: `phase/6b1-operation-journal-local-write`.
Worktree: `D:/RMProjects/Pi-phase6b1-operation-journal-local-write`.
Development environment: Windows, Node v26.4.0, npm 12.0.1; locked dependencies installed once.
Exact candidate SHA, changed-file/stat inventory, CI links and measured results belong in PR metadata.
Governing v1.3 plan and hot-path contract apply. The carried 6B0 plan is unchanged.
Supplemental approval resolved the host-dispatch blocker: two narrow agent-core seams plus necessary signatures are authorized.

## Host API and origin binding

```ts
const { session } = await createAgentSession({ operationJournal: { enabled: true }, /* ordinary SDK options */ });
const intent = { intentId: hostApprovedUUID, originBranch: originalBranchAnchor, path: "existing-parent/file", content: "bytes" };
const completed = await session.newOperation(intent);
const historical = await session.resumeOperation(completed.operationId, intent);
```

The host durably retains intentId, originBranch and the intended arguments before redelivery.
A genuinely new intent gets a new UUID, even with identical arguments. Re-delivery reuses the same intent UUID.
A failed delivery without a returned ID can re-deliver NEW with that same UUID; this is identity lookup, never an implicit new intent.
`operationId = op1:<journalUUID>:<intentUUID>`; `attemptId = operationId + :1` on started.
Only one execution attempt is supported. Result delivery/recovery does not increment it.
The binding digest covers adapter policy v1, origin session/cwd/branch, addressed absolute path and UTF-8 content digest.
Final post-tool_call arguments are captured as primitive strings, bounded and hashed before any effect.
Planned persists the canonical parent fingerprint and initial target generation separately from the stable binding.
A new target inode after successful creation does not invalidate completed recovery.
Missing, foreign, conflicting, corrupt, failed or unknown IDs never mean fresh work.
No assistant/run/turn/provider-call anchor is needed to reconstruct identity; no transcript scan or second provider request is used.

## Actual execution and recovery chain

1. SDK opt-in reaches `AgentSessionConfig.operationJournal`; absent/false creates no journal or gate.
2. `AgentSession.newOperation` / `resumeOperation` synchronously claim the host request slot and check trusted active registry identity.
3. `Agent.dispatchHostTool` enters the existing `runWithLifecycle` owner before its first await.
4. `runHostToolDispatch` emits agent/turn start and one explicitly host-origin association using the existing message shape.
5. `executeToolCalls` reuses preparation, incomplete-argument rejection, validation and current beforeToolCall permission hooks.
6. `createWriteToolDefinition.execute` captures path/content, enters `withFileMutationQueue`, then invokes its private gate.
7. `OperationJournal` opens/validates the sidecar, claims its active slot, validates identity and publishes planned if NEW.
8. Completed reads validate the bounded durable receipt and deliver a historical notice without target reads or writes.
9. Planned work validates the admitted parent/target; publishes started through file fsync and atomic install; rechecks binding.
10. The default local writeFile executes and settles inside the same queue interval; existing-parent protection needs no mkdir.
11. The owner publishes its bounded factual completed receipt before mutable afterToolCall/tool_result/message_end handling.
12. Normal execution end, result message start/end, session persistence, turn end and awaited agent end complete delivery.
13. Agent cleanup resolves waitForIdle; AgentSession releases operation ownership and its call-local handoff in finally.

Host dispatch never polls steering/follow-up queues, prepares another provider turn, or invokes AgentSession post-run retry/compaction.
Host failures propagate instead of generating an assistant error response. Result delivery errors cannot revoke a completed receipt.
The host association uses api `host-operation`, provider `host`, model `local-operation`, with zero provider usage.
It selects one call and rejects association/sibling changes during initial delivery; it never replays old assistant siblings.
Arbitrary user extensions may themselves perform network work; the host entry does not promise to prevent that.

## Storage, durability and reconciliation

One `<session-file>.operations-v1/` directory owns a strict versioned header, exclusive wx lock and one state file per intent.
`writeSessionEntriesAtomically` was narrowly extracted to `core/atomic-session-file.ts`; ordinary SessionManager callers keep their behavior.
Operation publication uses that exact write/fsync/close/link-or-rename chain and retains failed staging evidence.
Directory fsync remains best-effort; completed certifies an acknowledged OS-level write, not target fsync or power-loss survival.
The lock is acquired directly with wx before staging, so competing constructors do not allocate competing temporary publications.
Records have strict fields and a checksum envelope; bounded descriptor reads use cap+1 buffers, not stat followed by readFile.
Malformed/unknown fields, oversize files, hardlinks, foreign scope and unexpected directory entries fail closed.
This is process-crash-after-acknowledgment protection on supported local filesystems, not a transaction with external editors.
An effect may have occurred after any write error, timeout or abort. Those outcomes never authorize automatic retry.
Publishing completed failure poisons the live owner and preserves the lock; recovery sees started/unknown or inconsistent staging.
The host must independently establish prior-writer termination AND exclusive maintenance access before stale-lock reconciliation.
`OperationJournal.inspectWriter(sessionFile)` is read-only. Supplying its exact token as `stoppedWriterToken` explicitly attests those preconditions.
No PID/age inference, automatic stealing, background reconciliation or startup deletion of corrupt/staging facts exists.
Concurrent manual reconcilers are unsupported; the host must fence them externally. This is not a general lock service.
After explicit reconciliation, completed receipts may be delivered; started/failed/unknown still cannot execute.

| Interruption | Durable fact and permitted action |
| --- | --- |
| Before planned acknowledgment | No effect; missing explicit resume ID rejects. |
| Planned only | Revalidate original binding/current policy before starting. |
| Started publication ambiguity | No effect begins; poison and preserve ownership. |
| Started acknowledged, before effect | Recovery sees unknown; no replay. |
| Partial write/throw/abort | Failed or unknown is not proof of no effect; no replay. |
| Write succeeds, completed absent | Unknown; never rerun to obtain a receipt. |
| Completed acknowledged, result/persistence fails | Current policy plus durable historical receipt; no replacement write. |
| Corrupt/missing/foreign record or failed staging | Unavailable; preserve facts for manual reconciliation. |

## Eligibility, scope and lifecycle

Private symbol identity is created only by the default local write definition; custom operations cannot acquire it.
AgentSession also requires the exact active built-in definition/registry object; a custom tool named write is not eligible.
An unbound write in a protected session refuses and asks the host for NEW versus recovery intent.
Native Linux support is limited to verified ext-family, XFS, Btrfs or tmpfs identities and existing nonsymlink parent directories.
Every path component must be a real directory; targets must be regular single-link files or absent. The journal must be private.
Protected writes cannot modify their own journal or session authority file.
Native Windows and other platforms explicitly refuse; Windows CI is refusal/compatibility evidence, not protected-write support.
External editors are not excluded. Detected identity contradictions refuse; arbitrary malicious filesystem replacement is unsupported.
Compaction/tree movement cannot erase the sidecar. Explicit recovery retains the host-supplied original branch binding.
Fork/session changes cannot inherit authority; a changed session ID refuses. New SDK session instances anchor their own sidecars.
Dispose blocks admissions and preserves active ownership until underlying write/publication settles.
Retired definitions retain a stable refusal gate rather than reverting to ordinary execution; session callbacks are released.

## Bounds, allocation and compatibility

Payload <=256 KiB UTF-8; path input and resolved path each <=1024 UTF-8 bytes; origin anchor <=128 bytes.
Record <=8 KiB; receipt <=2 KiB; header and lock <=1 KiB each; at most 1024 durable operation files.
Logical reservation is 1024 * 8 KiB + 8 KiB staging + 2 KiB header/lock = 8,398,848 bytes, below 9 MiB.
New intents refuse at capacity. No durable LRU, TTL, rotation or record deletion; terminal replacement room remains reserved.
The selected implementation has zero resident history/cache entries, below the 128-entry limit; every lookup reads one bounded record.
Owner metadata is accounted separately and stays below 64 KiB. One active protected operation; no duplicate waiters.
No payload, complete result, progress/delta event, transcript array or G2 handle is stored in the journal.
Operation-level allocations include async calls, the existing run AbortController/deferred, queue callbacks/promises, bounded buffers,
JSON envelope/record objects and strings, payload digest state, filesystem wrappers and the short result/host association.
These are real durability costs, not an allocation-free path or presumed CPU/model-token optimization.
No new per-delta/progress callback, timer, journal lookup or hash is added to read/provider/render paths.
File-fsync counters exclude additional best-effort directory sync; timing includes the full real host path.
Version op1 is independent of session JSONL/provider schemas. Unknown versions/fields reject; no automatic migration or ID recycling.

## Verification and remaining gate

Deterministic red commits precede production. Focused host tests cover policy, changed arguments, busy/idle, failure and sibling isolation.
SDK tests cover default-off ordinary write, refusal, current hooks, first execution/reopen, and receipt survival after presentation/persistence errors.
Journal tests cover capacity, strict oversized reads, separate/conflicting intents, partial failures, symlinks and active disposal.
One task-owned subprocess fixture cuts actual publication/effect execution at started, partial, unpublished-completed and completed.
Only the exact exited child is reconciled. Linux-only tests are explicitly skipped on Windows.
One E2 fixture runs 10 warmup and 30 paired samples for disabled/first write/recovery, then one five-cycle allocation profile
and one controlled-GC journal WeakRef release check. Its compact result is emitted as `OPERATION_JOURNAL_E2` in normal CI logs.
No local Linux measurement has run. No WSL distribution is installed; no native support claim is inferred from overrides.
Local check passed after a test typing correction; offline build passed. Focused Windows tests passed with Linux-only cases skipped.
Representative existing Agent streaming tests passed unchanged. No local full npm test, historical phase campaign or manual CI rerun.
Normal exact-candidate Linux/Windows CI, native execution/crash/performance evidence and cumulative Candidate Review remain pending.
B0/B1: acceptance remains blocked on that evidence and any reproducible review finding. C: packet closeout. D: only deferred work below.
No Draft Candidate Gate claim until the required evidence is complete; one cumulative Review and at most one closeout are budgeted.

## Frozen areas, non-goals and rollback

6A1 Option B, same-ID/live-provenance/durable-fallback, bounds, permission/path/compaction/session/default-off behavior remain frozen.
`D-6A1-LINUX-IDENTITY-ELIGIBILITY` remains deferred. No 6A2/edit/shell/network/MCP replay, Harness migration, Phase 7/8 or general exactly-once claim.
Rollback baseline is 73390a81cf2b7bcfad19f7ccc121bf36a616e890, but rollback is NOT permission to replay protected sessions with an unaware binary.
Disable new admission, preserve the sidecar, and require explicit reconciliation before any recovery. Never delete journal facts to enable startup.
No Ready, merge, auto-merge, force push, history rewrite, branch/worktree deletion or next-stage work is authorized.
