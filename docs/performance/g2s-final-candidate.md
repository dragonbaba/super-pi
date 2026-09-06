# G2S final candidate evidence

Goal: SUPER-PI-G2-ALPHA-STABILIZATION-ASTRA. Draft PR https://github.com/dragonbaba/super-pi/pull/24. No Alpha manual validation or merge authorization is claimed.

Final measured implementation head: 4f1f90fa43eaf12bdc7ffb59865d798a8a45d16c. Earlier reviewed and CI-verified source: ea839584707d76992899227a1e311294c9a3374b. Baseline/merge-base/latest fetched origin/main: d5516ca39bfd7940f8bce76ea6aeb63616099383. Immutable old-production red: ed023a6c78e0d075866195fc306cc686f511f897. Cumulative implementation-head diff: 66 files, 4187 insertions, 159 deletions. Later gate-documentation commits, if any, must be identified separately from this measured SHA.

## Correctness and lifecycle

Original quit red: TUI/ProcessTerminal disposal → runtime invalidation callback → resetExtensionUI/updateTerminalTitle → rejected disposed-terminal write. Final path closes the extension UI generation and disarms replacement callbacks, joins the shared runtime owner, then independently releases UI owners, restores/stops/disposes the terminal, and unregisters signals. Normal success exits 0; disconnected output exits 129 after local cleanup; owner cleanup failure remains a failure. Repeated shutdown callers join the same operation. Live session replacement still resets/rebinds its UI.

Runtime disposal publishes its shared operation before externally reentrant callbacks. The 1/2/3/100-caller and combined throw matrix verifies exactly-once cancellation, shutdown emission, invalidation and session disposal, with mandatory cleanup and first-error propagation. Auxiliary active provider/tool/compaction/bash/tree work is joined or reports an explicit bounded timeout.

Candidate Review P1 3943217054 exposed progress-clear failure skipping disposal. The expanded 27-case recovery suite covers real Writable EIO, selector/status/footer/subscription failures, failed fullscreen transcript transfer, errors after a disconnect, runtime/footer EIO from non-terminal owners, and post-disposal rejection observation. Terminal disposal/raw restoration/listener cleanup remain mandatory. Expected disconnected-output handling is local to terminal drain/progress/restoration; it does not turn owner errors into successful disconnect exits. Closed rejection observation emits plain stderr with failure exitCode and does not request rendering.

Normal strict-terminal quit variants: shutdown=1, session disposal=1, terminal disposal=1, post-disposal writes/renders=0, raw=false, input/resize listeners=0, exit=0. Pipe CLI matrix includes quit/Ctrl+D/double Ctrl+C/extension/SIGTERM/SIGHUP, idle/stream/tool/compaction disconnects, enabled progress, settings/trust/startup cancellation, both modes. POSIX signal cases pass on Linux CI; Windows skips those four externally terminating signal cases. Native Windows agent-driven PTY smoke at earlier e30c19a observes four exits=0 with one shutdown/input-ready, and two observation-preloaded runs with actual TTY=true/raw=false. This is not the user's manual Alpha pass or emulator-paint timing.

Startup: the exact clean-HOME no-model sentinel failure has a deterministic fix; the user's configured-copy startup failure remains unconfirmed. Capture mode is default-off, isolated and records phase/duration/generation without prompts, keys, result content or full paths. The startup matrix includes 25 cycles per mode, partial failure/cancellation and 36 history/G2/extension combinations. Uncovered individual native dependency variants and constructor timing remain explicit coverage limits.

## Raw result acceptance

| Metric | 129 @ 1024 | 129 @ 16384 |
| --- | ---: | ---: |
| Executions / tool-end events | 129 / 129 | 129 / 129 |
| Provider calls / automatic replay | 1 / 0 | 2 / 0 |
| Effective initial per-result share | 7 | 127 |
| Measured fixed notice tokens | 58 | 57–58 |
| Outcome | budget-too-small / fixed-notice-does-not-fit | completed |
| Terminal turn state | error, one agent_end | stop, one agent_end |
| Projected total tokens | 0; no partial second request | 16384 |
| Minimum / maximum allocation | no dispatched allocation | 58 / 163 |
| Wrapper / measured context tokens | no second request | 1407 / 19006 |
| Recoverable continuations / artifacts | 129 / 129 | 129 / 0 |
| Coordinator / presentation entries after cleanup | 0 / 0 | 0 / 0 |
| WeakRefs released | 129 | 129 |

Both modes retain canonical UI results and accept later input after the typed boundary. 16384 is the first observed successful tested budget among 1024 and 16384, not an exact mathematical minimum. No contextual-budget production changes were made for this decision. A batch manifest is D backlog, not implemented.

Pinned raw fixtures cover small/medium/large/huge/10-MiB single line/repeated errors/JSON/CJK/ANSI/valid image, with seed, byte/code-unit lengths, BEGIN/MIDDLE/END, SHA-256 and tool identity. ANSI remains 230079 bytes. Direct owner and real session/provider/UI tests cover budgets, canonical recovery, ordering, session/branch identity, continuation reconstruction and lifecycle release. PowerShell's approximately 50-KiB upstream limit and fullOutputPath are separate tool-level coverage, never raw G2 projection evidence.

ANSI indexing is bounded to 49152 retained bytes using exact intervals/sparse checkpoints with in-place compaction and local safe scans. Counts through 65536 progress; ordinary ≤4096 behavior stays compatible. The 65536 fixture records four compactions, 470 chunks, one source digest construction and one full-source estimator scan, with no per-chunk digest/estimator pass. Oversized indivisible terminal sequences fail explicitly with artifact recovery. The approximately 48-KiB allocation for just one sequence remains D.

## Streaming measurements

The persistent baseline packet contains 705 independent processes (five per configuration), 120 growing-response processes, 130 Markdown ownership-verification processes, 70 footer iterator processes and five-before/five-after status profiles. L0 generates offline fixture chunks; L1 adds AgentSession; L2 adds memory TUI; L3 uses strict ProcessTerminal. Chunks are not model tokens; no inference about the user's actual provider speed is made.

Mean completion ms, 20-chunk immediate-sink fixture, five processes:

| Updates/s | L0 | L1 | L2 | L3 | L3 minus L1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 | 1902.127 | 1909.411 | 1912.632 | 1911.054 | +1.643 |
| 20 | 955.096 | 961.880 | 963.004 | 959.240 | -2.640 |
| 50 | 384.819 | 390.299 | 390.143 | 393.509 | +3.210 |
| 100 | 206.057 | 202.528 | 199.257 | 205.630 | +3.102 |
| burst | .231 | 3.174 | 15.269 | 15.447 | +12.273 |

Short burst includes initial/final parse/layout/diff/delivery; it exceeds the relative 5% target and is not called passed. Small 10/20 steady immediate-sink fixtures showed no additional reproducible >150-ms TUI stall. Two-interval marker latency is not uniformly met; event-loop/scheduling attribution remains inconclusive. Five/20/50/100-ms slow callbacks, 0/5k/50k history, both modes and 120×40/200×60, batching and content/endings matrices remain in the packet.

Pre-closeout ea83958 profile run: L3, 50k history, 120×40, 200 chunks at requested 100/s, HeapProfiler enabled, five processes per mode. Values below are means of process percentiles, not pooled event percentiles; largest max is separately labeled.

| Metric | Regular | Fullscreen |
| --- | ---: | ---: |
| Root p50 / p95 / p99 ms | 6.895 / 10.379 / 11.949 | 6.887 / 10.278 / 12.247 |
| Largest root max ms | 14.241 | 13.389 |
| Between-process CV of root p95 | .032 | .030 |
| Mean within-process root CV | .269 | .270 |
| Provider / visible inter-arrival p95 ms | 21.562 / 30.801 | 22.034 / 30.909 |
| Provider marker → physical write p95 ms | 40.294 | 40.849 |
| First / final visible ms | 20.217 / 2013.622 | 20.870 / 2014.561 |
| Largest visible stall ms | 66.343 | 52.143 |
| Root / active / completed renders | 96.4 / 95.4 / 2 | 96 / 190 / 2 |
| Footer invalidations (method is no-op) | 107 | 106.4 |
| Assistant updates / content scans | 99 / 99 | 98.4 / 98.4 |
| Markdown eligible / hit / full fallback | 94.4 / 94.4 / 3 | 94 / 94 / 3 |
| Reparsed / rewrapped characters | 54442.4 / 56141.6 | 54497.2 / 56189.2 |
| Parser tokens rebuilt / reused | 3 / 94.4 | 3 / 94 |
| Frames generated / written / replaced | 96.4 / 96.4 / 0 | 96 / 96 / 0 |
| Queue HWM / terminal bytes | 1 / 674853.8 | 1 / 255029.8 |

The two completed renders are prompt/final transitions. Isolated 100000 active-update stress separately has completed/offscreen delta=0, root=25, active=25 regular/50 fullscreen, no full-history fallback, final frame delivered, pending intent≤1 and queue≤2. Physical arrival means Writable write entry, not emulator pixel paint. All per-process p50/p95/p99/max/CV values and absolute-comparison data remain in hash-verified reports, including high-CV/inconclusive groups.

## Allocations, references and limits

Normal measured observer/frame counters: zero returned update Promises, frame Promises, AbortControllers, options wrappers, full-size frame copies or Promise tails/arrays; one active and at most one pending frame. Replaced frame references release immediately. Source inventory does not establish zero allocation across every helper: arrays/layout records, real rendered strings, trim/wrap/parser work and frozen provider/session helpers remain explicit. The footer status callbacks are stable module functions; no new pool exists. Existing READ_GROUP pools are unchanged. Shutdown's one collector closure captures first-error state only until the low-frequency operation settles; shared lifecycle Promises/callbacks are not per-delta work.

Final regular five-process sampled top-site sums: footer render 867412192 bytes; native filter 152714552; SessionManager.getBranch 151771064; breakLongWord 47009704. These are censored top-site sampling sums, not exact total allocation or retained heap. Footer still traverses history; unsafe generation caching and unauthorized SessionManager changes were not introduced. Large initial/final renders still exceed targets in parts of the corpus. The Markdown lexer→tokens→raw owner leak was fixed with eight success/throw/reentrant golden/WeakRef tests, without a second parser. V8 regexp-last-match retention is separately documented.

Exact ea83958 five-lifetime GC: seven owner WeakRefs clear each lifetime; regular net heap +451112 bytes, fullscreen -6015576. Earlier 13471f9 100-lifetime runs release all seven every cycle: regular -4757248, fullscreen -4643296. Small staircase changes remain; a strict universal zero slope is not claimed. The full chain's dynamic allocation count is not universally zero.

Local ea83958 check/build/Alpha probe/full npm test/source audit/diff check pass. Probe: 318 total / 314 pass / four Windows POSIX skips. Exact Linux and Windows CI: https://github.com/dragonbaba/super-pi/actions/runs/34019266386. Fifteen final independent profile/ANSI processes all exit zero and all manifest hashes/clean-head stamps verify. Candidate and fixed manual worktree are clean; no matching Alpha fixture Node process remains.

Unresolved: configured-copy startup B0 candidate; C timing/large-render/heap-slope/full-chain allocation and native coverage limitations. D: one-sequence index allocation and D-G2D-HIGH-FANOUT-BATCH-MANIFEST. Candidate Review P1 is resolved. Closeout review 5124670775 at ea83958 produced one P2 (3943342536), repaired by bdaaabe after red 214c894. It exposed component EIO hidden by composite ui.dispose error handling. Composite disposal/transfer errors are now always preserved. The Review allowance is exhausted; this final repair awaits external final review, with no third automated request. Neither D is implemented. Provider wire/adapters, session JSONL, contextual budget, artifact/cursor format, read/MCP, Evidence Ledger, operation-id and Harness v2 remain frozen. Rollback reference is d5516ca; no rollback/reset/clean/rebase/merge occurred.

Corrected manual guide: docs/performance/g2s-alpha-guide.md. Use npm run alpha:g2-probe for isolated raw fixtures; use npm run alpha:g2-capture for privacy-safe startup capture. Do not substitute PowerShell-truncated output for raw G2 coverage. Final intended stop: Draft Candidate Gate — awaiting external final review and explicit merge authorization.

## Post-closeout final implementation verification

Implementation head 4f1f90fa43eaf12bdc7ffb59865d798a8a45d16c passes check, offline build, Alpha probe (322 total / 318 pass / four Windows POSIX skips), full npm test, source audit, diff check, five-lifetime GC in each mode and 15 independent HeapProfiler/ANSI processes with verified report hashes. Recovery suite is 31 cases, plus four normal/signal quit cases (35/35). Detailed exact-head reports: 4f1f90f-validation/, 4f1f90f-profile/, 4f1f90f-profile-summary.json in the persistent evidence root. The final documentation-only Gate commit is identified by PR HEAD; exact-head CI uses that checkout, not a synthetic merge. See the [current PR checks](https://github.com/dragonbaba/super-pi/pull/24/checks); CI does not waive any listed C or startup limitation.

At the final implementation head, native PTY regular /quit and fullscreen Ctrl+D both exit 0, emit session_shutdown/input-ready once, and report actual stdinTTY/stdoutTTY=true and raw=false. Cursor and bracketed-paste restore controls are observed. Isolated phase reports and SHA-256 stamps are recorded in 4f1f90f-native-smoke.json. These are agent-driven smoke checks, not a user's manual Alpha pass, emulator paint measurements or the complete native dependency matrix.

Final profiled 50k-history/120×40/200-chunk fixture (five processes per mode; means of process percentiles): regular root p50/p95/p99=6.942/10.353/12.266 ms, mean max=12.814 ms, mean within-process CV=.283; fullscreen=7.048/10.179/12.773 ms, mean max=13.400 ms, CV=.255. Provider/visible inter-arrival p95=22.017/31.389 ms regular and 20.865/30.892 ms fullscreen. First/final visible means=22.846/2019.228 ms regular and 23.075/2011.328 ms fullscreen. Largest visible intervals=53.671/53.140 ms. All five individual p50/p95/p99/max/CV values and counters are retained, not pooled. Final GC net delta regular +451128, fullscreen -6015368 bytes, all seven owner WeakRefs clear per cycle; the heap-slope limitation remains.

Production files changed cumulatively:

- packages/coding-agent/src/core/agent-session-runtime.ts
- packages/coding-agent/src/core/agent-session.ts (only the evidence-gated no-model sentinel accessor)
- packages/coding-agent/src/core/tool-result-presentation.ts
- packages/coding-agent/src/modes/interactive/interactive-mode.ts
- packages/coding-agent/src/modes/interactive/components/assistant-message.ts
- packages/coding-agent/src/modes/interactive/components/footer.ts
- packages/tui/src/components/markdown.ts
- packages/tui/src/components/retained-item.ts (evidence-gated bounded active attribution)
- packages/tui/src/terminal.ts (default-compatible lifecycle test seam)

The complete test/script/CI/documentation file list and current cumulative diff stat are available in [PR Files changed](https://github.com/dragonbaba/super-pi/pull/24/files). Raw heap snapshots remain private. Scalar capture originals and persistent copies are intentionally retained; an earlier automatic approval review blocked a move/delete cleanup operation, and no deletion workaround was attempted.