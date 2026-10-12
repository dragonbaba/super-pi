# Preserve the excluded shell-command title color

## Design gate

Baseline: `f73c19c7db64116b82f77b7eaf09be940b157613`.
The constructor colors an excluded (`!!`) command dim, but updateDisplay
hardcodes bashMode. Streaming output, completion, expansion, padding changes
and cache reconstruction therefore lose the title's exclusion cue. The border
and the actual exclusion from model context remain correct.

Retain the selected theme color key as one readonly primitive field and use
it when rebuilding the title. Do not cache styled text, which would become
stale after a theme change. No execution, history, context or truncation logic
changes, and no extra hot-path allocation is required.

Audited chain: local/custom BashOperations -> executeBashWithOperations
(streaming sanitizer, onChunk, spill/truncate, finally release) ->
AgentSession.executeBash -> InteractiveMode.handleBashCommand's lifecycle
guard -> BashExecutionComponent.appendOutput/updateDisplay -> Text/preview
-> retained transcript invalidation -> Main/Alt layout/render ->
TerminalFrameQueue -> ProcessTerminal.writeFrame. Completed session history
reconstructs the same component using message.excludeFromContext. Completion,
error and cancellation stop the loader; final component cache release clears
preview/loader/UI references; TUI disposal releases frame owners.

Existing costs are unchanged: output splitting/joining/truncation, Text and
preview construction, styled strings, preview arrays and existing map
callbacks. The expanded path can render more stored output; this small color
fix does not redesign that pre-existing behavior or claim global zero
allocation. The added field points to one of two fixed color-name strings for
the component lifetime. No new closure, Promise, controller, queue, cache,
full-frame copy or object pool is introduced.

Verify ordinary and excluded titles through stream/completion/abort/error,
expand/padding/theme changes and cache release; reuse the existing final-release
check. Compare the leaf AST allocation sites against the baseline, preserve
shared frame invariants, and run a bounded before/after production rendering
allocation/GC probe. No shell execution or full local test suite is needed.

## Verification

The excluded-title case fails on its first output update before the change.
Both ordinary/excluded regressions pass afterward, each covering success,
error, cancellation, theme/padding changes and cache reconstruction. The
existing BashExecution final-release regression and repository typecheck pass.

The source AST comparison finds identical allocation sites in appendOutput,
updateDisplay, render and setComplete. In particular, updateDisplay still has
two existing map callbacks, one object literal, two array literals and four
constructor sites across its branches; this fix adds none. The shared frame
source invariants and bounded queue allocation probe also pass unchanged.

Three 128-update full-screen component/render/queue samples before/after are
49354/49874/50268 and 50780/48314/49005 sampled bytes/update (rounded).
All runs produce 128 frames, 0 measured synchronous-lane Promises, queue
high-water 1 and 0 frame wrappers/controllers/full-frame copies. Nine
UI/component/content WeakRefs are collected after success/error/cancel
completion and disposal. These values include existing output/rendering costs;
there is no performance-improvement claim. Evidence is in
`.git/ui-followups-20261012/`: components-before.json, bash-allocation.json,
bash-source-audit.json and bash-*.log (Windows, Node 26.4.0).
