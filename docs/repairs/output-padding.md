# Transcript output padding (F03.3)

## Design gate

Base: `8966e9be872056c6e2050336dd7096436d64129d` (PR #119 merged).
The existing outputPad 0/1 setting reaches user/assistant messages, but tools,
command output, summary/skill blocks and custom fallback boxes hard-code one
column. Runtime settings changes update only three message types while streaming,
and rebuild history otherwise, missing active/pending commands and tool rows.
The fixed upstream v1.1.0 comparison confirms these are application gaps, not a
missing settings feature. Local grouped read and Codemode shells need the same
base padding while retaining their relative tree indentation.

Use the existing component owners and primitive padding fields. Add cache-aware,
idempotent setPaddingX to Box/Text; pass the configured number at row creation,
history restoration and command execution. A settings-boundary traversal updates
existing transcript and pending rows, increments the retained context version and
invalidates viewport heights without rebuilding execution state. Mark cached
args-only tool call renderers dirty when padding changes. Add optional outputPad
to ToolRenderContext for source compatibility (host supplies it; legacy contexts
default to 1). Self-rendered edit handles its own padding; default tool/Codemode
shells and grouped read apply host padding. HTML renderer contexts use the fixed
export default 1. Existing custom entry renderers still own their layout; only the
host error fallback is padded. No new settings, output transformations, pools,
timers or asynchronous work. Unrelated command-header color behavior is excluded.

Audited chain: provider/tool progress -> Agent event delivery/snapshot ->
AgentSession -> InteractiveMode live/deferred/history row -> tool/built-in/custom
renderer -> Box/Text/Markdown/image -> retained viewport -> Main/Alt -> frame queue
-> terminal. Command chain: executeBash stream -> appendOutput -> preview/expanded
Text and Loader -> pending/transcript -> same frame lane. Settings apply only at
an explicit user command boundary. Existing formatting, public renderer context
snapshots, preview arrays and command output processing remain; padding adds only
primitive fields/arguments, no per-event closures/promises/controllers/wrappers.
Render caches remain component-owned; padding clears their cached lines, and
existing release/dispose/clear paths release derived state and animation owners.

Before production edits, reproduce pad=0/1 and live-toggle gaps and profile the
production tool leaf. Validate relevant component/live/history/self-rendered/edit
paths, retained cache invalidation, settings-boundary identity and lifecycle
release. Run the relevant AST/source gates, typecheck, affected builds, same
fixture leaf profiles and queue gate. Record counters, sampled allocations and
controlled-GC references in `.git/f03-3-output-padding-20261012/`; avoid a full
local suite and live provider calls.

## Verification (2026-10-12)

Windows x64, Node v26.4.0. The five initial regression groups failed on the base;
all six final groups pass, including real live factories/history restoration,
retained context changes and HTML context. The other 75 related tests pass
(source/AST invariants, frame hot paths, retained invariants, Box cache, tool leaf
closeout, bash reuse and renderer registration). Typecheck and the TUI/coding-agent
builds pass. No full local suite or real provider/terminal session was run.

Same fixture tool leaf profiles: 500 warmup, 2,000 updates, 500 historical rows.
Sampled bytes/delivery before -> after: generic 1019.780 -> 1114.564; built-in
918.016 -> 1065.708; custom 1247.716 -> 1285.024; image 1727.540 -> 1665.088.
These short samples are noisy and are not a performance improvement claim.
All structural counts stay unchanged: no new components or argument serialization
on progress; built-in listener Promises and pending scheduler tasks remain zero;
final sentinels match. Existing public context objects are 0/1/2/0 per update,
and existing renderer wrappers are 0/2/2/0. The new field adds one primitive to
each supplied context, not another object. Leading sites remain formatting,
getRenderContext, Box.addChild and benchmark delivery. No pool was added.

The command fixture measures the existing append -> truncation -> preview ->
render chain at pad=0: 100,528 sampled bytes/update for growing 2,000-line output,
led by split/join/truncateTail. This records existing whole-output processing;
the padding change adds no event closure, Promise, controller, wrapper or array.
Explicit setting changes rebuild only the existing component-owned display;
normal progress uses the same allocation sites. Edit retains its existing
Container and applies padding to its Text children, with no extra shell owner.

Controlled-GC fixture: five warmup and 20 measured lifecycles across completed,
failed, cancelled and directly disposed commands, self-rendered edit and grouped
Read. All 20 loader timer/UI owners are cleared, all 100 weak references to rows
and replaced caches are collected, and 40 unchanged-padding calls reuse their
cached output. Post-GC heap delta is +106,256 bytes; the reference counters, not
that single heap sample, establish release. Run with
`node --expose-gc --experimental-strip-types scripts/bench/output-padding-lifecycle.ts`.

Queue-only gate: 500 warmup/2,000 measured 64-KiB frames; 208.484 sampled bytes/frame
(primarily timing instrumentation), zero queue closures/Promises/controllers/
wrappers/full-size copies/materializations, and zero active/pending references or
bytes after flush. Controlled-GC heap delta +104,920 bytes. Source/AST gates cover
the unchanged completion/failure/abort/dispose frame ownership boundaries.
Raw logs/profiles are retained at `.git/f03-3-output-padding-20261012/`.

Delivery self-review also covered local plain error/vision output that previously
received changed padding only through history reconstruction. A Text subclass
exposes the same setter without adding state, wrappers or component owners; these
rows now participate in the in-place traversal. The history fixture asserts the
actual skill component and verifies error/vision updates. Its six groups plus
the affected frame/retained source gates pass (36 checks); typecheck and the
coding-agent build are repeated for this follow-up. Earlier leaf/queue profiles
remain applicable: the follow-up does not change those measured paths or caches.

## Review correction: inline image lane

PR review identified a same-scope omission: tool images are direct row children,
so text-shell padding does not move them. Before this correction, inspect Image
cache ownership and the complete Image -> Kitty/iTerm sequence -> retained/scroll
crop -> Main/Alt placement/queue -> disposal chain; capture the existing image
production profile (`tui-image-formats.ts`). Add one primitive padding field to
Image, default 0 for existing consumers; pass configured padding in existing tool
image options and update existing images at the explicit setting boundary.
Grouped Read preserves its preview indentation. Build the left margin only on
cache misses using the already-owned output array; do not add a wrapper component,
new array, per-frame callback or conversion. Padding clears only the line cache,
preserving the Kitty ID and prepared source. Existing release clears cached lines;
the new number owns no references. Verify both protocols, wrapping bounds, stable
cache hits/IDs, production allocation counters and controlled-GC image release.

The new failing image regression was reproduced before production edits, then
passed for initial padding, reversible changes, both protocols, grouped Read and
actual Kitty Alt/iTerm Main frame output. iTerm Alt intentionally retains its
existing text fallback behavior. The 75 affected image/UI/source checks pass;
the strengthened seven padding groups, typecheck and both affected builds pass.

Image benchmark: 2,048 cache-hit operations and 2,048 production Alt frames.
Before/after pad=0 sampled bytes per leaf operation: 77.137/97.180, per frame:
3712.512/3730.434. Explicit pad=1: 112.438 per leaf operation, 3603.094 per frame.
The sampler includes assertion/instrumentation overhead; the warmed Image path
returns the same array without executing the padding branch. All three runs
show zero measured conversions, frame Promises/controllers/wrappers/copies;
queue high-water is 1, one generated frame per render, and all queue byte/reference
and final-unmount counters are zero. Image WeakRef is collected after disposal.
No extra image owner, scratch array or pool was introduced. Evidence files are
`image-before.json`, `image-after.json`, `image-pad1.json` and `image-tests.log`.
Replay padding explicitly with `tui-image-formats.ts <output.json> --padding 1`.

## Review correction: queued user-message previews

A second review found the pending steering/follow-up previews and dequeue hint
still construct TruncatedText with hard-coded padding. Audit queue admission ->
getAllQueuedMessages -> updatePendingMessagesDisplay -> pending container ->
TruncatedText -> frame/clear. Keep its existing truncation and row owners; add a
primitive setPaddingX assignment to this uncached component, use a state-free
output adapter for in-place settings updates, and pass the configured padding at
all three pending-row creation sites. No queue semantics, wrapper/cache owner,
per-update allocation or callback is added. Verify initial/rebuilt pending views
and reversible settings changes while preserving row identity; include these
owners in the existing controlled-GC lifecycle fixture. Status/header chrome and
extension widgets remain separately owned UI, outside queued message content.

The queue regression fails on the reviewed head and passes after the change,
including steering/follow-up/hint creation, rebuilding at pad=1 and reversible
in-place changes. The eight padding groups and frame/retained source gates pass
(38 checks), as do typecheck and both builds. Lifecycle rerun includes 40
TruncatedText padding assignments and all 120 weak references collected; 20
loader owners are cleared, 40 unchanged cached Text/Box calls retain identity,
and controlled-GC heap delta is +117,888 bytes. The new setter is one primitive
assignment with exactly zero allocations; TruncatedText.render is unchanged.
Prior frame/image profiles remain applicable. Evidence: `queued-repro.log`,
`queued-tests.log`, `padding-lifecycle-queued.json`.
