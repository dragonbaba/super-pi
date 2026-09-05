# G2S — Alpha Runtime Stabilization and Streaming Responsiveness

Locally authoritative Goal: `SUPER-PI-G2-ALPHA-STABILIZATION-ASTRA`.
The prior cross-session Program is not being resumed or modified. This ledger is authoritative even while the Goal API returns null; no replacement Goal is created.

Status: **G2 Alpha Manual Validation Blocked → G2S active → G3–G10 unstarted**.
The scope-unblock addendum authorizes bounded ANSI indexing/forward progress, runtime exactly-once disposal, and final interactive UI ownership fixes. Continue on the existing worktree and branch; preserve red baseline `ed023a6c78e0d075866195fc306cc686f511f897` without amendment or rewrite.

Active findings:
- **G2S-B0-01**: final quit reaches title reset after terminal disposal.
- **G2S-B0-02**: three runtime dispose calls execute three session disposals.
- **G2S-B1-01**: ANSI index overflow prevents valid continuation progress.
- **G2S-B0-CANDIDATE-STARTUP**: reported normal-startup failure not yet reproduced.

The historical stopped-baseline evidence below is preserved. Its scope restriction is superseded by the addendum; implementation is active again. Streaming optimization still requires L0–L3 baseline evidence. Final target is Draft Candidate Gate, awaiting external final review and explicit merge authorization. No Alpha manual validation is claimed.

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
