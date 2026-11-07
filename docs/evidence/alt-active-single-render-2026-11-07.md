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
  and registers once per frame (`layoutFrameScopeRegistered`) before
  preparing, so lines kept by a measurement that throws midway are released
  too (Codex finding on #263). The same
  frame's `renderViewport` uses those lines and clears them in its existing
  `finally`. Lines measured only for height, such as an off-screen child above
  the tail, are released at frame end. Outside a frame, `getContentHeight()`
  keeps the old behaviour: measure, then release immediately.
- Not changed: the first frame or a width change measures every record without
  keeping lines, so the active record is composed once more there. That path
  is rare and not per-frame. Fixed in
  [fullscreen-leftovers-2026-11-07.md](fullscreen-leftovers-2026-11-07.md).

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

`tui-paced-real-leaf` (5,000 history items, 1,000 deliveries of 20 raw
updates). This bench paints only since the #262 review fixes, so its base is
`99470404a` (main after #262):

| Fixture | `activeItemRenders` before → after | B / delivery before → after | p50 / p95 ms before → after |
| --- | --- | --- | --- |
| assistant-plain-text | 2,000 → 1,000 | 35,531 → 34,811 | 0.0425 / 0.0748 → 0.0433 / 0.0731 |
| assistant-thinking | 2,000 → 1,000 | 32,982 → 33,026 | 0.0408 / 0.0587 → 0.0394 / 0.0559 |

`doRenderCalls` stays 1,000 and `finalHash` is unchanged for both fixtures.
`Markdown` caches internally, so the saved second render is cheap and CPU and
allocation stay within noise.

## Tests

- `tests/tui-layout-frame-scope.test.ts`:
  - 100 fullscreen frames, each with exactly one active render and zero
    completed renders; no prepared lines or registry slots remain after any
    frame;
  - an off-screen child measured only for height releases its lines;
  - a frame that throws after measuring releases its lines and the scope;
  - a measurement that throws inside the same container, after an earlier
    dirty child's lines were kept, releases them;
  - height queries outside a frame keep the release-immediately behaviour.
- Negative checks:
  - with the old source, the single-render test fails;
  - with release disabled, the off-screen and throwing-frame tests fail;
  - with registration after preparation (the first #263 revision), the
    same-container measurement failure test fails.
- `tests/tui-retained-transcript.test.ts` and `tests/tui-viewport.test.ts` now
  pin `activeItemRenders` to 1.
- `tsgo --noEmit` exit 0. Hot suite: 22 units pass. Rerun after rebasing on
  `99470404a`: `tsgo` exit 0; the four tests above pass 49/49; hot suite 22/22.
  After the registration-order fix: `tsgo` exit 0; 50/50; hot suite 22/22.
- Full suite with `npm_execpath` set: 473 units, 472 pass. The one failure,
  `windows-sandbox-powershell7`, is caused by the local execution policy.
