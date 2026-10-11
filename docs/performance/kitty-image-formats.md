# T07.2: direct Image format preparation

## Design gate

Baseline `0caf5b6707051d36904dd5c0298c29cbcbfcb800` (T07.1 merged).
`Image` passes its original base64 to `renderImage`, whose Kitty encoder always
declares `f=100` (PNG). Direct extension JPEG/GIF/WebP images therefore carry
the wrong wire format. Built-in tool images already have their own conversion
lifecycle; that implementation does not need replacement.

Register a synchronous PNG transcoder through the TUI's public API. The coding
agent loads the existing shared Photon converter at Kitty startup, before
extension initialization, with the existing initialization-generation guard
after the await. The registered callback is module-owned, holds only the shared
codec, and captures no session, TUI or image. No new dependency or worker.

`Image` prepares non-PNG Kitty content in its constructor or explicit
`invalidate`, never in `render`. One numeric converter revision bounds failures
to one attempt per registration. Success replaces the source representation
with PNG and its dimensions, so the instance does not retain both original and
converted payloads. PNG and iTerm2/unsupported protocols do not invoke the
converter. Failure yields text fallback, never mislabeled Kitty bytes. No
global image cache, pool, queue, timers, promises or controllers are added.

The constructor and first explicit invalidation after converter registration
are the named preparation boundaries. Ordinary invalidations of prepared PNGs
only clear layout lines. Cache-only unmount clears lines without repeating
conversion; semantic image data lives with the component until its owner drops
it. A later converter can retry a failed image on explicit invalidation.

## Production chain and hot-path scope

Extension initialization/custom UI or tool renderer creates `Image`; built-in
tool owners still pass their already-converted PNG. Constructor preparation
uses the registered callback -> loaded Photon conversion -> EXIF orientation
-> PNG bytes, with existing `finally` freeing image handles. `Image.render`
returns its width cache or rebuilds viewport-sized lines through `renderImage`
-> `encodeKitty` / `encodeITerm2`. Layout (`Container`, `VStack`, `ScrollView`)
feeds Main/Alt rendering, Kitty placement/cropping and bounded upload metadata,
then the existing `TerminalFrameQueue` -> `ProcessTerminal` callback lane.
Flush/failure/stop/dispose keep their existing queue ownership rules.

Review includes `Image.invalidate`, cache-only release, layout replacement,
scrolling, terminal upload cache eviction and final disposal. Image preparation
has one codec attempt per successful image (or failed registration revision),
no per-render attempt, and no retained source in the module callback. Normal
cached image rendering adds zero closures/promises/controllers/wrappers/arrays
or full-payload copies. Existing first-layout/width-change protocol encoding
and layout allocations are measured separately from the cached leaf path.
No change is made to provider deltas, tool progress or terminal writer logic.

## Validation

The actual JPEG fixture failed on the baseline: Kitty's payload was not PNG.
All six focused cases now pass: real small JPEG/GIF/WebP conversions, PNG and
iTerm2 bypass, bounded null/throw/malformed conversion failures and retry,
converted dimensions, scroll/cache-only release/layout replacement/disposal,
and actual InteractiveMode startup before extension `session_start`. An AST
case forbids conversion/decoding/closures/promises/controllers in `Image.render`.

The six existing affected files passed 61/61 tests: `tui-hot-paths`,
`tui-retained-source-invariants`, `allocation-cleanup-hot-paths`,
`tui-frame-hot-paths`, `tui-tool-image-lifecycle`, and `alpha-startup-quit`.
They retain the existing upload-cache capacity/eviction, pending conversion,
initialization cancellation and controlled-GC gates. Typecheck and the TUI and
coding-agent package builds passed. No local full suite was repeated.

Same-machine measurements: Windows x64, Node 26.4.0. Baseline Image SHA-256
`dd51b2721b16544c1a061143a47214f3c814ab19865d05c97813a01d6e4baeb5`;
candidate Image SHA-256
`eb3b2ef568d68f1895ae5bd5789342abc9e385e087aed52c6fb79835401ce14a`.
Both benchmark runs identify the base commit; the candidate was measured in
the working tree, and its source hash distinguishes it from the baseline.

| Observation | Baseline | Candidate |
| --- | ---: | ---: |
| Image fixture measured frames | 2,048 | 2,048 |
| Preparation converter calls | 0 (no support) | 1 |
| Converter calls during leaf/frame measurement | 0 | 0 |
| Frame promises / controllers / wrappers / full-size copies | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Frame materializations / frames | 2,048 / 2,048 | 2,048 / 2,048 |
| Active / pending high-water marks | 1 / 0 | 1 / 0 |
| Queue high-water mark | 1 | 1 |
| Sampled bytes per cached leaf call (whole harness) | 108.70 | 97.09 |
| Sampled bytes per Alt production frame | 3,609.87 | 3,678.19 |
| Sampled bytes per 64 KiB queue-only frame (20,000 frames) | 110.91 | 110.03 |
| Post-disposal upload entries / queued bytes / layout-owner references | 0 / 0 / 0 | 0 / 0 / 0 |
| Detached Image collected after controlled GC | yes | yes |

The format benchmark deliberately returns an identical prebuilt PNG from a
counted synchronous converter, with the same dimensions and wire size on both
candidates; it isolates preparation scheduling and repeated rendering. Actual
codecs and startup registration are covered by the behavior fixtures. It is
not a conversion-throughput or physical-terminal benchmark. Cached-leaf samples
are dominated by `assert.strictEqual` and inspector overhead; candidate samples
also attribute 1,176 bytes to `Image.render` in total, so these numbers are not
claimed as exact zero V8 allocation. In the production region, neither profile
attributes sampled bytes to Image; the leading sites are existing
`layoutComponent`, `renderCached` and regexp execution. Existing layout record
counters are unchanged (6,144 boxes, 14,336 rectangles, 6,144 clips per run).
Queue-only samples are dominated by the harness's clock and loop. These single
paired runs demonstrate unchanged deterministic limits, not a speedup claim.

Raw sampled profiles, queue measurements and the related test log are retained
at `.git/t07-2-kitty-image-formats-20261011/` on the implementation machine.
Reproduction commands:

```text
node --experimental-strip-types --test tests/tui-image-formats.test.ts
node --expose-gc --experimental-strip-types --test tests/tui-hot-paths.test.ts tests/tui-retained-source-invariants.test.ts tests/allocation-cleanup-hot-paths.test.ts tests/tui-frame-hot-paths.test.ts tests/tui-tool-image-lifecycle.test.ts tests/alpha-startup-quit.test.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-image-formats.ts <profile-output.json>
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts
npm.cmd run check
npm.cmd run build --workspace @super-pi/tui
npm.cmd run build --workspace @super-pi/coding-agent
```

Profile sampling stops and disconnects in the benchmark; its TUI is disposed,
frame bytes and render-cache references are checked empty, and the image owner
is collected while the disposed TUI remains observable. The startup integration
fixture shuts down its session/terminal and removes its own temporary root.
No detached worker or service is created. The global registered callback keeps
only the existing codec module; one numeric revision has no payload capacity.
Per-image capacity is one encoded source representation and the existing
width-specific line cache; no second converted-image cache is introduced.

Linux/Node 22.19 results come from final PR CI. Real Kitty/Ghostty/WezTerm/Warp
screens and Bun packaging were not visually exercised. T07.3 cropping remains
separate; none of the protocol assertions claims real-terminal visual approval.
