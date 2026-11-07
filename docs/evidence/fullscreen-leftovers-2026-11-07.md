# Fullscreen-only leftovers (2026-11-07)

Follow-up to [alt-active-single-render-2026-11-07.md](alt-active-single-render-2026-11-07.md).

## Scope

- **Width-change frames render an uncached record once.** The first frame and
  every width change take the full-measure branch of
  `RetainedContainer.prepareViewportIndex()`. It used to measure every record
  without keeping lines, so the active item (and any plain child) was rendered
  again during composition. Completed records were already cheap: the second
  call hits their retained cache. The branch now keeps lines only for:
  - uncached records (`record.retained?.completed !== true`);
  - within the last `VIEWPORT_HEIGHT_BLOCK_SIZE` (256) records;
  - and only when the caller asked to retain lines.

  The same frame's composition consumes them. Leftovers are cleared by the
  existing `renderViewport` `finally`, or, for `getContentHeight` inside a
  frame, by the frame scope.
- **Dead code removed:**
  - `TuiAltScreen.detachLayoutRootForTransfer()`. Its only caller was the
    Main↔Alt mode switch removed in #261. The source assertion in
    `tests/tui-frame-queue.test.ts` that pinned its body is removed with it.
  - `IdleStatus` in
    `packages/coding-agent/src/modes/interactive/components/status-indicator.ts`.
    Its last use was removed in #261, and it was never exported from the package.

## Hot-path audit

The change is in the width-change branch only. It runs on the first frame and on resize, not per frame. Steady-state frames use the dirty-record branch, which is unchanged.

The branch allocates nothing new:
- an indexed loop replaces the array iterator;
- the retain decision is a numeric comparison plus one property read.

Retained lines are the component's own output, not copies, and at most 256 records keep them. The prepared-record set is the existing one and is cleared on every exit path as before.

## Measurements (Windows x64, Node 26.13.0, i7-14700KF)

Base is `fb5e320e0` (main after #263); "after" is this change.

`tui-retained-lifecycle` (5,000 real transcript items, resize 120→96→144, 5
cycles, controlled GC):

| Metric | Before | After |
| --- | --- | --- |
| p50 / p95 ms | 703.9 / 714.1 | 698.2 / 702.2 |
| resize peak heap | 73,469,896 B | 72,588,504 B |
| final controlled-GC heap | 22,607,416 B | 22,578,400 B |
| heap slope / cycle | 6,770 B | 3,528 B |
| prepared line references / records after release | 0 / 0 | 0 / 0 |
| cached items / lines | 5,000 / 12,500 | 5,000 / 12,500 |

`tui-frame-allocations --fixture production-alt --items 5000 --warmup 1000 --frames 10000 --lifecycle-cycles 3`
(steady-state frames, as a guard):

| Metric | Before | After |
| --- | --- | --- |
| `activeRenderCallsPerFrame` | 1 | 1 |
| sampled bytes / frame | 10,098 | 10,080 |
| CPU p50 / p95 ms | 0.0256 / 0.0366 | 0.0267 / 0.0375 |
| lifecycle heap slope / cycle | 45,184 B | 37,512 B |
| retained references after dispose | 0 | 0 |

Frame string bytes, queue high-water mark and every other deterministic
counter are identical. CPU differences are within run-to-run noise.

## Tests

- New in `tests/tui-layout-frame-scope.test.ts`: "width-change frames render
  an active item once and keep at most one tail block". The fixture has 300
  completed, 300 plain and 1 active record, rendered at five widths. Each frame:
  - renders the active item and the visible plain tail exactly once;
  - measures the off-screen plain head once, then releases its lines;
  - leaves no prepared lines and no scope state.
- `tests/tui-retained-transcript.test.ts`: the first frame now renders 2
  transcript items, down from 3, and 1 active item.
- Negative check: with the `main` `retained-item.ts`, both tests fail (2
  failures).
- `tests/tui-retained-source-invariants.test.ts`: `prepareViewportIndex` joins
  the frame-scope AST check (no closure, object/array literal, `new` or spread).
  It also asserts the 256-record tail bound and the uncached-only retain
  condition.
- `tsgo --noEmit`: exit 0.
- All `tests/tui-*.test.ts` with `--expose-gc`: 517/517.
- Hot suite: 22/22.
