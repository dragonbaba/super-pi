# Fullscreen Home/End navigation

## Design gate

Baseline: `f73c19c7db64116b82f77b7eaf09be940b157613`.
The fullscreen input listener claims Home/End before the focused editor sees
them. The previous offline probe observed viewport 15 -> 0 with the editing
cursor unchanged at 4. Ctrl+Home/End currently take the editor route instead.

Change only the default binding declarations: Home/End and Ctrl+A/E move to
the start/end of the editing line; Ctrl+Home/End scroll the fullscreen
transcript. Keep explicit user overrides and PageUp/PageDown behavior.

Audited chain: ProcessTerminal input -> TuiBase input listeners ->
TuiAltScreen.handleViewportInput -> KeybindingsManager.matches ->
Input/Editor.handleInput or ScrollView -> requestRender -> Main/Alt render ->
TerminalFrameQueue -> ProcessTerminal.writeFrame -> stop/dispose.
Only startup/reload binding data changes; none of these hot methods changes.
The existing manager owns the key arrays until reload/collection. Removing
two editor aliases adds no per-input allocation, callback, Promise, timer,
cache or resource. No object pool or new runtime abstraction is needed.

Verification is limited to production input routing in both screen modes,
fullscreen transcript movement, preserved user overrides and relevant frame
source invariants. Allocation benchmarks are not required for a static
default-table change; the producer/render/queue implementations are unchanged.

Reference: [upstream Home/End change](https://github.com/earendil-works/pi/commit/6100fe5a8358709a26050b8da97ccd188ae93101).

## Verification

The new production-routing regression reproduced two failures before the
change and passes all four cases afterward. Three existing frame AST/source
invariants and the repository typecheck pass. Tests dispose both renderers
and verify terminal/input callback release. No full local suite, physical
terminal session, network call or global-install update was performed.
Evidence: `.git/ui-followups-20261012/navigation-*.log` and
`frame-invariants.log` (Windows, Node 26.4.0).
