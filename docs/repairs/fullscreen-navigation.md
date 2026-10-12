# Fullscreen Home/End navigation

## Design gate

Baseline: `f73c19c7db64116b82f77b7eaf09be940b157613`.
The fullscreen input listener claims Home/End before the focused editor sees
them. The previous offline probe observed viewport 15 -> 0 with the editing
cursor unchanged at 4. Ctrl+Home/End currently take the editor route instead.

Home/End and Ctrl+A/E move to the start/end of the editing line;
Ctrl+Home/End scroll the fullscreen transcript. Ctrl+Up/Down provide fallback
sequences supported by Windows Console. At binding rebuild, these two viewport
defaults yield to explicit user bindings; explicit viewport bindings and
PageUp/PageDown behavior remain unchanged.

Audited chain: ProcessTerminal input -> TuiBase input listeners ->
TuiAltScreen.handleViewportInput -> KeybindingsManager.matches ->
Input/Editor.handleInput or ScrollView -> requestRender -> Main/Alt render ->
TerminalFrameQueue -> ProcessTerminal.writeFrame -> stop/dispose.
Only startup/reload binding data and resolution change; none of these hot
methods changes. The existing manager owns key arrays until reload/collection.
Filtering is limited to KeybindingsManager.rebuild, a startup/reload boundary.
The two fallback keys add existing matchesKey work: one temporary parse array
and record per visited fallback. No new per-input closure, Promise, timer,
retained cache, frame copy, object pool or runtime abstraction is introduced.

Verification is limited to production input routing in both screen modes,
fullscreen transcript movement, preserved user overrides, relevant frame
source invariants and a bounded input/render allocation and release comparison.

Reference: [upstream Home/End change](https://github.com/earendil-works/pi/commit/6100fe5a8358709a26050b8da97ccd188ae93101).

## Verification

The initial routing regression reproduced two failures. Review identified
editor-only overrides conflicting with new viewport defaults, and Windows
Console omitting distinct Ctrl+Home/End sequences. Two additional production
input probes reproduced both gaps. All six cases now pass, along with three
existing frame AST/source invariants and repository typecheck. Tests dispose
both renderers and verify terminal/input callback release.

The fallback uses documented Ctrl+Up/Down sequences; it does not synthesize
modifier state or change the native keyboard helper. See [Microsoft's input
sequence table](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences#input-sequences).
Actual Windows Console keyboard hardware was not driven by these fixtures.

Three 128-input production TuiAltScreen samples before/after review changes
record 12796/12906/13825 and 12957/11813/13780 sampled bytes/input (rounded).
Each produces 128 frames with 0 measured Promises and queue high-water 1;
frame wrappers/controllers/full-frame copies and final active/pending bytes
are zero. All nine TUI/input/terminal WeakRefs are collected. The shared
512-frame queue allocation probe passes. Sampling noise does not establish
an allocation or speed improvement. No full local suite, physical terminal
session, provider call or global-install update was performed.
Evidence: `.git/ui-followups-20261012/navigation-*.log` and
`navigation-review-allocation-*.json`, `queue-allocation.json` and
`frame-invariants.log` (Windows, Node 26.4.0).
