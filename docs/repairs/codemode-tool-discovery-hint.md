# Codemode tool discovery hint (T09.1)

Baseline: `4a4d12f2e39fdbfec21abb04c7da103e85b12e86`, after PR #108.

The unknown-tool Proxy diagnostic recommends `searchTools(query)`, which is not
a script global in either the standalone sandbox or the coding-agent integration.
The actual catalog is `ALL_TOOLS` (script names and descriptions). The agent
additionally registers `describeTools` as a host global: although its host
implementation is synchronous, the VM bridge returns a Promise and scripts must
await it. Standalone sandboxes need not register that optional global.

The change is one fixed diagnostic string: tell scripts to filter `ALL_TOOLS`
by name/description and, when the host provides it, use
`await describeTools([names])` for schemas. No alias or new API is introduced.
Close-match suggestions, membership probes, catalog normalization, dispatch,
error classification and all existing limits remain unchanged.

This is not a provider/progress/render/large-result hot-path change. The literal
is captured during VM prelude initialization and appended only on an invalid
member access. No executable expression, callback, collection, cache, controller,
Promise or ownership state is added. Existing error formatting remains bounded
by `MAX_ERROR_CHARS`; the resulting diagnostic follows the existing script-error
bridge. An allocation benchmark of unrelated rendering would not measure this
literal replacement and is not required for this scope.

Audited route: CodemodeController execution -> sandbox worker -> QuickJS prelude
tool Proxy -> TypeError -> bounded describeError/done -> worker bridge ->
Execution.handleDone/finish -> worker terminate and listener removal -> session
error result. Recovery reads the existing catalog, awaits the registered global
through the same bridge, then dispatches the discovered tool through normal
policy. On success/error/abort, finish clears its deadline and abort listener,
pending calls and tool/global references, and awaits worker termination. The
controller clears invocation records/shown blocks and releases current in finally.
The change adds no resources or new cleanup requirement.

## Verification

Windows x64 / Node v26.4.0, 2026-10-11. Both new checks fail on the baseline
because the runtime/session error still names `searchTools` and omits the
awaited schema lookup. After the literal change:

- Standalone runtime: an unknown member remains a script TypeError with a close
  match and zero dispatched calls. Catalog lookup then calls the normalized
  tool successfully; neither `searchTools` nor `describeTools` has been invented
  as a standalone global. Final counters: active executions 0, workers started
  2, workers stopped 2, after awaiting sandbox close.
- Agent session: an initial unknown call returns the corrected guidance with
  zero child calls. The next script selects `read` from `ALL_TOOLS`, awaits its
  actual declaration through `describeTools`, and reads the fixture successfully.
  Existing session fixtures close their runtime and remove their owned directory.
- Three existing catalog invalidation/identifier-collision checks pass, covering
  both runtime aliases and session `describeTools` names. Eight Codemode hot-path
  invariants and four global source invariants also pass: 17 checks in total.
- Type checking and the Codemode build pass. No repeated local full suite and
  no allocation benchmark for a literal-only diagnostic edit. Complete platform
  coverage is left to the normal Linux/Windows PR CI.

```powershell
npm.cmd run build --workspace @super-pi/codemode
node --experimental-strip-types --test --test-name-pattern 'unknown tool|catalog snapshots|tool names that normalize|colliding tool names' tests/codemode-runtime.test.ts tests/codemode-session.test.ts
node --experimental-strip-types --test tests/codemode-hot-paths.test.ts tests/source-invariants.test.ts
npm.cmd run check
```

Raw logs: `.git/t09-1-codemode-tool-discovery-hint-20261011/`. The runtime fixture
loads source worker/prelude; the session fixture loads the built Codemode package,
so the package is rebuilt before candidate validation. No online provider or Bun
executable is exercised; prototype-mutation compatibility (T09.2), output
boundaries (T09.3) and installation replacement (T09.4) remain separate tasks.

## Pi 1.2.0 tool-information follow-up (2026-10-14)

Baseline: `fe3d0ea4be23c56d392add4a0583b2d1e36c439c`, with the unrelated local
model-catalog and browser error-summary repairs retained. Upstream references:
[v1.2.0 release](https://github.com/earendil-works/pi/releases/tag/v1.2.0) and
[declaration renderer](https://github.com/earendil-works/pi/blob/v1.2.0/packages/codemode/src/declarations.ts).
This adopts the relevant constraint-tag and self-contained result declaration
improvements, not a whole-version upgrade or upstream runtime semantics.

The observed browser session had explicitly requested `describeTools`, but its
description stopped mid-sentence at 1,024 characters and its return type was
`Promise<unknown>`. The same cap would cut off the newly clarified browser helper
instructions. Local inline declarations also lacked tool purpose and discarded
parameter constraints. A type exceeding 2,048 characters became `unknown` even
on an explicit detail request.

The controller now includes short purposes inline, makes shortened catalog
descriptions explicit, and returns full descriptions through bounded documentation
pages. Detailed types have a 16,000-character rendering budget; JSON mode preserves
the exact input schema within the existing 65,536-character structural bound.
The common result type describes Super Pi's content/details/isError/ref wrapper.
The standalone renderer spells out MCP result fields rather than emitting an
undefined shared alias. Browser code parameters include the synchronous Python
example and navigation limitations, with timeout bounds/default in the schema.

Audited route: registry/wrappers -> AgentSession tool catalog change ->
CodemodeController.setTools -> bounded inline provider declaration and descriptor
snapshot -> sandbox catalog -> Worker/QuickJS ALL_TOOLS -> describeTools host
bridge -> current authorized findTool -> bounded schema renderer or serializer ->
page -> existing result cap/projection -> provider context. Tool invocation,
progress, event delivery, rendering and result-cap algorithms are unchanged.

Catalog work remains at tool-version boundaries. Detail rendering occurs only on
explicit metadata queries, for at most 16 tools. Each request references full
descriptions in a request-owned segment array and materializes only its selected
page; schemas are bounded before rendering. No document cache, object pool,
background activity, or new controller state is added. Query-local segments and
rendered strings become unreachable on return/throw; close/dispose still clears
descriptors, identifier maps, the VM catalog and wrapped inline descriptions.
Pagination re-renders the requested schemas; it does not copy or scan the full
description text. This favors bounded retention and fresh metadata over a cache.

Same-machine catalog allocation benchmark: Windows x64, Node v26.4.0,
`node --expose-gc --experimental-strip-types scripts/bench/codemode-session.ts --catalog`.
One baseline and one candidate run; 8/512 registered tools, actual SDK/controller,
compiled Worker and disposal, metadata-only MCP fixtures, no live model/server.

| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| Inline chars, 8 tools | 5,038 | 5,652 |
| Inline chars, 512 tools | 32,503 | 32,615 |
| MCP schema reads on activation | 0 | 0 |
| Schema reads on unchanged next script | 0 | 0 |
| Catalog wire bytes, 8 / 512 tools | 765 / 52,279 | 765 / 52,279 |
| Host sampled allocation bytes | 16,989,528 | 18,019,424 |
| Tracked references remaining after controlled GC | 0 / 12 | 0 / 12 |
| Active executions / name mappings / extra declaration chars after close | 0 | 0 |

Both sizes reused descriptors/snapshots/catalogs on unchanged scripts, and each
started and stopped one Worker. Host sampled bytes increased about 6.1% in this
single run as documentation became richer; this is not proof of a runtime speedup
or a production p95/heap regression. It excludes Worker heap and actual provider
token/cache costs. The catalog cap remains 32,768 characters; very large tool sets
still discover omitted declarations on demand. The final optional-details marker
adds one character to the measured inline strings.

Targeted verification uses the existing `codemode-output`, `codemode-session`
and `codemode-hot-paths` files. Coverage includes actual browser metadata reaching
the provider context without browser execution, paged long descriptions, exact
large schemas, nullable/legacy bounds, comment safety, MCP result fields, name
collisions, deferred activation, snapshot reuse and disposal. No new test file or
full-suite run was added. Real-model adherence remains a separate manual check.

Verification completed: 28 distinct relevant regression/source-invariant checks,
root type check and browser-extension type check passed. The two first-run
integration failures were fixture selection errors (`tools:["read"]` excluded
the extension under test); correcting the fixture to include its registered tools
made both pass without loosening production selection rules. No browser mutation,
network inference or unrelated full test suite was run.

Both affected packages were rebuilt. A compiled-controller/Worker smoke probe
confirmed the full instruction tail, integer/bounds/default tags and ToolResult
declaration with zero target-tool executions. The existing global `superpi`
launcher starts from the rebuilt checkout (`--offline --version`: `0.84.1`);
the package version was not bumped.

Initial pre-review production source SHA-256 fingerprints:

| File | SHA-256 |
| --- | --- |
| `packages/codemode/src/declarations.ts` | `f7d9b3b2b73a35b949902256d47178c1a423f82731f035e11aca4dd1d79c7a76` |
| `packages/coding-agent/src/core/codemode.ts` | `e519c6eff24c40a74471e41ea8bfe3d77ccd5d1f464f2094d50bc0d5045226d6` |
| `packages/coding-agent/src/core/codemode-constants.ts` | `f9b399a8a0e72e06a85fc986c1db863933d058fb6012c2dcf8af704feb7ae1be` |

## Empty MCP discovery and incident chronology (2026-10-15)

The reported execution IDs were matched to the original session instead of
inferring a new regression from copied terminal output. The MCP and browser
failures occurred at 2026-10-14 18:21:20 and 18:21:24 UTC
(October 15, 03:21:20 and 03:21:24 Asia/Tokyo).
Both precede the Browser Harness migration. The same session subsequently
received the current Harness tool description at 03:55:21 and recorded three
successful browser calls at 03:55:46, 03:55:52 and 03:56:00, including Remotion
documentation content. The old stack path is retained historical output; the
removed Browser Use environment is not present on disk.

There was still an independent MCP defect. The effective project configuration
currently contains zero MCP servers, both with and without project trust.
Startup deliberately does not create a runtime for this case, but the registered
discovery tool used to throw whenever the runtime was absent. That turned a
valid empty configuration into a failure and stopped the rest of a Codemode
script before its browser call. Search now returns an explicit `unconfigured`
empty catalog. Its description and status commands clarify that MCP discovery
searches configured integrations. Invalid configuration, disabled MCP, startup/
shutdown unavailability and cancellation remain failures; background discovery
still waits for completion.

The existing `mcp-background-activation.test.ts` covers absent/empty configuration,
status output, unchanged activation/history, zero connections/list/calls,
pre-aborted searches with zero retained abort listeners, and shutdown rejection.
A real SDK/Codemode integration activates the actual discovery tools, executes
MCP search followed by a browser fixture in one script, and observes both
successfully complete. Browser fixture executions: 1; MCP connections, lists
and remote calls: 0. The fixture never opens a real browser. Seven targeted
checks passed, including the existing pending-discovery and disabled/invalid
configuration cases; root type check, JavaScript syntax and diff checks passed.
No new test file, full-suite run, real-browser retry or user-session rewrite was
needed. Test-owned HTTP listeners, sessions and temporary directories are closed
by the existing fixture cleanup.

Performance scope is the explicit discovery/command boundary: current lifecycle
state -> empty-configuration predicate -> one bounded result. The predicate is
allocated once per extension instance and retains only that instance's existing
state. There is no additional timer, event listener, cache, runtime, connection,
or per-chunk processing. Provider deltas, progress delivery, rendering and large
result handling are unchanged, so no hot-path allocation benchmark was repeated.

## Combined pre-PR review (2026-10-15)

The accompanying catalog repair retains remote-only model IDs even when the
remote manifest is older than the built-in catalog. Built-in definitions still
win for overlapping IDs, including canonicalized Cloudflare Claude aliases.
The audited route is stored/network catalog -> refresh-time precedence and
profiling -> published merged snapshot -> cached `getModels`. The temporary ID
set and filtered rows belong to refresh only; repeated lookup still returns the
same array without re-merging. Existing regression coverage exercises timestamp
boundaries, HTTP 200/304, offline reopen, provider isolation and profile counts.
The configured models appeared in the local offline catalog after rebuilding;
this does not establish successful live model inference.

Final combined verification passed 19 selected checks: six cross-module
regressions plus thirteen Codemode/global source invariants. These cover the
HTTP/offline catalog flow, actual browser instructions in model context,
approval-failure fallback exclusion with explicit activation preserved, empty
MCP search followed by browser execution, standalone runtime resolution, and
the generated Python prelude's fifteen DNS cases. Root type checking and both
browser/tool-classification extension type checks also passed. The final MCP
fixture closed its listener/session and removed its recorded temporary directory.
No test files were added and the full local suite was not repeated.

The three Codemode production fingerprints above still match the benchmarked
sources, so their allocation run was reused. Model refresh, browser admission/
failure formatting and empty-MCP discovery add no provider-delta, progress,
render/frame, or retained-reference work. Existing bounds and disposal remain
intact. There is no new pool, timer, background process owner or cache to justify
an unrelated benchmark. Linux/Windows integration remains subject to the normal
PR CI; the recorded live Chrome approval check is not automatically repeated.

### CI follow-up: exact-name discovery

The first PR CI run exposed a gap in the selected local regressions: the existing
N4 task matrix searched for `file_batch`, but the richer browser description now
contained both words. Both tools scored two keyword matches and the name
tie-break selected `browser_exec`. This reproduced on Linux and Windows; it was
not a network failure despite the provider fixture's outer "Connection error".

Exact tool-name matches now rank above description keywords after the existing
activity/permission filters. Case and surrounding whitespace are normalized;
Chrome DevTools remains excluded even for exact names. A new case in the
existing Codemode session file failed before the fix and passed afterward.
Three targeted discovery/permission cases passed, as did the previously failing
N4 matrix with all 36 task scenarios. Its 36 recorded directories were removed,
pending calls and final authorizations were zero, and extension type checking
passed. No full local suite, extra test file, or real browser call was needed.

The change adds only request-local normalization and a score at explicit search
time. It adds no candidate collection, retained state, timer, listener or
per-delta work; the catalog/Worker benchmark sources remain unchanged.

### Codex review follow-up: metadata revision and runtime admission

The first review identified three actionable gaps: MCP definitions can change
between documentation pages, an existing standalone Harness can still be too
old, and the documented Mihomo IPv6 Fake-IP subnet was not recognized. All three
were addressed. Browser version admission and the expanded 21-case DNS fixture
are documented in the extension README.

Documentation continuation now includes and requires a revision bound to the
requested current definitions, controller instance and format. Replacement, removal or changed
selection rejects stale continuation with `TOOL_DOCUMENTATION_CHANGED`; callers
discard previous pages and start at zero. The revision registry uses weak tool
keys and primitive IDs only, retains no document/schema text, and is replaced on
close even if sandbox shutdown fails. Metadata queries still use live permission
lookup; no document is served from a cached unauthorized definition. The real
MCP adapter regression replaces a cached definition between awaited pages and
verifies rejection, missing-token rejection and a parsable fresh live schema.

Four focused review regressions, three catalog/disposal checks and thirteen
source invariants passed. Root/browser type checks and the coding-agent build
passed. The extended disposal test verifies that queried revision identities are
cleared. No new test file or local full-suite run was added.

Because the controller changed, the catalog allocation benchmark was refreshed
on the same Windows/Node setup, including the final controller-instance token.
Final host sampled allocation: 18,039,584 bytes
(previous candidate 18,019,424; original baseline 16,989,528). This remains a
single noisy sample, approximately 6.2% above the original baseline, not a speed
or production heap claim. For 8/512 tools: wire bytes 765/52,279; schema reads on
activation and unchanged scripts zero; descriptors/snapshots/catalogs reused;
each worker started/stopped once; executions/maps/extra declaration retention
zero after close; tracked references 0/12 after controlled GC. Inline lengths
were 5,736/31,580: the larger introduction causes the fixed 32,768-character cap
to omit another whole declaration in the large fixture, which remains available
through explicit discovery. Raw final output: `.git/pr151-catalog-review-final.json`.

Final controller SHA-256: `6833aa30a45eeed1077f5ff6d73790e5de92e6d58feccdc2b3f7905b5c0b287f`.
Final constants SHA-256: `5b808e6770f39b7eda3ec3c04f20c06dbe82492bcccb37d35b51c5320e9a0f21`.
The declaration renderer fingerprint is unchanged. The new revision registry is
accessed only by explicit documentation queries; catalog changes, deltas,
progress, rendering and result projection gain no repeated allocation work.

### Second Codex review: production discovery boundaries

The second review found three additional production-path gaps. Unix uv tool
entry points are symlinks, so discovery now resolves them first and validates
the real executable regular target; Windows keeps its existing no-symlink rule.
The returned command is the resolved path, so retargeting the entry-point link
does not change an already admitted command. The Unix fixture also rejects
dangling links, directories and non-executable targets; it is intentionally
skipped on Windows and is exercised by Linux PR CI.

MCP adapter and schema-cache normalization previously truncated descriptions
before Codemode could paginate them. Full sanitized instructions now travel as
host-only `fullDescription` through both ToolDefinition/AgentTool wrappers;
model-facing descriptions and tool-search metadata stay summarized. The existing
2 MiB complete-catalog and cache bounds are unchanged. A new cache fingerprint
domain makes old abbreviated entries miss and rediscover. The real MCP adapter
integration sees the final instruction after 5,000 characters while its ordinary
description stays within 1,000; cache reopen retains the full description and
rejects the old fingerprint. Metadata strings are referenced at catalog/query
boundaries, not copied on provider deltas, execution progress or rendering.

HTTP 404/501 now clears both persisted remote models and the active overlay,
while preserving built-ins. Tests seed a stale remote-only model, verify its
immediate removal for both statuses, and reopen offline without resurrecting it.
Ordinary older HTTP 200/304 catalogs still retain missing models. This is a
refresh-lifecycle update; cached `getModels` behavior is unchanged.

Validation: seven model-catalog checks, four real-adapter/cache checks, two browser
resolver/version checks (plus one Unix-only skip locally), seven MCP pagination/
size-boundary checks, thirteen Codemode/global source invariants, and the MCP
count/GC/source benchmark gates passed. Root/browser type checks and affected
agent/coding-agent builds passed. No new test file or full local suite was added.

The final catalog candidate sampled 17,813,192 host bytes (about 4.8% above the
original 16,989,528 baseline). The variation from earlier candidate samples is
not evidence of a speedup. Deterministic results remain unchanged: zero schema
reads on MCP activation and unchanged scripts, reused descriptors/snapshots,
wire sizes 765/52,279 bytes, paired worker start/stop, zero active executions or
name-map retention after close, and 0/12 tracked references after controlled GC.
Raw output: `.git/pr151-catalog-metadata-final.json`. Final controller SHA-256:
`4ff6ca0c03590816d955fbef6a69a53eec3e6ec79f62f7d89bd207428d6e4e05`.
Other previously listed declaration/constants fingerprints are unchanged.

### Third Codex review: alias revisions and cache admission

Two boundary regressions were reproduced before fixing them. Activating a
registered identifier collision can change a TypeScript signature while keeping
the same AgentTool object. The continuation revision now includes the catalog
mapping generation, advanced only by `setTools` at catalog boundaries. Old pages
are rejected after this change as well as after definition replacement. The page
body limit is unchanged; the continuation hint was shortened to retain the
existing bounded-page assertion.

A discovery-valid near-2-MiB catalog can exceed the cache limit once entry and
envelope metadata are included. Cache put now checks the isolated serialized
entry before any map mutation or eviction. An uncacheable entry returns false
and preserves both prior server entries and disk contents. The single-entry
payload is reused when possible; this is request-owned cold cache-admission work,
with no retained buffer or processing in provider/progress/render paths.

Both regressions failed before the changes and passed afterward, together with
three related pagination/cache checks. Thirteen source invariants and the three
MCP count/GC/source gates passed; root type checking and coding-agent build passed.
No new test file or local full suite was introduced. Final same-machine catalog
sample: 18,170,144 host bytes versus the original 16,989,528 (about +7.0%); candidate
sampling varies and is not a timing or production-heap conclusion. Deterministic
reuse, zero unchanged schema reads, 765/52,279 wire bytes, paired workers, zero
post-close execution/mapping retention, and 0/12 tracked references after GC all
remain unchanged. Raw output: `.git/pr151-catalog-mapping-final.json`.
Final controller SHA-256:
`9f2625b3bc82076eeac36cdc9cd2f614c564d98ddf703bedac0e140ae4ad14a0`.

### Fourth Codex review: Unicode page boundaries

The existing long-document integration reproduced split UTF-16 surrogate pairs
in both instructions and exact JSON schemas. Page ends now rewind by one code
unit when necessary, and explicit mid-pair offsets normalize to the preceding
code-point boundary. Headers and continuation offsets reflect the actual slice;
the body stays within its limit and does not skip into a later segment after a
shortened end. The query still references description segments and materializes
only its page; the fix adds primitive boundary checks, no retained state, buffer,
callback or whole-document copy.

The expanded existing test verifies well-formed pages, all 2,500 description
emoji, exact non-BMP schema patterns/defaults and normalized manual offsets.
All three pagination tests, thirteen source invariants, root type check and the
coding-agent build passed. No test file or full-suite run was added. The final
catalog allocation sample is 17,606,704 host bytes versus the original 16,989,528
(about +3.6%; sampling varies, so this is not a timing or speedup claim). Reuse,
zero unchanged schema reads, 765/52,279 wire bytes, paired worker start/stop, zero
post-close execution/mapping retention and 0/12 tracked references after GC are
unchanged. Raw output: `.git/pr151-catalog-unicode-final.json`.
Final controller SHA-256:
`ef5d33005eeff84ce973546b532b025e3bdbec814ce6257778fd4da4a35b32e0`.

### Fifth Codex review: summary Unicode and linear schema paging

The 256-unit inline purpose and 900-unit catalog summary now share the same
surrogate-safe prefix operation. A regression places non-BMP characters across
both cutoffs and verifies that a real UTF-8 round trip preserves each result.

The real SDK/Worker benchmark reproduced repeated serialization: 16 schemas with
60,000-character fields required 121 pages and 1,936 schema property reads.
`describeTools` now validates the live selection and revision before using one
controller-owned snapshot of serialized schemas/signatures. Its hard capacity is
16 strings of at most 65,536 UTF-16 units each (at most 2 MiB of UTF-16 payload),
without description or tool-object references. It replaces the previous snapshot
on a new selection, and releases it after the final page, catalog changes, runtime
failure/cancellation or close, including failed sandbox close. This is not an
object pool. Description segments remain request-owned references, and only the
requested output page is materialized. Production call-chain review covers
Worker describe bridge -> current permission lookup/revision -> bounded schema
snapshot -> page slicing -> output, plus catalog update and execute/close cleanup.

Both findings were reproduced before fixing. Eight distinct pagination, summary,
revision and lifecycle regressions passed, including continuation across scripts,
final-page release, changed catalog, runtime failure, deadline cancellation and
failed close. Thirteen source invariants, root type checking and coding-agent
build passed. Existing test and benchmark files were extended; no full local
suite or new test file was introduced.

The same documentation benchmark now makes exactly 16 schema reads across the
same 121 pages/962,942 document units. Host allocation samples fell from
124,283,824 bytes to 8,621,192 bytes (about 93% in this specific fixture).
Snapshots retained after close: zero; workers started/stopped: 1/1; active
executions and name maps after close: zero; controlled GC retained 0/6 tracked
references. The benchmark now asserts the linear schema-read count. Raw samples:
`.git/pr151-documentation-before.json` and `.git/pr151-documentation-gated.json`.

The unchanged 8/512-tool catalog benchmark samples 18,163,856 host bytes versus
the original 16,989,528 (about +6.9%, with sample variation); its deterministic
reuse, zero unchanged schema reads, 765/52,279 wire bytes, paired workers and
0/12 retained references remain unchanged. Raw output:
`.git/pr151-catalog-snapshot-final.json`. These are host allocation samples, not
provider timings, Worker heap measurements or production p95 conclusions.
Final controller SHA-256:
`9350fd4d380badd9096d51385e6dbb826609fcc31ffdaa3324a02d95dd236ec3`.

### User correction: choose CDP by task, not a blanket activation ban

The initial Chrome DevTools exclusion was broader than requested. It is replaced
by two discoverable routes: `browser` for public-web interaction through Browser
Harness, and `browser_debug`/CDP/exact DevTools names for local HTML/localhost
preview, DOM/JavaScript inspection and UI validation. Model-driven CDP activation
is allowed without `/chrome-devtools enable`. Both actual tool descriptions now
explain target/profile selection; a managed profile does not inherit the user's
login or prove the original Harness connection is authorized. The exposed native
CDP tools remain list/select/navigate/evaluate/screenshot; no additional tracing
or network-interception API is claimed.

A narrow, per-extension pause is set only by the top-level Harness approval
failure marker or its reported-approval timeout. The dispatch guard blocks CDP
calls and discovery during that automatic workflow, including already active
CDP tools. A fresh non-extension input allows task selection again, but does not
grant browser permission: the model must follow the user's actual direction.
Extension-generated continuation cannot clear the pause. Ordinary Python errors,
including ones quoting the approval marker, do not set it. Session start, tree
switch and shutdown clear the single boolean. No result/browser references,
per-call listeners, timers, object pools or progress hooks are retained.

Call-chain audit: agent-core beforeToolCall -> AgentSession/ExtensionRunner
tool_call -> stable primitive guard; terminal tool_execution_end -> session event
adapter -> stable approval-prefix observer; input/session lifecycle -> reset.
This is a deliberate tool-call/failure boundary interception, not per-delta or
progress work. The existing runner still creates hook contexts and async dispatch
boundaries, so its cost is included rather than treated as free. The guard bodies
introduce no per-event closures, arrays, wrapper objects, promises or copies;
the blocked result is one frozen module object. Search/ranking remains cold,
request-owned bounded metadata work with the existing active-tool policy.

Eight focused integration/guidance checks and fourteen source invariants passed,
including direct model discovery, active-CDP pause, extension-vs-user input,
ordinary-error recovery, exact-name precedence and real tool descriptions reaching
Codemode. Root and all three affected extension type checks passed. Existing test
files were extended; no new test file or full local suite was added. No browser
was launched by these metadata/fixture checks.

The existing real SDK/controller/Worker benchmark now accepts `--browser-routing`
to include the actual classification extension. Same-machine host allocation
samples: 26,875,160 before and 28,452,840 after (about +5.9%). Warm-batch p95 samples
were 18.02/20.26 ms; these short offline samples are not production latency or a
speedup claim. Both runs retain the same deterministic counts: 242 child calls,
zero progress events, 11/11 Worker start/stops, zero pending read evidence and
0/55 tracked references after controlled GC. This new baseline is separate from
the catalog and large-schema paging baselines above. Raw outputs:
`.git/pr151-browser-routing-before.json` and `.git/pr151-browser-routing-after.json`.
Final classification source SHA-256:
`a6862d3836294a152f83d1b0de28373cbefdef99eec2eb4e18bcc3a970de93ae`.

### Follow-up review: capability phrases and explicit browser selection

The debug route also recognizes advertised task phrases such as `DOM inspection`,
`JavaScript inspection`, `UI validation`, reversed verb phrases and Chinese
equivalents, plus compound `browser_debug` searches. The direct command path runs
before `input`, so a successful explicit DevTools enable/tool selection now emits
one session-scoped selection event after settings persistence and generation
validation. A selection that activates no requested tools, a failure or a stale
transaction does not resume routing. Automatic discovery and startup restoration
do not emit this user-choice event. This resumes task selection; it does not grant
the original Chrome connection permission.

The guard retains only the pause boolean and current session ID. The stable
selection callback validates that ID; shutdown clears it and unregisters the one
event subscription. The complete added path is command/menu -> existing serial
settings transaction -> EventBus -> stable selection callback. The single payload,
array snapshot, event-bus async wrapper and selection predicate are confined to
explicit user commands, an allowed cold boundary. No provider delta, progress,
render, tool-result retention or per-call listener was added.

Both review cases first failed against the previous implementation. Seven focused
tests then passed, including natural capability discovery, actual command and
selector transactions, cross-session rejection, disable-without-resume and
subscription release on shutdown. Ten existing Codemode source invariants, the
root type check and both affected extension type checks passed. Existing test
files were extended; no real browser was launched and no full suite was repeated.

Final same-machine SDK/Worker sample in `.git/pr151-browser-routing-final.json`:
28,965,896 sampled host bytes versus 26,875,160 before this routing correction
(about +7.8%); warm-batch p95 17.20 ms versus 18.02 ms. Samples fluctuate and are
not a production performance guarantee. Deterministic counts remain 242 child
calls, zero progress events, 11/11 Workers, zero pending read evidence and 0/55
retained references after controlled GC. Source SHA-256:
`36b4d98e214094ce6a5e354cd76b57966acf1dc45d300568ca1d5d69feb151b9`.
