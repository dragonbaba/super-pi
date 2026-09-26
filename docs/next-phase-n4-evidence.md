# N4 task cost and bounded work

This work remains in progress. The first implementation slice makes the existing
tool-result budget visible and adjustable. It does not establish a performance win;
the full task matrix, I/O counters, five-process comparisons, formal PTY startup
and combined N1–N4 Session acceptance are still required.

## Explicit budget status and session settings

`/tool-budget status`, `/tool-budget <positive decimal integer>` and
`/tool-budget off` operate on the current idle AgentSession. `/settings` includes
the same control with a few explicit choices. Opening the setting does not enable
it. These controls change only this live session and never write global/project
settings or change their startup priority. Existing startup validation still rejects
an enabled malformed configured budget; SDK owners that explicitly omit the budget
are shown as enabled but unconfigured. Images, cache usage and billed cost are
unavailable estimates, not zero. Applied/blocked means actual request preparation,
not a provider billing claim.

The SDK's final conversion consults the session's current existing G2D owner.
An invalid option or active tool refuses atomically. Settings restore the actual
value after refusal. Reconfiguration disposes the prior projection owner, clears
the prior evidence generation and canonical UI references, and invalidates/detaches
old UI discovery registrations through the existing lifecycle helper. Subsequent
discovery activates its bounded index lazily; status does not rescan history.
The authoritative complete messages and tool effects stay in the Session.

The default SDK + actual OpenAI serializer regression creates a real fixture file,
blocks the next request at budget 1, explicitly changes to 4096 and continues. It
observes exactly one write, two serialized provider requests total, one durable tool
result, unchanged global/project settings, zero pending authorization, and released
old projection records/code units. A real InteractiveMode/SettingsList test holds
an actual tool in flight, checks command and keyboard settings behavior, refuses
the change without a misleading value, then changes it after settlement.

## Allocation and ownership scope

Audited chain: SDK final conversion → current projection owner → canonical messages
and result discovery → InteractiveMode registrations → tool components → retained
TUI invalidation → release. There is no status calculation in provider deltas,
tool progress, footer, layout or terminal-frame code. The settings callback is one
instance field per InteractiveMode; parser/formatter are module functions and the
only new pattern is a const in `tool-result-budget-regex.ts`. AST gates cover the
three Session methods, command method and exact once-owner callback; repeated status
queries leave full-source-estimator scan counts unchanged. No pool or persistent
cache is introduced, and explicit status snapshots are not claimed zero-allocation.

Initial Windows Node22.19 check/build:offline pass. Budget recovery/status/AST
focused tests: 13 pass, one existing platform-specific skip. Full allocation
benchmarks, whole-project gates, both-platform CI and current-head review remain
required before completing N4.

Both existing full `bench:tool-result-budgeted-model-view` and
`bench:tool-result-contextual-budget` runs pass on this first slice. Their source
counters retain zero full-result copies/serializations, per-result closures/pools
and per-request envelope wrappers/Promise/AbortController constructions. This is
a regression result for the existing projector, not proof of a new speedup.
