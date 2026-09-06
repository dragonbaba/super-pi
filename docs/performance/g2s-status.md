# G2S — Alpha Runtime Stabilization and Streaming Responsiveness

Locally authoritative Goal: `SUPER-PI-G2-ALPHA-STABILIZATION-ASTRA`.
The prior cross-session Program is not being resumed or modified. This ledger is authoritative even while the Goal API returns null; no replacement Goal is created.

Status: **G2 Alpha Manual Validation Blocked → G2S active → G3–G10 unstarted**.
The scope-unblock addendum authorizes bounded ANSI indexing/forward progress, runtime exactly-once disposal, and final interactive UI ownership fixes. Continue on the existing worktree and branch; preserve red baseline `ed023a6c78e0d075866195fc306cc686f511f897` without amendment or rewrite.

Active findings:
- **G2S-B0-01**: original post-disposal title-reset red is green after `851ebe7`; broader adversarial shutdown matrix remains open.
- **G2S-B0-02**: shared disposal implemented in `d12e4b7`; expanded 23 ownership/error/reentrancy/deadline tests pass, including 100 callers.
- **G2S-B0-03**: ordinary quit did not join cooperative provider/tool abort completion. Separate red `644f3d4`, fix `387f7e5`; eight real active-work regular/fullscreen and normal/signal tests pass.
- **G2S-B0-04**: manual compaction/tree/bash owners are outside the original idle wait. Red `67590e7`, fix `bc52e9f` and allocation follow-up `410ce03`; twelve real auxiliary-work shutdown tests pass. A non-settling owner produces `SessionShutdownTimeoutError` after a bounded deadline; it is not reported as successful quit.
- **G2S-B0-05**: dead stdout bypassed runtime cleanup and raw-mode restoration. Real CLI red `174cb15` observes exit 129, zero shutdown emissions and raw=true in both modes. Fix `60a6db1` joins the shared shutdown owner instead of hard exiting on the first EPIPE/EIO. Eight real CLI idle/stream/tool/compaction disconnect cases pass with exit 129, shutdown=1 and raw=false. Delivery of cursor/paste restore controls cannot be claimed for a disconnected output. Ordinary and signal exits now both release runtime before attempting terminal restoration, after closing all extension UI handles.
- **G2S-B1-01**: bounded sparse terminal index implemented in `0a23fcb`; 35 ANSI matrix tests pass, original large ANSI fixture preserved.
- **G2S-B0-CANDIDATE-STARTUP**: clean-HOME/no-model sentinel failure reproduced and fixed in `b09e15a`; the user's configured-copy failure remains unconfirmed. See [startup evidence](g2s-startup-evidence.md).
- **G2S-SCOPE-02 resolved by explicit contract clarification**: the former assertion requiring a second provider call for 129 results within a **total** 1,024-token envelope was contractually impossible. The documented typed budget-too-small boundary is expected. Lack of that second request was not itself a production defect. Separate 16,384-token full-chain coverage is required and now passes; contextual-budget production diff for this decision is zero.

The historical stopped-baseline evidence below is preserved. Its scope restriction is superseded by the addendum; implementation is active again. Streaming optimization still requires L0–L3 baseline evidence. Final target is Draft Candidate Gate, awaiting external final review and explicit merge authorization. No Alpha manual validation is claimed.

## Current implementation and evidence checkpoint

### Continued allocation/coverage checkpoint through `d6a21ac`

Production remains within the authorized nine files. Footer-only follow-ups have separate red tests and profile evidence: `deb9128` → `f62d88a` removes per-entry iterator protocol work without caching; `1dffae7` → `86cacbc` removes two per-render status closures/destructuring iterators using stable module functions. The former's 70-process CPU comparison is mixed, including a +0.607 ms fullscreen/5k p95 difference, so no universal performance gain is claimed. The latter has actual status-branch sampled source sites and five before/after processes; deterministic callback identities and output golden pass. See persistent evidence for precise attribution limits.

`68dc1f1` adds actual custom-footer exactly-once/late-registration/WeakRef ownership checks. `e661968` pins every default raw fixture's bytes/code units/SHA-256 plus decoded PNG digest, without changing any generated payload. `d6a21ac` adds four actual trusted/untrusted project startup cases; all pass after correcting the test extension suffix to the production loader's supported `.js`. This was a fixture discovery error, not a production trust failure. No contextual-budget changes, provider changes or new pool.

The cumulative [adversarial audit](g2s-adversarial-audit.md) records evidence and unclaimed coverage before the single Candidate Review. Final exact-head full checks/CI and review have not yet been run for these latest follow-ups. The existing branch still has no PR and no review request; all authorization ceilings are preserved.

### Full local verification at `ed2a577`

Subsequent test-only startup expansion adds 36 combinations: regular/fullscreen × 0/5k/50k history × G2 off/on × no extension/no-op/UI extension. All pass, including shared concurrent quit, exact session/terminal disposal, late UI-handle inertness, raw-mode recovery and listener baseline. The complete startup fault/cancellation/cycle/matrix file is 58/58 green. This is production-shaped startup coverage, not a claim that configured-copy startup or native terminal manual testing passed.

Clean `ed2a577ea4b8b9d2cd713f064db033e763fa3cb3`: `npm run check`, `npm run build:offline`, `npm run alpha:g2-probe` (245 total, 241 passed, zero failed, four Windows POSIX skips), and full `npm test` all exit zero. Owner/frame-queue focused tests: 147/147 pass. The earlier mode-switch harness omitted `runtimeHost.dispose`; `aeca454` supplies the missing lifecycle boundary and asserts one invocation, retaining its original drain-cause assertion. The real runtime/CLI tests do not use that stub as lifecycle proof.

`git fetch origin` still observes `origin/main=d5516ca39bfd7940f8bce76ea6aeb63616099383`, also the merge-base. Candidate and fixed read-only manual worktree were clean at this verification. No matching residual benchmark/test Node process was observed after the runner completed. CI now explicitly checks out and verifies PR head, rather than the synthetic merge revision. Linux/Windows CI has not yet run; the local Windows result is not substituted for it.

See [persistent measurement evidence](g2s-persistent-evidence.md) for hash-verified matrices, timing limitations and remaining allocation work. Full local verification does not close the unknown configured-copy startup candidate, performance targets, native terminal manual validation or external review.

### Persistent evidence checkpoint at `67301e2` (2026-09-06)

The existing branch and immutable red baseline remain unchanged. Persistent private evidence is under `D:/RMProjects/Pi-g2s-evidence/20260906-g2s`; raw heap snapshots must not be uploaded to the PR.

- Clean `8c3f18d76c4c685339b6489a9de1d7935d28d9b8`: check, offline build, full npm test and expanded probe passed (227 total, 223 passed, four Windows POSIX signal skips). A sequential 705-process matrix completed with exact stamps and report hashes. A further 120-process growing-response matrix passed at `375adac`. Timing acceptance remains open; large first/final burst renders exceed the 16/33 ms targets.
- 129@1024: 129 executions/end events, one provider request, typed `budget-too-small` / `fixed-notice-does-not-fit`, error terminal state and one agent end, no automatic replay. Production-estimated notice 58 tokens exceeds share 7. Canonical UI retains 129 recoverable results; cleanup leaves zero coordinator/presentation entries and clears all 129 WeakRefs.
- 129@16384: 129 executions, exactly two provider requests, final completion, projected total 16,384 tokens, per-result allocations 58–163 (initial share 127), wrapper overhead 1,407. All 129 provider continuations reconstruct in canonical order. Cleanup entries zero and 129 WeakRefs cleared. This is the first observed success among tested 1,024/16,384, not an exact mathematical minimum. Contextual-budget production diff for this decision remains zero.
- Real CLI matrix now covers 24 cases: 20 pass and four POSIX signal cases require Linux. Active model/tool/compaction cleanup settles before session shutdown. Malformed settings are read from the production config directory, reported and preserved. Pipe-backed tests are not native Windows Terminal manual validation.
- Standalone 100-cycle, 100,000-update-per-cycle runs release seven owner WeakRefs each cycle in both modes. Heap samples contain plateaus and small upward steps; do not claim a strict zero-slope pass from owner WeakRefs alone.

**G2S-B1-02 — shared Markdown tokenizer retains its temporary lexer.** Heap retaining paths showed `markdownParser.defaults.tokenizer.lexer.tokens → token.raw` holding a 100,024-byte completed fixture string. A separate V8 `regexp_last_match_info` root initially masked this second path. Diagnostic-only replacement of V8's last match exposed the tokenizer root; attributing all retention to the VM would be incorrect. Red commits `ae08320`, `65b0b12`, with test-tracker release correction `8c45c20`, exercise success, throw, reentrant success and reentrant throw in both incremental modes. Production `67301e226103b20192d6cae4705851ee672da537` restores the previous lexer in a synchronous finally block. Top-level completion releases it; nested parsing restores its caller. No parser/cache redesign or per-update wrapper/closure/Promise is introduced.

At clean `67301e2`, eight ownership cases and the existing incremental golden/source gates pass. One initial invocation of source tests through the isolated probe failed only because those existing tests resolve source paths from cwd; the normal repository-cwd invocation passes unchanged. A sanitized standalone heap snapshot retains only the V8 last-match path for the target; the diagnostic RegExp control snapshot has zero target strings. Normal five-cycle heap delta is +451,264 bytes, so this proves removal of the identified owner path, not universal heap stability. The separate 130-process growing/profile matrix completes successfully. This is a reference-correctness repair; no 30% allocation / 20% CPU optimization improvement is claimed.

Still open: aggregate timing/non-regression assessment, real CLI dead-stdout adversarial cleanup, complete source/ownership audit, final exact-head verification and Linux/Windows CI, one cumulative Draft PR and authorized review. No PR, Ready, merge or user manual pass is claimed.

### Continuation checkpoint through `4e62937`

**Evidence retention update (2026-09-06):** after the interrupted turn, the previously recorded `C:/Windows/TEMP/g2s-evidence-7628a840d93d424db9db6b946d408f59` directory was observed empty. The cause is unknown. Numbers below were observed during execution but their raw local files are no longer available for review. Final exact-head evidence must be reacquired under the persistent task-owned `D:/RMProjects/Pi-g2s-evidence` directory. Do not treat the missing temporary reports as an attached/reviewable packet. Git commits and this ledger survived unchanged.

Existing branch/worktree preserved. Full local `check`, `build:offline`, expanded `alpha:g2-probe` and `npm test` passed at clean `5cb80edd297273f1f69357495387993f26583e8e`. The probe reported **208 total, 204 pass, zero fail, four Windows POSIX-signal skips**. Later commits `b4bb94f`, `9f56f91`, `4e62937` change test/benchmark infrastructure only; targeted tests and check pass. They still require final exact-head full validation. No push, PR or review request yet.

Real `/new` → `/fork` → `/resume` tests pass in both modes. Four session starts, three replacement shutdowns and three UI resets occur before final quit; final shutdown adds exactly one session shutdown and no replacement UI reset. Old extension context getters throw the stale-context error; previously captured UI handles cannot write. Prior-session artifact/cursor access is rejected, and terminal raw mode/data/resize listeners are restored/released.

The runtime final-dispose path now claims shared ownership before callbacks, cancels auxiliary operations, joins cooperative abort and activity flags, emits session shutdown once, invokes the remaining invalidation callback at most once, and disposes the session once. Interactive final shutdown disarms UI callbacks and closes extension UI ownership before its first await. Ordinary quit releases/stops TUI before runtime teardown; signal quit performs runtime teardown before terminal restoration. Both use the same terminal ownership boundary. Active tests record zero post-disposal control/frame/render calls. The auxiliary wait uses one instance-stable polling callback and one optional lifecycle Promise/10 ms interval with a 5 s deadline; idle disposal adds no polling timer. Resolve/reject fields and timer are cleared before settlement. The abort rejection observer captures first-failure state until that abort settles. This is lifecycle work, not a per-delta/frame allocation exemption. An externally non-cooperative Promise may retain its own reaction until settlement; no universal cancellation of third-party code is claimed.

Additional clean measurements are recorded in [the measurement packet](g2s-measurement-checkpoint.md): 100 fullscreen slow-sink processes, 60 batched L0–L3 processes, 30 wide-terminal/history processes and 90 corrected visible-marker corpus processes. Timing remains inconclusive against the strict end-to-end interval gate. Root timing and bounded work pass in the measured fixtures; this is not actual-provider throughput evidence.

At `b4bb94f`, 25 controlled-GC cycles per mode again release all seven owner WeakRefs every cycle. Surviving-allocation sampling starts after warm-up and excludes collected samples. Regular heap delta is -4,979,296 bytes; fullscreen +177,544 bytes. Last-five heaps remain slightly increasing in fullscreen (41,377,224 → 41,383,448). Samples include inspector internals, a 100,024-byte `trim` allocation, theme/system-prompt initialization and async internals. Sampling does not identify retaining paths; strict zero-slope/reference-retainer closure remains open. No speculative production cache rewrite follows this evidence.

The initial Markdown latency corpus put its marker in an extra table cell, which a fresh renderer correctly omits. Red `9f56f91` fails only that corpus (8/9 pass). Test-only `4e62937` places the marker in a visible paragraph; 9/9 fresh-render controls and all 90 L3 corpus processes pass with the final-marker assertion retained. The original failed log remains evidence, not a claimed production frame-loss defect. No Markdown production source changed.

Remaining gates include complete process-level active/startup/error adversarial coverage, explicit per-call allocation/reference attribution, surviving-retainer evidence, final exact-head verification and Linux/Windows CI, and the single cumulative Draft Candidate review. The configured manual-copy startup failure remains an investigation candidate. G2 Alpha is not manually validated; G3–G10 remain unstarted.

### Streaming/validation continuation after the contract decision

The 129-result contract work is committed as `239135b`; no contextual-budget production semantics changed. Work continued automatically on the same branch. Additional production commits: `1f8bf07` reuses the proven single-text AssistantMessage structure, `a3346cf` coalesces dirty retained versions and attributes bounded active line changes, and `b4869cc` preserves that attribution through the ordinary final frame. Retained evidence and explicit bounded reference ownership are in [the measurement packet](g2s-measurement-checkpoint.md); each production change follows separate red/evidence commits. Original red `ed023a6` remains immutable.

- Exact `e66c5da` full `npm test` completed with exit 0, including the memory workspace. The first run stopped at an obsolete fatal-teardown source regex; the replacement checks the actual stop/runtime owner path and retains the independent real crash-cleanup tests. Full exact-final tests must be rerun after subsequent retained/completion changes.
- `npm run check` and `npm run build:offline` passed locally. Existing retained/viewport/golden/source matrix passed 117/117 after the active fix; completion-focused subset passed 63/63 after the final-frame follow-up.
- Expanded `alpha:g2-probe`: **176 total, 172 pass, 0 fail, 4 Windows skips for POSIX signal behavior**. This includes the 18-case parallel contract matrix, real CLI ordinary exits, 17 stream corpora through L0/L1/L2/L3, 1/4/16/64 code-unit deltas, 16/64/256 KiB growing text, final-first, abort/error and thinking/tool transitions. These corpus assertions prove canonical/queue correctness, not complete latency coverage.
- The real 100k-update test previously generated 25 active full-history fallbacks and one final fallback in regular mode. Both are now zero. The ordinary provider 100k burst probe remains separately labeled: observer coalescing means its generated chunk count is not its UI update count.
- Clean `903bd7d`, five long-word processes per mode, 50k history: all ten have zero full-history fallback. Regular root p95 range 6.21–9.08 ms, max p99 10.35 ms; fullscreen p95 8.14–8.96 ms, max p99 10.53 ms. Largest physical-marker p95 44.32 / 42.07 ms still exceeds a strict 32 ms immediate-sink goal in some runs. Maximum visible gaps 49.22 / 50.49 ms versus provider gaps 31.21 / 29.77 ms. Temporal acceptance is not declared; CV and layered latency remain under investigation.
- Five measured 100k-update/teardown cycles released message/content WeakRefs each time, but heap rose by 455,592 regular / 799,520 fullscreen bytes. The follow-up completed **25 measured cycles per mode** plus warm-up, releasing all seven WeakRefs (message, content, session, runtime, mode, renderer, terminal) on every cycle. Regular heap changed 45,500,320 → 40,510,088 bytes; fullscreen 40,804,472 → 40,985,064. Last-five ranges were 40,494,216–40,510,088 / 40,978,952–40,985,064. Growth decelerated substantially, but small positive tails remain; this is ownership-release evidence, not a strict zero-slope claim. Surviving-allocation attribution remains open.
- `561dc16` adds bounded fixture-only handled/render timestamp tables. The source AST inventory includes full touched files and existing READ_GROUP pools, and explicitly distinguishes syntax sites from dynamic per-update counts. Manual cross-await/reference attribution and all hard gates remain open.
- [Corrected Alpha guide](g2s-alpha-guide.md) replaces the invalid PowerShell projection procedure. Linux/Windows exact-head CI, remaining adversarial/failure coverage, final profiler packet and cumulative Draft review remain outstanding. No PR, review request, Mark Ready, merge or Alpha manual pass is claimed.

### High-fanout contract clarification

The updated production-shaped parallel matrix passes **18/18**, including both independent 129-result fixtures in regular/fullscreen. No result count or 1,024 boundary budget changed. Immutable red `ed023a6` and historical contradictory assertion commit `0ca0f5a` remain in history.

| Evidence per mode | 129 @ 1,024 boundary | 129 @ 16,384 full chain |
| --- | ---: | ---: |
| Executions / tool_execution_end | 129 / 129 | 129 / 129 |
| Maximum simultaneous executions | 129 | 129 |
| Provider requests | 1 | 2 |
| Terminal assistant state / agent_end | error / 1 | stop / 1 |
| Typed projection code | budget-too-small | none |
| Effective first share | 7 | 127 |
| Projected ToolResult total tokens | no request emitted | 16,384 |
| Per-result projected token min/max | not dispatched | 58 / 163 |
| Production-estimated notice tokens | 58 | 57–58 |
| Message-wrapper token overhead | not dispatched | 1,407 |
| Full request context tokens | not dispatched | 19,006 (plus 4,096 reserve < 128,000) |
| UI artifacts / checked continuations | 129 / 129 | 0 / 129 |
| Automatic tool replays | 0 | 0 |
| Coordinators / presentation entries after cleanup | 0 / 0 | 0 / 0 |
| Source WeakRefs released after controlled GC | 129 / 129 | 129 / 129 |

16,384 is the first observed successful total among the explicitly tested 1,024 and 16,384 totals, not a claim of the exact mathematical minimum. It succeeds, so the conditional escalation to 32,768 is unnecessary. At the larger per-tool cap, 64 KiB canonical UI results legitimately remain V1, while the turn-wide provider projection supplies 129 usable cursors. The test reconstructs every omitted region from its own source and checks exact canonical provider ordering, combined envelope, and unchanged persisted/UI content.

The error is caught at the actual owner's contextual projection boundary before AgentSession converts it into an assistant error message; its actual class and `code` are asserted, without matching the complete error string. The stable fixture reason `fixed-notice-does-not-fit` is supported by the actual share and production estimator, not a hard-coded token constant. Both paths have no active indicator or streaming session after the turn and accept later input through injected terminal stdin without tool/provider replay. No separate failure-handling defect was observed in these cases.

Five controlled-GC readings in the fullscreen boundary run: 46,064,128 → 45,989,992 → 45,981,288 → 45,962,072 → 45,962,072 bytes. Full-chain: 46,097,736 → 46,022,992 → 46,014,696 → 45,995,576 → 45,995,576. These establish this fixture's release, not the outstanding 100k-update slope gate. Raw scalar evidence: `high-fanout-contract.log` in the recorded local evidence directory.

**D-G2D-HIGH-FANOUT-BATCH-MANIFEST**: fitting 129 independently recoverable large results inside a 1,024-token total envelope requires a future aggregate batch artifact/manifest or equivalent protocol. Backlog only; no manifest, new setting, provider-wire change, owner redesign, silent omission or budget weakening is implemented in G2S.

The earlier checkpoint below is retained as history; its pending-acceptance/red-test status is superseded by this clarification. Remaining G2S work continues automatically.

Latest production commit at this checkpoint: `0e0e230` (fatal teardown), following measured footer change `d537baec10780ee8c2a37afe50f3914309ec4524`. Baseline/merge-base remains `d5516ca39bfd7940f8bce76ea6aeb63616099383`; original red `ed023a6` is unchanged. Existing branch/worktree retained. No push, PR, review request, Mark Ready or merge has occurred.

- Expanded direct probe passed **82/82** before adding the actual parallel matrix. This includes ten raw AgentSession/provider/UI modes, strict before-init and initialized quit, ANSI, runtime ownership, and upstream truncation.
- Actual parallel matrix: **14 pass, 2 red**. G2 off: 1/4/8/129 all reach provider in regular/fullscreen. G2 on: 1/4/8 pass; 129 hits the total-envelope boundary above. Maximum simultaneous executions equals requested count, including 129. This is stronger evidence than the old direct-owner identity loop.
- Image validity audit found an invalid IDAT CRC. Test-only red `b4d45c3`, checksum correction `72c5a10`: complete PNG chunk CRCs and decoded one-pixel scanline now pass. No ANSI fixture/budget/assertion was reduced.
- Real PowerShell tool with injected process execution proves 256 KiB enters the real accumulator, output is truncated upstream to its 50 KiB payload limit, and the independent spill file is complete. G2's canonical/artifact content equals the already truncated tool result. No claim that G2 owns full shell output.
- Pipe-backed actual CLI tests previously passed eight Windows ordinary-exit cases; four POSIX signal cases explicitly skipped on Windows. These are not native PTY/manual Windows Terminal evidence.
- Clean-commit four-layer timing: **100 processes**, 5 each for L0/L1/L2/L3 × requested 10/20/50/100 updates/s and burst. Additional history/mode baseline: **30 processes**, 5 each for 0/5k/50k × regular/fullscreen. See [measurement checkpoint](g2s-measurement-checkpoint.md) for limits and remaining gates.
- Measured footer-only optimization: red `3f1cf26` proves two full `getEntries()` copies per render; `d537bae` combines latest-name selection with the existing usage traversal, reducing copies to one. No cache, throttle, scheduler or provider change. Five-process after measurements per mode and a separate allocation sample collected.
- ANSI exact-commit benchmark at `0ca0f5a`: one source hash and one full estimator scan per source; 65,536 sequences finish in 470 chunks; fixed index HWM 49,152 bytes, retained bytes zero after dispose; 12/12 weak references cleared after controlled GC. The same 48 KiB allocation for a one-sequence source remains a **D** item, not concealed.
- Fatal-recovery red `7d3f877` demonstrated terminal disposal without runtime/session shutdown in both modes. `0e0e230` uses final stop ownership followed by runtime dispose, logs cleanup errors and preserves the original fatal error/nonzero exit. Both crash tests and four ordinary/signal tests pass. This is a teardown finding, not the user's startup root cause.
- 22 added startup tests pass: six injected phase failures per mode, four quit-during-await cases per mode, and 25 complete init/quit cycles per mode. Original causes preserved, terminal/runtime disposed, raw mode restored, listeners return to baseline. Existing lifecycle/source focused tests: **74/74**.
- `npm run check` and `npm run build:offline` pass after production changes. `npm test` ran and stopped at the two unwaived parallel-budget red assertions; later suites were not reached. It is **not green**.
- `npm run alpha:g2-capture -- --tui-mode regular` provides isolated default-off phase capture; actual CLI capture schema/one input-ready checks pass. Capture wrapper `--version` smoke retained its scalar report at `C:/Users/ADMINI~1/AppData/Local/Temp/g2s-startup-capture-dB8YZa/startup-phases.jsonl`; temporary HOME removed. Constructor timing and configured-global-settings reproduction remain open.
- Complete startup adversarial coverage, slow-terminal/corpus/batch matrix, stream release/100k-update gates, full source/allocation audit, native Linux/Windows exact CI, baseline clean-worktree validation, PR packet and review remain pending.

The one-click probe now includes image, footer, crash, startup-fault/cycle and actual parallel tests, including both unwaived 129-result red assertions. Latest observed expanded run: **124 total, 122 pass, 2 fail**, exit 1 (~20.65 s), both failures exactly the 129-result/7-token notice boundary. Do not interpret the earlier 82-pass subset as overall Alpha acceptance.

Read-only baseline check: fixed manual worktree remains clean at `d5516ca39bfd7940f8bce76ea6aeb63616099383`; it was not edited or used to run builds/tests. Benchmark processes completed naturally and their exact output directory is retained. Candidate is a work-in-progress with a pending acceptance decision, not Draft Candidate Gate. Local Goal stays authoritative and active; no Goal API registration/reset has been attempted.

The detailed sections below describe **historical ed023a6 evidence only**, not current production status.

## Baseline

- Fetched origin on 2026-09-05: `d5516ca39bfd7940f8bce76ea6aeb63616099383`.
- Observed d5516ca equals fetched main; ancestor check exit 0.
- Dedicated branch: `fix/g2-alpha-runtime-stabilization`.
- Worktree: `D:/RMProjects/Pi-g2s-alpha-runtime`, initially clean.
- Original worktree: main at `60b9ccfc670362ed37db8a8fcaf62c4788845a97`, untracked `SUPER_PI_CODEX_PHASED_OPTIMIZATION_PLAN.md` preserved.
- Fixed manual copy `D:/RMProjects/Pi-g2-final-main-d5516ca` is read-only for this task.
- Node v26.4.0; npm 12.0.1; Windows 11 Pro for Workstations 10.0.22631.
- Intel i7-14700KF, 20 cores / 28 logical processors; visible RAM 33,334,764 KiB, free snapshot 19,952,212 KiB.
- Agent command transport: PowerShell, TERM=dumb, TERM_PROGRAM absent, WT_SESSION present. This is not evidence of a manually observed Windows Terminal render mode. Both regular/fullscreen require testing.

## Evidence and gates

1. Test-only lifecycle/raw-result baseline commit, before production fixes.
2. Four-layer deterministic streaming baseline and startup reproduction; optimize only measured hotspots.
3. Lifecycle ownership fix with red/green evidence, then full adversarial matrix.
4. Exact candidate validation, one Draft PR and requested review, stop at external merge gate.

The single 256 KiB and four 64 KiB built-in PowerShell tests are invalid G2 projection samples: upstream tool truncation occurs before G2. They establish neither G2 pass nor failure. No prior Alpha pass conclusion is carried forward.

Startup failure and 10–20 token/s attribution remain unconfirmed. Initial filename inspection of the fixed copy root and adjacent directory found no startup capture logs. No provider credentials or session content were inspected.

## Blocking finding: forbidden owner boundary

The user's explicit scope rule applies: “如果真实证据证明必须修改禁止范围，停止并报告，不得自行扩大。” Production implementation is stopped at the test-only baseline. G2S remains the active blocking child; it has **not** reached Draft Candidate Gate.

`ToolResultPresentationOwner` cannot advance within a single ANSI text block once its terminal-sequence index overflows:

| Control | Raw bytes | Indexed intervals | Capacity fallbacks | Continuation budget | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 4,096 valid ANSI sequences | 62,548 | 4,096 | 0 | 1,024 | forward progress |
| 4,098 valid ANSI sequences | 62,559 | 4,096 | 1 | 1,024 | `budget-too-small` |
| raw ANSI mode, 20,000 sequences | fixture metadata | capped | overflow | 16,384 | `budget-too-small` |

Boundary control SHA-256: `2e9433dd2610a0e97d709a6a485964779925b8ef64b346ecf237af6bc30cfddf`.
Boundary failure SHA-256: `3b345a5736b53da737c2d07d0f0dd7f1e0cb398ad5f58ba91d9d60ebd7ac4fdb`.

Mechanism in `packages/coding-agent/src/core/tool-result-presentation.ts`:

- Line 17 fixes `MAX_TERMINAL_SEQUENCE_INTERVALS = 4096`.
- Lines 721–723 set `terminalIndexCapacityFallback` on overflow.
- Line 523 returns 0 for every prefix boundary (or the entire text length for a suffix) after overflow.
- `readContinuation` reaches line 2108 without forward progress and throws.

No shell, read tool, MCP, or upstream adapter participates. The result bytes are verified before owner invocation. Raising the continuation budget to fit the entire block would bypass the required multi-chunk property, and changing/splitting the input fixture would not repair the original-result behavior. Satisfying bounded forward progress for this corpus requires a decision about the explicitly forbidden owner boundary. No change was made there.

## Lifecycle red evidence

Both regular and fullscreen production-shaped **before-init** shutdown tests execute:

```text
InteractiveMode.shutdown
  → stop / performStop
  → actual TUI.dispose
  → actual ProcessTerminal.dispose
  → actual AgentSessionRuntime.dispose
  → beforeSessionInvalidate
  → resetExtensionUI
  → updateTerminalTitle
  → ProcessTerminal.setTitle / writeUnawaitedControl
  → Cannot write with a disposed ProcessTerminal
```

Per mode: terminal dispose observed once; first subsequent title write illegal; post-dispose writes = 1; session disposal was not reached before the exception. This confirms the known lifecycle mechanism, not normal startup success or a process-level smoke pass.

Concurrent actual runtime disposal invokes actual AgentSession disposal **3 times for 3 callers**, versus the test requirement of 1. No fix or green evidence yet.

The first combined probe stayed alive because its before-start input drain attached to the Node test worker's IPC stdin. The exact worker PID was recorded and terminated; the parent runner exited and cleaned its owned temporary directory. The test now uses ProcessTerminal's existing internal drain-input source with a dedicated EventEmitter. No production method is stubbed for this adjustment. The next combined run naturally exited 1 in about one second, without forced test exit.

## Verification at the stopped baseline

- `npm ci --no-audit --no-fund`: completed.
- `npm run build:offline`: passed with unchanged production sources.
- `npm run check`: passed again after the final boundary test addition.
- `git diff --check`: passed before commit.
- `npm run alpha:g2-probe`: **19 tests, 14 pass, 5 intentional red failures** (ANSI main fixture, ANSI boundary, regular/fullscreen shutdown, concurrent runtime disposal).
- No production file modifications; no performance changes or object pools.

The passing direct-owner tests establish sizes, text marker preservation, budget metadata, artifact binding, continuation reconstruction for supported inputs and distinct parallel identities. They do **not** establish the complete AgentSession/provider/UI dispatch matrix, true parallel execution, clear/resume/fork/compaction, valid image decoding, or WeakRef release. SHA-256 values are generated deterministically, but a complete pinned digest manifest remains pending.

No upstream PowerShell truncation fixture, process-level CLI matrix, startup capture command, stream instrumentation, five-process timing baseline, HeapProfiler, controlled-GC, full `npm test`, Linux/Windows exact CI or Codex Review has run. PR number: none. No Draft Candidate has been submitted. These are pending work, not waived gates.

## Corrected Alpha test guidance (interim)

From the dedicated worktree, after `npm ci` and `npm run build:offline`:

```powershell
npm run alpha:g2-probe
# Raw-only diagnostic, still expected red for ANSI on baseline:
node scripts/alpha-g2-probe.mjs tests/alpha-g2-raw.test.ts
```

The runner creates an isolated temporary HOME/config/session and removes only that exact owned directory. It emits test names, scalar diagnostics and failure stacks, never the full raw payload. This diagnostic is currently expected to fail; it is not an Alpha approval command. Do not use PowerShell's truncated stdout as proof of G2 ownership of the full original output. Built-in `fullOutputPath` remains an upstream artifact, whose separate fixture is still pending.

Rollback point: unchanged production baseline `d5516ca39bfd7940f8bce76ea6aeb63616099383`; no reset or rollback executed. No manual validation, performance acceptance, CI acceptance, or review acceptance claimed. All previously frozen production areas remain untouched; G3–G10 are unstarted.
