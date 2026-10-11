# WezTerm fullscreen image redraw (T07.3)

## Design gate recorded before implementation

Baseline: `a0abead84df9ab30ce261e79d3a543cf41dd8b40` (PR #105 merged).
Reference: upstream [672000c80c](https://github.com/earendil-works/pi/commit/672000c80c84f59a4b3ffd7f7f8975772c270b1b).
The local production renderer reproduces both protocol defects: full frames place
an image before later covered-row clears/writes; an unchanged image anchor does
not redraw when a covered text row changes. This is protocol-output evidence,
not a real WezTerm visual acceptance run.

Scope: detect WezTerm once per terminal start, track visible image coverage with
primitive row bounds in the existing comparison loop, and emit all clears/text
before image lines. Read explicit cropped `r` before registered original height.
Reuse the existing generation-aware upload cache and placement-only commands.
No crop arithmetic, decoder, worker, session policy, object pool or new retained
image data. Do not copy upstream's per-frame `map`/`some` closure/change-array path.

Audited production chain: wheel/scroll/scrollbar or component update → stable
`requestRender` callback / scheduler → `performRender` → Alt `doRender` →
`renderLayoutFrame` / `paintBox` / `paintScrollbar` / `cropKittyImageLine` →
line normalization and comparison → Kitty placement preparation → frame string →
`TerminalFrameQueue.submit/start/finish` → `ProcessTerminal.writeFrame` → stable
Writable callback and drain → flush / failure / abort / final disposal. The
InteractiveMode session layout replacement uses `setLayoutRoot` and its existing
detached-owner render-cache release. Source audit includes these existing helpers,
the upload cache, scheduled callbacks and cleanup; no producer/queue/writer API changes.

Existing allocations: layout viewport output and paint strings; image metadata
regex matches/wrappers; placement result/strings and viewport-sized prepared lines
when image redraw is required; one final frame string; numeric upload metadata
on first encounter. New state is one instance boolean; coverage is local numbers
and booleans, no retained scratch. Row parsing uses bounded control headers only,
never decodes/scans the image payload. Normal frames introduce no closures,
Promises, AbortControllers, change arrays, wrapper state or full-frame copies.
Coverage lookup does add two regex match arrays per inspected unchanged image
header (and an ID match on metadata fallback); it returns only a number. The
placement parser now reuses its control header instead of matching it twice.
Newly required covered-row redraws use the existing placement result/array path.

Existing ownership bounds remain: uploaded metadata stores visible images plus
at most 16 offscreen entries / 32 MiB encoded / 64 MiB decoded estimates. It owns
no encoded image strings. Global metadata holds at most 1000 numeric entries.
Prepared lines are call-owned, at most viewport height, unretained after return
or throw; previous/next/raw screens and layout caches belong to the TUI and clear
on final disposal. Component render cache is released on detached ownership.
Queue failure/abort clears logical frame references; outstanding OS writes retain
only their existing physical owner until callback/drain completes.

## Validation (2026-10-11)

Windows x64, Node v26.4.0. Seven focused tests pass, including `WEZTERM_PANE=0`,
case-insensitive `TERM_PROGRAM`, unchanged anchors, cropped height, scrolling,
ordinary Kitty compatibility, detached caches and final upload/queue cleanup.
The baseline fails the full-frame ordering, unchanged-anchor and scroll-order
assertions. The scroll fixture explicitly sets `maxHeightCells: 4` (Image's
default at a two-column width is one row).

All 66 related tests in the five source/layout files below pass. Five selected
existing queue tests pass for pending replacement, stream error/close/abort/late
events, lifecycle timeout, failure and synchronous completion. `npm run check`
and the TUI build pass. No repeated local full-suite run; PR CI owns the complete
Linux/Windows suite.

```powershell
node --expose-gc --experimental-strip-types --test tests/tui-wezterm-images.test.ts
node --expose-gc --experimental-strip-types --test tests/tui-hot-paths.test.ts tests/tui-retained-source-invariants.test.ts tests/allocation-cleanup-hot-paths.test.ts tests/tui-frame-hot-paths.test.ts tests/tui-alt-layout-allocation.test.ts
node --expose-gc --experimental-strip-types --test --test-name-pattern='^latest terminal frame|^ProcessTerminal frame writes isolate|^normal writes have no absolute deadline|^discardPending releases|^synchronous writers finish' tests/tui-frame-queue.test.ts
npm.cmd run check
npm.cmd run build --workspace @super-pi/tui
node --expose-gc --experimental-strip-types scripts/bench/tui-wezterm-images.ts output.json
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts
```

The production benchmark uses a real Image, layout, Alt renderer, instrumentation
and frame queue with a synchronous no-output terminal. Each scenario warms 128
frames and samples 2,048 frames at a 1 KiB HeapProfiler interval. The terminal
counts uploads/placements without retaining frames. The full scenarios force a
full redraw; covered/outside scenarios change one text row. It records eight
controlled GC turns after detached ownership and disposal. It creates no OS
terminal, worker or persistent timer. Queue-only measurement uses the existing
20,000-frame, 64 KiB prebuilt-frame benchmark.

| Scenario | Baseline sampled bytes/frame | Candidate sampled bytes/frame | Baseline → candidate placements |
| --- | ---: | ---: | ---: |
| Full WezTerm | 6749.18 | 6621.83 | 2048 → 2048 |
| Full ordinary Kitty control | 6629.27 | 6483.89 | 2048 → 2048 |
| Changed covered row, WezTerm | 2099.24 | 4737.43 | 0 → 2048 |
| Changed outside row, WezTerm | 2214.76 | 2484.19 | 0 → 0 |
| Queue only | 108.98 | 108.38 | N/A |

The covered-row increase is the required restoration previously omitted by the
buggy baseline, including placement parsing and redraw frame strings. Outside-row
overhead includes the control-header coverage lookup; there is no image reupload.
Full-frame leading sites remain `doRender`, `getKittyImagePlacement`,
`renderCached` and existing encoding/runtime work. Covered-row leading sites are
`doRender`, placement preparation and layout. Outside-row leading sites include
the header regex matches and layout. No performance improvement is claimed from
one sample. The first candidate sample ran concurrently with checks; its timing
was discarded. The table uses the final sequential candidate measurement.

Every scenario has exactly 2048 generated/physical frames, zero uploads after
warmup, frame Promise/controller/wrapper/full-copy counts all zero, queue and
active-write high watermarks 1, pending high watermark 0, and zero active/pending
bytes after flush. Source invariants establish no new hot closures/change arrays.
One frame string is generated per render; zero-copy counters do not prove zero
V8 cons-string flattening. Queue-only measured closure/Promise/controller/wrapper
counts and full-frame copies are zero; final active/pending references are zero.

Periodic production peak heap samples are 13.47–17.75 MB for the candidate and
13.62–17.50 MB for baseline. They are samples, not absolute peak bounds. Saved
profiles accumulate across scenarios and are included in final heap measurements,
so these heap totals are not proof of retained application memory. The lifecycle
evidence is direct: every candidate image WeakRef is collected; all final Alt
document/upload/layout/selection owner counters are zero. Detached image cached
lines are undefined before GC. Existing queue tests cover error/abort reference
release without changing physical Writable ownership semantics.

Raw profiles/logs are retained locally at
`.git/t07-3-wezterm-image-redraw-20261011/` (`baseline.json`,
`candidate-serial.json`, corresponding queue JSON and test logs). Baseline Alt
SHA-256: `bb9248e36e289b950bf10a7c1f6dd12edc120e84d3477f93eb48f145c03dc541`;
candidate Alt SHA-256:
`48c32b6af5033ba39683ccd829ba612981549d3865aa51c2d0454082cb44e9ea`.
Baseline terminal-image SHA-256:
`81f4e190fbbdf7247e130914734605e661849746f6c218677944b005674bcf0e`;
candidate: `0dc6aed7a71ab78e663b3b1af299d72982733591dd59290d5bedfcb62af3fe03`.
Both runs record all three production source hashes; candidate was measured as
an uncommitted change on the baseline commit, not claimed to be that commit.

No real WezTerm visual acceptance, remote terminal or Bun executable validation
was performed. The regression asserts protocol ordering and reuse through the
production renderer. Final PR review and CI status are recorded separately in
the local task plan.
