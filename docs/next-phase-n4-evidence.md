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
Successfully admitted complete messages and tool effects stay in the Session.
MCP input-admission failure can instead retain an error without the complete remote
output, even when the remote operation already ran; status explicitly states this.

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
budget parser pattern is a const in `tool-result-budget-regex.ts`. AST gates cover the
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

## Review and full-call-chain regex correction

The dc160fe34 review identified idle compaction, provenance rediscovery, established
SDK source gates and the MCP retention wording. Actual manual compaction and branch
summary operations now refuse budget changes before owner/evidence mutation. The
SDK source invariants follow the Session bridge and assert every unchanged request
envelope argument, including image policy, output/context bounds and planning.
Seven existing AgentSession regexes now live in `agent-session-regex.ts`; repeated
interleaved lastIndex tests preserve behavior and the complete consumer file is
included in the dedicated-pattern AST gate.

An explicit configuration change advances one primitive generation. At the next
assistant start after successful request projection, the UI uses the existing
bounded canonical discovery API and matches exact source-array/tool-call identity
to retained tool leaves. It releases old sidecars and updates only matching leaves;
it does not replay scrollback or rebuild the transcript. The normal unchanged
generation returns before allocating/scanning. The temporary presentation map is
bounded by the existing discovery limit and cleared in finally. Full transcript
rebuilds adopt the current generation; no new persistent map or callback is added.
Cold rediscovery visits transcript components against at most the bounded discovery
set, so its explicit-action work still depends on retained history length. It is
not an O(1) operation and does not run per delta, progress update, frame or status.

Windows Node22.19 check and seventeen targeted real SDK/serializer/UI/source tests
pass. The actual profile performs twenty budget changes/next requests on the same
retained component: 22 provider-fixture requests, one tool execution, twenty cold
rediscovery passes/component probes, zero extra probes from 2,000 unchanged-generation
calls, and zero registrations after release. Sampling records 21,571,008 bytes for
the entire explicit-command/request lifecycle; controlled heap is
48,981,528→53,268,232 bytes. The fixture still owns complete Session/output references
at the second heap sample, so this is neither proof of zero retained heap nor a
per-delta allocation figure. Old projection owners release records/code units and
old cursors are replaced. Full new-head gates and actual review remain required.

## Expanded actual serializer success matrix (in progress)

`next-phase-task-matrix.test.ts` captures the actual OpenAI serializer with an offline
fetch fixture and runs 36 success rows: create/exact/snapshot/mixed × 1/4/16 addressed
paths × T1/T2/T3. Exact and snapshot use actual prior reads; tool discovery is actually
executed and charged. T2 schedules independent calls in one reply. Mixed moves count
both paths against the existing 16-path limit, so successful mixed 16 has twelve
operations/four moves (mixed 4 has three operations/one move). The original 16-operation
mixed fixture correctly exceeded the existing budget; that failure was not fixed by
relaxing production limits. Separate negative/recovery dimensions remain required.
The data includes English/Chinese, BOM/CRLF, valid multi-edit exact operations and
8 KiB single lines. Every successful row checks actual final filesystem content,
pending calls and authorization release. Windows initial full 36-row execution passes.

The first o200k_base measurement exceeded its test deadline. The unchanged 8 KiB
repeated-text estimator probe attributes 13,313 of 13,775 CPU samples (96.6%) to
js-tiktoken; five calls take approximately 3.0 seconds each on this host. This is
measurement-tool overhead, not an application hotspot or product speedup. The full
matrix defaults to the existing conservative text estimator, labelled
`super-pi.conservative-v1`; optional `SP_COST_TOKENIZER=o200k_base` retains that
estimator variant. Counts with different estimator labels are not directly compared.
Task data and final wire capture stay unchanged. Wire/schema/history/tool/output
estimates, requests, calls, approvals, actual reads, CPU/wall and sampled heaps are
reported separately; provider usage/cache hits/bills remain null. Five independent
interleaved processes, additional failure/history dimensions and full N4 measurements
are outstanding; this success slice is not final acceptance.
