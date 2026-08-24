# Super Pi Statusline Compatibility Build

Based on `@narumitw/pi-statusline@0.41.0`, locally adapted for Super Pi's Pi 0.84.1 source baseline.

## Runtime and security compatibility

- The package declares `@super-pi/coding-agent` and `@super-pi/tui` as Super Pi-provided peer dependencies.
- Startup is gated to `0.84.x`. Unsupported versions register only a warning and leave Pi's native footer intact.
- If Super Pi does not expose `VERSION`, the version is treated as unknown and the extension disables itself rather than guessing or loading the implementation. This is the safe-degradation policy.
- This build resolves the standard `.sp` config root with a lightweight helper equivalent to Super Pi's `getAgentDir()` for default, absolute, and `~`-relative `SP_CODING_AGENT_DIR` values. This avoids loading a second local coding-agent runtime solely for path constants.
- Project settings and package metadata reached from project-local package entries are inspected only when `ctx.isProjectTrusted()` is true.
- Package metadata, Git values, extension statuses, model/tool/path values, and configured display strings are stripped of ANSI/OSC/control sequences and bounded before terminal rendering.

## Local change

The upstream footer wakes every 30 seconds and always calls `tui.requestRender()`, even when neither `branch` nor `time` is visible. On Windows terminals this can interrupt IME pre-edit rendering and make Pinyin input flicker.

This build keeps the timer for compatibility but skips idle redraws unless the active layout includes `branch` or `time`. When `branch` is hidden it also skips startup, branch-event, and post-tool Git status queries. Event-driven updates (model, thinking level, tools, context, session state) are unchanged.

Tool activity text is also rendered without the upstream `⚙` and `💭` Emoji so the compact monochrome footer remains visually quiet.

The footer hot path renders powerline rows directly as `string[]`. The public string renderer remains as a compatibility wrapper, but normal TUI repaint no longer builds a newline-joined string, splits it back into rows, or creates an intermediate two-dimensional line array.

This build also adds a `speed` segment. It records the latest completed assistant stream's output-token throughput using monotonic timing between Pi's first assistant stream event and message completion. Request latency and tool execution are excluded; non-stream or implausibly short timing is omitted.

Pi loads deterministic precompiled `dist/index.js` instead of translating the full TypeScript graph on every start. This local build registers no `/statusline` command and carries no menu/TUI-kit runtime path. The startup graph also avoids runtime imports from the package-local coding-agent dev dependency. `npm run typecheck` rebuilds dist after validation.

## Update procedure

When updating upstream, reapply the guarded timer block in `src/statusline.ts`, then verify:

1. `pi --offline --list-models` starts without extension errors.
2. Regular and fullscreen TUI modes both render exactly one current editor/footer dock.
3. RPC `get_commands` does not expose `statusline`, while the footer still installs normally.
4. A layout without `branch` and `time` does not redraw while idle.
5. Model/tool/context changes still refresh the footer.
6. A streamed assistant response reports a finite `t/s` value after completion, while non-stream messages do not report fabricated throughput.
7. An untrusted project does not cause reads of its project settings or local package metadata.
8. ANSI/OSC/control-sequence payloads cannot alter terminal state through footer data.
9. `npm run typecheck` rebuilds `dist/`; fresh offline Pi RPC startup remains near the extension-free baseline.
