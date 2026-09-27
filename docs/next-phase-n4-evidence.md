# N4 task cost and bounded work

This work remains in progress. The first implementation slice makes the existing
tool-result budget visible and adjustable. It does not establish a performance win;
the full task matrix, I/O counters, five-process comparisons, formal PTY startup
and combined N1–N4 Session acceptance are still required.

Subsequent measurement slices now implement those fixtures; five independent
interleaved final comparisons and final CI/review remain outstanding. Functional
probes are deliberately separate from the final timing evidence below.

The 0e287/08d56 review identified contaminated baseline imports, a mislabeled
heap reading and incomplete measurement cleanup. The shared model/runtime fixture
now imports no production modules. Inspector-only validation of the baseline success
and context processes observes zero candidate-package scripts; this diagnostic
preload is excluded from fair timing. TUI takes 122 defined heap samples (initial,
before/after each of sixty frame flushes and after stop), reports their maximum and
labels the separate after-stop value. This is a sampled maximum, not a true peak.
Each comparison child now has a generous scenario deadline and its recorded PID
is terminated on expiry (exact Windows tree / owned POSIX group). Failure/close
records distinguish incomplete cleanup; real stalled and missing-executable tests
settle with descriptors closed. Setup cleanup starts immediately after root/Session
acquisition; injected loader and I/O setup failures verify exact fixture removal.
PTY release now records a verified boolean and retains the root path separately.

The actual combined Session also exercises false-success interception after partial
completion, after a zero-effect remaining preview, and after filesystem observation
and draft creation. None clears unfinished obligations. The functional fixture now
records 25 requests, eleven tools and six approvals on Windows, with no replay.
Budget status records `preparation-failed` for non-budget projection errors instead
of leaving a stale applied/not-observed value. An actual default read hook produces
invalid layout after a valid request; the next serialization is blocked while the
completed read remains in the Session, and explicit status reports preparation
failure. The failure branch updates one primitive slot, with no regex/callback or
new scan; existing AST/ownership gates remain applicable. Final comparisons and
all final-head gates/CI/review are still outstanding.

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

## Recovery, context and combined Session fixtures

`next-phase-recovery-matrix.test.ts` adds fifteen equal four-file exact rows across
T1/T2/T3 and short/100-pair history, durable reopen, model switch and warm activation.
The actual serializer accounts for initial discovery, warm reads and reopening's
setup request. Overlimit 17-path and invalid-preflight batches leave every target
unchanged; an explicit bounded corrected request creates only its chosen target.
Baseline and candidate functional context/success matrices pass. No usage/cache or
bill is fabricated; the existing conservative estimator and its CPU cost are labelled.

One actual default SDK Session now performs: real batch preview with zero effects,
snapshot/create/move/delete commit, external drift after a committed first item,
structured partial completion, user-invoked changes verification/draft without calls,
new approval and remaining request, real multiline Bash exit 23, Windows PowerShell
exit 7, actual 5MiB log cap with final tail, too-small budget refusal, explicit budget
change/continuation and durable reopen without replay. Initial candidate passes with
21 serialized requests, ten tools, six approvals and zero pending calls; these are
fixture observations, not a production cost estimate. Current-parent reruns remain required.

## File I/O measurement boundaries

`next-phase-file-io.ts` traces actual default SDK read → read-window proof → guard
preparation → queued revalidation → shared commit → receipt. Files are 4KiB, 256KiB,
2MiB minus one byte (the edit adds one byte), and 8MiB, for 1/4/16 paths, exact/snapshot.
At most three full snapshots are grouped under the existing 8MiB resident limit;
the task does not suppress required read/prepare/queue/commit rechecks. Explicit
FileHandle opens/closes and bytes read are instrumented; path-based readFile calls
with implicit opens are reported separately, not mislabelled complete syscall counts.
Hashes include content/proof/request hashing. Windows canonical and short Temp aliases
share the same measured scope. V8 precise counts are used only for synchronous named
candidate/diff constructors; async resumptions are not counted as function invocations.

Default local window reads currently do not issue snapshots for the larger rows.
Those rows record unavailable snapshots and unchanged bytes, without falling back
after failure. A separately labelled existing custom-I/O read/compact-snapshot
subsystem fixture measures real read-issued 8MiB snapshots and verified postimages
for 1/4/16 files, with fixture path hooks; it is not represented as default SDK
authorization support. Initial candidate rows pass. Observed retained snapshots,
full-file parsing/diff and mandatory hashing have measurable costs; no cache, pool,
generation shortcut or pure speed optimization is added on this evidence.

## Output, TUI and formal PTY probes

`next-phase-output-spill.ts` uses actual default SDK Bash processes and a recorded
owned temporary directory containing 1,024 entries. It measures first spill, actual
5MiB cap, an injected 8ms open/write delay and cancellation during delayed writes.
Both WriteStream scalar and vector writes are counted even when created by fd.
All four functional rows verify final content/cap or cancellation, settled stream
closure and zero pending writes. Slow filesystem injection is a controlled scenario,
not a claim about a particular disk. CPU granularity can yield zero in short Windows
samples; event-loop measurements and wall time remain separate.

`next-phase-tui-boundaries.ts` uses the actual built Alt/ScrollView/retained assistant
and tool components, 5,000 history entries, a 188,455-code-unit Markdown/code message,
and a 16-file bounded preview. It starts the TUI and asserts actual renders/writes,
then measures 60 resize/history-jump/expand transitions and a gated terminal boundary.
Initial valid execution writes 66 frames; the sampled render loop has zero deliberate
full-frame copies and zero frame Promise/AbortController/wrapper objects. It still
does real width-change work and bounded layout allocations. Final flush/stop releases
queue data and transcript children; the deliberately never-completing sink exercises
the terminal error/deadline path. The earlier zero-render prototype is invalid
measurement and excluded. Existing full Markdown work belongs to the previous phase;
the unchanged full-replay benchmark is reused, not claimed as newly completed.

The formal PTY harness launches Node22.19 `scripts/superpi.mjs --offline` with isolated
HOME/settings, default bundled resources and an offline fixture provider. Actual
editor input triggers the real default read and verifies its bytes. Network entry
points are blocked and counted. Functional candidate and baseline cold/warm probes
finish with two fixture requests, one read and zero network attempts. Cold means a
fresh process/settings; warm is another process sharing those settings, not a
flushed OS cache. Five interleaved process pairs are still required. npm ci is an
online dependency installation; post-install build/runtime probes do not download.

`next-phase-compare.mjs` records clean exact baseline/candidate coordinates and runs
six full scenarios in independent, interleaved processes: one discarded warmup pair
and five measured pairs. Raw logs remain outside the repository. Its final results,
percentiles, regressions, parent-chain verification and current-head CI/review must
be recorded before declaring this PR complete.

Measurement corrections are now exercised: the baseline success/context processes
report zero candidate package scripts through a separate inspector diagnostic
(two actual test child PIDs; excluded from timed runs). Shared model fixtures have
no production imports. Both baseline and candidate TUI/spill functional runs pass.
The old baseline only renders a batch summary; detailPathsRendered records that
feature difference instead of pretending both implementations draw identical text.
Heap samples are explicitly sampled maxima, with after-stop separate. Setup-failure
probes cover matrix/session/spill/IO cleanup; success, missing executable, deadline,
and ledger-write-failure probes verify exact owned child release. Every comparison
child now has a deadline and bounded termination watchdog; incomplete termination
is reported, never counted as release. PTY reports a checked boolean removedRoot.

The combined scenario executes 25 actual serialized provider requests, 11 tool
calls and 6 approvals. False-success remains blocked after partial mutation,
dry-run, verification and drafting, until an explicit fresh repair. Non-budget
projection preparation failures now show preparation-failed instead of stale
applied or budget-too-small state; actual read output and serializer tests pass.
All final five-round comparisons, PTY pairs and latest-head CI/review remain pending.

The subsequent review closes two remaining measurement scope issues: main I/O
resets sampledPeakHeap to the controlled-GC start value after discovery; TUI records
workload wall/CPU endpoints before stopping/traversing the inspector profile and
reports analysis overhead separately. Baseline and candidate TUI functional runs
pass with the revised report fields.

Comparison now builds both clean recorded revisions with the installed npm CLI's
build:offline before warmup, hashes every regular file under package dist trees
plus the lockfile, and verifies the same artifacts/revisions/clean status after
all rounds. These build processes are outside measured rounds. A fixture proves
ignored output changes and lockfile changes change the manifest. No dependency
installation/download is part of this build step; npm_execpath must point to the
already installed npm CLI.

The real PTY child now uses the owned deadline runner (120 seconds per cold/warm
child), SIGINT/SIGTERM abort handling and recorded PID termination. A failed kill
reports retained-root/cleanupIncomplete instead of deleting a live child's root.
POSIX inherited PTY termination targets only the recorded foreground child;
this formal launcher imports its CLI in-process and the fixture runs builtin read.
Normal non-PTY children retain the separately owned process group behavior.
Windows real cold/warm functional pair passes: 2 provider requests and 1 actual
read each, zero network attempts, both child close records clean, removedRoot=true.
An inherited-stdio stalled-child regression observes termination and timer cleanup.
These functional timings are not part of final five-round evidence.

Budget configuration also treats the public Agent's streaming state as busy.
Actual session.agent.prompt()/continue() provider streams held before any tool is
pending reject replacement atomically (same owner/status/generation); after the
stream settles, explicit reconfiguration disposes the old owner once. Current
check, offline build and focused budget/source/measurement guards pass. All final
whole-project checks, comparisons and exact-head review remain necessary.

The remaining measurement counter review uses the real Session compaction_start
event, including failed preparation attempts. An actual empty Session compact()
emits one counted start, refuses without a provider request and releases its busy
state. The coding-agent README now matches the status screen's MCP admission
caveat: rejected remote output can leave only an error, without continuation,
even after execution. These fixes do not change the production budget pipeline.

Inspector startup is also outside the workload clocks: TUI allocates timing state,
resets instrumentation and performs controlled GC before starting sampling; setup
wall/CPU is reported separately from workload and profile-analysis overhead.
Both main and legacy-compact I/O start precise coverage before controlled GC and
workload clocks. Updated complete I/O and TUI functional runs pass. Fair timings
still require the serial alternating baseline/candidate run on the final tree.

The success-matrix peak starts at the same post-GC heap baseline as its workload,
so setup's peak cannot contaminate peakHeapDelta. Both measurement changes need
a fresh final comparison; the interrupted r23 warmup contains no measured rounds
and is excluded.

After explicit budget changes, a bounded weak source-identity map captures the
actual context-transformed input of the successful projection. UI rediscovery
requires that exact content identity and tool-call ID, consumes the weak map and
never creates it on unchanged-generation provider deltas/progress/render paths.
No callback or regex was added to these methods. Actual SDK/OpenAI-serializer/TUI
tests cover canonical identity, context filtering and cloning. The latter two
cannot attach canonical cursors; a filtered result is serialized as the existing
adapter's synthetic missing-result error. Failed projection does not publish a
source map; configuration/disposal clears it, and weak keys retain no source.
Serial Node22.19 sampling over 20 changes: 22 requests, one tool execution,
20 rediscovery passes/probes, zero extra unchanged-generation probes, zero
registrations retained after release, 21,819,792 sampled bytes for the complete
request/command fixture (not per-delta allocation or a speedup claim).

Review r26: transcript rebuilds no longer acknowledge a pending budget generation
before successful request projection. A rebuild that consumes the new projection
uses its actual source identity and releases the weak map; otherwise the deferred
refresh remains pending. Actual InteractiveMode thinking-visibility rebuilds cover
identity/filter/clone contexts, new component binding, zero unchanged-generation
probes and zero retained registrations. Fifteen budget tests pass on Windows Node22.
The success matrix separately records synchronous diagnostic estimation plus its
JSON serialization CPU/wall cost, subtracts that interval from workload figures,
and retains inclusive totals. Timer quantization and later GC are not isolated;
heap samples still include estimator allocation. It remains an offline fixture,
not provider billing or pure product CPU. All 36 real serializer/filesystem rows
and 11 measurement guard tests pass; final serial comparison remains pending.

A subsequent actual runtime replacement probe exposed an independent boundary:
the UI revision belonged to the disposed Session. New/fork/resume rebind now resets
that primitive to the new owner's initial zero, preserving any explicit factory
configuration as pending. The existing once-lifecycle callback is reused. Actual
SDK/TUI replacement after three budget changes verifies continued historical cursor
binding without executing the tool again; both rebuild variants exercise it.

Review r27: the shared real-Session measurement helper now records CPU, wall time
and pass counts for diagnostic estimation and its serialization. Context, file-I/O
and spill workloads subtract only their own interval's deltas, preserving inclusive
totals and the stated GC/timer/heap limitations. A real setup-plus-two-workloads
test verifies setup is not subtracted again. Context/mixed/measurement guards:
17 passed on Windows Node22.19. TUI allocation sampling includes objects collected
by both major and minor GC; earlier sampling without those flags is retained-object
sampling and is superseded for allocation conclusions.

The serial comparison prepares both exact lockfiles with explicit network npm ci,
retaining repository script policy. It then binds every installed dependency byte,
native/generated file, internal link, actual package version and lock SRI before
offline build, after build and after all measurements. npm ci verifies archive SRI;
the unpacked-tree hash detects later mutations and is not called an SRI check.
Absent optional or explicitly extraneous lock entries are recorded separately;
missing required packages and version mismatch fail. Workspace source/dist are
bound independently; links escaping the project fail. Two installations and two
builds are preparation, followed by 12 discarded warmup and 60 measured children.
No install-time download is included in product timing. The current Windows tree
contains 422 lock records and 22,397 dependency files/links; these counts must be
refreshed by the final clean-install comparison.

Review r28: budget source provenance remains pending after model conversion and
is consumed only after the existing effective-provider-dispatch observer fires.
A pre-dispatch failure releases the weak map at agent_end while keeping the
generation pending for retry. UI rebuilds cannot attach those untransmitted
sources. A before_provider_request payload hook invalidates the pending source
proof because arbitrary wire transformations cannot preserve canonical identity;
such a request acknowledges dispatch without attaching historical cursors for
that changed generation. This conservative limitation also applies to hooks that
return an unchanged payload. Ordinary identity/filter/clone contexts retain their
tested behavior.

The UI reads a primitive waiting/ready/none state rather than allocating a status
snapshot. Enabled presentation without a configured budget acknowledges each
generation without repeated rediscovery. Actual runtime failure/retry, an injected
ExtensionHookTimeoutError before fetch, rebuild, payload-hook retry and five real
unconfigured responses plus 1,000 probes verify these boundaries. The latter
records zero status snapshots, captures, rediscovery passes and retained entries.
Existing owner callbacks are reused; no production regex or callback was added.
Budget and source gates: 28 passed; Node22.19 check passed. Updated profiling and
the final serial comparison are still required.

Review r29: successful Codex dispatch acknowledgement occurs after streaming.
The existing assistant message_end lifecycle now also probes the primitive
generation and refreshes once if acknowledged; unchanged generations return
without status snapshots, callbacks or scans. Actual Codex SSE adapter + SDK +
InteractiveMode execution records waiting at assistant start and a fresh retained
cursor at that same response's end, with three requests and only one tool run.
Undispatched provenance release moved into _emitAgentEnd before listeners, keeping
the existing awaited terminal-flush source invariant unchanged. Budget/source
tests: 20 pass; lifecycle/budget/frame-queue tests: 104 pass before the late-Codex
addition; Node22.19 check pass. Final combined gates, profiles and review remain.
