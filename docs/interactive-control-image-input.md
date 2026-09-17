# Interactive control and image input

Implementation and review-closeout record, 2026-09-17. This records source changes and observed tests, not a claim that native desktop acceptance has passed.

## Workspace and review units

- Repository: `dragonbaba/super-pi`.
- Fetched `origin/main` and implementation parent: `96a2657ef7206c2c837d94131d0966c18cd6e55c`.
- Branch: `feat/interactive-control-image-input`.
- Worktree: `D:/RMProjects/Pi-interactive-control-image-input`.
- Original `D:/RMProjects/Pi` main checkout and its untracked `SUPER_PI_CODEX_PHASED_OPTIMIZATION_PLAN.md` were left unchanged.
- No commit, push, PR, merge, stash, reset or clean was performed.
- Review units: attachment/clipboard/session projection; `ask_user` and batch scheduling; permission rules/dialog; visual-tail and empty-owner performance.

## Attachment protocol and ownership

`core/image-attachments.ts` defines protocol version 1. An attachment has a stable ID, kind, source, display name, validated MIME, byte count, dimensions and an index into its submission's canonical image content. The index is a content reference, **not a filesystem permission**. A submission has its own ID and ordered attachment metadata.

The host `ImageAttachmentDraft` owns preparing/ready/failed records. Clipboard and complete local path paste use this same owner whether auxiliary vision exists, is disabled, or has invalid configuration. The UI projection is a persistent `CustomEditor` component: `已粘贴/已添加 · 未发送`. It supports image-only drafts and commands `/image path`, `/image-remove N`, `/image-clear`. Add paths separately from explanatory prose; existing editor text remains available. Ambiguous mixed prose/code paste stays text. Relative paths are accepted by explicit `/image`; automatic path-only paste requires absolute paths or local file URIs.

Receive → bounded local read/validation → visible draft → explicit submit → immutable submission snapshot → backend adaptation. Preparing or failed records block submission and preserve the text. An early Enter never becomes deferred permission to send. Clear/session invalidation rejects late callbacks; ordinary text edits do not invalidate an in-flight addition. Clipboard operations have one active owner and no waiting queue. Local file additions have one bounded active batch.

Limits: 8 images/draft, 10 MiB/image, 40 MiB/submission, 24 million pixels/image. Session image queues and compaction image queues are bounded to 32 images/128 MiB each. Restoring more than one draft's capacity refuses the restore and leaves the queue intact.

User files are opened read-only, checked as ordinary local files, read through a bounded handle, checked for changes and closed in `finally`. Remote paths/UNC and remote file URIs are rejected. A verified content snapshot is retained, so replacing the original file after adding it does not change what is sent. The host creates no clipboard temporary file and never registers a user original with a deletion manager. Image decode resources are freed in `finally`. Removing/clearing transfers or releases the draft references; submitted bytes use the existing user-message persistence, not a second media store. Metadata survives history reconstruction. Missing image content is displayed as `源图片不可用`.

Normal text keys, cursor movement, resize and draft render do not read credentials, invoke vision, upload bytes, scan editor text for temp paths or authorize tools. A pasted marker string cannot create an attachment. An image added while an agent is running belongs to the next draft until the user explicitly submits it.

SDK/RPC `prompt(images)` is an explicit submission boundary and creates the same metadata. `steer`/`followUp` carry images plus submission IDs; identical text with different images has different queue identity. Auxiliary processing begins when the submitted message reaches the provider boundary, not when it is enqueued or displayed.

## Canonical history versus backend input

Canonical user messages retain original text, standard image content and `imageSubmission`. Provider conversion strips host metadata. A multimodal main model receives ordinary provider image content. A text-only main model receives a projection containing text plus the auxiliary result and never raw image/base64 or internal metadata as text.

Ordinary `input` handlers run once in `prompt()` at explicit submission, for either model capability. Image-processing handlers opt into the existing input mechanism with `{ phase: "image-processing" }` and run at the SDK context boundary after queue delivery. Neither phase runs on draft receipt. Managed submissions disable the legacy clipboard text scanner. Auxiliary vision stores `image-vision-result-v1` as a session custom entry, bound to submission ID, image order and a digest of exact text/images/effective processing configuration. The TUI displays this as a separate derived result; it never substitutes it for the user's image record. Completed results are reused on later requests with the same inputs; configuration changes invalidate that reuse. No global image cache was introduced.

Missing/invalid auxiliary configuration requires an explicit `provider/model` and fails closed; it cannot silently pick the old default provider. `blockImages` blocks the submitted-image route and `inspect_image`. Vision failure or model change during processing stops the main request and automatic session retry/queue continuation. The original message remains available for an explicit retry after fixing configuration or changing model. Cancellation prevents subsequent main dispatch; it does not claim that an already transmitted request was undone or unbilled.

Session restore alone performs no vision call. Existing image bytes live with the session's normal message retention. There is no new independent image expiry policy or gallery.

## Confirmed wiring defects

The fetched baseline still had the reported mismatch: TUI `super-pi.clipboard-artifact-lifecycle.v1` / `sp-clipboard-` versus auxiliary extension `pi.clipboard-artifact-lifecycle.v1` / `pi-clipboard-`. The TUI could delete its new file and return without a visible attachment when the owner was absent. Merely renaming the Symbol would still leave core paste dependent on extension startup.

The new host path removes that dependency and does not use either marker as its source of truth. Old `pi-*` parsing remains only in the legacy auxiliary input adapter and uses its existing single owner. Extension reload cannot dispose the host draft.

Windows Alt+V and user keybindings retain existing precedence, including extension shortcut interception. Windows image reads use a fixed encoded PowerShell helper with `-STA`, `-NoProfile`, bounded execution/output and cancellation. Forms image/stream resources are disposed. It runs through asynchronous `execFile`, with no shell interpolation, polling, `spawnSync`, temp-file handoff or native-Windows `wslpath`. No image falls back to normal text paste; helper errors and validation errors remain visible.

## Questions and permissions

`ask_user` is a registered built-in tool, subject to `tools`, `excludeTools` and `noTools`. Its bounded schema has one question, optional explanation, 2–6 stable-ID choices and optional supplemental text. The existing UI promise resolves only from a user event. Cancel, abort, session change and unavailable UI return a terminating status; noninteractive callers can identify `requires_user_input` in the tool result and agent-end state.

The agent identifies an interaction boundary before starting a tool batch. It executes the question first and returns explicit error results for every other unexecuted tool call, preserving call/result IDs. After an answer the model must replan. The old write/bash parameters do not execute. Cancellation ends both the inner loop and the outer session continuation; follow-up remains queued. Normal batches retain their existing parallel execution. Answers never create permission rules. Persisted tool results contain data only; pending UI promises are not serialized or automatically resumed after reopening.

Permission dialogs keep all choices visible below independently scrollable, bounded detail windows. They show the full inspectable request, backend, effective cwd, scope, exact/prefix rule, unverified model explanation and `操作尚未执行`. Navigation arms explicit confirmation; an initial/repeated Enter or paste payload does not approve. Undersized terminals disable approval and show resize/cancel instructions. Confirm/cancel hints use effective bindings.

Prefix rules reuse the existing rule type and are scoped to backend/cwd. `ls *` includes `ls`, `ls -la`, `ls ./src`; it does not include `lsof` or `lsblk`. Compound execution, substitutions, pipes, redirects, opaque/high-risk scripts and uncertain syntax are excluded from prefix reuse. `git status *` keeps the subcommand. Explicit equal cwd can reuse a rule; different cwd and actual target scope still go through checks. Exact rules remain exact, and old rules are not upgraded to prefix. Existing final invocation authorization and rule revocation remain in force.

## Hot-path audit and measurements

Reviewed call chains:

1. Terminal complete-paste dispatch → CustomEditor → host draft → async helper/file handle → validation/Photon → stable draft-change callback → attachment Text → existing Main/Alt retained render and frame queue. Per-add promises/controllers are operation-owned; plain keys create none for attachments.
2. Session prompt/steer/follow-up → canonical message → SDK transformContext → auxiliary input/derived entry → convertToLlm → provider serializer. No attachment work was added to provider deltas.
3. Tool batch admission → question boundary → existing tool hooks/progress/finalization → agent_end → session retry/compaction/queue continuation. Existing ToolProgressDelivery implementation remains unchanged.
4. Bash/tool preview → truncateToVisualLines → shared Unicode/ANSI wrapper → bounded tail collector → public result → retained component/frame release. No copied Unicode implementation and no shared mutable public result arrays.
5. Permission analysis/final authorization → actual approval only → full request formatting → selector detail window/choices → dispose. Full-request formatting remains deferred until approval is needed.

The legacy clipboard owner now short-circuits an empty record map and releases `pendingEditorText`. The new host no longer calls that legacy editor observer at all. The tail wrapper scans all required text to get an accurate skipped count, retains only N visual lines and pads only those N lines. It removes the temporary `Text` component and whole-output line retention. It does not claim to eliminate per-line Unicode/ANSI scanning allocations.

Environment: Windows 11, PowerShell, Node v26.4.0, Intel Core i7-14700KF. Baseline modules loaded read-only from `D:/RMProjects/Pi`; candidate modules loaded from this worktree. Allocation profiling and unsampled timing are separate processes. Fixtures are offline/non-sensitive. Heap sampling includes fixture/provider/event allocations; sampled byte totals are estimates, not exact object counts.

Initial implementation measurements, run after that round's full suite finished (no concurrent test load):

| Visual tail, 10,000 physical lines, width 80, retain 10, 20 measured operations | Baseline | Candidate |
| --- | ---: | ---: |
| Unsampled p50 | 10.671 ms | 11.182 ms |
| Unsampled p95 | 12.665 ms | 11.638 ms |
| Heap-profile sampled bytes/operation | 16,648,284 | 13,251,537 |
| Returned lines / skipped lines | 10 / 9,991 | 10 / 9,991 |
| Empty legacy owner, 10,000 editorChanged calls: scheduled microtasks | 1 | 0 |
| Empty legacy owner: retained final text code units | 18 | 0 |

Sampled allocation fell about 20.4%. The p50 was about 4.8% slower and p95 about 8.1% lower in this run; this is an allocation improvement, not proof of uniformly faster rendering. The controlled-GC heap delta was -9,872 / +14,496 bytes in the unsampled processes, and +1,102,984 / +911,072 bytes in the profiled processes. Profile-tree retention contaminates the latter, so these deltas are not used as proof of resource release. The collector clears its ring before returning, and regression tests retain old public arrays across subsequent calls.

| ToolProgressDelivery case | Updates | Drains, baseline/candidate | Delivered events, baseline/candidate | Unsampled elapsed, baseline/candidate | Sampled bytes/update, baseline/candidate |
| --- | ---: | --- | --- | --- | --- |
| Synchronous burst | 20,000 | 1 / 1 | 2 / 2 | 3.393 / 3.569 ms | 199.90 / 180.09 |
| Actual `.awaited()` | 2,000 | 2,000 / 2,000 | 2,000 / 2,000 | 4.328 / 4.314 ms | 2,426.25 / 2,411.94 |
| `setImmediate` paced | 2,000 | 2,000 / 2,000 | 2,000 / 2,000 | 6.978 / 7.185 ms | 3,505.17 / 3,265.61 |

Every progress case had two offline provider requests, pending high-water 1, active pending 0 and pending tool calls 0 after settlement. The existing two `startDrain` callbacks are per drain, not per update: the burst has one pair, the other fixtures have 2,000 pairs. Production delivery was deliberately retained: each pair captures its cycle's promise, and replacing it with mutable stable callbacks without a proven generation-safe design risks finishing a later cycle. These noisy profile differences are not attributed to a ToolProgressDelivery optimization. Existing reentrancy, first-error, MCP, awaited, final-flush and settled-before-cleanup tests remained passing.

`image-draft-lifecycle.ts` wraps actual FileHandle.read, Buffer base64 encoding and the editor's attachment projection setter:

- 1,000 ordinary edits/renders: reads 0, encodes 0, projection updates 0.
- One 1×1 PNG local addition: 2 read calls (data + bounded EOF probe), 1 base64 encode, 2 projection updates (preparing + ready).
- 1,000 more edits/alternating-width renders with that attachment: all three counters unchanged.
- Clear while an asynchronous read was starting settled in 0.519 ms in this fixture; this does not characterize native desktop clipboard or large-image decode latency.
- Records after cleanup: 0. Two WeakRefs (record and image content) both cleared after explicit GC across event-loop turns. File handles close in `finally`; this path creates no image temp files.

## Initial implementation verification results (before acceptance closeout)

| Command / scope | Final result |
| --- | --- |
| `npm run check` | Passed |
| `npm run build:offline` | Passed, all configured workspace stages |
| Image/question integration + visual tail + permission files | 49 passed, 0 failed, 0 skipped |
| `npm run test:hot` | 31 passed, 0 failed, 0 skipped |
| `npm test` | Exit 0; 1,682 tests reported across files/workspaces, 1,624 passed, 58 skipped, 0 failed |
| `git diff --check` | Passed |
| Three operation/allocation benchmark scripts | Completed; counters/results above |

The complete run includes the existing Bash responsiveness, retained viewport/frame queue, tool recovery, snapshot edit, permission final-invocation and async owner tests, plus the memory workspace's three tests. The 58 skips are pre-existing platform/opt-in gates: Windows POSIX signals, conservative filesystem identity/evidence hits, Linux inode/FIFO/procfs/journal behavior, and explicitly opt-in measurement/GC child cases. They are not counted as passing. Native platform gaps remain.

Development runs exposed a retained-layout allocation-budget failure (three unnecessary empty-array sites), an agent-end source-order invariant, and a stale built-package export after adding the protocol export. The array sites were removed and event handling preserved the invariant; the package was rebuilt. Assertions/budgets were not widened. The final clean build/full-suite run above supersedes those failed runs. Ignored local logs are `check-release.log`, `build-release.log`, `final-targeted.log`, `hot-release.log`, `full-tests-release.log`, `perf-*.log`, `progress-final.log` and `lifecycle-measurements.log`; this document carries the durable results.

## Reproduction commands

Run from the candidate worktree after dependency installation:

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/interactive-control-images.test.ts tests/visual-tail.test.ts tests/permission-interaction.test.ts
node --experimental-strip-types --test tests/tui-async-owner-closeout.test.ts tests/tui-frame-queue.test.ts tests/tool-result-presentation-ui.test.ts
npm run test:hot
npm test
git diff --check
npm run bench:interactive-input -- D:/RMProjects/Pi
npm run bench:interactive-input -- .
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts D:/RMProjects/Pi --sample
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts . --sample
node --expose-gc --experimental-strip-types scripts/bench/image-draft-lifecycle.ts
```

Progress runs use `npm run bench:interactive-progress -- <sourceRoot> <burst|awaited|paced>`, separately with `--sample`. The awaited fixture calls the real `.awaited()` API; awaiting the ordinary fire-and-forget callback would not measure this case.

## Native acceptance and limits

| Environment/configuration | Status |
| --- | --- |
| Real SDK, offline provider serialization, simulated clipboard, real Main/Alt components and terminal writes; multimodal main | Automated tests passed |
| Same chain; text-only main + actual auxiliary extension + offline vision provider | Automated tests passed |
| Native Win+Shift+S → Windows terminal Alt+V → multimodal online main | **Not executed** |
| Native Win+Shift+S → Windows terminal Alt+V → text-only online main + auxiliary | **Not executed** |
| Native Explorer drag/drop outside workspace, both configurations | **Not executed** |
| Native Linux/macOS/WSL clipboard/terminal acceptance | **Not executed** |

No paid online model, private screenshot upload or native desktop automation was used. Actual Windows terminal brand/version and two real model configurations are therefore not asserted. A future native run must record them, leave the ready draft unsent long enough to observe zero image calls, then submit, inspect routing/history, and verify original files remain unchanged. Simulated terminal success does not establish these desktop results.

Known limits: text attachment markers are the cross-terminal baseline; bitmap previews are not added. Mixed prose/path input that cannot be confidently classified stays text. A combined queue larger than draft limits cannot be restored wholesale; it is left intact instead of losing images. Pixel decoding now runs in one operation-owned Worker; the closeout measurements below characterize this fixture, including remaining peak-memory cost. Native desktop clipboard/Explorer acceptance is still unexecuted. No persisted interactive-form recovery or single-item queue extraction UI is added. The new host protocol is the supported route; legacy path-marker behavior is retained only for compatibility and is not evidence of new attachment ownership.

## Acceptance closeout — implemented and automatically verified

This closeout continues the same uncommitted worktree. It adds a native-input/offline-backend launcher, operation measurements, immutable-content digest reuse and queue recovery regressions. It does not certify the original Windows desktop symptom as resolved.

- `scripts/acceptance/windows-image-input.mjs` creates an isolated agent directory, workspace, sessions, synthetic model catalog/auth and explicit auxiliary configuration **before** importing the application. Only system/terminal environment values are inherited. External `fetch` and outbound sockets are denied. It does not read or modify real credentials/model configuration. Generated fixtures and scalar event logs are non-sensitive, outside the isolated workspace; no private image is bundled.
- Both transports run the real OpenAI Responses serializer with an in-process SSE response. Configuration A exposes an image-capable main model. Configuration B exposes a text main plus the actual auxiliary-vision extension and a separately registered offline vision transport. The vision reply explicitly says it is a fixture, not real image recognition.
- Normal launch uses the actual `InteractiveMode`, `ProcessTerminal`, key dispatch, Windows STA clipboard helper and host attachment owner. `/offline-status` shows bounded request counters. `--check` explicitly submits a generated SDK image; `--startup-check` initializes/stops the real TUI over the host's pipe. Neither self-check exercises native gestures.
- `image-decode.ts` owns one Worker and deadline per validation operation. The draft retains its read/decode slot through cancellation until its own cleanup/worker exit, so repeated clear/add cannot release an unfinished slot. A Worker is created only at image reception, not at each key/frame; there is no pool, polling or changed capacity.
- Byte/header dimensions are checked before pixel decode. The shared dimension parser accepts a byte view, avoiding the receive-time base64 encode/decode round-trip. Per-draft total bytes are checked before decode and again before publishing a ready record, since a queue restore may occur while decoding. File byte limits are checked by handle stat before bounded reading. Corruption that passes the header check is rejected by actual pixel decoding.
- The session verifies MIME/header dimensions/byte bounds once per canonical content object at its first text-model request, freezes its string-valued image block and memoizes the actual SHA-256 content digest using a session-owned WeakMap. This is not trust based solely on an unverified reference. Configuration, text, ordered image digests, session branch and submission identity still participate in result reuse; privacy/model/cancel checks remain live. A changed extension image array invalidates the host proof. Legacy results are compared through a bounded 32-entry scalar digest adapter, cleared at extension shutdown. No cache owns image bytes.
- Source review found a misleading second “No queued messages” notice after capacity rejection; it is removed. Two independently legal queued submissions (5+4 images) retain exact text, order and identities after rejected whole restore. The warning now describes existing reachable actions: explicitly send a new message to continue processing, or `/new` to cancel the current session queue. A cancelled question remains paused; restoring or clearing does not run it automatically. Actual editor input and `/new` replacement tests verify those paths and old-session image references are released.

The complete source review covers the existing call chains listed above, every changed tracked file and all task-created source/tests. It rechecked question pre-admission before all business calls, explicit unexecuted tool results and the outer pause return; permission rule creation/matching/revocation and final authorization; snapshot/queue ownership; shared dimension and ANSI/Unicode parsing. No blanket source-invariant exemption or budget increase was introduced. The acceptance launcher initially failed the repository's property-delete invariant; rebuilding an isolated environment object fixed the cause. The first full run stopped at that invariant and is not counted as a completed pass.

## Native input plus offline backend — not executed

The installed desktop automation package loaded, but `sky.list_apps()` failed with `Computer Use native pipe is unavailable: failed to connect native pipe: 系统找不到指定的文件。 (os error 2)`. There was no usable native desktop surface. No Win+Shift+S, native Alt+V, Explorer drag, desktop resize, or real clipboard screenshot was performed. The automated clipboard fixture tests remain explicitly simulated.

The actual host for command/self-check runs was Windows 10.0.22631 (Windows 11), PowerShell 7.6.5 at `D:/PowerShell/7/pwsh.exe`, Node 26.4.0, Intel i7-14700KF / 28 logical processors. Self-check stdin was a pipe, not a native terminal. A Windows Terminal brand/version is **not** inferred from these runs. `run.json` records terminal environment hints and COMSPEC (the default command processor, not proof of the launching shell); the human operator must add actual terminal, shell and gesture results. `nativeInputExecuted` starts false and is not automatically promoted by a self-check.

Checked startup commands, from this worktree after `npm run build:offline`, in two separate native terminal runs:

```powershell
node --experimental-strip-types scripts/acceptance/windows-image-input.mjs multimodal
node --experimental-strip-types scripts/acceptance/windows-image-input.mjs auxiliary
```

For each run:

1. Record terminal name/version, PowerShell version, effective Alt+V binding and configuration A/B. Read the displayed run/fixture directory. Use only a non-sensitive desktop view.
2. Win+Shift+S → capture → focus this terminal → Alt+V. Wait for the persistent `已粘贴 · 未发送` attachment. Type a question, resize/scroll and wait; `/offline-status` and the bounded `events.jsonl` must still show no main/vision request caused by this draft.
3. Submit normally. A: one main wire image, zero vision calls. B: a vision wire request followed by a text-only main wire request. Original question and image marker must remain in history; B also has the separately labelled derived result. No extra confirmation is required.
4. From Explorer, drag the launcher's `outside-workspace` fixture into the terminal, add the second fixture, inspect both unsent markers and remove one using `/image-remove N`. If that terminal delivers ambiguous mixed prose/path input, keep it as text and use the explicit `/image` action; record the native drag outcome separately. Do not label the fallback as a drag pass.
5. Confirm zero model calls before the next normal submit, correct routing afterwards, and that both originals still exist with unchanged hashes. Record hashes before/after using `Get-FileHash -LiteralPath` on the displayed fixture paths. The generated input names include spaces and Chinese; all paths remain literal data.
6. Stop the app normally. Keep the isolated run directory only for needed acceptance evidence, then remove that exact recorded directory. It contains fixtures and the test session, not a copy of the repository.

Self-check commands actually executed successfully for **both** configurations:

```powershell
node --experimental-strip-types scripts/acceptance/windows-image-input.mjs multimodal --check
node --experimental-strip-types scripts/acceptance/windows-image-input.mjs auxiliary --check
node --experimental-strip-types scripts/acceptance/windows-image-input.mjs multimodal --startup-check
node --experimental-strip-types scripts/acceptance/windows-image-input.mjs auxiliary --startup-check
```

A self-check observed main=1, vision=0; B observed main=1, vision=1 with one submitted-image input hook. Both startup checks exited 0. The compiled `.js` decode Worker also decoded the non-sensitive one-pixel fixture successfully after the offline build.

## Real online services — not verified

No external or paid provider was called and no private screenshot was uploaded. Offline serializer/dispatch success cannot establish credentials, service availability, real visual quality or remote billing behavior. No online manual authorization was sought or assumed.

## Previous closeout measurements (retained, definitions corrected)

For image response and reuse, “baseline” means the existing uncommitted implementation at the start of this closeout (inline Photon decode and full hash per request), not clean `origin/main`, which did not have this host draft feature. The visual-tail baseline remains the read-only main checkout. Candidate source SHA-256 values are recorded with the measurements.

The bounded scalar records are in [interactive-image-closeout-measurements.json](performance/interactive-image-closeout-measurements.json). They retain planned/actual probe times, read/decode/encoding/UI stages, observed frame generations, OS peak RSS, heap/external/ArrayBuffer and WASM observations. They do not contain image bytes, credentials, sessions or raw heap profiles.

The original targets were ≤100 ms for input/cancel and ≤150 ms for a corresponding frame. **The old instrumentation did not directly measure those semantics**: `probe.handled` was recorded in the timer callback before `input.write()`, and the candidate probe explicitly called `renderNow()`. Its frame observation tracked the next generation, without verifying corresponding screen contents. The baseline frame used flush completion. The tables below therefore retain **probe callback delay / forced-refresh frame completion observations**, not natural input acceptance/display latency, and do not establish the original responsiveness targets. Each scenario used a fresh child, real ProcessTerminal/TUI dispatch and a simulated asynchronous Writable (1 ms sink delay); no desktop compositor timing was measured. The +5 ms planned time still exposes synchronous event-loop blocking. The separate review-round natural-scheduling measurements below establish actual handler acceptance and content-matched frame completion.

Fixtures: 1920×1080 PNG (64,955 B), 6000×3999 PNG (23,994,000 pixels; 1,385,685 B), noisy 1600×1600 PNG (10,244,793 B, 97.7% of the 10 MiB limit), three such noisy images (30,734,379 B under 40 MiB), an oversized-dimension header, a 10 MiB+1 file, and a truncated PNG. PNG requires no format conversion in this route; actual encode/decode method wrappers and Worker events observe work rather than predeclaring zero counts. Windows clipboard helper conversion/memory remains outside this non-desktop benchmark.

| Normal case | Baseline callback delay (ms) | Candidate callback / forced-frame observation (ms) | Ready / ready-frame from add input (ms) | Peak RSS baseline / candidate (MiB) |
| --- | ---: | ---: | ---: | ---: |
| 1080p screenshot | 44.57 | 0.33 / 2.30 | 76.30 / 107.06 | 193.8 / 230.0 |
| 23.994 MP | 652.62 | 0.77 / 2.75 | 228.23 / 252.99 | 439.4 / 484.1 |
| Near 10 MiB | 18.64 | 1.19 / 3.15 | 102.20 / 119.78 | 231.2 / 279.6 |
| 3 images / 29.3 MiB | 19.27 | 0.33 / 2.29 | 235.34 / 253.59 | 289.4 / 305.8 |
| Oversized header | 12.74 | 11.76 / 13.06 | rejected | 172.9 / 161.3 |
| >10 MiB file | 7.34 | 6.15 / 21.97 | rejected | 160.8 / 160.8 |
| Truncated PNG | 3.64 | 0.56 / 2.53 | rejected | 170.9 / 214.5 |

| Candidate normal case | Read calls / ms | Pixel-decode operations / ms | Base64 encodes / ms | UI projection calls / ms (including clear) |
| --- | ---: | ---: | ---: | ---: |
| 1080p screenshot | 2 / 0.105 | 1 / 17.020 | 1 / 0.034 | 3 / 0.040 |
| 23.994 MP | 2 / 0.545 | 1 / 150.047 | 1 / 0.381 | 3 / 0.040 |
| Near 10 MiB | 2 / 2.715 | 1 / 26.219 | 1 / 2.089 | 3 / 0.041 |
| 3 images / 29.3 MiB | 6 / 8.234 | 3 / 62.728 | 3 / 6.005 | 7 / 0.068 |
| Oversized header | 2 / 0.103 | none observed | none observed | 3 / 0.065 |
| >10 MiB file | none observed | none observed | none observed | 3 / 0.034 |
| Truncated PNG | 2 / 0.101 | 1 / 8.877 | 1 / 0.019 | 3 / 0.042 |

| Cancel probe case | Callback / forced-frame observation (ms) | Worker exit after planned probe (ms) | Operation settled after planned probe (ms) |
| --- | ---: | ---: | ---: |
| 1080p screenshot | 1.06 / 3.03 | 4.98 | 5.25 |
| 23.994 MP | 0.88 / 2.86 | 5.26 | 5.60 |
| Near 10 MiB | 0.64 / 2.61 | 5.39 | 5.66 |
| 3 images / 29.3 MiB | 0.28 / 2.25 | 5.70 | 5.97 |
| Oversized header | 2.47 / 18.05 | no worker | already rejected before probe |
| >10 MiB file | 13.48 / 29.00 | no worker | already rejected before probe |
| Truncated PNG | 0.65 / 2.61 | 3.95 | 4.23 |

All legacy callback/forced-frame observations were below the numerical targets; this is not evidence of natural handler/frame latency. Over-limit cases reject before any pixel decoder; their probe runs after rejection and is not decode-window evidence. The non-cancelled large decode interval is measured directly; cancellation records termination rather than pretending the decoder returned normally.

Peak RSS for the completed large case increased from 439.4 to 484.1 MiB, while post-clear diagnostic RSS fell from 435.1 to 193.6 MiB. The Worker reached 278.7 MiB WASM memory and exited; the warmed parent WASM remained 1.4 MiB. Worker startup, one bounded byte clone and additional isolate cost are real. Normal/cancelled valid fixtures returned ArrayBuffer use to about 0.19 MiB; corrupt fixtures retained about 0.26 MiB at the four-turn GC observation. That small residual is reported, not a claim of exact allocator return or proof against every long-run native leak. The fixture preloads the parent Photon module equally outside timing in both versions; initialization, operation and post-clear memory are separate in the raw records.

The original near-24MP decode was synchronous on the TUI thread: the +5 ms probe was actually delayed 501–653 ms. Wrapping it in an async method did not make it interruptible. The operation-owned Worker now isolates that native computation. Normal exit calls Photon free in `finally`; cancellation terminates the Worker and waits for exit, which releases its entire WASM isolate even if JavaScript finally cannot run. A terminated decoder's exact native object count/function completion and instantaneous WASM peak are unknown; its measured process RSS peak and worker-exit time are reported instead. After all measured cases, draft records are zero and all started Workers have exited. Controlled GC is only a diagnostic and does not promise that the OS returns every allocator page immediately.

Local ordinary-input counters remain: 1,000 text edits/renders before an image cause 0 reads, 0 encodes and 0 attachment projection changes; one local PNG addition causes 2 bounded reads, 1 encode and 2 projection changes; another 1,000 edits/width changes do not increase them. The small read-start cancellation diagnostic is distinct from the decode-window probes. Two cleared JS WeakRefs support reference release only, not a native peak-memory conclusion.

Repeated-work test uses the real SDK, real auxiliary extension, existing session persistence and real provider serializer. It wraps actual Hash.update/Buffer operations for the known fixture:

| Phase (cumulative within the test) | Before: full image scans / bytes | Candidate: full image scans / bytes | Vision calls |
| --- | ---: | ---: | --- |
| Local ready | 0 / 0 | 0 / 0 | 0 |
| Vision succeeds, main fails | 1 / 39,504 | 1 / 39,504 | 1 |
| Explicit retry | 2 / 79,008 | 1 / 39,504 | still 1 |
| Three text follow-ups | 5 / 197,520 | 1 / 39,504 | still 1 |
| Open saved session, no submit | unchanged | unchanged | 0 in new runtime |
| Explicit restored continue | 6 / 237,024 | 2 / 79,008 | 0; persisted result reused |
| Another restored follow-up | 7 / 276,528 | 2 / 79,008 | 0 |
| Necessary processing config change | 8 / 316,032 | 2 / 79,008 | 1 new call |

There is one receive-time base64 encoding; subsequent requests do not re-encode/re-read the original local file or pixel-decode it. Candidate performs one base64 decode for verification at the first text-model use and one after session restore; subsequent text follow-ups do neither. The old receive-time dimension check unnecessarily decoded the just-encoded base64 once. In that earlier candidate, ordinary image input hooks still ran for historical requests (5 live calls, 3 after reopen). This was the responsibility error fixed in the review round below: ordinary interception now runs once per new explicit submission, while the auxiliary processing phase still checks current processing configuration at each applicable request. They still construct small arrays and scan session metadata for results; this is not zero-allocation history processing. Full-image hashing is eliminated for verified frozen blocks, not all history traversal. Changed image bytes/question/settings and transformed input are tested; old persisted pre-digest results also restore without automatically uploading again.

The earlier **20.4%** figure was sampled allocation improvement for the particular visual-tail fixture, not overall TUI/machine speed. The closeout rerun of that same fixture measured baseline/candidate unsampled p50 11.136/11.163 ms, p95 12.801/11.621 ms; sampled bytes/operation 16,987,454/13,388,226 (about 21.2% lower). Sampling and unsampled response runs were separate. Returned/skipped lines stayed 10/9,991. These noisy repeat measurements are not a new broad performance claim. ToolProgressDelivery drain code is unchanged and receives no performance credit.

## Previous closeout verification and continuing limits

- Native input/offline backend acceptance: **not executed**, despite checked launcher/self-checks. Real online service acceptance: **not executed**. Linux/macOS/WSL native input remains unverified.
- The Worker adds startup/byte-clone overhead for ordinary images. Peak native memory still matters at 24MP; there is no claim of bounded-to-compressed-size decoding. PNG timings do not characterize every JPEG/WebP/GIF or Windows GDI clipboard conversion.
- Ambiguous mixed text/path input stays text. Attachment display remains a reliable text marker, not universal terminal bitmap support. Existing full-request permission inspection and final authorization remain conservative; this closeout does not expand shell grammars or tools.
- The queue overcapacity recovery uses explicit continue or existing `/new`; no single-item extraction UI, enlarged limit or automatic answer/default approval was introduced.

| Previous closeout command / scope | Observed result |
| --- | --- |
| `npm run check` | Exit 0 after final production change |
| `npm run build:offline` | Exit 0; all configured workspaces |
| Five complete related test files below | 119 passed, 0 failed, 0 skipped |
| `npm run test:hot` | 31 passed; same gates also included in final full suite |
| `npm test` | Exit 0; 1,690 total, 1,632 passed, 58 skipped, 0 failed, 0 cancelled across 142 reported file/workspace summaries |
| `git diff --check` | Passed |
| Response matrix | 14 isolated child runs completed (7 inputs × normal/cancel); no heap sampling during response runs |
| Lifecycle and visual-tail allocation benchmarks | Completed; actual counters and results above/JSON |
| Offline SDK transport + TUI startup self-checks | Both configurations passed; native gestures not exercised |
| Native desktop input / online services | Not executed / not executed |

Previous closeout full-suite log: ignored local `tests-closeout-complete.log` (not the final review-round candidate). `tests-closeout-final.log` is the earlier failed source-invariant run, and `tests-closeout-rerun.log` predates the final read-slot fix; neither is substituted for the final run. Static/build logs are `check-closeout-final.log` and `build-closeout-final.log`. No test assertions were deleted or budgets widened. The 58 skips remain the existing platform/opt-in cases, not passes. Existing Bash, viewport/frame queue, permission final authorization, tool recovery, snapshot and async-owner files are included in the full run.

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/image-acceptance-closeout.test.ts tests/interactive-control-images.test.ts tests/visual-tail.test.ts tests/permission-interaction.test.ts tests/tui-async-owner-closeout.test.ts
npm run test:hot
npm test
git diff --check
node --experimental-strip-types scripts/bench/image-response.ts
node --expose-gc --experimental-strip-types scripts/bench/image-draft-lifecycle.ts
npm run bench:interactive-input -- D:/RMProjects/Pi
npm run bench:interactive-input -- .
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts D:/RMProjects/Pi --sample
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts . --sample
```

The host's npm wrapper rejected forwarding `--sample` as an unknown npm flag before executing those sampling runs. Calling the same checked benchmark script directly with Node succeeded. No performance result is inferred from the failed invocations.

All response-matrix child roots were cleaned by their recorded owner. Eleven native-launcher self-check directories were receipt-verified, but automatic approval review rejected their cleanup with only `blocked by policy`. Cleanup was not retried through another mechanism. These non-sensitive isolated directories remain under `C:/Users/ADMINI~1/AppData/Local/Temp`: `sp-native-image-5PBzVE`, `sp-native-image-7fhU8s`, `sp-native-image-AlK3eD`, `sp-native-image-BRDv5B`, `sp-native-image-gs10bQ`, `sp-native-image-kbMXVG`, `sp-native-image-kKV5cx`, `sp-native-image-OZVVre`, `sp-native-image-RqHIA7`, `sp-native-image-uGvg0d`, `sp-native-image-yXz8XD`. No self-check process or decoder Worker is left running. Their contents are not included in the source review patch.


## Review round: three interaction boundaries

This round stays on the same dirty branch and preserves the Worker, read-slot lifetime, verified-image digest reuse, question batch admission and final permission authorization. The previous rounds' test totals and hashes above are historical records. The final-candidate commands/results and new observations below are separate.

### Ordinary input and image processing

Reproduction used real `createAgentSession`/`AgentSession.prompt`, the resource loader and extension runner, actual auxiliary-vision extension, persisted sessions and the OpenAI Responses serializer with offline SSE transport. An ordinary handler returning `handled` or `transform` was skipped for image-capable main models; text-only image requests instead called all ordinary handlers again during history projection. The initial 11-test boundary run failed all 11 cases before the changes (`review-boundaries-before.log`). These are full local SDK/TUI regressions, not only method-level review probes.

`prompt()` now dispatches ordinary input once for a new explicit submission (including submission through `streamingBehavior`), before normal template/skill expansion. Source and streaming behavior reach that handler. `handled` keeps normal input semantics: the extension owns handling, so no provider request or canonical user message is synthesized. `transform` changes the backend input; original user text and images remain canonical. Image arrays/blocks exposed to ordinary handlers are frozen snapshots: handlers return transforms instead of mutating the original. Changed image content is validated and copied as necessary metadata/string references. The committed `inputProjection` is persisted beside the original association and removed at provider conversion, including after session reopen. A transform that removes images retains the original history record while sending the explicitly transformed text.

The auxiliary extension registers its processing handler with `pi.on("input", handler, { phase: "image-processing" })`. This uses the existing extension handler registry, chaining and lifecycle, not another event system. Its ordinary handler keeps only legacy-input compatibility and declines host submissions. Only the processing phase consumes submitted history at an actual request boundary. Ordinary handlers are not replayed on text follow-ups or history restore. Direct `steer`/`followUp` APIs retain their existing queue-only semantics; `prompt(..., { streamingBehavior })` retains ordinary input semantics. Queue admission performs no auxiliary analysis. The existing `blockImages` check also prevents handing prohibited images to ordinary hooks; the prior zero-interception assertion is preserved.

The old digest-proof regression now explicitly registers its transform in the processing phase, where its test is intended to operate. It still proves changed bytes invalidate the host digest proof and force the correct derivation; the security assertion was not removed. A second old failure fixture likewise registers a processing-stage failure and continues to assert no automatic retry/queue drain. The new ordinary-input tests separately verify both models, handled/transform, queue timing, source/streaming behavior, text-only transforms, image removal and persisted projection without replay.

### Preflight ownership and recovery

The old TUI consumed the draft before asynchronous authentication/preflight, then attempted to merge it back into whatever new draft existed. An eight-image or near-byte-limit next draft made `restore()` throw, hiding the authentication error and losing a reachable owner of the first submission. Even a smaller draft could combine unrelated text/images.

`submitImageDraft()` now retains one independent pending/failed submission until the existing `preflightResult(true)` acceptance callback transfers ownership to the session/queue. On rejection it records the original error and original ordered text/attachment snapshot, leaving the next draft untouched. A persistent editor marker explains the failure and recovery commands. `/image-recover` requires an empty draft; rejection leaves both owners intact. `/image-discard` releases only that failed submission. Session replacement/stop releases the slot. It is bounded to one ordinary submission (8 images/40 MiB), with no increased per-draft or queue limits and no automatic replay. Further image submissions while this slot is occupied are refused with the edited text preserved. Failed recovery is not hidden in an empty catch.

The real ProcessTerminal/editor input regression holds synthetic asynchronous authentication before any user message is accepted, then adds the next draft using complete path paste. Cases cover 0, 7 and 8 images plus four 10,244,793-byte images: the latter new draft is legal by itself but cannot merge with the previous image. Tests assert the original error, identity, text and order remain recoverable; next-draft contents remain exact; duplicate sends while pending do not create another authentication/submission/queue entry; recovery/cancel commands are reachable; no unobserved rejection occurs. This is synthetic auth plus real SDK/TUI, not a failure injected after a main model has accepted the user message.

### Policy validity after asynchronous processing

The previous block check preceded the auxiliary await. The result became ordinary text, so raw-image filtering could no longer identify or stop it. `prepareSubmittedImages()` now retains request-local association through a bounded session field (model, session, cancellation signal and effective image-policy revision). SDK checks it after image processing and context hooks, at stream admission, after header transformation and before/after payload hooks. It is not attached to provider messages. Effective-setting publication tracks `blockImages` changes, including overrides/reload/trust changes; toggling on and back off still invalidates an in-flight image request.

The production `Image submission blocked:` outcome preserves canonical attachments and existing derivations, suppresses automatic retry/compaction/queue continuation and requires an explicit user continuation. It cannot retract the already-recorded offline vision request. There is no provider exactly-once or billing claim. Fifteen SDK cases gate vision responses, context hooks or provider-payload hooks and interleave blocking, block/unblock, override/unblock, model replacement or cancellation. They assert one already-issued vision request, zero subsequent main requests and the queued follow-up preserved. Completed derivations remain; a cancelled unfinished vision response is not mislabeled complete. Final header checks were source-reviewed on the production ModelRuntime path; the integration fixture uses a synthetic credential/catalog ModelRuntime and does not claim a live authentication/provider-header service test.

### Review and continuing acceptance limits

The complete source diff and all new task files were reviewed, including attachment snapshot/projection ownership, Worker/read-slot release, question mixed-batch admission and the outer pause return, permission rule creation/matching/revocation/final invocation, and shared ANSI/Unicode visual-tail layout. The last three groups were retained; no drain/frame scheduler/Worker rewrite, whitelist expansion, capacity increase or test-budget exemption was introduced.

Native desktop input + offline backends: **not executed in this round**. The previously unavailable desktop interface was not retried. The checked launchers and minimal manual steps above remain available. Actual online providers: **not executed**, with no paid calls/private screenshot uploads. The local SDK serializer fixtures verify submission/processing behavior, not native Win+Shift+S, Alt+V or Explorer gestures. The eleven previously policy-blocked temporary directories remain untouched; that cleanup status is separate from passing source regressions and observed Worker exit.

### Final-candidate natural scheduling and repeat-work measurements

Final response measurements ran after the full suite, without concurrent test load or heap sampling. Command: `node --experimental-strip-types scripts/bench/image-response.ts --natural`. Targets were declared before measurement: **planned probe → accepted state ≤100 ms; planned probe → corresponding frame write complete ≤150 ms**. These do not bound total image readiness. `inputArrived` is entry into the real editor handler; `processed` is recorded only after that handler changes the expected text or clears the editor/draft. `callbackAt` remains separate from handler acceptance. The diagnostic observes the actual Alt-screen `nextScreen` used to construct a frame, verifies the expected text or its removal, matches its exact data at the terminal queue sink, then records that generation's completion. An arbitrary first frame cannot pass. Setup/cleanup may flush; the probe and measurement wait do not call `renderNow()` or flush. The final ready-attachment observation also requires the complete add operation and a ready-state frame.

| Scenario | Normal accepted / matching frame (ms) | Cancel accepted / matching frame (ms) | Cancel worker exit after plan (ms) | Normal peak RSS (MiB) |
| --- | ---: | ---: | ---: | ---: |
| screenshot | 1.488 / 2.184 | 1.362 / 2.678 | 4.410 | 226.4 |
| near-24mp | 1.012 / 1.765 | 0.835 / 1.269 | 4.656 | 482.1 |
| near-bytes | 1.080 / 1.865 | 1.462 / 1.916 | 5.164 | 278.2 |
| multi | 0.613 / 1.392 | 1.178 / 1.608 | 6.018 | 304.7 |
| over-pixels | 16.037 / 30.902 | 12.859 / 27.690 | no worker | 173.4 |
| over-bytes | 13.058 / 27.621 | 6.730 / 21.429 | no worker | 161.4 |
| corrupt | 0.439 / 1.225 | 1.676 / 2.095 | 4.483 | 212.5 |

All 14 runs had verified accepted state and corresponding natural frame completion. Maximum planned-to-accepted was 16.037 ms and planned-to-frame 30.902 ms; all met these controlled targets. The five decoder-backed scenarios (normal/cancel) placed the planned probe inside the measured decode/termination interval. Over-limit probes followed rejection and provide no decode-window evidence. This is one isolated child per case, not a production percentile or desktop compositor measurement. No new Worker/scheduler repair was justified. Original forced-refresh datasets and source hashes remain in the JSON with corrected labels; they are not mixed with this run.

The 23.994MP normal case still peaks at 482.1 MiB process RSS. The Worker isolates synchronous decode from the input loop; it does not eliminate decode memory. Every started Worker exited, and draft records were zero after release. Controlled GC is diagnostic; interrupted native function completion/object counts/instantaneous WASM peak remain unknown. The non-sensitive PNG matrix does not measure Windows Forms clipboard conversion or all image formats.

The final repeated-work SDK regression observes one ordinary image input hook on initial submission and none for subsequent historical reprocessing. After vision success/main failure, explicit retry and three text follow-ups keep full image scans at 1 / 39,504 bytes, base64 encodes at 1 and verification decodes at 1; vision remains 1. Opening a saved session triggers neither provider. Explicit restored continuation performs one fresh verification/digest (cumulative 2 / 79,008 bytes, 2 decodes), reuses the saved vision result, and does not replay ordinary image input. Further text continuation does no new image scan; necessary auxiliary configuration change causes one new vision call. Session/request metadata traversal and small processing arrays still exist. This is not zero-allocation history processing.

`image-draft-lifecycle.ts` observes 0 reads/encodes/attachment projection updates in 1,000 ordinary edits/renders; one addition yields 2 reads, 1 encode, 2 projection updates; 1,000 subsequent edits/width changes add none. Its read-start cancellation is 0.628 ms, distinct from the natural decode-window probes. Both JS WeakRefs released; they are not native peak-memory proof.

The unchanged visual-tail fixture was rerun separately without sampling and with sampling against the read-only main checkout. Baseline/candidate p50: 11.001/11.298 ms; p95: 12.904/11.657 ms. Sampled bytes/operation: 17,118,516/13,275,243. Returned/skipped lines remain 10/9,991. This repeat does not replace or generalize the original 20.4% sample; no drain improvement is claimed.

### Final-candidate verification

| Command | Observed result |
| --- | --- |
| `npm run check` | Exit 0 |
| `npm run build:offline` | Exit 0, all configured workspaces |
| Six complete related files (command below) | 150 passed, 0 failed/skipped |
| `npm run test:hot` | 31 passed, 0 failed/skipped |
| `npm test` | 1,721 total; 1,663 passed, 58 skipped, 0 failed/cancelled; exit 0 |
| `git diff --check` | Passed |
| Natural response / lifecycle / visual-tail benchmarks | 14 natural children; lifecycle and separate sampled/unsampled baseline/candidate runs completed |
| Native desktop / online services | Not executed / not executed |

```powershell
node --experimental-strip-types --test tests/image-review-boundaries.test.ts tests/image-acceptance-closeout.test.ts tests/interactive-control-images.test.ts tests/visual-tail.test.ts tests/permission-interaction.test.ts tests/tui-async-owner-closeout.test.ts
node --experimental-strip-types scripts/bench/image-response.ts --natural
node --expose-gc --experimental-strip-types scripts/bench/image-draft-lifecycle.ts
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts D:/RMProjects/Pi
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts .
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts D:/RMProjects/Pi --sample
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts . --sample
```

Authoritative verification logs are `check-review-final.log`, `build-review-final.log`, `tests-review-related.log`, `tests-review-hot.log`, `tests-review-full.log`; response data use `response-review-natural-final.log`. The natural benchmark's final diagnostic refinement matches the complete ready-image frame as well; production source did not change after the full suite. Earlier failed/intermediate logs are retained locally but are not final results. The measurements JSON records final source and log SHA-256 values under `reviewRound`; historical keys retain historical hashes. The companion regenerated full patch/manifest includes all 50 task files (32 tracked modifications, 18 new files), with per-file byte counts and SHA-256. No ignored logs, credentials, private sessions, node_modules or raw heap profiles are included. No commit/push/PR/merge was made.

## Complete review inventory

The companion review patch includes both tracked changes and new files (plain `git diff` omits the latter). The manifest records path, status, bytes and SHA-256 for each file; it excludes dependency directories, generated build output, ignored logs and unrelated main-worktree files. There is no second maintained source tree.

```text
docs/interactive-control-image-input.md
docs/performance/interactive-image-closeout-measurements.json
package.json
packages/agent/src/agent-loop.ts
packages/agent/src/agent.ts
packages/agent/src/types.ts
packages/coding-agent/src/core/agent-session.ts
packages/coding-agent/src/core/extensions/loader.ts
packages/coding-agent/src/core/extensions/runner.ts
packages/coding-agent/src/core/extensions/types.ts
packages/coding-agent/src/core/image-attachments.ts
packages/coding-agent/src/core/messages.ts
packages/coding-agent/src/core/sdk.ts
packages/coding-agent/src/core/settings-manager.ts
packages/coding-agent/src/core/tools/ask-user.ts
packages/coding-agent/src/core/tools/index.ts
packages/coding-agent/src/core/tools/tool-definition-wrapper.ts
packages/coding-agent/src/index.ts
packages/coding-agent/src/modes/interactive/components/custom-editor.ts
packages/coding-agent/src/modes/interactive/components/extension-selector.ts
packages/coding-agent/src/modes/interactive/components/visual-truncate.ts
packages/coding-agent/src/modes/interactive/interactive-mode.ts
packages/coding-agent/src/utils/clipboard-image.ts
packages/coding-agent/src/utils/clipboard.ts
packages/coding-agent/src/utils/image-decode-worker.ts
packages/coding-agent/src/utils/image-decode.ts
packages/extensions/auxiliary-vision/clipboard-lifecycle.ts
packages/extensions/auxiliary-vision/core.ts
packages/extensions/auxiliary-vision/index.ts
packages/extensions/resource-lifecycle-guard/permission-contract.ts
packages/extensions/resource-lifecycle-guard/permission-controller.ts
packages/extensions/resource-lifecycle-guard/permission-rule.ts
packages/extensions/resource-lifecycle-guard/permission-state.ts
packages/tui/src/components/editor.ts
packages/tui/src/index.ts
packages/tui/src/terminal-image.ts
packages/tui/src/utils.ts
scripts/acceptance/windows-image-input.mjs
scripts/bench/image-draft-lifecycle.ts
scripts/bench/image-response-child.ts
scripts/bench/image-response.ts
scripts/bench/interactive-image-input.ts
scripts/bench/interactive-progress.ts
tests/alpha-cli.test.ts
tests/github-review-regressions.test.ts
tests/helpers/image-acceptance-fixtures.ts
tests/helpers/offline-image-runtime.ts
tests/image-acceptance-closeout.test.ts
tests/image-review-boundaries.test.ts
tests/interactive-control-images.test.ts
tests/permission-interaction.test.ts
tests/tui-async-owner-closeout.test.ts
tests/visual-tail.test.ts
```

## GitHub PR #38 review fixes (2026-09-17)

This section supersedes the earlier uncommitted delivery status. Commit `80e627211cc2add89d08ddd810a0bd52bd3ffdd2` was published with user authorization. The following fixes respond to its GitHub review; historical measurements and validation above still describe their recorded candidates.

| Review comment | Reproduction/root cause | Change and regression |
| --- | --- | --- |
| [4036989760](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989760) | An image prompt waits in `before_agent_start`; another ordinary prompt acquires the Agent. The old preflight callback cleared TUI recovery before actual Agent admission. | Agent invokes acceptance only after acquiring its run owner. Rejected contenders retain their failed submission and do not settle the competing run. Real SDK/TUI regression gates both the extension and provider. |
| [4036989770](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989770) | Invalid `ask_user` schema/duplicate IDs produced an ordinary error but the batch loop converted every error into termination. | Only explicit interaction termination pauses. Validation errors return to model replanning; all stale business calls in the mixed batch remain unexecuted. Both error cases are covered. |
| [4036989779](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989779) | SDK metadata with matching byte count/MIME bypassed validation, especially for multimodal models. | Caller metadata is no validation proof. Headers/limits are checked on snapshot; unverified content is decoded by the existing Worker before either backend. Private weak receipts transfer only from already decoded, frozen host content. MIME forgery, oversized headers and corrupt pixels are rejected before provider calls. |
| [4036989792](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989792) | Ordinary input transforms retain projected images in addition to canonical images; queue accounting counted only canonical metadata. | The unchanged 32-image/128-MiB queue budget counts both retained representations. Count and byte-limit regressions preserve existing queued entries and release accounting on clear. Draft restoration counts the canonical images actually restored. |
| [4036989803](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989803) | Deferred processing hardcoded `interactive`, allowing extension-origin images to enter automatic auxiliary processing. | Submission persists the original input source and passes it through processing; legacy records without source retain the prior interactive default. Real auxiliary extension regression confirms extension-origin input does not invoke vision/main. |
| [4036989810](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989810) | Old schema-v3 readers could discard the newly scoped backend/cwd fields and widen a saved rule. | Scoped rules now serialize as schema v4, which older readers reject. Current readers preserve v1-v3 compatibility without upgrading exact to prefix. Round-trip and legacy exact regressions pass. Downgrading cannot preserve v4 approvals; users must authorize again. |
| [4036989823](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989823) | Linux helper list/read calls omitted cancellation. | Both `wl-paste` and `xclip` receive the signal in both phases. Four controlled child-process transport tests verify abort propagation and no later fallback; this is not native Linux clipboard acceptance. |
| [4036989834](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989834) | Queue images followed insertion order while restored text grouped steer before follow-up; current draft placement also diverged. | Queue mode is retained; restoration uses the same steer/follow-up/current order for text and images. Actual TUI dequeue-key regression verifies IDs and editor text together. |
| [4036989842](https://github.com/dragonbaba/super-pi/pull/38#discussion_r4036989842) | Compaction flush bypassed ordinary input for all but the first submission using direct steer/follow-up. | Each submission enters `prompt` once, including retry queue-only admission. Ownership transfers one accepted item at a time; failed/unaccepted items remain queued. Real TUI/SDK tests cover handled, transformed and unchanged images with/without pending retry, retaining canonical history and zero queue-time model calls. |

The new file `tests/github-review-regressions.test.ts` contains 17 regressions. Its first six reproduction cases all failed on the published source before repair. These are local SDK/TUI/provider-serialization regressions with offline transport. The clipboard cancellation cases isolate child-process transport, and the compaction cases explicitly control the compaction flag; neither is a native desktop claim.

### CI failure

[CI run 35221531720](https://github.com/dragonbaba/super-pi/actions/runs/35221531720) passed Linux but failed Windows at `fullscreen/startup-quit` with an unhandled stdin `EPIPE`. The test extension had already requested startup shutdown, but the harness scheduled Ctrl+C after its readiness marker. `tests/alpha-cli.test.ts` now sends no redundant input for that self-shutdown scenario, clears the timer on child exit and guards delayed writes after exit. Error assertions remain intact; no generic pipe error is swallowed. All 42 CLI cases remain present (38 pass / 4 POSIX-signal skips on this Windows host).

### Measurement and remaining limits

The existing immutable-content receipts remove a redundant base64 verification decode for locally validated images; no model work moves before submission. The repeated-work regression records one local encode, one 39,504-byte digest scan and one ordinary image hook across initial submission, main failure, retry and three text follow-ups; auxiliary calls stay at one. Opening history makes no provider call. Restored continuation verifies content once and reuses saved vision output; later text follow-up does no additional full-image scan. A necessary auxiliary configuration change invokes vision once more. The `decodes` diagnostic counts base64 conversions, not native pixel decoder invocations; restored/untrusted content additionally crosses the Worker validation boundary.

Native Windows screenshot/Explorer desktop acceptance and online models remain unexecuted. The 11 directories retained after the earlier cleanup-policy rejection remain untouched; their cleanup state is separate from Worker exit/reference-release checks. The original 20.4% number remains a specific visual-tail allocation sample. The drain implementation is unchanged and receives no performance credit.

### Verification of the GitHub review fixes

| Command | Current local result |
| --- | --- |
| `npm run check` | Exit 0 (`check-github-second.log`) |
| `npm run build:offline` | Exit 0 (`build-github-first.log`) |
| Eight complete related test files below | 209 total / 205 passed / 4 platform skips / 0 failed or cancelled |
| `npm run test:hot` | 31 passed / 0 failed or skipped |
| `npm test` | 1,739 total / 1,681 passed / 58 skips / 0 failed or cancelled; exit 0 |
| `npm run alpha:g2-probe` | 322 total / 318 passed / 4 platform skips / 0 failed or cancelled; exit 0 |
| `git diff --check` | Passed |
| Natural response and lifecycle benchmarks | 14 completed children with matching natural frames, all targets met; started Workers exited and final draft records zero |

```powershell
node --experimental-strip-types --test tests/github-review-regressions.test.ts tests/image-review-boundaries.test.ts tests/image-acceptance-closeout.test.ts tests/interactive-control-images.test.ts tests/permission-interaction.test.ts tests/tui-async-owner-closeout.test.ts tests/visual-tail.test.ts tests/alpha-cli.test.ts
node --experimental-strip-types scripts/bench/image-response.ts --natural
node --expose-gc --experimental-strip-types scripts/bench/image-draft-lifecycle.ts
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts .
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts . --sample
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts D:/RMProjects/Pi
node --expose-gc --experimental-strip-types scripts/bench/interactive-image-input.ts D:/RMProjects/Pi --sample
```

Tests completed before running these separate sampled/unsampled benchmarks. Maximum planned-to-state-accepted/frame-write-completed latency was 13.702/37.325 ms (targets 100/150 ms); near-24MP peak process RSS was 483.8 MiB. The lifecycle probe observed 0 reads/encodes/projection changes for 1,000 ordinary edits, 2/1/2 for addition, and no further work during 1,000 attached edits/renders. Read-start cancellation was 0.442 ms, distinct from natural decode-window cancellation; both JS WeakRefs released.

Unchanged visual-tail baseline/candidate p50 was 11.139/11.492 ms, p95 12.860/12.195 ms. Separate sampled allocation was 17,177,800/13,374,798 bytes/operation, with returned/skipped lines 10/9,991. This fixture is not a whole-TUI speed claim.

Current source/log hashes, individual natural runs, repeated-work counts and lifecycle results are under `githubReviewRound` in the measurements JSON. Prior `reviewRound` and earlier keys remain historical. The regenerated full patch/manifest covers all 53 task files relative to the review base, including the three additional files in this review-fix round. No private sessions, ignored logs, dependencies or raw heap profiles are included. Remote CI/re-review results belong to the eventual pushed commit and must be checked on GitHub separately.
