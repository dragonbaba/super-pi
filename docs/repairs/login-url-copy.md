# Copy the active login URL

## Design gate

Baseline: `f73c19c7db64116b82f77b7eaf09be940b157613`.
LoginDialog displays an authorization URL but forwards app.message.copy to
Input. The prior device-code probe reproduces this with the default Ctrl+X.

Keep one active URL and one copy-hint Text per dialog, with one in-flight
clipboard write at most. Both browser and device-code URL displays use the
existing app.message.copy binding and clipboard helper. Copy failure is
reported inline without failing login. A captured hint identity rejects stale
feedback after URL replacement; cancel, details replacement and the login
owner's finally clear the URL/hint references. No clipboard operation is started
for ordinary input, and a held copy key cannot enqueue pending writes.
The existing clipboard API is not cancellable: an already-started write may
finish after cancellation, but cannot update the closed dialog.

Audited chain: ProcessTerminal -> TuiBase -> focused LoginDialog.handleInput
-> Input for ordinary keys, or explicit copy command -> copyToClipboard
(native/platform/OSC52 fallback) -> one existing hint update -> requestRender
-> Main/Alt render -> TerminalFrameQueue -> ProcessTerminal.writeFrame.
Authentication events arrive through InteractiveMode.notifyAuthDialog;
showLoginDialog finally and cancelActiveLoginDialog own completion and abort.

Ordinary key input adds primitive/reference admission and one lookup through
the existing keybinding matcher while a URL is active. `matchesKey.parseKeyId`
already creates one split array and one parsed record per configured binding;
this additional match has that existing, call-owned cost. It retains neither
result and must not be described as allocation-free. Clipboard copying
is an explicit user-command async boundary; it may use the existing platform
helper's Promise/process resources. The dialog has no new timers, controllers,
queues, unbounded status history, or object pools. The callback is retained
once per dialog; no per-key closure/Promise is introduced. Existing render,
input editing and terminal costs remain and will be measured, not called zero.

Validation: focused URL/keybinding/error/late-completion behavior and the
existing login cancellation checks, source invariants, bounded allocation
comparison for ordinary login input, and controlled-GC owner release. No real
clipboard write, browser launch, provider login or full local test suite.

## Verification

The device URL regression fails before the change. Seven focused checks and
two existing login cancellation checks pass, together with repository typecheck
and the shared frame invariants. Browser launching and clipboard writes are
substituted in behavior fixtures; no real authentication or desktop state is used.

Three 128-update ordinary-input samples before/after measure 16021/15895/15816
and 16597/15974/15171 sampled bytes per update (rounded). Each produces 128
frames, 0 Promises in the measured synchronous lane, queue high-water 1,
0 frame wrappers/controllers/full-frame copies, and zero active/pending frame
bytes after synchronous writes. These small samples include existing editor,
layout and rendering costs; they do not establish a speed or allocation win.
Nine WeakRefs to UI/dialog/content owners are all collected after disposal.
Evidence: `.git/ui-followups-20261012/components-before.json`,
`login-allocation.json`, `login-*.log`; Windows, Node 26.4.0.
The unchanged frame queue also passed its bounded allocation probe (512 frames,
4 KiB each; `.git/ui-followups-20261012/queue-allocation.json`).
