# F08 — Login application name

## Design and scope

Baseline: `bf2aa4ebd843ba59ba8326a445b97fcb724c732a` (F07 / PR #127 merged).
The fixed upstream reference is [v1.1.0 auth types](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/types.ts).
Only its optional `LoginOptions.agentName` behavior is adopted.

The local browser authorization builder already accepts an originator with default `pi`,
but the provider always calls it without an argument. Neither `Models.login`,
`ModelRuntime.login`, nor the lazy OAuth wrapper forwards login options. Two offline
reproductions through the real Models/provider and ModelRuntime/provider chains returned
`pi` when given `Super Pi & 登录=fixture`. Both completed login and released their owned
ephemeral callback listeners before asserting. Evidence: `.git/f08-login-agent-name-20261012/reproduction.log`.

Add an optional fourth argument to Models/ModelRuntime login and an optional second
argument to OAuthAuth.login. The lazy wrapper forwards the same options object. Only
the Codex browser flow consumes its name, using the existing URLSearchParams encoder.
The interactive `loginProvider` command supplies `APP_TITLE` (`Super Pi`); SDK callers
that omit options retain `pi`. No device/installation ID feature is added.

The complete affected chain is explicit interactive login → ModelRuntime credential
queue → Models.login → lazyOAuth → openaiCodexOAuth.login → browser authorization URL
→ existing callback/manual-code completion → token exchange → credential persistence
and runtime synchronization. Direct SDK login enters at Models or OAuthAuth. Device code
login keeps its existing path. OAuth client ID, scopes, redirect URI, token/account
handling, extension callback compatibility, refresh, and T04.3 request headers are unchanged.

## Allocation and ownership boundary

The allocation contract was read before implementation. These functions run once per
explicit login; none runs per provider delta, tool progress, input update, render, or
terminal frame. The changed UI function is exactly `InteractiveMode.loginProvider`,
an explicit user-command boundary. No render/event handler is changed.

The UI owns one options object with one primitive string for that login. Intermediate
layers forward its reference without cloning or caching it. The existing URL builder
encodes that string once in its existing URL; no additional Promise, closure, controller,
array, queue, timer, listener, file, or pool is introduced by forwarding. Options are not
stored in credentials or provider state and become unreachable after the login operation
settles. Existing lazy-module caching retains only the OAuth implementation, not options.
Existing callback close/finally logic owns and releases the server, sockets, prompt abort
controller and listeners on completion/failure/cancellation. A hot-path allocation
benchmark is not applicable to this explicit-login-only change; no performance improvement
or whole-login zero-allocation claim is made.

## Validation

On Windows, the 22 callback/login tests pass, including the two previously failing
Models/ModelRuntime chains, legacy default, URL encoding, unchanged client/scope/redirect
and stored credential shape, device-code isolation, PKCE, cancellation, completion and
failure cleanup. The existing UI cancellation test additionally verifies that interactive
login supplies `APP_TITLE` and ignores late notifications after stop (1 selected test).
The fixtures use memory credentials, mocked token responses and real loopback servers
on owned ephemeral ports, never the user's port 1455. Release assertions verify closed
listeners, zero connections and detached abort listeners before fallback teardown.

Root typecheck, the AI offline build and coding-agent build pass. Evidence logs are in
`.git/f08-login-agent-name-20261012/`. The local full suite and unrelated allocation
benchmarks were not run. Hosted CI and Codex review are recorded in the PR and local plan;
local results do not claim Linux or real OpenAI login-screen verification.
