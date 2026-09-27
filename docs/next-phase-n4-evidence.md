# N4 task cost and bounded work

## Delivery evidence (2026-09-27)

All original N4 functions and measurements are implemented. The measured code is
`32fca50f1caa7eff66d1fed8e5d91a8e811fc903` (tree
`f9e1d2271e881add01d8820549c8cba69e9885d0`), containing final N3
`b50844cc8e201b9aeecc4576b81f149380804ffc`. Baseline is the agreed main
`4f547535b830c15d3a9605574c229a0641f94923`, not an intermediate topic branch.
The delivery documentation commit changes only the two evidence/index documents;
its current HEAD, full-gate CI and review are recorded in [Draft PR #50](https://github.com/dragonbaba/super-pi/pull/50).
The measured source coordinate is preserved rather than relabelled as that later
documentation HEAD. All four PRs remain unmerged.

On measured code, Node 22.19.0 check, build:offline, test:hot and full local tests
pass: **2,737 passed, 90 conditional/platform skips, zero failures**. Both x64
platforms passed [CI 36307505067](https://github.com/dragonbaba/super-pi/actions/runs/36307505067),
including clean npm ci, offline build, actual source/built/delivery entry probes,
five-process native costs and full tests. Actual [Codex review](https://github.com/dragonbaba/super-pi/pull/50#issuecomment-5854385789)
found no major issues. The two earlier presentation-spread and agent-end source
assertion failures were corrected in production without changing either assertion.
The relevant focused set passes all 133 tests. Final documentation-candidate
verification is reported separately on the PR, not inferred from this earlier CI.

Five relevant allocation gates pass: bash rendering, configured/contextual tool
result budgets, TUI tool leaves and shell compatibility. The complete changed
production-file AST audit finds **zero regexes outside dedicated regex modules**.
Lifecycle callbacks remain fixed module helpers or once-owner fields; the new
projection/status/rediscovery helpers pass their zero-callback gates. No pool,
new default budget, global import policy or pure speed optimization was added.

### Reproducible measurement record

Local raw evidence is under `D:/RMProjects/Pi-next-phase-artifacts/`:

- `n4-final-comparison-r39/summary.json`: all 85 groups, each with five independent
  alternating baseline/candidate processes and one discarded whole-process pair.
  All 60 measured, 12 warmup and four preparation children closed successfully.
- `n4-final-comparison-r39/coordinates.json` and installed/build manifests bind
  clean HEAD/tree, lockfile, every installed dependency byte/link/native artifact,
  and package builds before/after measurement. Baseline/candidate installed hashes
  are `e3834dfe62fac77889aa56363cb49794dd29db7cbf457b204b68a418a50caaf2` /
  `f61f2b65f372d9df7da2110df5f6c731fd73f9aec9314f21a451163f151e3b48`;
  build hashes are `a292d1469341f651beabdd86c42fff8dcb143bc99dd9f9bcd89ed45538879df3` /
  `b18998497933683f2ed964d4179bec88a4b02e892573df7664cfbe703b022532`.
- `n4-r39-pty-summary.json`: five alternating process pairs with cold and warm
  children each; **20 children, ten released roots**, two fixture requests and one
  real default read per child, zero network attempts. All source coordinates match.
- `n4-r39-{check,build-offline,test-hot,test}.log`, five
  `n4-r39-bench-*.log` gates, `n4-r39-budget-profile.log`, and
  `n4-r39-request-profile-30696.json` preserve validation and release evidence.

The comparison uses explicit **network npm ci**, then offline builds/runs; npm ci
is not an offline installation. No CPU benchmarks ran concurrently. Five-point
nearest-rank p95/p99 both equal the maximum, so they are not precise tail estimates.
Short Windows CPU samples are quantized and sometimes zero. Diagnostic token
estimation/serialization CPU and wall intervals are subtracted separately, with
inclusive totals retained; their allocations, later GC and fixture scheduling are
not isolated. Heap maxima are defined samples, not exact transient peaks or whole
process allocation. Worker/native/external Buffer memory is excluded from main
V8-heap samples. All measured I/O bytes are API bytes, not physical disk traffic.

### Task cost, including unsuccessful and recovery paths

The 36 success rows cover create/exact/snapshot/mixed, 1/4/16 addressed paths and
T1 (separate replies), T2 (multiple single-file tools in one reply) and T3
(one file_batch). Sixteen additional context/recovery rows cover short/long
history, reopening, model switch, warm discovery and overlimit/preflight repair.
Every row checks actual bytes and released calls. The fixture explicitly charges
discovery, schema, history, reads, continuations/retries and approvals. Billing,
provider usage and cache hits are **unknown/null**, never inferred from estimates.

For sixteen exact file changes, candidate five-process medians are:

| Strategy | Requests / tools | Discovery | Estimated input / schema / history / output tokens | Workload wall p50 / p95=p99 ms |
| --- | --- | --- | --- | --- |
| T1 | 33 / 32 | 0 | 352,587 / 91,707 / 101,752 / 3,200 | 310.96 / 313.30 |
| T2 | 3 / 32 | 0 | 30,680 / 8,337 / 8,354 / 2,982 | 245.82 / 250.69 |
| T3 | 4 / 18 | 1 | 38,451 / 14,365 / 9,665 / 2,497 | 302.29 / 409.44 |

These success rows have zero approvals under their chosen authority setup; they
do not measure an approval reduction. All three include sixteen real prior reads.
T3 uses fewer calls and provides batch preflight/receipts, but **does not beat T2
in this row's requests, input estimate or wall time**. No universal batch/token
saving is claimed. Every raw row retains CPU p50/p95/p99, individual samples,
input/tool/output estimates, retries, supplemental reads and quality.

The separate actual combined Session regression passes with **25 serialized
requests, eleven tools, six approvals and zero pending calls**: zero-effect preview,
mixed snapshot/create/move/delete, drift after a committed item, partial receipt,
verification/draft without replay, fresh approval and repair, real Bash/PowerShell
failure facts, 5 MiB log cap, explicit budget recovery, and durable reopen.
False-success remains blocked through preview/verification/drafting until repair.
This functional fixture is not a paid-model bill or fair timing comparison.

### Costs retained with the required behavior

| Workload | Baseline p50 / p95=p99 ms | Candidate p50 / p95=p99 ms | Interpretation |
| --- | --- | --- | --- |
| 16 x 4 KiB exact I/O | 457.81 / 458.52 | 623.52 / 643.08 | Native metadata/revalidation/publication cost included |
| 16 x 8 MiB exact I/O | 5,393.94 / 5,424.47 | 6,232.29 / 6,410.94 | Required extra read/hash work; no faster-FFI claim |
| 16 x 8 MiB legacy compact subsystem | 27,179.00 / 27,726.56 | 27,350.43 / 27,817.14 | Custom-I/O snapshot fixture, not default SDK authorization |
| First output spill | 101.92 / 103.28 | 102.26 / 105.84 | Actual log contents and closure verified |
| Output cap | 96.92 / 100.17 | 97.42 / 103.08 | Actual 5 MiB cap and final tail verified |
| Injected slow output | 107.77 / 118.64 | 111.93 / 116.81 | Controlled 8 ms open/write delay |
| Output cancellation | 215.37 / 254.53 | 232.33 / 251.22 | Settled streams and zero pending writes |
| 60 TUI width/history/expand changes | 5,286.14 / 5,334.95 | 8,132.43 / 8,198.88 | Candidate renders new bounded file details absent from baseline |
| Existing full replay/backpressure | 1,497.87 / 1,516.83 | 1,502.17 / 1,507.23 | Unchanged default fixture, no reduced run size |

The full I/O matrix includes 24 default read/exact/snapshot rows and three labelled
legacy compact rows. Large default reads that cannot issue snapshots report that
capability and unchanged bytes; these are not successful snapshot commits. For
16 x 8 MiB exact, baseline/candidate measured read bytes are 939,852,048 /
1,745,158,464 and hash bytes 1,209,630,650 / 2,149,235,818. Candidate preparation/diff
counts remain 32 exact candidates, sixteen patches and sixteen diffs. Native
identity, content and metadata verification accounts for the additional necessary
work; no checks were removed and no fallback-on-failure was introduced.

The expanded TUI case is deliberately **different visible work**: baseline has
`detailPathsRendered=false`, candidate true. CPU p50 is 2,249 / 3,453 ms and
GC-inclusive sampled allocation 5,194,576,112 / 5,940,991,184 bytes across the whole
workload. The new bounded preview wraps graphemes on changed widths; the existing
large Markdown/history also reflows. This is an explicit expansion/resize cost,
not an equivalent-output speed regression disguised as a win. Stable widths reuse
bounded rows; completion constructs the bounded report once, not in rendering.
Queue counters retain active <=1, pending <=1, zero deliberate full-frame copies,
and zero frame Promises/AbortControllers/wrappers. Flush/abort/stop release all
frame bytes and render intents. Controlled sink timing is not OS terminal drain.

### Formal PTY and explicit-change allocation

| Actual PTY boundary | Baseline p50 / p95=p99 ms | Candidate p50 / p95=p99 ms |
| --- | --- | --- |
| Cold input-ready | 1,828.45 / 1,931.22 | 1,850.61 / 1,891.26 |
| Warm input-ready | 1,802.07 / 1,809.57 | 1,810.56 / 1,837.35 |
| Cold editor-submit to real read result | 26.96 / 27.23 | 27.59 / 27.81 |
| Warm editor-submit to real read result | 25.62 / 27.06 | 26.18 / 26.66 |

Cold means fresh settings/process, not OS-cache eviction; warm is another process
sharing settings. Tool time starts at recorded editor submission, excluding
automation waits. Startup CPU p50 is 687/874 ms cold and 702/687 ms warm. Cold
paired differences range -18.2% to +60.1%; warm -32.2% to +25.0%. The five cold
samples show a higher median and must not be called zero overhead. Investigation
finds no consistent cold/warm CPU direction (cold p95 +1.4%, warm p95 -15.3%);
these samples cannot establish a stable overall >5% CPU regression or a speedup.
Candidate startup heap p50 is 194,039,008 bytes cold / 193,717,856 warm versus
189,819,208 / 190,196,552. This is disclosed low-frequency initialization cost;
the contribution of added source versus runtime variance is not isolated. It is
not a new optimization target under the user's scope freeze. No ordinary delta/progress/render lane
loads the native adapter. All individual CPU/heap samples remain in the report.

Explicit-budget profiles perform twenty changes/requests for each rebuild variant:
21,853,544 / 22,177,776 sampled bytes; controlled heaps
60,442,136 -> 63,110,184 and 63,167,064 -> 63,772,392 bytes. Both have one tool
execution, twenty rediscovery passes, zero additional unchanged-generation probes
and zero retained UI registrations. The ten actual contextual/image-policy/
headless/SDK-invalidation lifecycles sample 220,430,712 bytes; heap is
5,144,864 before module loading, 71,442,680 at end, 64,710,880 after GC. This includes
module/fixture/test-runner costs, not per-request or production-only allocation;
heap alone is not a no-leak proof. Ownership assertions separately verify final
view release on success/error/abort/disposal while canonical history remains.

The audited production chain is final SDK conversion -> Session projection bridge
-> configured/contextual/image policy -> bounded final-view capture -> actual
dispatch acknowledgement -> retained UI attachment -> response/agent-end/disposal
release. Ordinary unchanged generations allocate no capture records. Explicit
changes have two separate allowances: resident projections and temporary captures,
each <=128 entries /128 Mi accounting units, combined <=256 Mi units. This is not
a heap-byte cap; shared references may be counted twice and canonical history,
V8 overhead and temporary construction are excluded. Payload hooks conservatively
invalidate canonical provenance even when returning the same payload.

N1's million-field import enumeration remains the explicitly accepted cold-path
limitation documented in its evidence file. No global Session limit, alternative
enumerator, import-format change, AST relaxation or new N5/N6 implementation was
introduced. Windows/Linux x64 are exercised; ARM, musl, macOS and other untested
environments receive no expanded promise. The earlier three rejected exact-root
cleanup attempts and one unrecorded early fixture root remain disclosed in
`task-resource-exceptions.txt`; all final comparison/PTY roots closed cleanly.

## Historical implementation and review checkpoints

The following entries are chronological observations, not the current completion
status. Earlier numbers and pending statements are superseded by the delivery
record above and the final documentation-candidate checks on PR #50.

Latest integration correction: CI on `721dc68ffd78d3cbc7e9e064cf613e621983960d`
found the unchanged frame-queue source assertion requiring direct awaited
`_emitAgentEnd` delivery. Captured-view cleanup now belongs to that method's
existing lifecycle `finally`, alongside timer release, instead of wrapping its
caller. The assertion is unchanged; all 133 frame-queue, actual headless/SDK/TUI
budget and presentation/source regressions pass on Node 22.19.0. Complete gates
and final measurements remain pending for this corrected candidate. The completed
r38 comparison (85 groups, 60 measured + 12 warmup + 4 preparation children, all
closed successfully) remains bound to its actual `721dc68` source coordinate.

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

Review r30: projection provenance uses the existing UI owner's V2 eligibility
check before consuming a bounded source slot. Small results no longer evict an
older projected result merely by count. An actual SDK/InteractiveMode scenario
runs 129 tools across five requests: one large result followed by 128 small ones
retains a renewed continuation after an explicit budget change. Budget/source
tests: 21 pass; check pass on Windows Node22.19. The owner/helper chain reuses
existing source scans; no production regex or callback was added. Final profiling
and combined CI/review remain required.

Spill heap measurement now samples immediately before/after the workload and at
every observed write entry/completion, with an exact 2*writes+2 sample invariant.
The reported maximum includes these in-workload samples and identifies their
scope/probe overhead; it is not a claim about the true unsampled peak. Serial
baseline and candidate functional runs pass all four scenarios, release owned
roots and report zero pending writes. These single functional runs are excluded
from final fair timing conclusions. The alternating five-pair comparison remains
outstanding.

Review r31: source provenance is collected during the existing projection scan,
using its computed estimate rather than a separate walk/estimator pass. An
explicit-change scratch map retains at most 128 V2 source identities, prefers
the most recent qualifying identities, and converts to weak storage only after
successful projection. A finally block clears strong references on either exit.
Normal unchanged generations pass no map and allocate no capture object.
The actual 129-tool SDK/TUI case observes zero pre-dispatch candidate inspections
and an empty scratch map after return. A 2,130-result projector comparison has
identical production scan/allocation counters with and without capture, 128
retained identities despite 2,000 trailing small results, and zero owner entries
and retained code units after disposal. This proves no extra source scan; it is
not a claim that the cold map itself allocates nothing.

Payload preview uses a primitive depth scoped only around its synchronous
builder, with finally restoration. Awaited extension hooks never hold that
mode. Successful and budget-blocked actual SDK Codex payload previews preserve
request status, pending provenance and generation and dispatch no provider call.
The existing SDK request-envelope AST gate is unchanged. Budget/presentation/
contextual source gates and regressions: 33 pass; check pass. Full call chain:
SDK converter -> Session projection bridge -> configured/contextual owner
projection -> bounded identity collection -> successful-dispatch UI rediscovery
-> source release. No production callback or regex was added. Prior r30 head
99c3324cf45c8e461a57453606c83b83584bc47c passed all local gates (2,656 tests,
90 skips), five allocation gates, explicit-command profiles, five isolated
native-cost processes and both-platform CI 36297004716. These profiles must be
refreshed for the changed capture chain before final conclusions.

Review r32: projection creation, bounded source capture and projected-only UI
inspection share the complete token/artifact/MCP-byte-cap predicate. Actual
SDK/TUI audio and resource results survive a budget change after 128 later small
results; cold and resident inspection also cover the MCP byte cap below the
token limit. The fixed module predicate and inspection are included in the AST
callback/regex gate. Budget/presentation/contextual tests: 38 pass; check pass.
The production path still reuses its required source scan and bounds the capture
map at 128, with no production callback or regex added.

The success matrix now samples at every tool start, progress and end plus both
sides of each final filesystem assertion. All 36 actual task rows verify exact
start/end sample counts and final file contents. This is a sampled maximum, not
total allocation or the true transient peak; tool-probe overhead is included in
timing and final verification remains outside timing.

Native Worker primitive counters account for file readSync bytes and every
SHA256 update, including metadata framing. File I/O reports show main/worker
components and combined totals; proc metadata read bytes remain separate. These
are API byte counts, not physical storage I/O or OS-internal metadata reads.
Diagnostic snapshots never load an unused worker and occur outside timing.
Real staged commits test counter growth and exact bytes, with zero handles,
descriptors and pending calls after release. All 24 file-I/O and three compact
snapshot functional cases passed, including worker counters and root removal.
Those functional timings ran alongside other validation and are not comparative
performance evidence. Final serial comparisons/profiles and current-head full
local, two-platform CI and actual review remain outstanding.

Review r33: capture occurs only after an actual V2 projection succeeds, including
per-result turn shares, contextual headroom and image-policy omission. The
bounded explicit-change map carries only tool-call ID and effective budget;
projected-only UI reconstruction uses that budget without changing the global
model projector or retaining request projection arrays. Actual SDK/TUI tests
restore both continuation and artifact when the original result fits the global
budget but its turn/context share does not. Budget/contextual/source tests: 51
pass; check pass. The whole changed chain is projection -> bounded provenance ->
successful dispatch -> canonical UI selection -> reconstruction -> release.
The explicit cold map retains at most 128 small metadata values; this is not a
zero-allocation claim. Production callbacks and regexes were not added.

The agreed comparison baseline is main 4f547535b830c15d3a9605574c229a0641f94923,
not the N3 parent. That baseline predates the native worker and correctly reports
zero worker I/O. All 24 ordinary and three compact cases passed on both this
baseline and the corrected candidate harness, with exact bytes, handle counts,
sample counts and removed fixture roots. Arbitrary intermediate native revisions
with pre-counter stats are explicitly unsupported; their unobserved bytes are
never silently reported as zero. General old-revision compatibility is outside
the user's frozen scope.

Main-isolate heap probes now surround measured read/hash APIs inside tool work,
in addition to provider boundaries. Reports label the sampled scope and exclude
Worker heap, native allocator and external Buffer storage; they support no whole-
process allocation or precise peak claim. Probe/coverage overhead is included
in instrumented timings. Hash counters include all main Hash.update calls during
the active task (including source/resource loading and request/proof/commit),
plus Worker SHA256 updates, not only file-content hashing. Spill event-loop
monitoring starts after controlled GC. Context clocks start after fixture file
creation while discovery, warm reads, reopening and model switching remain in
the measured task. Both revisions passed the complete context and spill
functional cases. Those concurrent-validation timings remain excluded from the
final serial comparison. Final combined full gates, profiles/comparison/PTY and
actual current-head review remain required.

Review r34 supersedes the r33 ID/budget-only reconstruction described above.
Configured and contextual image-policy results now capture the final successful
projection, including its actual cursor, text boundary, filtered model content
and token estimate. UI rediscovery reuses that final view; it does not rerun a
pre-policy projection that could skip unseen text. Four actual SDK/TUI cases cover
configured/contextual omission and further shrink, compare UI cursors and token
counts to the actual request, read continuation/artifact content, and verify zero
pending provenance and UI registrations after release. Focused budget/contextual/
source tests: 46 pass; check passes. The source gate also audits the fitting helper.

This necessary correctness fix changes the explicit-change retention cost: up to
128 final-view records reuse existing content arrays/strings, bounded in aggregate
by the existing 128 Mi code-unit allowance (text/image string references plus
block slots). This is a reference allowance, not a byte-exact heap limit. Oldest
views are evicted at either bound; an individual over-limit view is not retained.
The canonical history is unchanged. Scratch is cleared in finally; pending views
are dropped on dispatch completion, failure, replacement, payload invalidation
or disposal. Normal requests without pending explicit budget changes allocate no
capture records. No production callback or regex was added. Allocation/lifecycle
profiles and the complete final comparison remain required before completion.

Review r37 closes final-view ownership at the assistant response boundary in all
runtime modes, with agent-end finally cleanup for failure/abort paths. The actual
headless SDK tests retain canonical history keys yet observe captured views during
request preparation and no pending capture after success, provider error or abort.
An explicit Session budget-change event now invalidates active InteractiveMode
registrations for SDK callers as well as slash/settings callers, without forcing
initialization, adding a callback or running work on deltas/progress. A direct SDK
regression checks immediate removal of old cursors and zero UI registrations.
Budget/contextual/source regressions: 50 pass; check and test:hot pass.

Capacity clarification for r34: resident projection caching and pending explicit-
change final views have TWO separate 128 Mi-code-unit accounting allowances, each
with at most 128 entries. Their combined accounted allowance is at most 256 Mi
units; shared content may be counted in both. Pending accounting includes string
references and block slots. This is not a byte-exact heap cap, and canonical
Session history, source data, V8 overhead and temporary construction are excluded.
The separate capture constant and lifecycle above make the scope explicit rather
than claiming one shared 128 Mi allowance. No new import limit or general cache
platform was introduced. Final integrated profiles/comparison/PTY and full gates
remain required; the numerical costs below earlier checkpoints are historical.

Review r38 / CI closure: both e29ffea platforms and the local integrated 6d57e316
run reproduced the unchanged presentation source gate's object-spread assertion
(1 versus required 0). The final-view wrapper now spells out its fixed fields;
no invariant or test was relaxed. The full presentation/contextual source checks
were added to the focused command: 59 tests pass and check passes. This also
includes the real SDK/TUI image-policy, headless release and SDK invalidation
regressions from r34/r37. The combined code now includes stable N3 parent
b50844cc8e201b9aeecc4576b81f149380804ffc, which passed all local gates, both CI
platforms and actual Codex review. Final N4 measurements and final-candidate full
validation remain outstanding; prior failed runs are not counted as passes.
