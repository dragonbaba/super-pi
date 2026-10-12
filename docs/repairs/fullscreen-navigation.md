# Fullscreen Home/End navigation

## Design gate

Baseline: `f73c19c7db64116b82f77b7eaf09be940b157613`.
The fullscreen input listener claims Home/End before the focused editor sees
them. The previous offline probe observed viewport 15 -> 0 with the editing
cursor unchanged at 4. Ctrl+Home/End currently take the editor route instead.

Home/End and Ctrl+A/E move to the start/end of the editing line;
Ctrl+Home/End scroll the fullscreen transcript. Ctrl+Up/Down provide fallback
sequences supported by Windows Console. At binding rebuild, these two viewport
defaults yield to explicit user bindings. Accepted extension shortcuts also
override viewport actions, including explicitly configured viewport bindings.

Audited chain: ProcessTerminal input -> TuiBase input listeners ->
TuiAltScreen.handleViewportInput -> KeybindingsManager.matches ->
Input/Editor.handleInput or ScrollView -> requestRender -> Main/Alt render ->
TerminalFrameQueue -> ProcessTerminal.writeFrame -> stop/dispose.
Only startup/reload binding data and resolution change; none of these hot
methods changes. The manager owns key arrays and accepted override key strings
until reload/collection; extension UI reset clears the override keys.
Filtering is limited to KeybindingsManager.rebuild, a startup/reload boundary.
The two fallback keys add existing matchesKey work: one temporary parse array
and record per visited fallback. No new per-input closure, Promise, timer,
handler retention, frame copy, object pool or runtime abstraction is introduced.

Verification is limited to production input routing in both screen modes,
fullscreen transcript movement, preserved user overrides, relevant frame
source invariants and a bounded input/render allocation and release comparison.

Reference: [upstream Home/End change](https://github.com/earendil-works/pi/commit/6100fe5a8358709a26050b8da97ccd188ae93101).

### Extension override follow-up design

Review found that ExtensionRunner accepts non-reserved shortcut overrides, but
the fullscreen listener can consume them before CustomEditor invokes the
extension. At extension setup, restore unclaimed bindings before collecting
accepted shortcuts, then exclude their keys from viewport actions. Apply the
same rule to explicit viewport bindings because the runner permits those
overrides too. Reserved shortcut rejection remains owned by ExtensionRunner.
The keybinding manager owns only a set of key strings, replaced at setup and
cleared on extension UI reset/reload; it never retains extension handlers.
User configuration is not rewritten. Rebuild is a cold configuration boundary;
matches, viewport input, CustomEditor dispatch and frame methods stay unchanged.
The existing shortcut callback/context/Promise costs remain explicit command
costs. Verify real runner acceptance -> setup -> fullscreen -> editor dispatch,
including empty reload and reserved rejection, without extending the full suite.

## Verification

The initial routing regression reproduced two failures. Review identified
editor-only overrides conflicting with new viewport defaults, and Windows
Console omitting distinct Ctrl+Home/End sequences. Two additional production
input probes reproduced both gaps. A second review exposed extension shortcuts
being intercepted. Two additional tests reproduce the loss and cover accepted
default/explicit viewport overrides, reserved rejection, repeat setup, restored
keys and released callbacks after empty reload. All eight cases now pass, along with three
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

With extension override keys installed, a bounded follow-up records
12588/12175/12248 sampled bytes/input, 128 frames, 0 measured Promises,
queue high-water 1 and zero active/pending bytes in each sample. Clearing
overrides restores default keys; all twelve manager/TUI/input/terminal WeakRefs
are collected. This measures ordinary input with accepted keys installed, not
extension handler execution; it does not claim a speed or allocation improvement.
The dispatch/render hot methods remain unchanged. Follow-up evidence is
`navigation-extension-{before,after,typecheck}.log` and
`navigation-extension-allocation.json` in the same evidence directory.
