# Pi Browser Use

Registers one sequential `browser_exec` tool for every model. It sends one bounded Python procedure to Browser Harness CLI over stdin (`shell: false`) so navigation, waiting, extraction, and interaction can be batched without exposing many browser tools.

## Contract

- `code`: 1–4000 characters; the complete model script fits the permission preview.
- `session`: optional Browser Use cloud-session name. Local Chrome needs no cloud account.
- `timeoutMs`: 5–300 seconds; default 120 seconds.
- `purpose`: optional concise permission context.
- Browser output is untrusted and bounded to 50 KiB per stream.
- A fixed trusted prelude redirects `capture_screenshot()`'s default output to a unique file in the extension-owned session workspace and validates standard navigation calls. The model script itself remains unchanged.
- Screenshots are accepted only from that workspace, read through a bounded file handle, identity-checked, MIME-checked, and deleted with the workspace on shutdown.
- Python stdin/stdout is forced to UTF-8 so non-ASCII scripts and selectors survive Windows pipes unchanged.
- Failure summaries remain capped at 1000 characters. Python failures put the final exception first so collapsed Codemode output retains the cause, followed by bounded traceback details.
- Helpers are pre-imported synchronous functions: use `print(list_tabs())`, not top-level `await` or `browser.tabs.list()`. Call `wait_for_load()` after `new_tab`/`goto_url` before `page_info()` or DOM reads. After a failed browser script, inspect tabs before further actions; `page_info()` requires a loaded document.
- `chrome_devtools_*` may use a separate managed browser profile. Its successful connection does not prove Browser Use has connected. `tool_search` never activates these tools; the user's `/chrome-devtools enable` command or saved selection controls them. After `permission-blocked` / `BROWSER_EXEC_PERMISSION_REQUIRED`, stop for the user's instruction; do not automatically retry, reload the daemon, or switch browsers.
- The first local connection attempt displays a connection/approval notice before launching the CLI. This is guidance, not proof that Chrome displayed a prompt. Explicit setup failures carry bounded approval guidance. An old approval hint followed by a Python traceback remains a script failure; an outer deadline retains `BROWSER_EXEC_TIMEOUT` because the current approval state is unknown.
- Navigation supports absolute public HTTP(S) URLs. Local HTML preview through `file:`, `data:`, `about:` or loopback requires another registered tool that explicitly supports it. Do not inject HTML with `document.open/write` or weaken CSP/Trusted Types to work around this boundary.
- Each script should batch one coherent inspect/branch/act procedure and reacquire elements after UI rerenders; human CAPTCHA/OTP remains an explicit call boundary.
- Model Python is compiled inside the existing Browser Harness process before execution; syntax failures return a short line/column error without launching another interpreter.
- HTTP(S) literals receive a static credential/metadata/private-network check. Standard `new_tab`/`goto_url` calls also validate the actual runtime URL and resolved IPs. RFC 2544 `198.18.0.0/15` and RFC 5180 `2001:2::/48` DNS answers are accepted only for hostnames and only when an independent public probe confirms that the system resolver is operating in proxy fake-IP mode; literal fake-IP URLs and ordinary private/internal answers remain blocked. Direct navigation through `js`/`cdp` is outside that guard and prohibited by the tool contract. Browser-side redirects cannot be prevalidated, and the browser resolves hostnames again after the guard, so DNS rebinding remains an inherent check/use limitation rather than a claimed sandbox guarantee.

`resource-lifecycle-guard` provides exact one-call authorization bound to the full code, session, timeout, purpose, and tool-call ID. `full-access + never-ask` may run silently; other applicable modes retain confirmation.

The extension entry stays lightweight: browser runtime modules and permission code load on first status/execute use. Each CLI invocation is owned by one disposable runner object that clears deadlines, abort hooks, child listeners, streams, and references on completion. A measured precompile experiment was rejected because it did not improve cold startup.

## Installation

Required runtime: standalone Browser Harness 0.1.13. Install it in an isolated environment:

```text
uv tool install --python 3.12 browser-harness==0.1.13
```

The resolver accepts only `browser-harness` (`browser-harness.exe` on Windows). It checks `SP_BROWSER_HARNESS_CLI`, the managed agent bin, uv's `%USERPROFILE%/.local/bin`, the AppData uv bin, then absolute PATH entries. An override must be an absolute path to an executable with that name. Relative PATH entries and symlinked executables are rejected. There is no `browser-use` executable fallback and `SP_BROWSER_USE_CLI` is no longer read. The obsolete Browser Use CLI environment flags are not forwarded; Browser Harness's own local/cloud settings remain supported.

For an existing installation, release the old connection with `/browser-use release`, then remove the old tool with `uv tool uninstall browser-use`. Restart or `/reload` Super Pi afterward. Chrome remains open; the next new connection may request approval again.

Use `/browser-use status` after `/reload`; it reports the selected executable, not a verified Chrome connection. `/browser-use release` runs the official daemon stop command and disconnects Chrome control when no browser call is active; it does not close Chrome. `/browser-use install` only prints instructions and never installs automatically.

Local Chrome 144+ may require one Allow confirmation for each browser run or newly established debugging connection. Browser Harness 0.1.12+ keeps one pending approval per daemon name instead of replacing its connection on retries. Normal `browser_exec` calls reuse the persistent daemon and must not restart it. Super Pi still enforces the selected 5–300 second outer deadline and cancellation; on Windows its existing process-tree termination can also end a newly spawned pending daemon. This is not an unlimited approval wait. Do not automate the Chrome security prompt or edit Chrome Local State. A zero-prompt setup requires a separate automation profile launched with its own `--user-data-dir` and debugging port; it does not share the default profile's login state. Cloud authentication is optional. Local recordings are explicitly disabled unless the user opts in.

## Verification

From the repository root:

```text
node --experimental-strip-types --test --test-name-pattern="browser " tests/tool-reliability-recovery.test.ts
npm run typecheck --workspace @super-pi/browser-use
```

Official CLI health check:

```text
browser-harness --doctor
```

A failing optional cloud-auth line does not affect local Chrome when daemon and active browser connections are healthy.

### Dual-stack Fake-IP regression evidence (2026-10-15)

The affected session received complete tool instructions
and could run `list_tabs()`, including after the user approved Chrome debugging.
Navigation to Google and Remotion still failed in `_pi_check_address`, before
the browser's navigation helper ran. On the affected machine, the resolver
returned `198.18.0.89` plus `2001:2::55` for the independent probe, with similar
dual-stack answers for both target sites; the active route used the Mihomo
Meta Tunnel adapter. The IPv4-only predicate rejected the probe's IPv6 result,
disabled Fake-IP compatibility for the call, and then rejected its IPv4 target.
The IPv4-only predicate predates the recent tool-description edits; those edits'
metadata-only checks had not exercised the machine's real dual-stack resolver.

The repair adds only the IPv6 benchmark range to the existing predicate, retaining
the independent-probe requirement. [Mihomo's DNS documentation](https://wiki.metacubex.one/config/dns/)
describes separate IPv4/IPv6 Fake-IP ranges; [IANA](https://www.iana.org/assignments/iana-ipv6-special-registry)
identifies `2001:2::/48` as the IPv6 benchmarking range. Arbitrary ULA/private
networks are not treated as Fake-IP.

Validation used the actual generated Python prelude, with 15 cases in the existing
root `tool-reliability-recovery.test.ts`: public, IPv4, IPv6 and dual-stack Fake-IP;
failed/empty/non-Fake-IP/mixed-private probes; mixed-private target answers; and
literal benchmark, loopback and metadata addresses. All passed. The independent
probe runs at most once for two successful navigations in one script and zero
times for ordinary public answers or blocked literals. No target navigation runs
for rejected inputs. Set `SP_TEST_PYTHON` to the standalone Browser Harness
interpreter to run this case when it is not available as `python`.

A live-DNS stub reproduced the old refusal and accepted both target hosts after
the change. A real Browser Use call through `runBrowserUse`, its filtered
environment and the production prelude then loaded
`https://www.remotion.dev/docs/ai/skills`, returning `Agent Skills | Remotion`,
exit 0 and empty stderr. Its own target was closed by its recorded identity in
`finally`; the original target
was restored and the exact temporary workspace removed. No daemon stop, browser
update, profile/settings change or saved-session rewrite was performed. The
earlier permission-popup delay was not reproduced by this successful call.

Performance scope: admission -> runner-owned CLI process -> generated prelude ->
URL/DNS validation -> cached probe -> navigation helper. This change adds one
fixed IPv6 network value per script lifetime and one membership choice; it adds
no DNS queries, timers, subprocesses, listeners, cross-call cache or Node hot-path
state. The existing runner releases the process, streams and callbacks at exit.
Provider deltas, progress, result bounding and terminal rendering are untouched,
so unrelated allocation/full-suite runs were not repeated. Five browser-focused
checks (including the 15-case Python fixture), extension and root type checks
passed. The source-loaded extension takes effect on `/reload` or process restart.

### Chrome approval and automatic fallback repair (2026-10-15)

The same session's `tool_search("web search", limit=3)` activated both Browser
Use and Chrome DevTools. After Browser Use reported `permission-blocked` and the
user said no prompt was visible, the model called `chrome_devtools_list_pages`.
That tool can launch a separate managed Chrome profile; success there did not
resolve the original approval. Search now excludes inactive `chrome_devtools_*`
tools even for exact-name requests, while explicit user activation remains valid.
The real Codemode integration test proves the denied fallback executes zero
DevTools calls, followed by one successful explicitly enabled call.

The installed Browser Use 0.13.7 depended on Browser Harness 0.1.8. Upstream
[PR #737](https://github.com/browser-use/browser-harness/pull/737), released in
[0.1.12 and retained in 0.1.13](https://github.com/browser-use/browser-harness/releases),
fixes destruction of pending approval connections, duplicate cold starts and
the local 45-second handshake deadline. This machine now has standalone
Browser Harness 0.1.13 in its own uv environment. Following the user's explicit
request to drop old-version compatibility, the old local daemon was released
and `uv tool uninstall browser-use` removed Browser Use 0.13.7 and its five CLI
entry points. The resolver now accepts only the standalone runtime. These
mechanisms explain the session's retry/prompt churn; the exact original popup
timing was not recorded and is not claimed as a controlled before/after result.

Live verification used the production runner, filtered local environment and
generated prelude under an isolated daemon name. A read of the tab count
completed in 3,641 ms; a second read took 195 ms, with the same daemon PID
and empty stderr. The user confirmed timely approval and no second popup.
Both calls exited 0 and read three tabs. Explicit release exited 0; a subsequent
identity probe returned no daemon. No user tab was navigated or closed.

An earlier diagnostic used the wrong return shape for upstream `ipc.identify`
(integer, not object); its script failed after connection. Its named daemon was
also explicitly released and verified absent. This exposed a useful boundary:
the earlier approval notice in stderr must not override a later Python exception.
The bounded failure test now covers that case, explicit pending/rejected approval,
abort, and timeout with unknown approval state. Windows fixture path assertions
use native realpath to account for short TEMP aliases.

Performance scope: explicit tool search -> bounded active-tool catalog change;
browser invocation admission -> one connection-lifecycle notice -> unchanged
runner/stdout/stderr delivery -> terminal failure formatting. No per-chunk hook,
polling timer, Promise chain, new listener, hot-path cache or object pool was
introduced. One primitive notice flag belongs to the extension and resets on
release/shutdown. Error strings retain the 1,000-character cap; stream bounds,
runner cleanup and UI/progress implementations are unchanged. The standalone
runtime's pending connection is owned by its named daemon and official release
path. Unrelated full-suite and allocation benchmark runs are not required for
these cold-path changes.

Validation completed: ten distinct targeted checks across the existing recovery
and Codemode session test files, the root type check, both affected extension
type checks, and `git diff --check` passed. Only failed/changed cases were rerun;
no new test file or full-suite run was added. The selected executable reports
0.1.13; the global source-checkout launcher reports Super Pi 0.84.1. Both edited
extensions load source, so `/reload` or process restart activates the changes
without another full build.

The follow-up migration removes the legacy executable candidates, old override
variable and unused Browser Use CLI environment flags. The existing resolver
test now covers rejection of legacy-only managed/uv/PATH installs, both old and
misconfigured new overrides, and successful explicit standalone selection.
This reduces cold discovery candidates without adding subprocesses or version
probes per browser call. The active default local daemon was checked
by identity before official release; its endpoint was absent before uninstall.
The updated resolver regression, extension type check and diff check passed.
The production resolver selects `browser-harness.exe` reporting 0.1.13; the old
uv environment and all five executable entry points are verified absent. The
previous live approval test was not repeated for this discovery-only follow-up.

One diagnostic workspace was retained: immediate removal met Windows EBUSY,
and the later exact-path cleanup command was blocked by automatic approval
policy. No deletion workaround was attempted. Its recorded identity remains
in the local task history; it is separate from project data and browser profiles.
