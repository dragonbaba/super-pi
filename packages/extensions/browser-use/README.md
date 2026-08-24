# Pi Browser Use

Registers one sequential `browser_exec` tool for every model. It sends one bounded Python procedure to Browser Use CLI 3.x over stdin (`shell: false`) so navigation, waiting, extraction, and interaction can be batched without exposing many browser tools.

## Contract

- `code`: 1–4000 characters; the complete model script fits the permission preview.
- `session`: optional Browser Use cloud-session name. Local Chrome needs no cloud account.
- `timeoutMs`: 5–300 seconds; default 120 seconds.
- `purpose`: optional concise permission context.
- Browser output is untrusted and bounded to 50 KiB per stream.
- A fixed trusted prelude only redirects `capture_screenshot()`'s default output to a unique file in the extension-owned session workspace. The model script itself remains unchanged.
- Screenshots are accepted only from that workspace, read through a bounded file handle, identity-checked, MIME-checked, and deleted with the workspace on shutdown.
- Python stdin/stdout is forced to UTF-8 so non-ASCII scripts and selectors survive Windows pipes unchanged.
- Failure summaries remain capped at 1000 characters but retain both the traceback header and final root cause.
- Each script should batch one coherent inspect/branch/act procedure and reacquire elements after UI rerenders; human CAPTCHA/OTP remains an explicit call boundary.
- Model Python is compiled inside the existing Browser Harness process before execution; syntax failures return a short line/column error without launching another interpreter.
- HTTP(S) literals receive a static credential/metadata/private-network check. Standard `new_tab`/`goto_url` calls also validate the actual runtime URL and resolved IPs. RFC 2544 `198.18.0.0/15` DNS answers are accepted only for hostnames and only when an independent public probe confirms that the system resolver is operating in proxy fake-IP mode; literal fake-IP URLs and ordinary private/internal answers remain blocked. Direct navigation through `js`/`cdp` is outside that guard and prohibited by the tool contract. Browser-side redirects cannot be prevalidated, and the browser resolves hostnames again after the guard, so DNS rebinding remains an inherent check/use limitation rather than a claimed sandbox guarantee.

`resource-lifecycle-guard` provides exact one-call authorization bound to the full code, session, timeout, purpose, and tool-call ID. `full-access + never-ask` may run silently; other applicable modes retain confirmation.

The extension entry stays lightweight: browser runtime modules and permission code load on first status/execute use. Each CLI invocation is owned by one disposable runner object that clears deadlines, abort hooks, child listeners, streams, and references on completion. A measured precompile experiment was rejected because it did not improve cold startup.

## Installation

Recommended isolated install:

```text
uv tool install --python 3.12 browser-use
```

The resolver checks `SP_BROWSER_USE_CLI`, the managed agent bin, uv's `%USERPROFILE%/.local/bin`, the legacy AppData uv bin, then absolute PATH entries. Relative PATH entries and symlinked executables are rejected.

Use `/browser-use status` after `/reload`. `/browser-use release` runs the official daemon stop command and disconnects Chrome control when no browser call is active; it does not close Chrome. `/browser-use install` only prints instructions and never installs automatically.

Local Chrome 144+ may require one Allow confirmation for each browser run or newly established debugging connection. Normal `browser_exec` calls reuse the persistent daemon and must not restart it. Do not automate the Chrome security prompt or edit Chrome Local State. A zero-prompt setup requires a separate automation profile launched with its own `--user-data-dir` and debugging port; it does not share the default profile's login state. Cloud authentication is optional. Local recordings are explicitly disabled unless the user opts in.

## Verification

From this directory:

```text
npm test
npm run typecheck
```

Official CLI health check:

```text
browser-use --doctor
```

A failing optional cloud-auth line does not affect local Chrome when daemon and active browser connections are healthy.
