# Independent tool renderer registration (F03.1)

## Design gate

Baseline: `c41850fd60eb3ec4e2e11de7d362051bf83e7f5e` (PR #117 merged).
The loader has no `registerToolRenderer`; interactive/history rows and HTML
exports consult executable definitions. A missing historical tool cannot obtain
extension rendering without registering executable capability.

Adopt `registerToolRenderer((toolName, next) => renderers)` and exported
`ToolRenderers`/`ToolRendererResolver` types. Resolvers run synchronously in
extension/registration order; `next()` continues the chain, with the registered
definition as the base. Include local `renderCallStability` and
`collapseCallOnResult` fields. Registration never refreshes execution tools,
alters activation, or adds model/provider tools. Keep `getToolDefinition` intact;
add a separate presentation lookup. Preserve the legacy HTML lookup option.

## Ownership and hot-path audit

Audit chain: loader registration -> extension runner resolution -> AgentSession
presentation lookup -> InteractiveMode live-row creation/history rebuild ->
ToolExecutionComponent call/result rendering and invalidation -> retained viewport
-> Main/Alt render -> TerminalFrameQueue -> ProcessTerminal completion/release.
HTML export is a separate explicit-command path using the same resolution.
Read grouping must not bypass an explicit override. A replaced Codemode row must
also use the chosen renderer rather than forcing the built-in tree.

The runner owns one stable `next` callback, primitive traversal/depth slots and
one transient base reference. Save/restore slots with `try/finally` for nested
resolution and repeated next calls. No per-lookup callbacks, Promise, controller,
wrapper, array, cache by tool name or object pool. Limit registrations to 64 per
loaded extension and synchronous recursion to 128 frames. Registrations belong
to the loaded extension resource lifetime; transient resolution names/base
references clear on success/error. Invalidation rejects future resolution.
Returned renderer/component state retains the existing row owner and cache-release
contract. Custom renderers remain extension-owned and retain their existing
dynamic-by-default invocation semantics.

Resolve only when creating a row or explicitly exporting it, not on progress,
delta, layout, or frame delivery. The surrounding production chain retains its
existing snapshot/context/result allocations; no new allocation per ordinary
progress delivery. Baseline/candidate tool-leaf profiles and queue allocation gate,
source/AST invariants, structural resolution counters and controlled-GC transient
reference release are required. Test behavior through real loader/session and
TUI/HTML paths, including no execution authority, precedence, error fallback,
reentrancy, history and cleanup. Avoid an unrelated full local suite.

Duration persistence, lazy setup timestamps and outputPad remain separate F03
goals. The pinned upstream source was inspected from the local v1.1.0 comparison;
its per-resolution flatMap/recursive closures are not copied.

## Verification (Windows, Node 26.4.0, 2026-10-12)

- Baseline loader probe confirms the API is absent. Six focused cases now pass:
  ordering/reentrancy/repeated next; errors/invalid async/recursion; bounds and
  failed-load revocation; real session live/history/HTML without execution authority;
  explicit read/Codemode overrides and default read grouping; legacy HTML lookup.
- The real session lookup count does not change across 100 tool-progress events.
  Missing tools remain absent from definitions, model tool information and active
  tools even after an explicit activation attempt. Export reads a real persisted
  session and verifies its pre-rendered HTML payload.
- 51 related checks pass across tool-leaf behavior, retained/frame/source invariants
  and the new traversal AST gate. Typecheck and coding-agent build pass. Initial
  integration-fixture errors (missing footer, in-memory export, encoded export
  data) were corrected without production changes or weakened assertions.
- A 100,000-lookup profile invokes two resolvers exactly 200,000 times. One runner
  continuation is created at construction; normal traversal contains no callback,
  wrapper/list, Promise/controller or cache allocation. V8 samples 13,296 bytes
  attributed to `resolveToolRenderers` across the run; this is not a zero-heap
  allocation claim. Success and error base references plus a discarded-load
  resolver (failed API deliberately still retained) all clear after four GC/task
  boundaries: 0/3 retained; transient base/name/depth return to empty/0.

Existing production tool-leaf profile, same 2,000 updates / 500 warmup / 500
history items before and after (candidate run isolated from the build):

| Fixture | Sampled bytes/delivery before -> after | p95 ms before -> after |
| --- | --- | --- |
| Generic | 1222.816 -> 1072.500 | 0.0035 -> 0.0032 |
| Built-in | 951.056 -> 1053.832 | 0.0023 -> 0.0025 |
| Custom | 1379.032 -> 1264.404 | 0.0025 -> 0.0028 |
| Image | 1767.988 -> 1875.112 | 0.0036 -> 0.0066 |

All final hashes and deterministic counters match. Per delivery, normal inline
closures/Promise tails/Promise arrays/event wrappers/built-in Promises remain 0.
Existing renderer-context objects remain generic=0, built-in=1, custom=2, image=0;
existing result/options wrappers remain built-in/custom=2. Custom renderer
callbacks and their independent public contexts retain the established local
compatibility contract, not a new pooled object. No new component is created per
delivery. Leading sampled sites remain output formatting, fixture delivery,
renderer contexts and timing instrumentation. These short profiles do not establish
timing equivalence or improvement, particularly for the image fixture; production
update/render methods are unchanged and no pool is introduced.

The queue-only 20,000-frame gate reports closures/Promises/controllers/wrappers,
queue string materializations/full-frame copies all 0; active/pending slots and
bytes are 0 after flush. Its sampled 107.332 bytes/frame predominantly come from
timing/fixture instrumentation. This test does not claim a zero process-heap delta.

Exact local logs and working-tree source hashes are in
`.git/f03-1-tool-renderers-20261012/`: baseline, behavior, regression, typecheck,
build, resolution, leaf-before/leaf-after-isolated and queue. Benchmarks report
the base commit because they were measured before the candidate commit; source
hashes identify the measured candidate. Temporary session/export directories are
owned by their fixtures and removed in `t.after`; no background server is started.
The lifecycle contract for arbitrary third-party renderer side effects is unchanged.

## Review follow-up: template-rendered tools

The later inline review identified an export gap despite the earlier no-findings
summary: `preRenderCustomTools` skips bash/read/write/edit/ls, and the browser
template checks pre-rendered HTML only in its default tool branch. Audit the
complete explicit export path: AgentSession -> renderer selection -> pre-render
filter -> encoded session data -> template `renderToolCall`.

Before changing production, add a real persisted-export regression for all five
names, including call-only/result-only overrides and the default-template control.
Run the actual template functions against the decoded payload. Add an optional
override predicate so legacy custom exporters retain their existing behavior;
compare the selected renderer to the executable base, and give existing rendered
HTML priority in the template. This work is confined to explicit export and its
offline HTML view; live progress/row resolution and measured TUI paths stay intact.
The predicate adds no cache or retained owner. Export-local lookup callbacks/maps
retain their existing one-export lifetime; rerun affected behavior, typecheck and
package build, without repeating unrelated TUI profiles or full local suites.

The regression failed on the original head at `both:bash has pre-rendered HTML`.
After the fix, seven behavior cases plus the traversal AST check pass (8 checks),
as do typecheck and coding-agent build. The new case exports all five template
tools with full, call-only and result-only renderers and without an override;
it evaluates the actual template functions against each decoded export. It
verifies both generation and template precedence, not just embedded strings.

A second review found repeated resolver selection within one exported row. Before
the follow-up fix, strengthen the same export case to return a fresh renderer on
every resolution and require exactly one selection per tool-call ID, including
undefined/default results. Use one export-owned map bounded by exported tool-call
IDs; predicate, call and result share that selection. Its references release with
the export renderer's existing component/state/args maps after export returns or
throws. This is an explicit-command owner, not a live-progress or global cache.
The strengthened test fails before the fix with 15 selections for five rows.
Afterward all four export variants select exactly five times, and call/result
HTML carries the same per-row renderer identity. The affected 8 checks, typecheck
and coding-agent build pass. No controlled-GC claim is added for this cold export
map; the measured live resolver and frame lifecycle evidence remains unchanged.
