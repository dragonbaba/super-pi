# Fullscreen-only TUI and scrollbar fast path (2026-11-07)

## Scope

- Interactive mode always mounts `TuiAltScreen`. `tuiMode` and
  `fullscreenExitOutput` stay in the schema as deprecated, ignored keys;
  `--tui-mode` is still parsed but only warns. Runtime mode switching,
  transcript transfer between renderers and the regular-mode idle status were
  removed from `InteractiveMode`.
- `TuiMainScreen` itself is still used by startup UI, config selector, tests and
  benchmarks; deleting it is a separate follow-up.
- Scrollbar: `auto` and `always` reserve the last column. Rows inside a
  full-width reserving `ScrollView` keep the cached full-width fast path, and
  visible thumb cells are appended inline. Rows that cannot use the fast path
  (tabs, images, overlays, narrow boxes, very tall terminals) fall back to one
  `compositeTuiLine` per thumb row. The per-cell ANSI slicer
  `styleScrollbarCell` was removed.
- Mouse: the whole reserved column of an overflowing scroll view is the target,
  even while an `auto` bar is hidden. Hover reveals it, thumb press drags, and
  track press centres the thumb on the pointer and continues as a drag.
  Non-overflowing columns stay available to text selection.

## Hot-path audit

Production chain: `TuiAltScreen.render` → `renderLayoutFrame` → `layoutComponent`
→ `paintBox` → `paintScrollbarRows` / `paintLeadingScrollImage`.

- No closures, promises, arrays or wrapper objects were added per frame. Scroll
  context is saved and restored in four scalar locals around child painting.
- One `scrollbarStyle(" ")` call per frame, and only while the bar is visible.
- `LayoutContext.inlineScrollbarCell` is restored after child painting and reset
  in `begin()`, so no thumb string is retained between frames.
- New frame counters: `scrollbarInlineRows` and `scrollbarCompositeRows`.

## Measurements

Layout-only probe: 120x40, 5000 transcript lines, the active line changes every
frame, 500 warm-up frames, 5000 measured frames, sampled heap profiler at 256 B.
Each mode was run once against the HEAD (`8d4f0f124`) and working-tree sources.

| Mode | HEAD p50 / bytes per frame | New p50 / bytes per frame | Cached rows (HEAD → new) |
| --- | --- | --- | --- |
| hidden | 0.040 ms / 2.19 KB | 0.039 ms / 2.22 KB | 39 → 39 |
| auto, bar hidden | 0.040 ms / 2.19 KB | 0.040 ms / 2.19 KB | 39 → 39 |
| auto, bar visible | 0.335 ms / 53.9 KB | 0.043 ms / 2.78 KB | 38 → 38 |
| always | 1.865 ms / 315.7 KB | 0.043 ms / 2.77 KB | 0 → 38 |

In both visible modes the new frame paints 2 inline thumb rows and 0 composite
rows.

## Verification

- `tsgo --noEmit`: exit 0; `npm run build:offline`: 12/12 packages; `tests/alpha-cli.test.ts`: 20/20 (fullscreen only).
- `tests/tui-scrollbar.test.ts`: 9/9. It covers the reserved width, cached rows
  with a hidden bar, inline thumb rows with cache hits, the composite fallback,
  the dock boundary, hover reveal, track jump plus drag, thumb grab, and
  selection on a non-overflowing column.
- `scripts/test.mjs --suite hot`: 22 files, exit 0.
- Directly affected suites pass: `tui-frame-queue`, `tui-async-owner-closeout`,
  `tui-editor-cache-lifecycle`, `tui-alt-layout-allocation`,
  `allocation-cleanup-hot-paths`, `tui-transcript-selection-reset`, and
  `settings-json-schema`.

## Limits

- The track is a blank column, not a `│` glyph. That glyph has East Asian
  ambiguous width and can render two cells wide in CJK terminal configurations.
- A width change still relays out the visible transcript, about 50 ms at 5000
  items. Batching session appends was left unchanged because synchronous append
  is part of crash safety.
