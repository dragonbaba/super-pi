# Remove TuiMainScreen (2026-11-07)

Follow-up to [fullscreen-only-scrollbar-2026-11-07.md](fullscreen-only-scrollbar-2026-11-07.md).

## Scope

- `packages/tui/src/tui-main-screen.ts` and its package export are deleted.
  `TuiAltScreen` is the only renderer.
- Startup prompts (`startup-ui.ts`) and the config selector now use
  `TuiAltScreen` and close with `dispose({ preserveScreen: true })`. Visible
  change: these dialogs open on the alternate screen, and closing them restores
  the terminal exactly as it was before the prompt. Both pass
  `STARTUP_DIALOG_SCREEN_OPTIONS` (`mouse: false` and the new
  `viewportKeys: false`), so selector Page Up/Down and native right-click
  paste keep working (Codex findings on #262;
  `tests/tui-dialog-screen-options.test.ts`).
- `clearOnShrink`: the setting is marked deprecated in the schema and
  `SettingsManager` no longer reads or writes it. `TUI.getClearOnShrink()` /
  `setClearOnShrink()` remain as deprecated no-ops for extensions.
- Main-only `TuiBase` helpers `resolveFakeCursors` and
  `recordFullHistoryFallback` are removed; `resolveFakeCursorLine` remains.
- Tests and benches that used Main as a host now use
  `TuiAltScreen(..., { mouse: false })` with explicit `start()`/`stop()`.
  Main-only tests are deleted. `tests/tui-main-viewport-lifecycle.test.ts` is
  replaced by `tests/tui-fullscreen-exit-scrollback.test.ts`, which keeps the
  Alt exit-to-scrollback check. Bench fixtures `production-main`,
  `--editor-screen main` and the Main half of the session-clean fixture are
  removed; `tui-frame-allocations --fixture` accepts only `production-alt`.
  The four migrated leaf benches (`tui-paced-real-leaf`,
  `tui-paced-streamed-tool-args`, `tui-real-leaf-allocations`,
  `tui-tool-leaf-allocations`) call `start()` before measuring and throw if no
  frame was painted (Codex finding on #262).
- The renderer-handoff orphan-barrier tests in `tui-frame-queue` now cover
  Alt → Alt, the path the startup dialog → interactive mode uses.

## Hot-path audit

No production hot path gained code. The only production changes were
deletions plus the two dialog constructors. The frame hot-path, source
invariant and overlay/selection allocation AST checks now list only Alt
methods.

## Known pre-existing behaviour (not changed)

Alt's implicit transcript `ScrollView` calls
`RetainedContainer.getContentHeight()`, which measures dirty records by
rendering them and then drops the prepared lines; `renderViewportTail()`
renders the same dirty record again. The active retained item therefore
renders twice per frame (`activeItemRenders` = 2; `Markdown` caches
internally, so the second pass is cheap). Migrated tests pin 2 with a comment.
Keeping the prepared lines until the frame's `renderViewport` is a candidate
follow-up; it must satisfy the lifecycle/reference-release contract.

## Verification (Windows x64, Node 26.13.0)

- `tsgo --noEmit`: exit 0. `npm run build:offline`: 12/12 packages.
- `tests/alpha-cli.test.ts`: 20 pass, 0 fail (22 total).
- `scripts/test.mjs --suite hot`: 22 units, exit 0.
- `scripts/test.mjs --suite all --keep-going`: 472 units. 469 passed in that run.
  `tui-alt-overlay-selection-allocation` was fixed afterwards and passes 6/6.
  `native-source-delivery` needs `npm_execpath`; run with it set (as `npm test`
  does), it passes 2/2. `windows-sandbox-powershell7` fails only because the
  local execution policy is not `RemoteSigned`; it touches no file in this change.
- Directly migrated files pass on their own, including:
  - `tui-frame-queue` 78/78
  - `tui-editor-cache-lifecycle` 39/39
  - `tui-final-unmount-cache-owners` 24/24
  - `tui-frame-hot-paths` 12/12
- No `TuiMainScreen`, `tui-main-screen` or `captureRenderState` reference is
  left outside dated `docs/evidence` and generated indexes.
