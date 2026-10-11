# OSC 7501 program status

F05.2 follows fixed upstream v1.1.0
`abe508e1b89912adde45528136c3221eb69acdd7`, after F05.1 merged as
`4a4e60a56911152944b394b47032d204b6916ced`.

## Design gate

Interactive mode currently reports only OSC 9;4 progress. There is no OSC 7501
encoder, support negotiation or working/blocked/completion outcome report.
The protocol reference is https://www.superlogical.com/rex/docs/build/program-status
(checked 2026-10-12). Only the root record and existing basic states/kinds are in scope.

Audit: Agent latest observer -> snapshot -> AgentSession synchronous observer and
session event listeners -> InteractiveMode.handleEvent -> primitive reporter ->
ProcessTerminal -> its existing frameOutput/error observer and outstanding-write
ownership. Input support replies pass through StdinBuffer before keyboard
negotiation. Startup, stop/resume, mode replacement, session replacement, dialog
finish/cancel, output failure and final disposal are the release boundaries.
Ordinary rendering/layout, frame creation, TerminalFrameQueue and writeFrame
remain unchanged; their existing allocation/source gates still apply.

Use fixed primitive state and two bounded dialog slots (extension dialog and
login), not a map/array snapshot or JSON serialization on each event. Ignore
message/tool deltas without reading or copying their payload. Compare primitive
status values before encoding. Only state transitions sanitize bounded text and
materialize a small OSC string. No per-update closure, Promise, controller,
wrapper, array or timer; no object pool. Session names, titles and first error
lines are bounded to 2048 UTF-8 bytes; prompts, responses and tool output are not
reported. Waiting-for-input survives agent settlement until a new run/reset.

Terminal support is queried before the existing DA1 sentinel. `SP_PROGRAM_STATUS`
accepts 0 (disabled) or 1 (forced); absent means auto-detect, with no heartbeat or
new timeout. Replies are consumed rather than entering the editor. Restart
requeries support and replays the latest state. Keep the Terminal method optional
for third-party terminal implementations; use primitive arguments to avoid event
wrappers. Existing OSC 9;4 configuration stays independent.

The terminal owns at most one in-flight status write and one bounded latest
encoded status. Stable callback/drain/close handlers share the existing output
failure and disposal accounting. Callback plus drain must settle before another
status is written. Stop suppresses new writes while retaining the bounded latest
status for resume; final disposal and failure drop logical text references while
preserving outstanding physical write/error ownership until completion. No raw
stdout bypass and no full terminal-frame copy.

Validate protocol bytes/limits, split replies and DA ordering, explicit overrides,
deduplication, bounded backpressure, synchronous/asynchronous output failures,
resume/disposal and real interactive state/dialog/session transitions. Use the
existing session-event and queue allocation baselines, focused AST/source gates,
and a controlled-GC owner-release probe. Run only relevant checks locally.

## Verification

Windows / Node v26.4.0. The initial production capability probe failed because
`ProcessTerminal.setProgramStatus` was absent. Final local checks:

- 22 new behavior/lifecycle checks pass with controlled GC. These exercise real
  Main/Alt sessions, permission cancellation and renderer handoff; split BEL/ST
  support replies; DA-before-reply; both environment overrides; UTF-8/control
  limits; both callback/drain orders; stop/restart; throw, callback, close and
  error failures; and a synchronous pending-write failure inside drain delivery.
- 118 relevant existing frame, terminal, event and source/AST checks pass. The
  enhanced benchmark gate was rerun after adding the real reporter to its fixture.
  Root typecheck and TUI/coding-agent builds pass. No full local suite.
- 100,000 message plus 100,000 tool updates produce zero status writes, zero
  Promises and zero reads of delta payloads. 100,000 duplicate terminal statuses
  produce one write. A gated output retains one active write and only its latest
  replacement through 1,000 state changes. Callback and drain are both required.
- Disposal drops encoded/message/terminal references. Four WeakRefs (terminal,
  input, output and reporter) have zero survivors after controlled GC. Error,
  close, drain and input listeners and outstanding-write counts reach zero after
  physical completion; an unfinished write keeps the existing error observer.

Before/after allocation evidence (100,000 updates, 10,000 warmup per event case;
20,000 prebuilt 64 KiB frames, 1,000 warmup for the unchanged queue):

| Fixture | Sampled bytes/update or frame before -> after | Controlled-GC heap delta before -> after |
| --- | --- | --- |
| Message update | 8.007 -> 10.715 | 107,616 -> 124,240 B |
| Tool update | 21.325 -> 22.451 | 132,280 -> 138,960 B |
| Coalesced observer chain | 151.838 -> 155.819 | 858,936 -> 881,216 B |
| Prebuilt frame queue | 112.791 -> 106.015 | 258,064 -> 251,432 B |

The baseline has no reporter; the candidate benchmark now includes the actual
reporter inside the same InteractiveMode event path. Both have zero built-in
listener/bridge Promises, rejection observers and source-gated wrapper/closure/
array counters. The candidate adds explicit zero status-report counters. The
coalesced chain retains one delivered snapshot per 100,000 raw updates and all
final values are correct. Leading sampled sites remain InteractiveMode.handleEvent
for direct delivery, scheduleFlush/iterator operations for coalescing, and the
existing queue measurement. The changed code introduces no delta allocation;
small sampled differences include JIT/instrumentation noise and are not claimed
as a performance improvement. CPU p95 per direct update is 0.0684 -> 0.0742 µs
(message) and 0.1802 -> 0.1922 µs (tool); coalesced raw-update p95 is
0.6662 -> 0.6302 µs. No pool is introduced.

The queue retains zero active/pending references and bytes after flush; frame
Promises/controllers/wrappers, queue string materializations and full-size copies
are zero. No frame algorithm changed. Event benchmarks use real observer delivery
and stub UI leaves, while behavior checks exercise the actual Main/Alt UI and
ProcessTerminal with a fake Writable. A terminal that visually displays OSC 7501
has not been tested. Raw logs and profiles are local under
`.git/f05-2-program-status-20261012/`.
