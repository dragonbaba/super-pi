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

Run after `npm ci` and `npm run build:offline`, from the dedicated worktree:

```powershell
node scripts/alpha-bench.mjs stream --layer 3 --rate 20 --count 20 --history 50000 --mode regular
node scripts/alpha-bench.mjs stream --layer 3 --rate 20 --count 40 --history 50000 --profile on
node scripts/alpha-bench.mjs ansi
```

The runner isolates HOME/config/session and SP_OFFLINE. It removes only its exact created temporary root. Repeat separately in five processes, retain exact commit/dirty stamps, and avoid simultaneous CPU-heavy tests. No provider token/s, native PTY, actual Windows Terminal manual validation, Linux CI, or final acceptance is inferred.
