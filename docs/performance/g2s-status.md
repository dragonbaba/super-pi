# G2S — Alpha Runtime Stabilization and Streaming Responsiveness

Locally authoritative Goal: `SUPER-PI-G2-ALPHA-STABILIZATION-ASTRA`.
The prior cross-session Program is not being resumed or modified. This ledger is authoritative even while the Goal API returns null; no replacement Goal is created.

Status: **G2 Alpha Manual Validation Blocked → G2S active → G3–G10 unstarted**.
The scope-unblock addendum authorizes bounded ANSI indexing/forward progress, runtime exactly-once disposal, and final interactive UI ownership fixes. Continue on the existing worktree and branch; preserve red baseline `ed023a6c78e0d075866195fc306cc686f511f897` without amendment or rewrite.

Active findings:
- **G2S-B0-01**: original post-disposal title-reset red is green after `851ebe7`; broader adversarial shutdown matrix remains open.
- **G2S-B0-02**: shared disposal implemented in `d12e4b7`; 13 ownership/error/reentrancy tests pass, including 100 callers.
- **G2S-B1-01**: bounded sparse terminal index implemented in `0a23fcb`; 35 ANSI matrix tests pass, original large ANSI fixture preserved.
- **G2S-B0-CANDIDATE-STARTUP**: clean-HOME/no-model sentinel failure reproduced and fixed in `b09e15a`; the user's configured-copy failure remains unconfirmed. See [startup evidence](g2s-startup-evidence.md).
- **G2S-SCOPE-02 resolved by explicit contract clarification**: the former assertion requiring a second provider call for 129 results within a **total** 1,024-token envelope was contractually impossible. The documented typed budget-too-small boundary is expected. Lack of that second request was not itself a production defect. Separate 16,384-token full-chain coverage is required and now passes; contextual-budget production diff for this decision is zero.

The historical stopped-baseline evidence below is preserved. Its scope restriction is superseded by the addendum; implementation is active again. Streaming optimization still requires L0–L3 baseline evidence. Final target is Draft Candidate Gate, awaiting external final review and explicit merge authorization. No Alpha manual validation is claimed.

## Current implementation and evidence checkpoint

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
