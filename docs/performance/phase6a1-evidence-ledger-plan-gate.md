# SUPER-PI-PHASE6A1-EVIDENCE-LEDGER-CORE-READ

Status: **OPTION B ACCEPTED: bounded existing G2 artifact-integrity validation on resident evidence hits; no conditional canonical-content immutability.** Continue the existing Goal, branch and worktree. The completed Phase 5C-B Goal is untouched.

## Exact preflight

Fetched origin before other work on 2026-09-07. Repository: dragonbaba/super-pi.

- Actual fetched origin/main: `172c52341249414d236eeb9153516bfd10087782`.
- First parent: `946442c7cd41c77dde26d2b8fbce442211dfef7d`.
- Second parent: `8b62e61b86a3293735fe4b4ebb7c0641142074ee`.
- Merge tree and second-parent tree both: `3751becc07c39ac62703195c6d60ed41fa1cfa5b`.
- Ancestor check passed. No intervening commits. `git ls-remote origin refs/heads/main` also returned the observed merge before worktree creation.
- [Final-main CI 34122081849](https://github.com/dragonbaba/super-pi/actions/runs/34122081849): completed/success, push/main, headSha exactly the merge above.
- [verify-linux](https://github.com/dragonbaba/super-pi/actions/runs/34122081849/job/101742206035): completed/success; exact-candidate step success; completed 2026-09-07T12:38:43Z.
- [verify-windows](https://github.com/dragonbaba/super-pi/actions/runs/34122081849/job/101742206357): completed/success; exact-candidate step success; completed 2026-09-07T12:43:52Z.

Phase 5A / 5B / 5C: **Completed / merged / accepted-area frozen**.

Authorized worktree: `D:/RMProjects/Pi-phase6a1-evidence-ledger-core-read`.
Branch: `phase/6a1-evidence-ledger-core-read`.
Initial HEAD and merge-base equal the baseline above. The original workspace's older local main and untracked `SUPER_PI_CODEX_PHASED_OPTIMIZATION_PLAN.md` remain untouched.

## Ten-point source Plan Gate

### 1. Built-in construction and execution

`createAgentSession` (core/sdk.ts) creates Agent and AgentSession. AgentSession `_buildRuntime` constructs `createAllToolDefinitions(cwd, options)` unless base-tool overrides were supplied. The built-in `read` definition comes from `createReadToolDefinition` (core/tools/read.ts). `_refreshToolRegistry` passes built-ins through `wrapRegisteredTools` -> `wrapRegisteredTool` -> `wrapToolDefinition`. Custom definitions are installed afterwards and may replace the name `read`.

Agent loop: `executeToolCallsSequential` or `executeToolCallsParallel` -> `prepareToolCall` -> `executePreparedToolCall` -> wrapped AgentTool.execute -> definition.execute -> local read implementation.

Local read: `resolveReadPathAsync` -> access check -> MIME detection -> `readSmallFileIfStable` for bounded small text; cursor/large text uses `readWindow`; images use the existing image path. Custom ReadOperations use the separate operations path and are not eligible. The portable harness read in packages/agent/src/harness/tools/read.ts is a separate implementation and is outside 6A1.

### 2. Actual ordering

`tool_execution_start` precedes argument preparation/validation and `beforeToolCall`. AgentSession's before hook invokes ExtensionRunner.emitToolCall. Policy/confirmation implemented by tool_call hooks runs here; there is no separate universal read-confirmation call in agent-loop.ts. Local filesystem access checking currently occurs inside the actual read execution. It must still be respected by the adapter.

After interception, execute receives the validated argument object, including in-place changes to that object made by tool_call hooks. A blocked/throwing hook produces an immediate error result and never begins execution. Successful execution is followed by `afterToolCall` -> `emitToolResult` -> image normalization -> finalized result -> `tool_execution_end` -> `message_start` -> `message_end`.

Agent.processEvents stores the ToolResultMessage in agent state before dispatching message_end. AgentSession runs message_end extension interception, final host canonicalization/presentation, session listeners, then SessionManager.appendMessage. The presentation branch has its own append-and-return tail. Parallel calls emit execution ends as they finish, then result messages in call order.

The proposed adapter belongs inside execute, after the policy hook, and returns through this unchanged tail. Unknown/mutating-tool invalidation belongs at execution entry, not tool_execution_start, because the latter precedes denial.

### 3. Read details and file generation

Schema: path, optional offset, limit, cursor. There are no independently configurable byte-window options. Details contain optional truncation and window metadata (ReadWindowResult without text). Window metadata includes line/byte range and continuation information; it does not expose the validated complete file-generation tuple as a separate evidence field.

read-window.ts generation is `dev:ino:size:mtimeNs:ctimeNs:birthtimeNs`. Both the bounded small-file snapshot and large scanner compare descriptor metadata before/after reading, re-resolve the real path and compare target metadata. Cursor scope binds canonical workspace and session. Reuse must preserve this behavior, not duplicate the scanner. Adapter argument material must include the bounded cursor hash when present, never retain or expose the raw cursor; omitted offset and explicit offset=1 may normalize together. Omitted limit must not be equated to a guessed limit because notices/window semantics can differ.

### 4. Session identity

SessionManager exposes getSessionId, getCwd, getLeafId, getLeafEntry, getEntry and getBranch. Entries have stable id/parentId identities; appendMessage returns the entry ID. getBranch walks the current leaf's ancestry and includes historical entries, while buildSessionContext/buildContextEntries account for compaction. Neither historical presence nor an unchanged toolCallId proves effective-context accessibility.

### 5. Existing G2 owner APIs

AgentSession already owns ToolResultPresentationOwner. `create(content, toolCallId)` admits canonical source/projection records. `readArtifact(id, messages)` resolves a session-bound descriptor against an active message list. Internally: resolveArtifactRecord -> validateArtifactRecord -> validateContinuationRecord plus validateArtifactIdentity; ensureArtifactDescriptor can issue a descriptor using an existing source scan, without copying content, under existing retention limits. clearProjectionRecords/dispose release records.

Critical constraint: validateArtifactIdentity hashes all ordinary text blocks again. validateContinuationRecord alone checks array/source identity and uniqueness, not in-place text mutations. The owner supports mutable ordinary text sources today; it does not freeze them.

### 6. Invalidation seams

AgentSession manual compaction and successful automatic compaction already call clearProjectionRecords after rebuilding messages. navigateTree clears it at successful tree replacement. AgentSessionRuntime tears down/disposes the old session on replacement (including fork/session switch); new AgentSession construction starts fresh. AgentSession.dispose disposes the owner. A v1 ledger would clear at those same successful boundaries and dispose, and on tool-registry rebuilding conservatively. Session/cwd checks remain necessary for direct SessionManager replacement. Mutation-capable execution increments workspace generation before any possible side effect, including failed/aborted executions. No shell parsing, watchers or in-flight waiters.

### 7. Trusted identity

`_baseToolDefinitions` and separately constructed registeredBuiltInTools provide an internal identity seam. Eligibility would bind the exact locally constructed built-in definition and its exact wrapped AgentTool, with base overrides and custom shadowing excluded. Definition names and synthetic sourceInfo alone are insufficient. No public opt-in marker is needed, and custom ReadOperations cannot opt in.

### 8. Proposed production files

- New core/evidence-ledger.ts: bounded metadata-only completed records and numeric diagnostics; session-owned, in-memory, insertion eviction; 128 records, 256 KiB metadata, 64 locations / 8 KiB location characters, 64 KiB argument input.
- core/agent-session.ts: optional ownership, trusted execution adapter, post-finalization admission, invalidation and disposal.
- core/settings-manager.ts: only evidenceLedger.enabled, false by default; disabled construction does not instantiate the ledger or install its execution adapters.
- core/tool-result-presentation.ts: the approved resident-only existing-source handle and integrity API.
- core/tools/read.ts and core/tools/read-window.ts: private symbol metadata handoff from the existing validated descriptor lifecycle. Scanner output and public cursors remain unchanged.

Focused tests, one benchmark/allocation fixture and contract/review documentation would be added separately. Red tests must be committed before implementation. No changes proposed to JSONL, provider wire, public artifact/cursor formats, TUI, MCP, deferred adapters or operation-id.

### 9. Proof of model accessibility

Preferred conservative route: a valid existing G2 artifact for an exact unique source still active in agent.state.messages, whose content integrity can be proven. A handle is a reference to the existing owner, never another content owner. Missing/ambiguous/replaced sources or evicted/unavailable handles mean miss. Mutable tool_result/message_end handlers disable lookup and admission; observer-only subscriptions do not. Context-transform hooks require conservative treatment too.

An active-context-only fallback cannot simply consult agent.state.messages: SDK transformContext, convertToLlm and G2 contextual projection determine the effective model messages. It needs separate proof at that boundary; historical SessionManager storage is insufficient. To avoid changing provider/projection behavior, initially require the artifact route whenever effective-context identity is not proven.

No shortcut around mutable-source integrity is proposed. A source that is still the same array and message object can contain different text, and referring to that content as prior file evidence would be stale reuse.

### 10. agent-loop.ts

No change is currently proposed. The existing execute boundary receives final effective arguments after interception and preserves execution/message lifecycle for short returned results. The exact synchronous ledger methods must not add Promises, closures, controllers or timers; filesystem-bound adapter work and existing wrappers must be counted separately across the full call chain.

## Source-integrity decision (resolved by user)

Evidence: tests/tool-result-artifact.test.ts, test `resident artifact reads reject in-place source block mutation`, mutates an ordinary resident text block in place and requires the existing owner to reject the artifact. It asserts artifactIntegrityScans increments on both reads. core/tool-result-presentation.ts validateArtifactIdentity calls createHash and streams every ordinary text block through appendSourceIdentityBlock. Agent.state exposes the live message objects; only observer snapshots are cloned/frozen.

Consequently, the current zero-full-result-hash / zero-source-retention contract cannot safely be satisfied by replacing G2 validation with reference equality for ordinary mutable sources. Freezing those sources changes observable mutation behavior; reusing existing validation adds full-result hashes on hits. A second snapshot/store is prohibited, and an always-miss implementation fails the requested effectiveness gate.

The user approved Option B. Ordinary canonical arrays and blocks remain mutable. Evidence requires the existing configured session G2 owner. The new API is resident-only, checks a bounded text envelope before hashing, validates exact active-source identity and uniqueness, and performs at most one existing integrity scan per resident candidate. Eviction/clear is a miss, with no history reconstruction. File-generation mismatch precedes G2 validation and performs zero integrity scans.

The read scanner may hand off metadata from the same descriptor lifecycle that validated the returned content, using an internal nonserializing callback. It must not use a standalone post-read stat to assign source generation. No buffers, results, cursors or contexts enter this handoff. All four meaning/context-mutating hooks (tool_result, message_end, context, before_provider_request) bypass lookup/admission; registry rebuild clears metadata. Disabled mode constructs no ledger/adapters and adds no stat/hash work. G2 integrity scans/bytes are accounted separately from bounded argument/scope hashes; complete file hashes, ledger-owned result hashes, copies and result serialization remain zero.

The approved execution plan is: separate deterministic red-test commit; bounded core and resident G2 API; trusted local-text adapter plus exact validated identity handoff; focused invalidation/lifecycle coverage; three benchmark configurations, one allocation profile and one controlled-GC fixture; candidate checks, Draft PR and review within the original strict budgets. Candidate Review and final-head CI remain future work; this is not the Draft Candidate Gate.

## Development finding: Windows stat does not prove a change generation

The real same-size mutation fixture exposed stale reuse with a stat tuple that appeared precise. A targeted 12-write reproduction on this Windows host observed multiple successive closed writes retaining identical dev, inode, size, mtimeNs, ctimeNs and birthtimeNs. Fractional nanosecond digits did not establish actual update precision. Microsoft also documents deferred last-write timestamps while writing handles remain open: https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times .

The uncertainty rule therefore requires Windows stat-only local reads to miss. Windows executes normal reads before any new argument hash, extra identity stat, or identity capture. It does not adopt a guessed age threshold, freeze canonical messages, hash the source file, or invent a native change-ID capability. The scanner's public behavior remains unchanged. Windows compatibility, permission, mutation and owner/core tests still run; real-file hit effectiveness requires Linux verification, and two real-hit tests explicitly identify their Windows unsupported-identity skip. This is a material v1 limitation, not a claim of Windows speedup.

The current host has no installed WSL distribution. A narrowly scoped push workflow runs only the evidence tests on Linux during development; the existing exact Linux/Windows candidate CI remains unchanged. Development has now consumed the single allocation profile, single controlled-GC fixture, and single local full-suite invocation. Results and remaining candidate gates are recorded in the companion candidate packet. Three positive real-file reuse tests explicitly skip on Windows; the other compatibility and mutation fixtures run.

## Implemented decisions

The production file set above is final. Ledger records use 192 KiB of the 256 KiB session envelope; completed metadata-only read handoffs awaiting final message_end have a separate 64 KiB reservation and are never lookup candidates. Both have bounded entry counts and clear together. There is no in-flight Promise map.

Admission is anchored to the G2 resident generation immediately after final host admission, before display listeners. A listener replacing/rebuilding the source cannot turn transformed content into file evidence. Ordinary content remains mutable and later in-place mutation fails the existing integrity scan. Evidence only uses the artifact route; it makes no direct active-model-context accessibility claim.

The original red tests were committed separately at 25e5474, before production implementation. agent-loop.ts, provider adapters, public extension types, session JSONL, cursor/artifact formats and accepted Phase 5 projections remain unchanged. The Option B decision is accepted, not pending.
