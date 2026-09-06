# G2S persistent evidence, 2026-09-06

Goal: `SUPER-PI-G2-ALPHA-STABILIZATION-ASTRA`. This is evidence, not Alpha manual approval or a merge authorization. The earlier TEMP reports are missing; only the persistent reports listed here are currently reviewable locally. Do not upload raw heap snapshots.

Root: `D:/RMProjects/Pi-g2s-evidence/20260906-g2s`.

| Report directory | Clean source SHA | Independent processes | Result |
| --- | --- | ---: | --- |
| `8c3f18d-matrix` | `8c3f18d76c4c685339b6489a9de1d7935d28d9b8` | 705 | all exit 0 |
| `growing-matrix` | `375adac4b48ed9ede386b58c4f69b91c6bd634c1` | 120 | all exit 0 |
| `67301e2-markdown-matrix` | `67301e226103b20192d6cae4705851ee672da537` | 130 | all exit 0 |

Each manifest stamps HEAD, Node/platform, arguments and stdout/stderr SHA-256. `scripts/alpha-matrix-summary.mjs` verifies every hash, completion count and exact-head clean report before summarizing. `matrix-705-summary.json` and `markdown-growing-comparison.json` retain each process's p50/p95/p99/max/CV as numeric arrays, with between-process mean/min/max/CV and comparison absolute differences. These are not pooled event percentiles. High variance remains inconclusive, even when every process exits successfully.

## L0–L3

The 705-process matrix contains rates (100), slow sink (200), history/terminal sizes (60), batched delivery (60), nine content corpora (270), HeapProfiler (10), and ANSI (5). Five independent processes per configuration, run sequentially without simultaneous tests. L0 generates fixture chunks; L1 uses AgentSession; L2 adds the interactive memory terminal; L3 uses real ProcessTerminal and a Writable. No real provider traffic or keys are used. Chunks are not model tokens.

The following values are mean completion ms over five processes, with 20 generated chunks and an immediate sink:

| Requested updates/s | L0 | L1 | L2 | L3 | L3−L1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 | 1902.127 | 1909.411 | 1912.632 | 1911.054 | +1.643 |
| 20 | 955.096 | 961.880 | 963.004 | 959.240 | −2.640 |
| 50 | 384.819 | 390.299 | 390.143 | 393.509 | +3.210 |
| 100 | 206.057 | 202.528 | 199.257 | 205.630 | +3.102 |
| burst | 0.231 | 3.174 | 15.269 | 15.447 | +12.273 |

Negative differences in paced fixtures are scheduling variation, not a TUI speedup. Short burst includes first/final parse, layout, diff and frame delivery; +12.273 ms exceeds a 5% relative headless limit and is reported explicitly. No artificial typing or scheduler throttle was added.

| Rate | Largest process root p95 ms | Largest marker→write p95 ms | Mean first-visible ms | Maximum visible interval ms |
| --- | ---: | ---: | ---: | ---: |
| 10 | 2.740 | 39.289 | 35.037 | 129.990 |
| 20 | 2.702 | 35.317 | 32.531 | 81.986 |
| 50 | 2.205 | 50.364 | 32.538 | 51.062 |
| 100 | 1.646 | 40.536 | 33.289 | 40.690 |
| burst | 11.139 | 12.657 | 15.207 | 0 (coincident markers) |

Maximum provider intervals at 10/20/50/100 were 114.99/67.83/37.38/29.64 ms. Provider arrival and physical marker arrival are separate tables in every report. No additional >150 ms stall was seen in these small 10/20 steady immediate-sink fixtures. The strict two-render-interval target is not uniformly met. A 50/s sample has provider→event p95 25.37 ms, handled→render p95 28.50 ms, render-start→write p95 1.69 ms and event-loop delay p95 30 ms. These unpaired percentiles cannot be summed as a single chunk's timeline. Attribution beyond event-loop/scheduling wait remains inconclusive; this does not establish the user's real provider speed.

At 20/s, injected sink callback delays 5/20/50/100 ms produce largest marker→write p95 34.85/33.33/63.52/106.24 ms regular and 32.64/35.36/68.05/109.94 ms fullscreen. Provider max interval stays 62.59–74.75 ms. Queue HWM is 1 in these runs; no frame replacement is needed because the renderer defers intent while the physical writer owns a frame. Frame-queue unit tests separately exercise one active plus one replaced pending frame. Physical means Writable `_write` entry, not emulator pixel paint or callback completion.

## Growing response and Markdown ownership repair

Burst source sizes are 1,096/16,440/65,623/262,218 code units: the fixture rounds upward to a complete 137-character chunk and reports actual bytes/code units. Do not label these exact 1/16/64/256 KiB inputs.

After the lexer ownership fix, mean per-process root p95 values and differences from the matching five-process pre-fix run are:

| Mode | Approximate size | Mean root p95 ms | Difference | Between-process CV |
| --- | ---: | ---: | ---: | ---: |
| regular | 1 KiB | 11.455 | +2.32% | .014 |
| regular | 16 KiB | 20.193 | +0.17% | .023 |
| regular | 64 KiB | 42.509 | +2.96% | .026 |
| regular | 256 KiB | 112.760 | +1.15% | .009 |
| fullscreen | 1 KiB | 11.710 | +1.15% | .022 |
| fullscreen | 16 KiB | 16.308 | +2.68% | .022 |
| fullscreen | 64 KiB | 31.025 | +1.85% | .037 |
| fullscreen | 256 KiB | 75.897 | −1.83% | .018 |

This repair does not regress these measurements by >5%, but it does not provide a 20% CPU / 30% sampled-allocation improvement. It removes an incorrect long-lived parser owner, without introducing a complex optimization. Large first/final renders remain above the 16/33 ms targets. The conservative initial/full parse path has not been replaced with a second parser or a cross-session cache.

The 50k-history regular 120×40, 200-chunk run group at `8c3f18d` averages 99 root/frame/write operations, 98 active renders and two completed renders at prompt/final transitions. Isolated active-update stress separately asserts completed render delta zero. No full-history fallback occurs. Footer invalidation calls average 109.6 (the method itself is a no-op); Assistant update calls/content scans 101.6. Markdown eligible/hit averages 97/97, full fallbacks 3, reparsed characters 54,469.8, rewrapped 56,215.8, tokens rebuilt/reused 3/97. Fallback `none` means initial/full phase, not proof that an unsafe append was incremental. Frame strings generated/written average 99/99, replaced 0, terminal bytes 678,250.4, queue HWM 1.

## Allocations and owner release

Five regular 50k-history profile processes after the Markdown repair attribute sampled top-site sums to footer render (~1,051,600,000 bytes), native iterator `next` (~70,330,280), native `filter` (~48,867,760), SessionManager.getBranch (~48,493,680), breakLongWord (~45,833,328) and splitIntoTokensWithAnsi (~33,939,496). These are sums of sampled top-15 records over five processes, not exact total allocation or retained heap. Footer still traverses all entries, and context accounting still requests the branch. No unsupported generation cache was introduced: leafId alone is insufficient after append followed by branch movement back to an earlier leaf.

The AST inventory at `ed2a577` is retained as `ed2a577-source-audit.json`. `lexMarkdown`, frame-queue submit/start/finish have no allocation syntax sites in the audited categories. Successful `ProcessTerminal.writeFrame` adds no per-frame Promise/closure/AbortController/wrapper; its error constructor is on the failure path. Normal UI observer stress reports zero Promise returns, frame counters zero Promise/AbortController/wrapper/full-size copies, pending intent <=1, physical queue <=2. This is not a zero-allocation claim for every render/helper:

- Assistant fallback contains eight trim sites, two Markdown and four Text constructors and five object literals; fixture counters distinguish the single-slot append path from fallback.
- Footer render contains two array literals, map/slice/join/repeat calls and two extension-status callbacks. They remain visible in the audit; extension callbacks were not measured by the no-extension 50k profile and were not speculatively rewritten.
- Markdown render contains six array literals, two Array constructors, one object literal and trim/repeat/concat work. Formatting helpers and native string operations remain part of the full call chain. Syntax alone does not prove a full-size string copy.
- Existing READ_GROUP pools retain four Sets and four Maps with the existing <=128-entry retention predicate; unchanged, synchronous acquire/finally release, not newly justified by this profile.
- Shared runtime/shutdown deferred Promises are lifecycle operations. Abort rejection observation retains first-error state until abort settlement. The auxiliary activity waiter retains session and resolve/reject callbacks until completion/deadline, then clears callback fields and its one interval. No per-delta Promise tail/array was added. A third-party Promise that never settles may retain its own reaction.

The actual 100,000-update stress uses direct session-event dispatch, not a provider burst that coalesces to a handful of UI calls. Standalone 100-cycle runs at `f8497a6` release seven owner WeakRefs every cycle, in both modes, using one isolated HOME and a preallocated numeric sample table outside node:test. Heap contains plateaus and small positive steps. WeakRef success does not establish a zero total-heap slope.

Pre-fix snapshots expose both V8 `regexp_last_match_info` and the global Markdown tokenizer→lexer→tokens→raw chain. Post-fix `markdown-fixed.heapsnapshot` retains the 100,024-byte target only through V8; the separate diagnostic RegExp-control snapshot has zero target strings. Normal five-cycle heap delta is +451,264 bytes. The diagnostic control is never run in production and is not used to claim universal release. Eight real lexer tests cover success/throw/reentrant success/reentrant throw in both incremental modes, including exact outer-lexer restoration and WeakRefs.

ANSI's five-process benchmark covers 1/4096/4097/4098/8192/65536 sequences. Retained index HWM stays 49,152 bytes even for one sequence. At 65,536: four compactions, 470 continuation chunks, one source digest construction and one full estimator scan, 65,994 fallback characters, all index bytes released. This fixed common-case allocation remains D. No per-chunk digest, full-source copy, unbounded interval collection or budget change.

## Remaining gates

Functional local checks are recorded separately in the status ledger. Time targets, strict total-heap slope, complete per-update dynamic allocation attribution and the user's configured startup failure remain open/inconclusive as described above. Native terminal manual validation, Linux/Windows exact-head CI and external Draft review are not implied by any table here. Frozen provider wire, session JSONL, contextual-budget semantics and artifact/cursor format are unchanged.
