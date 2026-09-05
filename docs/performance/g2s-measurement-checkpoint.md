# G2S measurement checkpoint (not acceptance)

Goal: `SUPER-PI-G2-ALPHA-STABILIZATION-ASTRA`. No real provider credentials or model traffic used. All results below use deterministic generated chunks, not model token throughput. Local raw numeric reports and command logs are retained at `C:/Windows/TEMP/g2s-evidence-7628a840d93d424db9db6b946d408f59`; no raw tool result/session text is included in these reports.

## Four-layer baseline

Exact clean source commit: `092cc7321f69d36a6bcf03f6c9dad2d6baf714ff`. Windows, Node 26.4.0, 120×40 regular, plain text, no completed history, 20 chunks per process. Each cell is the mean completion duration over five independent processes. HeapProfiler disabled for timing. L0 consumes fixture only; L1 real AgentSession with no constructed TUI; L2 real InteractiveMode with memory terminal; L3 real InteractiveMode/ProcessTerminal with immediate Writable sink.

| Requested updates/s | L0 ms | L1 ms | L2 ms | L3 ms | L3 minus L1 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 | 1907.33 | 1911.13 | 1908.19 | 1909.87 | -1.26 |
| 20 | 954.85 | 962.79 | 959.77 | 961.76 | -1.03 |
| 50 | 383.69 | 388.93 | 388.55 | 390.41 | 1.48 |
| 100 | 296.78 | 291.13 | 251.80 | 241.83 | -49.30 |
| burst | 0.24 | 3.66 | 15.80 | 16.10 | 12.44 |

The 100/s generator did **not** sustain its requested schedule: Windows timer granularity changes actual arrivals. Its apparent TUI speedup is not a performance improvement. Burst's 340% relative headless overhead is not a pass against the 5% gate; this very short fixture includes first/final frame work, and a longer burst/isolated active-update measurement is required. Report schedules and actual inter-arrivals separately.

For 10/s L3, the largest per-process p95 provider-to-physical latency was 32.54 ms; maximum provider inter-arrival 110.45 ms, visible inter-arrival 122.75 ms. At 20/s these were 39.73 / 62.77 / 62.68 ms. Maximum per-process root-render p95 was 0.88 / 0.83 ms respectively. No >150 ms visible stall occurred in this limited steady fixture. The strict two-interval latency target is not uniformly met. The reports retain p50/p95/p99/max/CV per process; small sample sizes and high root-duration CV make strong time-improvement conclusions **inconclusive**.

Marker timestamps measure first presence in a physical sink write (L3), not a screenshot or emulator paint completion. Diff frames may omit already visible markers. Multiple markers becoming visible in one write retain equal timestamps, exposing batching. Final marker is required, queue HWM <=2 and pending render HWM <=1 are asserted. Instrumentation and timestamp tables exist only in the fixture, hard bounded to 100,000 chunks. The benchmark still needs explicit event-to-render/render-to-write attribution and complete fallback-reason accounting before final acceptance.

## History baseline and measured footer change

Exact clean baseline: `0ca0f5a85c791bfaf1d4f3946cc0bdbb59ea2dec`, requested 20/s, 20 chunks, L3 immediate. Five processes per row. Values below are the largest per-process root p95 (not a pooled percentile).

| Mode | History | Root p95 ms | Provider-to-physical p95 ms | Max visible stall ms | Completed renders |
| --- | ---: | ---: | ---: | ---: | ---: |
| regular | 0 | 0.83 | 46.31 | 66.04 | 2 |
| regular | 5k | 1.62 | 46.81 | 90.64 | 2 |
| regular | 50k | 6.55 | 49.54 | 94.02 | 2 |
| fullscreen | 0 | 0.95 | 46.07 | 78.08 | 2 |
| fullscreen | 5k | 1.55 | 46.95 | 92.00 | 2 |
| fullscreen | 50k | 6.51 | 37.41 | 78.47 | 2 |

These counts include prompt/final-message transitions. They do not establish the required zero completed/offscreen delta during isolated active updates. A regular 50k run also records one full-history fallback and an ~8.4 MB frame around the transition; this remains open, not labeled an active-update pass.

Separate 40-chunk/50k HeapProfiler sample (32 KiB sampling interval) showed `getBranch` ~58.4 MB, `getSessionName` ~57.1 MB, native `filter` ~58.1 MB, footer `render` ~11.9 MB self allocation, plus native iterator allocation. Sampling includes first/final transitions. Inlining changes attribution; these are sampled sites, not exact allocation counts.

Source evidence: footer `render` already obtains all session entries for usage and then calls `getSessionName`, which obtains another filtered full entry array. `footer.invalidate()` itself is a no-op. Test-only red `3f1cf26` observes two copies. Production `d537baec10780ee8c2a37afe50f3914309ec4524` collects latest session-info name in the existing append-order usage loop, preserving empty-name clearing. Green test observes one copy and unchanged displayed cost/name. No storage rewrite, cache, event change, pool or throttle.

Five-process after measurements at clean `d537bae`, 50k: largest root p95 regular 6.37 ms, fullscreen 5.86 ms; mean root p95 5.91 / 5.65 ms. Largest provider-to-physical p95 38.45 / 37.22 ms. The separate profile no longer has `getSessionName` in its top sites, but attribution shifts heavily into footer render. Do not infer an exact allocation percentage or claim full streaming performance acceptance from this sample. Deterministic benefit is exactly one fewer full entry array per footer render.

## ANSI release sample

Clean `0ca0f5a`, sizes 1/4096/4097/4098/8192/65536 sequences. Fixed per-source index HWM 49,152 bytes, including the one-sequence case (D backlog). At 65,536: 4 compactions, 61,440 overflow sequences, 645 overflow lookups, 5,137 fallback sequences inspected, 65,994 logical fallback characters, maximum fallback distance 7,670, 470 continuation chunks. All six sources have exactly one digest construction and one full estimator scan. After dispose every retained index byte count is zero.

Five controlled-GC heap readings: 16,424,432; 16,422,352; 16,403,320; 16,403,320; 16,403,920 bytes. 12/12 WeakRefs cleared. This checks these ANSI sources only, not the full interactive release matrix or long-run heap slope. Profile top allocations are dominated by the independent `ansiCorpus` oracle/Set; production examples include `scanText` ~921 KB, `createCursor` ~327 KB, estimator ~281 KB, `readContinuation` ~205 KB, `parseCursor` ~150 KB. Separate oracle-free allocation comparison remains pending.

## Reproduction

## Active retained-range investigation (G2S, before candidate acceptance)

The evidence-gated retained-item change is justified by immutable red `24701c9` and the clean `1f8bf074e29f990158583ea00ba37f1b3f13d6c2` L3 profile. The red fixture dispatches 100,000 actual InteractiveMode updates, rendering every 4096 updates; ordinary provider burst delivery is separately coalesced and does not prove this count. Regular mode recorded 25 full-history fallbacks; fullscreen did not. A 200-chunk word corpus at requested 100 updates/s with 50,000 completed items recorded 89 fallbacks in 103 root renders, 4,450,154 retained cache hits and 51,249,417 terminal bytes. Sampled allocations included doRender ~857.5 MB, applyLineResets ~285 MB and retained render ~190.4 MB (sampling attribution, not exact byte counters). Root p95 was 42.07 ms in that single process; this is hotspot evidence, not five-process acceptance.

Source causes: repeated invalidations of an already-dirty record overflow the fixed mutation ring before measurement; an active item's unchanged prefix is conservatively attributed as changed, causing main-screen full-history replay when that prefix is above the viewport. The proposed retained-only fix coalesces pending invalidations and keeps a bounded reference snapshot of rendered active lines to attribute exact changes. The snapshot owns its array because arbitrary Components may reuse theirs. It retains at most 4096 line references and 512 Ki code units, copies no strings, and releases on invalidation, completion, cache release and disposal. Above the cap it preserves conservative fallback. Exact attribution requires a single mutation generation and the same baseline rendered version; intermediate direct renders or stale observers fall back conservatively. It adds no pool, per-update Promise, closure, timer, Map or Set. The active reference array is allocated once per cache lifetime, not once per frame. These references are additional to completed cache accounting and must not be described as zero retained active content.

Initial dirty-tree after-profile reduced active fallbacks to zero but still recorded one final-transition fallback: 113 roots, 112 active and two completed renders, 50,068 cache hits, 9,168,483 terminal bytes, root p95 7.72 ms. The full transition frame was still ~8.46 MB and remains an open item. Top allocations moved to footer render (~133 MB and ~128 MB sampled sites). These single-process before/after figures have different delivered event counts and are **not** a percentage improvement acceptance claim. The exact-head five-process comparison remains required. The additional attribution tests cover reused arrays, no-change versions, width change, hard caps, release, stale observers, and intermediate direct/full renders. Existing cursor/overlay golden tests caught an empty-range end-of-document fallback during development; it was corrected without weakening assertions.

## Reproduction commands

### Completion follow-up

Clean-head five-process long-word samples at `5143ecd`: regular mean root p95 8.61 ms, largest p95 9.28 ms, largest p99 11.95 ms; fullscreen 8.14 / 9.26 / 11.19 ms. Largest marker-to-write p95 37.59 / 39.00 ms, visible gaps 92.13 / 54.45 ms, provider gaps 27.99 / 27.34 ms. Regular recorded exactly one completion fallback in every run; fullscreen recorded none. Maximum within-process root CV was 0.782 / 0.317: temporal acceptance remains inconclusive, especially transition tails. These are post-change samples, not a five-process paired allocation reduction claim.

Independent red `f334a05` extends the real 100k-update fixture through message_end and agent_end and reproduces the final fallback (regular 1, expected 0). Source evidence: `complete()` erased the active render comparison before the ordinary final render, attributing the whole long item again. The follow-up keeps the already-bounded snapshot through that one transition, compares at the normal final render, then releases it as the completed cache takes ownership. There is no eager render or new work inside the AgentSession final event callback. If no final render occurs, invalidate, cache release and disposal still release the snapshot. The lifecycle test now asserts this explicit pending-completion owner and its release rather than requiring premature loss of the comparison at complete(). No canonical/provider/event-order semantics change. Green real 100k fixtures retain zero fallback including completion and release both source WeakRefs after GC.

Earlier clean `239135b` slow-sink matrix: 100 independent processes, five per requested 10/20/50/100/burst rate at each callback delay 5/20/50/100 ms, 20 chunks, regular 120x40. Queue HWM and pending render intent never exceeded one in these runs; every final marker was written. Largest marker-to-write p95 by delay: 48.01 / 47.18 / 66.35 / 124.45 ms. Largest visible gap: 126.26 / 126.29 / 155.30 / 114.96 ms, while provider gaps reached ~111 ms in the 10/s schedule. Thus the 155 ms slow-sink gap is not evidence of a 155 ms provider-independent CPU stall. Physical means entry into the injected Writable, not pixel visibility. Fullscreen slow-sink and failure/close measurements remain required.

Run after `npm ci` and `npm run build:offline`, from the dedicated worktree:

```powershell
node scripts/alpha-bench.mjs stream --layer 3 --rate 20 --count 20 --history 50000 --mode regular
node scripts/alpha-bench.mjs stream --layer 3 --rate 20 --count 40 --history 50000 --profile on
node scripts/alpha-bench.mjs ansi
```

The runner isolates HOME/config/session and SP_OFFLINE. It removes only its exact created temporary root. Repeat separately in five processes, retain exact commit/dirty stamps, and avoid simultaneous CPU-heavy tests. No provider token/s, native PTY, actual Windows Terminal manual validation, Linux CI, or final acceptance is inferred.
