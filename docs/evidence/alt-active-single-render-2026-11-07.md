# Fullscreen active item renders once per frame (2026-11-07)

Follow-up to [remove-main-screen-2026-11-07.md](remove-main-screen-2026-11-07.md).

## Problem

In a fullscreen frame the transcript `ScrollView` first asks
`RetainedContainer.getContentHeight()` for the height, then calls
`renderViewport()`/`renderViewportTail()`. `getContentHeight()` measured dirty
records by rendering them and then dropped those lines; composition rendered
the visible ones again. The active (uncached) retained item was therefore
rendered twice per frame.

## Change

- New `packages/tui/src/layout-frame-scope.ts`: a depth counter plus a fixed
  owner registry. `renderLayoutFrame()` opens the scope and closes it in a
  nested `finally`, so it also closes when the frame or the scratch abort
  throws. When the outermost frame ends, every registered owner is released
  and its registry slot is set to `undefined`.
- `RetainedContainer.getContentHeight()` inside a frame keeps the lines it
  measured (`prepareViewportIndex(width, true)`, ≤256 dirty records as before)
  and registers once per frame (`layoutFrameScopeRegistered`). The same
  frame's `renderViewport` uses those lines and clears them in its existing
  `finally`. Lines measured only for height, such as an off-screen child above
  the tail, are released at frame end. Outside a frame, `getContentHeight()`
  keeps the old behaviour: measure, then release immediately.
- Not changed: the first frame or a width change measures every record without
  keeping lines, so the active record is composed once more there. That path
  is rare and not per-frame.

## Hot-path audit

Production chain: `TuiAltScreen.doRender` → `renderLayoutFrame` →
`layoutComponent` (scroll) → `ViewportContainer.getContentHeight`/`renderViewport`
→ `RetainedContainer.getContentHeight` → `prepareViewportIndex` →
`renderViewport`/`renderViewportTail` → `composeViewport` →
`renderViewportRecord`, then `endLayoutFrameScope`.

- No new closures, Promises, `AbortController`s, wrapper objects or arrays per
  frame. The registry is one module-level array that only grows to the number
  of distinct owners registered in a single frame. Registration is a slot
  write guarded by a boolean.
- The retained lines are the ones the active component already returned, not
  copies. Their lifetime is one synchronous frame.
- Source invariant: `tests/tui-retained-source-invariants.test.ts` ("layout
  frame scope hands measured lines to composition …") checks that the scope
  functions, `getContentHeight` and the release method contain no closure,
  object or array literals, `new` or spread, and that the scope closes in a
  nested `finally`.

## Measurements (Windows x64, Node 26.13.0, i7-14700KF)

Base is `a6ac2fd34` (PR #262 head before review fixes); "after" is this
change on top of that base.

`tui-frame-allocations --fixture production-alt --items 5000 --warmup 1000 --frames 10000 --lifecycle-cycles 3`:

| Metric | Before | After |
| --- | --- | --- |
| `activeRenderCallsPerFrame` | 2 | 1 |
| sampled bytes / frame | 10,154 | 10,062 |
| CPU p50 / p95 ms | 0.0256 / 0.0365 | 0.0250 / 0.0351 |
| lifecycle heap slope / cycle | 45,720 B | 37,780 B |
| retained references after dispose | 0 | 0 |

All other counters were identical, including viewport visits, copied lines,
frame strings, queue high-water marks, and frame Promise, wrapper and copy
counts.

`tui-transcript --cpu-only` (production `UserMessageComponent`/`AssistantMessageComponent`, 5,000 items), three runs each:

| | `activeItemRenderCalls` | p50 ms (3 runs) |
| --- | --- | --- |
| before | 2, 2, 2 | 0.0708, 0.0671, 0.0739 |
| after | 1, 1, 1 | 0.0706, 0.0622, 0.0627 |

## Tests

- `tests/tui-layout-frame-scope.test.ts`:
  - 100 fullscreen frames, each with exactly one active render and zero
    completed renders; no prepared lines or registry slots remain after any
    frame;
  - an off-screen child measured only for height releases its lines;
  - a frame that throws after measuring releases its lines and the scope;
  - height queries outside a frame keep the release-immediately behaviour.
- Negative checks:
  - with the old source, the single-render test fails;
  - with release disabled, the off-screen and throwing-frame tests fail.
- `tests/tui-retained-transcript.test.ts` and `tests/tui-viewport.test.ts` now
  pin `activeItemRenders` to 1.
- `tsgo --noEmit` exit 0. Hot suite: 22 units pass.
- Full suite with `npm_execpath` set: 473 units, 472 pass. The one failure,
  `windows-sandbox-powershell7`, is caused by the local execution policy.
