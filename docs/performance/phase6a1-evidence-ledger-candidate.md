# Phase 6A1 conservative read evidence candidate

Goal: SUPER-PI-PHASE6A1-EVIDENCE-LEDGER-CORE-READ. Draft only. No ready/merge authorization.

## Revision and scope

Actual base and merge-base: `172c52341249414d236eeb9153516bfd10087782`. Production implementation through `0526eddc5a5b359c1143773995496a8027158b96`; benchmark harness through `9ac6c743cce7b122559e5188906e2886e2668d04`. The PR packet records the exact candidate commit containing this document and exact-head CI URLs, avoiding a documentation-only commit after CI. The [Plan Gate](phase6a1-evidence-ledger-plan-gate.md) preserves the preflight, merge parents/tree and accepted Option B decision.

Phase 5A / 5B / 5C: completed, merged, accepted-area frozen. No changes to agent-loop.ts, provider wire/adapters, session JSONL, ToolResult dual views, contextual budgeting, public artifact/cursor formats, read stale-file semantics, MCP adapter/progress/ceilings/canonicalization, terminal/Markdown/TUI lifecycle. The existing read scanner only adds the authorized private metadata handoff. G2 only adds resident evidence accessors. No immutable-message mode, freeze, seal or property restrictions on canonical content.

Production files: core/evidence-ledger.ts (new), core/agent-session.ts, core/settings-manager.ts, core/tool-result-presentation.ts, core/tools/read.ts, core/tools/read-window.ts. Supporting files: seven evidence test suites, one fixture helper, one historical benchmark script, this packet and the Plan Gate. The phase-only development workflow was removed during cumulative closeout. Exact changed-file list and diff stat are in the PR body.

Rollback point: the base above. Disabling `evidenceLedger.enabled` returns to ordinary reads; a fresh disabled session creates no ledger or execution adapter. A revert would require separate authorization. No rollback operation was performed.

## Execution and policy

Before: createAgentSession -> AgentSession._buildRuntime -> createAllToolDefinitions -> createReadToolDefinition -> _refreshToolRegistry -> wrapRegisteredTools/wrapToolDefinition -> agent loop execution -> local read -> readSmallFileIfStable/readWindow -> normal result/message tail.

After: the same registry and loop -> lifecycle-created trusted execution adapter -> synchronous ledger metadata lookup -> targeted file check -> resident G2 validation -> bounded reference on hit, or the original read on miss. The read's private symbol carries only validated file metadata to the session. Completed metadata awaits final message_end; it is not a record available to concurrent lookups.

Actual ordering remains: tool_execution_start -> argument validation -> permission/confirmation implemented by normal tool_call interception -> final effective arguments -> execute adapter -> tool_result interception -> normal normalization -> tool_execution_end -> message_start -> message_end. Agent state already contains the canonical ToolResult when AgentSession handles message_end. Extension mutation and final host canonicalization precede G2.create. Display listeners run, session persistence appends the final message, and only then evidence admission occurs. Critical agent_end delivery remains awaited before receipt cleanup.

There is no separate universal permission API in the current agent loop. Denied tool_call interception never enters the adapter. Every hit still runs interception and filesystem read access checking. Permission outcomes are not retained. Mutation-capable tools invalidate at execute entry, after possible denial and before possible side effects. `tool_call` argument mutations are keyed from the final values; primitive arguments are captured and checked again after awaits.

Trusted identity requires the exact locally constructed built-in definition, its exact wrapped built-in registry object, and no base-tool override. A custom tool named read fails identity. Images, custom ReadOperations, remote/virtual operations, binary windows, errors and aborts cannot produce eligible identity. Shell, MCP, network, write/edit, custom and unknown tools cannot reuse and increment workspace generation before execution. Direct user shell execution does the same.

Installed tool_result, message_end, context, before_provider_request, tool_execution_end or message_start mutation handlers bypass both lookup and admission. Observer-only display subscriptions remain allowed. Registry rebuilding clears all metadata. Admission captures G2's resident generation before display dispatch and rejects replacement/rebuilt records afterward. Same-array text mutation remains legal and fails the subsequent integrity scan.

## Ownership, bounds and handles

One optional ledger per AgentSession. All records contain allowlisted primitive metadata only: v1 kind/id, argument hash, scope hash, result handle ID, source tool-call ID, G2 resident generation, relative path/location, turn and branch/workspace generations, canonical path/file generation/session/cwd, bounded envelope and numeric token/byte estimates. No source array, text block, Buffer, ToolResult clone, message, transcript, owner, extension context, permission result or cursor is retained.

Bounds: 128 ledger entries; 192 KiB conservatively accounted record metadata, reserving 64 KiB for completed handoff receipts within the aggregate 256 KiB session envelope. Receipts also cap at 128 and never contain a Promise. One location string per record (smaller than the allowed 64), at most 8192 characters; argument and scope input each at most 64 KiB. Per-field caps reject overlarge IDs/paths. Admission detaches bounded metadata strings so sliced input cannot retain a giant backing string. Insertion-order eviction; no object pool. Clear/dispose zero entries and metadata accounting; counters retain only numeric diagnostics.

G2 must already be configured for this exact session. No owner means ordinary read and artifact-unavailable miss, no record or evidence hash; no hidden owner/budget/registry is created. `issueEvidenceArtifact` only uses an already resident final canonical record and existing descriptor construction/retention. `validateEvidenceArtifact` checks resident generation, exact source array, unique active toolCallId, successful result, one text block, and the original recorded text length before exactly one existing G2 integrity scan. It returns boolean, never content. A 50,000-message list is rejected immediately: the evidence active-source scan caps at 4096 messages. Public artifact reads retain their existing lazy behavior.

All reuse requires a valid existing artifact, including when original text would have been reduced by model projection. There is no active-context-only fallback or claim that historical SessionManager storage proves model access. Existing G2 artifact recovery is the model-access route. Missing/ambiguous sources, source-array replacement, descriptor eviction, owner clear, foreign session or integrity failure mean miss and real read. A recreated G2 record cannot inherit an old evidence lease even if the public descriptor ID repeats.

The notice contains bounded workspace-relative path, original line/byte range, monotonic evidence ID, existing artifact ID and an explicit no-new-disk-read statement. It contains no old text, raw cursor or absolute home path. Public artifacts remain session-bound and resolved by the existing owner.

## File and scope identity

The argument key is a fixed tuple for the current schema: policy, real cwd, normalized workspace-relative addressed path, real canonical target path, offset, limit and optional bounded cursor. Offset omission equals 1. Omitted limit stays distinct where the existing legacy continuation notice differs; no guessed default merges semantically different output. Paths use existing resolution, separators and NFC normalization; exact addressed path, canonical path and file generation are also checked before reuse. Ordered values are not reordered. No recursive serializer or result serialization. The key uses path identity, while the bounded notice uses JSON-quoted path and location fields.

Scope binds session, real cwd/path, workspace/branch generations, read policy, and Phase 5C-A's dev/inode/size/mtimeNs/ctimeNs/birthtimeNs tuple. Realpath checks bind the addressed symlink target. The read descriptor's own before/after validation supplies admission identity; a post-read standalone stat cannot assign it. No descriptor, source Buffer or public cursor travels in the handoff. Empty-ledger misses derive keys from this validated identity and avoid redundant pre-read checks.

Candidate lookup performs R_OK, one bigint stat, target realpath validation, scope checks, then resident G2 validation. Proven file mismatch performs zero integrity scans. Exceptions/uncertainty invalidate, rather than retaining a candidate for guessed reuse. No full file/repository hash or watchers.

**Windows limitation:** observed rapid same-size rewrites retained the entire stat tuple despite apparent nanosecond precision. Win32 therefore bypasses before new hashes/stats/capture. Ordinary reads continue; no Windows hit benefit is claimed. Missing/coarse/nonregular metadata also misses. Linux precise-metadata mutation and effectiveness fixtures run in CI. No native change-ID adapter is introduced in 6A1.

| Event | v1 behavior |
| --- | --- |
| append/truncate/same-size rewrite/atomic replace/delete-recreate/touch | exact file generation invalidates before G2 hash |
| symlink target replacement | real target/key identity prevents reuse |
| write/edit/shell/custom/MCP/unknown execution, including failure | workspace generation increments before execution; clear records and receipts |
| denied operation | no execution; permission not cached |
| session/cwd/fork/tree change | clear; old session owner cannot admit |
| successful manual/automatic compaction | clear at existing projection-reset seam |
| registry rebuild/reload | clear; canonical history remains mutable |
| owner eviction/clear, source replacement/ambiguity/removal | resident-only miss, no historical rebuild |
| dispose/process resume | clear/release; new process ledger empty |
| four simultaneous initial reads | four real executions; later completed read may hit |

## Allocation and diagnostics

Ordinary synchronous ledger lookup: zero closures, Promises, controllers, timers, signal/options wrappers, spreads, arrays, new Maps/Sets or strings; a Map.get plus numeric counters. Argument hashing separately creates one crypto Hash and hex digest from bounded fixed-schema material. Scope hashing only occurs on admission, not an exact hit.

Full enabled exact-hit adapter is asynchronous: one adapter async Promise plus the existing resolver/filesystem async work. It has zero inline closures, controllers, timers, object spreads or new Maps/Sets. At source level it creates two arrays (fixed key tuple and one-block notice), one text block/result envelope, JSON key string, digest, generation string and notice string; path resolution/normalization creates additional bounded strings internally. G2 envelope inspection creates three property-descriptor objects; existing G2 integrity creates its existing Hash and digest material. Node realpath/access/stat also allocate internal Promise and path/stat objects. These are not claimed to be zero simply because they live in helpers.

Filesystem count per ordinary exact hit: three realpath calls (cwd, target, revalidated target), one targeted stat, R_OK access plus the resolver's F_OK access. The resolver adds no realpath; missing-path fallback can add access calls, outside the ordinary exact-hit path. No disk content open/read, full-result serialization, file hash, ledger-owned result hash or retained source reference. The ledger reuses one stat-options object allocated at construction; no per-hit signal/options wrapper is introduced. Argument bytes are bounded and recorded; corpus key material was approximately 112 bytes/hit. G2 integrity bytes are reported separately below.

Disabled fresh session: no ledger/receipt Map, execution adapter, key, stat, hash, listener or result handle. The read definition has an absent-symbol guard only. Numeric diagnostics use counters and reason enums; paths/args/text/handles/hashes are not emitted as telemetry.

The one allocation profile ran on `dbfd5d0`, [Linux run 34130970263](https://github.com/dragonbaba/super-pi/actions/runs/34130970263), with 100 sampled exact hits after warmup. Inspector sampling at 1024 bytes, including collected objects, reported 2,172,472 sampled allocation bytes (~21,725 per full fixture lookup/message tail). Leading attribution included realpath (271,384), adapter frames (193,488 and 75,248), access (112,256 and 99,200), path.resolve (92,760 and 61,352), stat (87,048), fixture.read (65,176), message tail (62,640) and file-generation strings (58,256). This is sampled allocation, not retained heap or an exact object count. Later code removes per-hit stat-options creation and redundant token rescanning; the profile was not repeated.

The single controlled-GC fixture in that run retained only the disposed ledger while checking four WeakRefs (session, owner, message, content). All four released; entries=0, metadataBytes=0, retainedSourceReferences=0. A 100,000-lookup structural loop on the cleared ledger remained empty; capacity growth is covered separately by deterministic 128/129 admission tests. No second GC/profile process was run.

## Effectiveness and performance evidence

Three configurations only: enabled exact hit, enabled generation-invalidating miss, disabled. Corpora are medium ~32 KiB local text and a large ~700 KiB source returning the existing bounded 16 KiB window. Real production read/owner/message-tail fixture, no provider/network. Ten-read tests require one real execution and nine compact references; a real agent-loop provider-context fixture verifies the projected result token estimate drops by more than half. No second complete source/result enters the ledger.

Paired run [34132404011](https://github.com/dragonbaba/super-pi/actions/runs/34132404011), implementation `201384b`, 100 measured samples/config/corpus:

| Corpus/config | p50 ms | p95 ms |
| --- | ---: | ---: |
| medium disabled | 1.719509 | 2.118481 |
| medium hit | 0.358570 | 0.435225 |
| medium invalidating miss | 1.818975 | 2.633511 |
| large disabled | 2.079235 | 3.072386 |
| large hit | 0.342409 | 0.525196 |
| large invalidating miss | 2.163466 | 3.300223 |

Medium hit integrity p50/p95: 0.061857/0.077267 ms, 64,027 integrity bytes/hit. Large: 0.036525/0.049087 ms, 33,849 bytes/hit. These are existing G2 identity encoding bytes, not source-file bytes. Each hit has exactly one scan. 110 hits prevented 110 real reads per corpus; projected token estimates avoided 213,840/213,400 over those hits. File hashes, ledger result hashes, copies and retained source references were zero.

Miss delta p50: +0.099466 ms medium, +0.084231 ms large. P95: +0.515030/+0.227837 ms, exceeding the requested gate in this sample. Earlier independent-process runs also showed miss overhead, motivating empty-ledger identity reuse and reuse of existing G2 projection estimates. A final single-process set of five bounded paired windows is recorded in the PR packet; no additional profiles/GC are authorized or needed. Do not treat the successful benchmark workflow status as proof that this numerical gate passed.

Process accounting through that final measurement: five hit processes including the allocation-profile process; four each for miss and disabled. The final process collects five windows rather than starting five processes. No further hit benchmark process remains in budget.

Final [run 34133442700](https://github.com/dragonbaba/super-pi/actions/runs/34133442700), exact `9ac6c743cce7b122559e5188906e2886e2668d04`, pools all 500 measured values from five bounded paired windows per corpus; it does not select a favorable window. Each fixture remains below owner eviction limits. Raw per-window values and timings are in the workflow artifact.

| Corpus/config | pooled p50 ms | pooled p95 ms |
| --- | ---: | ---: |
| medium disabled | 1.754170 | 2.008553 |
| medium hit | 0.342501 | 0.445399 |
| medium invalidating miss | 1.842493 | 2.080293 |
| large disabled | 2.050600 | 2.384796 |
| large hit | 0.308251 | 0.411159 |
| large invalidating miss | 2.144954 | 2.471138 |

Miss overhead: medium +0.088323/+0.071740 ms (p50/p95); large +0.094354/+0.086342 ms. Both p95 deltas and large p50 are below 5%. Medium p50 is approximately 5.04%, accepted under the explicitly permitted sub-0.2 ms absolute-delta allowance. The additional bounded metadata/handoff/admission work accounts for a small real cost; the older tail variance is not evidence of zero overhead. Hit median reductions are approximately 80.5%/85.0%.

Across these windows, integrity p50 ranges 0.054751–0.062212 ms medium and 0.032644–0.036872 ms large; p95 ranges 0.065073–0.094958 and 0.043622–0.056914 ms. Bytes/hit are 64,027 and 33,851. Each hit fixture executes one read and prevents 110; no copy/file hash/ledger result hash/source reference is introduced. No timing process was repeated after this final measurement.

## Verification and review classification

Red commit `25e5474` demonstrated absent reuse separately from production. Latest local focused ledger/core/owner/read/session/source-invariant and Phase 5C-A regressions: 98 tests, 94 passed, four Windows/baseline skips, zero failures. Existing small G2 artifact subset: five passed. npm run check and npm run build:offline passed after the final production fix. git diff --check passed.

The single local npm test invocation at `201384b` stopped on `tui-frame-queue.test.ts`'s source-shape assertion requiring critical agent_end delivery first. Cleanup placement was corrected in `0526edd`; that exact test passed afterward. No second local full suite was run. Exact candidate Linux/Windows CI must supply the complete-suite evidence; its exact head and job URLs belong in the PR packet.

One-pass self-audit covered built-in/custom-read/shell/MCP/network/write eligibility; path/cwd/symlink/file/args/session/branch/compaction identity; permission/final args/mutable and observer hooks; resident artifacts and ambiguous/missing sources; clear/dispose/fork/tree/concurrent first calls/error/abort; key/hash/stat/Map/string/source ownership. Findings repaired before review: Windows false identity, stale G2 generation after replacement, mutable display re-admission, uncertain lookup invalidation, cleanup boundary placement. No known B0 remains from this pass.

Classification for Candidate Review: B0 = stale/scope/permission/secret/public/cross-session error; B1 = contract/bounds/performance/lifecycle; C = narrow test/docs/diagnostic closeout; D = deferred adapter/optimization. The final 500-sample measurement closes the development miss-performance B1 using the permitted absolute-delta allowance; earlier unfavorable samples remain disclosed. Windows native identity support and grep/find/LSP/git adapters are D and outside this change. One Candidate Review and at most one incremental closeout review are authorized. No operation-id, persistence, Harness v2 or Phase 7/8 work.

## Candidate Review closeout batch

The single Candidate Review of `317abb468facbbeee135209e800628229d97488d` followed successful exact-head Linux/Windows [CI 34133965317](https://github.com/dragonbaba/super-pi/actions/runs/34133965317). It reported two findings:

- [B0 workspace compatibility](https://github.com/dragonbaba/super-pi/pull/27#discussion_r3950957698): evidence-only realpath(cwd) could fail an otherwise accessible absolute small-file read after cwd rename/removal. The metadata probe now catches its own resolution failure, leaves evidence ineligible and continues the original target read. Normal target access/read errors remain unchanged.
- [B1 range accuracy](https://github.com/dragonbaba/super-pi/pull/27#discussion_r3950957700): a line-limit stop records the next unread line. Only the private evidence location now subtracts one when stoppedAtLine; public window fields/content/cursors remain unchanged.

Both deterministic reproductions failed before the fix in separate red commit `162c41d`. Focused closeout checks then passed: 64 tests, 62 passed, two Windows/baseline skips; check and offline build passed. No allocation profile, GC fixture, benchmark process or local full-suite repeat was used. The changes affect exceptional evidence workspace resolution and metadata range formatting, with no new exact-hit allocation or integrity work. Exact closeout head CI and the single reserved incremental review are linked in the PR packet; no documentation-only commit follows that CI.

No C findings were reported. Deferred Windows native identity and other adapters remain D. This batch addresses both reported B0/B1 findings; incremental review must confirm closeout.

Stop target: **SUPER-PI-PHASE6A1-EVIDENCE-LEDGER-CORE-READ — Draft Candidate Gate — awaiting external final review and explicit merge authorization.** This packet alone does not assert that pending closeout CI/review has completed.

## Cumulative external last-diff closeout

This section supersedes the previous stop target and no-open-findings assessment. The externally reviewed candidate `f74d177716642d1b2cf6dd509157838e999baca3` remains unchanged in history; base/merge-base remains `172c52341249414d236eeb9153516bfd10087782`. Option B, allocation/GC evidence, Windows conservative misses and previously reviewed invalidation behavior remain accepted and frozen.

### Separate red evidence

Test-only `4dcd13aa8ece6a3588d4bf89ff2a0778c110cb84` introduced production AgentSession/read/G2 regressions before any production correction. Its initial check stopped on a test fixture using `state.error` instead of `state.errorMessage`; test-only `4cb4cbf82afb11676d5e04bf9f5eb147ebf1319b` corrected that observation without changing production. The [semantic Linux red run 34142072622](https://github.com/dragonbaba/super-pi/actions/runs/34142072622) then passed check/build and recorded exactly six focused failures (55 pass, one Windows-only skip):

- **B0-6A1-03:** original tiny read = 1 estimated token. The repeated reference = 101 tokens. Budgets 1 and 2 failed only on the second read with `Tool-result budget ... cannot contain the fixed continuation notice.` At budgets 128 and 2048 both calls completed but the repeated result amplified 1 to 101 tokens.
- **B1-6A1-04:** after `alias-a.txt -> target.txt`, reading `alias-b.txt -> target.txt` incorrectly hit and returned a reference naming alias-a. The same wrong hit occurred after deleting alias-a. The oversized-first-line fallback explicitly embeds the addressed filename, making the semantic mismatch observable.

No red commit was rewritten. The first failed type-check is disclosed separately from the semantic red evidence.

### Correction and deterministic coverage

`cbbdf93` adds the single `formatEvidenceReference` formatter, exact admission estimate and numeric `referenceTokens`; `3ce7305` binds both admission and lookup keys to the normalized addressed path and checks the recorded path before G2 integrity work. `8e022b1` requires an explicit admission budget, preserves early invalidation paths without allocating a reference, and adds deterministic medium/large effectiveness checks. `efd9568` removes `.github/workflows/evidence-ledger-development.yml`; no replacement phase workflow was added.

The existing G2 owner exposes only `getEvidenceBudgetTokens()`. After the real artifact handle and final bounded metadata are known, admission measures the actual escaped notice and requires `referenceTokens < modelTokens` and `referenceTokens <= ownerBudget`. Existing field/byte bounds run before formatting. No minimum file-size heuristic, second owner, early projection, source copy, notice retention, second artifact or estimator ownership is introduced. Only a numeric token field is retained. Missing, invalid or inconsistent legacy/internal token metadata invalidates with `not-beneficial`, before any G2 integrity scan. Declines do not increment hit, prevented-read or avoided-token counters.

Lookup keeps scope/path/file-generation/resident-artifact checks ahead of reference construction. A potentially valid reference is built once, measured with the existing estimator to check its numeric metadata, and returned only after exactly one existing G2 integrity scan. A path mismatch performs zero such scans. Both canonical target identity and generation validation are retained. `file.txt`, `./file.txt` and `dir/../file.txt` stay equivalent; distinct symlink aliases do not. JSON quoting keeps newline, ESC, quotes and delimiter-like filename characters within the structured path field; the key never uses that display encoding.

The [first Linux green run 34142401539](https://github.com/dragonbaba/super-pi/actions/runs/34142401539) at `3ce7305340922a1927230c7d34e49f9916ec5e6b` recorded 69 pass, one Windows-only skip, zero failures. Tiny reads remain 1 token at budgets 1, 2, 128 and 2048 with zero hits; the final escaped candidate notice measures 105 tokens. The dynamic sweep also brackets that actual reference estimate. Both path-sensitive fallback cases now execute normal alias-b reads; these short fallback notices are themselves unprofitable to reference. A separate profitable alias fixture verifies that a later alias-b hit names alias-b and performs exactly one integrity scan.

Maximum accepted path (1024 characters), location (8192), evidence ID (512) and handle (1024) fields produce an actual escaped notice of 23,121 characters / 12,524 estimated tokens in the deterministic metadata fixture. Admission rejects budget `referenceTokens - 1`, accepts an exact fitting budget only when the source estimate is larger, and rejects equal/larger reference-to-source estimates. Missing, negative, plausible-but-inconsistent and excessive internal token metadata, addressed-path mismatch, escaped filename identity, and normalized spellings have focused coverage.

The [final production focused Linux run 34142587551](https://github.com/dragonbaba/super-pi/actions/runs/34142587551), exact `8e022b1a03e33e816a5c7b1cf6a271ce9327a556`, passed 72 tests with one Windows-only skip and zero failures. Each medium/large fixture records one real execution, nine hits, nine integrity scans and no reference projection/truncation. Medium: source model estimate 2046, reference 106, ten-call total 3000 versus 20,460 without reuse (85.34% reduction). Large: source 2047, reference 111, total 3046 versus 20,470 (85.12% reduction). These are deterministic token counts, not a timing campaign. The later workflow removal and this packet do not change production or tests.

Local Windows focused checks pass with hit-dependent cases explicitly skipped; the existing five G2 artifact tests pass. `npm run check`, `npm run build:offline` and `git diff --check` pass. No local full-suite repeat, allocation profile, controlled-GC fixture, timing campaign, 100,000-lookup campaign or extra Phase 5/MCP/TUI matrix was run. The authorized normal exact-head Linux/Windows CI (including `npm test`) remains the final verification source.

This packet is committed **before** final exact-head CI. The exact final SHA, final CI job URLs/results, clean-worktree check and unchanged origin/main ancestor check are published in PR #27's body after CI, without a later docs-only commit. No third broad automated review is requested. No local B0/B1/C remains in this correction; external last-diff review and explicit merge authorization remain outstanding.

**SUPER-PI-PHASE6A1-EVIDENCE-LEDGER-CORE-READ — Corrected Draft Merge Gate — awaiting external last-diff review and explicit merge authorization.** PR #27 remains Open and Draft. No Mark Ready, merge, Phase 6A2 or Phase 6B action is authorized or performed.

### Exact-head CI investigation

At `8ce320c0115f1ed22057341729f1df400ddb26e7`, [CI 34142772950](https://github.com/dragonbaba/super-pi/actions/runs/34142772950) passed Windows but failed Linux's existing `large bounded local-text windows carry only private metadata` hit assertion. The failed-job-only Linux retry on the unchanged SHA failed the same assertion. Both attempts passed all new benefit/path tests, including the deterministic medium/large reduction cases. The preceding [full Linux/Windows CI 34142590530](https://github.com/dragonbaba/super-pi/actions/runs/34142590530) at `8e022b1` passed with identical production and tests; only workflow removal and packet text separate these commits. The cause is not established from the original boolean-only assertion, so no third blind retry or production-policy relaxation is used. Failure-only counters, token metadata and filesystem precision diagnostics are added to that existing test without changing its assertion. This test/packet commit precedes the next exact-head CI. The corrected gate remains pending final CI; the two failed attempts remain disclosed.

The diagnostic-SHA [Linux run 34144721276](https://github.com/dragonbaba/super-pi/actions/runs/34144721276) at `7db9d54` encountered the same ordinary-read-instead-of-hit symptom in the earlier new large effectiveness test, so the fail-fast full runner never reached the instrumented session test. Failure-only counters and before/after file-generation metadata are therefore also added to the new medium/large assertion. Neither assertion is weakened, and production remains unchanged while the cause is investigated.

At `b6a6eb6`, [Linux CI 34145432309](https://github.com/dragonbaba/super-pi/actions/runs/34145432309/job/101816338122) passed the full suite, including both large assertions, without entering their failure diagnostics. Large source/reference/total token counts were 2044/111/3043 versus 20,440 without reuse; medium remained 2046/106/3000 versus 20,460. The earlier failures therefore remain unattributed. Static inspection identifies an existing G2 possibility to investigate: after its bounded shrink loop, G2 can fall back to a full-omission continuation notice. This could legitimately be cheaper than a reference, but the failed logs did not record the original projected estimate and do not prove that mechanism. A focused production read/G2 sweep at budgets 2044–2051 now reports each original/reference estimate and checks that admission/hits follow those measured values. Local Windows source-estimate coverage passes; Windows reuse remains unsupported. No G2 algorithm or positive-hit assertion is changed, and this test/packet update again precedes exact-head CI.
