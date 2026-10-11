# Multiline syntax colors (T08.1)

## Design gate

Baseline: `c46b4dd938908418c513d4c9889d328e1f1a8769`, after PR #106.
Reference: upstream [b9ab918c62](https://github.com/earendil-works/pi/commit/b9ab918c626ad3dd5edb58de037540f9467def88).
The formatter wraps an entire multiline token once. Markdown/theme callers then
split it into rows and terminal line resets remove its color on subsequent rows.
Nested interpolation also inherits string color without an explicit `subst` style.

Scope: format each nonempty line segment using numeric newline offsets, preserve
blank lines/newlines and nested-scope fallback, and give interpolation the theme's
text color. No per-token split/map/join arrays or callbacks. The single-line path
passes the existing text directly to its formatter. No language/parser upgrade.

The complete chain audited is assistant streaming update → existing reusable
Markdown slot / `setText` → scheduler → Main/Alt render → Markdown code token →
theme highlighter → highlight.js → HTML renderer → per-row styling/wrapping →
terminal line resets → frame queue → ProcessTerminal callback/drain → flush,
failure/abort, detached cache release and disposal. Tool read/write renderers also
call the same `highlightCode` entry. Their existing rendering caches and the
Markdown/theme caches retain the final output; this change adds no cache.

The HTML renderer currently uses a global ObjectPool for output/text/scope state.
No admission profile for this particular pool was found in the repository's
performance evidence (the other syntax benchmark covers tui-kit). Replace that
renderer pool with call-local output/text variables and one scope stack. This
removes shared render-state retention and needs no new pool admission. Stack size
is bounded by the input's nesting depth, is never returned or stored, and its
backing store becomes unreachable on return or throw. Formatter reentry gets a
separate stack. There is no async/abort boundary inside the synchronous renderer.

Existing allocations include highlight.js parser/emitter objects, HTML/entity
decode records, scope strings/regex matches, theme/highlight options, final
highlighted line arrays, Markdown layout and frame strings. The new line scanner
adds only necessary substring/style strings, no line arrays, closures, Promises,
controllers or wrapper objects. Existing theme formatter closures are created on
theme setup/cache miss, including the new interpolation mapping. The global theme
cache retains the theme, not highlighted source or a session. Unknown-language
fallbacks and read/write formatting are audited existing branches, not rewritten
as part of this token-formatting fix.

## Validation (2026-10-11)

Windows x64, Node v26.4.0. Six focused tests cover multiline strings/comments,
empty/leading/trailing lines, CRLF preservation, decoded newline entities, nested
scopes and prefix fallback, text-colored interpolation, both theme entry points,
real Markdown rendering/cache reuse, reentrant formatters and formatter throws.
The baseline reproduces the missing per-line colors and interpolation style.
The AST test rejects pools, wrapper objects, closures and temporary line arrays
in the HTML rendering chain; its sole array is the call-owned scope stack.

All 40 tests in the command below pass (six new, 34 existing), including the
global source invariant that scans scripts and the eight Markdown lexer ownership
cases. Type checking and the coding-agent build pass. No repeated local full
suite; the PR's normal Linux/Windows CI provides full-suite coverage.

```powershell
node --expose-gc --experimental-strip-types --test tests/syntax-highlight-multiline.test.ts tests/runtime-utilities.test.ts tests/source-invariants.test.ts tests/tui-frame-hot-paths.test.ts tests/alpha-markdown-ownership.test.ts
npm.cmd run check
npm.cmd run build --workspace @super-pi/coding-agent
node --expose-gc --experimental-strip-types scripts/bench/multiline-syntax-colors.ts output.json
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts
```

The same benchmark was run serially before/after production changes: 128 warmups,
1024 measured operations per case, 1 KiB Inspector sampling interval. Helper
cases isolate single-line and three-nonempty-line spans. Production cases change
a Python fenced code block through real Markdown/theme/highlight.js/Main or Alt
rendering and the frame queue, using a synchronous no-output terminal. They do
not simulate an online provider. The queue-only fixture uses 20,000 prebuilt
64 KiB frames and 1,000 warmups.

| Fixture | Baseline sampled B/operation | Candidate sampled B/operation |
| --- | ---: | ---: |
| Single-line HTML helper | 523.62 | 553.30 |
| Multiline HTML helper | 505.38 | 938.58 |
| Markdown through Main | 31796.09 | 35683.55 |
| Markdown through Alt | 27885.17 | 31231.05 |
| Queue only | 107.80 | 109.35 |

The single-line formatter count stays 1024; the multiline count rises from 1024
to 3072, exactly one per nonempty line, with zero calls for blank lines. Reopening
colors adds ANSI/style strings and downstream wrapping work; removing the pool
adds one temporary scope array per HTML render. This is a correctness fix, not
an allocation-reduction claim. Leading helper sites are scope regex matches,
stack push and formatting strings; production leaders remain `wrapTextWithAnsi`,
string repeat, highlight.js `compileLanguage` and existing final-line split/match
work. No timing improvement is inferred from one profile.

Both production cases call the highlighter exactly 1024 times and generate 1024
frames. Frame Promise/controller/wrapper/full-copy counters are zero; active and
queue high watermarks are 1, pending high watermark is 0, and queue bytes/refs are
zero after flush. One logical frame is generated per render. AST plus profiling
support the new renderer's structural claims, not a claim that the third-party
parser or all legacy formatting branches allocate nothing. Queue-only counters
also report zero closures, promises, controllers, wrappers and frame copies.

Candidate periodic peak-heap samples: Main 30.89 MB, Alt 40.27 MB (baseline
29.93 MB / 38.24 MB). These are samples, not hard peak bounds; final heaps include
saved Inspector profiles and cannot by themselves prove application retention.
The lifecycle evidence is direct: disposal clears Markdown cached lines and
all Main/Alt final-render reference counters; after the fixture owner returns,
the Markdown WeakRef is collected across eight event-loop/GC turns. The Main TUI
can still own its public component tree while the caller retains that TUI, so
collection is checked after releasing that caller-owned fixture. Formatter-owned
objects are collected after normal/reentrant rendering and throwing rendering.
There is no renderer-global state to clear on abort; exceptions unwind call-local
state, and theme callers retain their existing plaintext fallback. The unchanged
queue's failure/abort/late-event lifecycle is covered by the existing gates run
for the immediately preceding PR #106.

Raw evidence: `.git/t08-1-multiline-syntax-colors-20261011/`, including baseline and
candidate JSON profiles, queue samples and test logs. Baseline renderer SHA-256:
`7c89b50244d7c60673a814d0708ef9e8f8045aece908d98f7ab141f7b27d529d`;
candidate: `0adfd389ee41d28c3623564c42a90c2028ab6e1af4c8baa6841eb77fb28c21f0`.
Baseline theme SHA-256:
`819abb46c9b372bf178234052670bcd9ade3d219b624ea4857def36489f5fd73`;
candidate: `e9294aee1766d1a5a39b44f2d7909cf17c8c219ae2bb6f36fd16744a18667a2b`.
Candidate profiles were captured as uncommitted source on the baseline commit;
source hashes identify the measured implementation. No background services,
workers, OS terminals or theme watchers are created by these fixtures.
