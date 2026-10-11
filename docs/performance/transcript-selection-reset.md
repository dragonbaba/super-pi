# Transcript selection reset (T08.2)

## Design gate

Baseline: `6ae1f2e74e7c25bf63c5539d077c0b8f2d46751a`, after PR #107.
Reference: upstream [83c9e26453](https://github.com/earendil-works/pi/commit/83c9e26453782cdea5ea838b46744a2e4cff70bc).

The production Alt mouse/selection and InteractiveMode rebuild fixture reproduces
selection owners surviving a transcript replacement inside the same ScrollView.
Layout ownership never changes, so `releaseLayoutInteractionOwners()` is not
called. Stale coordinates can highlight new text; click history and active
auto-scroll also survive. Three behavioral checks fail on the baseline; ordinary
streaming/append-only compaction and regular-renderer controls already pass.

Add a synchronous `TuiAltScreen.resetTextSelection()` API and invoke it before
entry conversion/rendering in `InteractiveMode.renderSessionEntries()`. It stops
the existing selection timer, clears fixed selection/click/link slots and asks
for a coalesced redraw only if a selection existed. It adds no state, cache,
pool, array, wrapper, closure, Promise or controller. It neither detaches the
layout nor resets scrollbar/focus state. Repeated/empty resets are safe.

Audited production chain:

- Runtime new/switch/fork/recovery -> registered rebind callback ->
  `rebindCurrentSession({renderBeforeBind:true})` -> `renderCurrentSessionState()`
  -> `renderInitialMessages()` -> `renderSessionEntries()`.
- Tree navigation clears the chat and calls `renderInitialMessages()`; settings,
  reload and history rebuild use `rebuildChatFromMessages()` -> the same entry
  boundary. RetainedContainer clear releases retained items/indexed lines, but
  does not replace the ScrollView or its selection coordinates.
- Successful compaction currently appends a summary while retaining the visible
  transcript. This is not an ownership replacement and preserves selection. A
  subsequent rebuild of compacted entries passes through the reset boundary.
  Canceled/failed navigation does not rebuild and keeps the current selection.
- Mouse input -> hit testing/click/drag -> selection fields and optional existing
  auto-scroll timer. Reset cancels that timer before dropping points/ranges,
  click history, drag pointer, pressed URL and press state. Late drag/release
  cannot act on the replacement transcript. Reset precedes fallible entry work.
- Ordinary agent `message_update` -> stable session listener -> `handleEvent()`
  -> assistant update/retained version -> `requestRender()` is unchanged.
- Coalesced `requestRender` -> stable nextTick/timer callbacks -> Alt `doRender`
  -> layout/retained viewport -> overlays -> `applySelection` -> ANSI line reset
  and terminal diff -> one composed frame -> TerminalFrameQueue ->
  ProcessTerminal callback/drain -> flush, error/abort and disposal.

The modified API is a low-frequency transcript ownership boundary; no new call
is added to provider deltas, tool progress, input processing or per-frame code.
The complete surrounding render chain remains within the audit and existing
AST/allocation gates. Existing input parsing creates mouse/selection records,
word/line ranges and copy text/arrays on explicit mouse actions; auto-scroll has
an existing timer callback. Layout retains bounded viewport scratch and selection
composition creates necessary styled strings, clears resolved point references
in finally and does not copy the full viewport. None of these existing paths is
reclassified as allocation-free by this change.

No object pool is introduced. No selection payload is returned to callers or
stored outside the owning TUI. Normal reset and failed rebuild drop references
synchronously; existing layout transfer/disposal cleanup remains in place.

## Verification

Windows x64 / Node v26.4.0, 2026-10-11. Six focused tests pass, including real
Alt mouse events and production InteractiveMode lifecycle methods (offline
session/content-renderer fixtures, not online runtime replacement). They cover
the shared new/switch/resume boundary, history/tree rebuild, unchanged layout
identity, fresh click count, active auto-scroll cancellation, ignored late
drag/release, failed rebuild, idempotent reset, normal streaming and append-only
compaction, regular rendering, and the exact reset call/allocation AST gate.
The fixture imports TUI through the same package entry as InteractiveMode so
the `instanceof` guard uses the production class identity. Build TUI first.

The four selection objects (anchor, focus, initial range and last click) are
collected over eight event-loop/controlled-GC turns while the TUI and ScrollView
remain alive. The active timer is destroyed synchronously; all selection
reference diagnostics are zero after reset/failure/disposal. The suite is
registered in the existing runner's `GC_TESTS` list so CI runs this assertion
with `--expose-gc`, without skipping it. No timer, worker, session, theme watcher
or terminal created by the tests remains active after their finally blocks.

Another 33 existing checks pass: selection/overlay allocation and ownership,
frame hot-path AST, global source invariants (including scripts) and the test
runner's lifecycle checks. Type checking and TUI/coding-agent builds pass.
No repeated local full suite; normal PR CI covers the complete Linux/Windows
suite. Commands:

```powershell
npm.cmd run build --workspace @super-pi/tui
node --expose-gc --experimental-strip-types --test tests/tui-transcript-selection-reset.test.ts
node --expose-gc --experimental-strip-types --test tests/tui-alt-overlay-selection-allocation.test.ts tests/tui-frame-hot-paths.test.ts tests/source-invariants.test.ts tests/test-runner.test.ts
npm.cmd run check
npm.cmd run build --workspace @super-pi/coding-agent
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --fixture production-alt --alt-control selection-multi --items 5000 --frames 2048 --warmup 128
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts
```

The existing production selection benchmark was run serially before/after the
change on the same machine: 5,000 retained items, 120x40 viewport, 128 warmups,
2,048 measured frames, 1 KiB Inspector samples. It measures the ordinary
selected-frame path, where reset is deliberately absent; the reset boundary's
new allocations are structurally zero and its release behavior is tested above.

| Fixture | Baseline sampled B/frame | Candidate sampled B/frame |
| --- | ---: | ---: |
| Production Alt, multi-row selection | 58247.34 | 58599.33 |
| Queue only, 20,000 prebuilt 64 KiB frames | 104.54 | 109.68 |

Both production samples visit/compose 11 selected rows and 32 viewport items
per frame, render zero completed items, materialize exactly one frame, and
have zero Promise/controller/wrapper/full-frame-copy counters. Active/queue high
watermarks are 1; pending high watermark, active/pending bytes and post-disposal
layout/composition reference counters are zero. No full viewport array copy is
introduced. The queue-only flush also ends with zero frame references/bytes.
Leading sampled sites remain selection styling (`highlightTerminalColumns`),
viewport rendering and existing layout records; queue samples are mainly timing
and benchmark bookkeeping. No pool is introduced or justified by these samples.

Production CPU p95 is 0.1855 -> 0.2253 ms; a single sample of an unchanged frame
path does not establish a timing improvement or causal regression. Post-frame
heap observations are 26.26 -> 26.34 MB; post-disposal controlled-GC heap deltas
are 6.623 -> 6.621 MB and include benchmark-owned data/profiles. These are neither
hard peak bounds nor proof of leaks. Direct reference counters and WeakRefs,
rather than heap size alone, establish the release result. Unchanged queue
failure/abort/late-event ownership retains its existing tests and the successful
PR #106 coverage; this fix adds no queue or physical-writer behavior.

Raw sample JSON, top allocation sites, test logs and measured source hashes are
in `.git/t08-2-transcript-selection-reset-20261011/`. Candidate samples were
captured as uncommitted source on the baseline; hashes identify the exact source.
SHA-256:

| Source | Baseline | Candidate |
| --- | --- | --- |
| `tui-alt-screen.ts` | `48c32b6af5033ba39683ccd829ba612981549d3865aa51c2d0454082cb44e9ea` | `08787fc770167a6497cb089745d41675a3a68243fa076330188b3a6db667a1af` |
| `interactive-mode.ts` | `d6ee24ffe01d5706facc2b0f975f5fe53241c3b3d8243ff7a323cb2483da8ca8` | `55fcdbb5c0f3494f9af88ff40502e8e3032679b3193d0aa8d9b142babb786a19` |

No online provider, real mouse/terminal visual session or Bun executable was
tested. These remain outside the offline behavioral/allocation evidence.
