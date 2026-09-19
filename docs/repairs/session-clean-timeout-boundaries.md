# Session clean, timeout, and Anthropic boundary repair

Date: 2026-09-19. Baseline: `origin/main` at `6699fb432a8be8bdf3572bcdc427de852f436dd1`. Worktree: `D:\RMProjects\Pi-session-clean-timeout-boundaries`. Branch: `fix/session-clean-timeout-boundaries`.

## A: `/memory-sessions clean`

The confirmed cause was one selector index spanning read-only file rows and actions. The initial index therefore pointed at a non-selectable file row, while Enter was presented as a general action. Detail lines were conditional, so changing focus changed the component height.

The selector now keeps independent bounded browse and action indices. The dangerous permanent-delete action cannot be the default; the default action is cancel. File rows are labelled read-only, Tab switches browse/actions, and confirmation is accepted only in the action focus. Configured keybindings provide the confirmation/cancel hints. Key release, key repeat, and bracketed paste are ignored. The detail area has a fixed bounded allocation, is recalculated with available overlay space on resize, clears stale lines, and keeps long paths inspectable. Narrow/short windows show an enlarge/cancel message and disable dangerous confirmation. The selector reuses TUI `truncateToWidth`, `wrapTextWithAnsi`, and shared key parsing.

Synthetic tests use fictional paths only. The Main and Alt TUI frame paths are exercised with 100 focus/navigation toggles; the terminal viewport and frame writes do not accumulate the full path. Existing candidate identity, lease, current-session, managed-directory, and replacement checks remain in the deletion routine. Cancelling stage two preserves the recovery file while reporting earlier index cleanup separately.

## B: Bash GNU `timeout`

GNU Coreutils documents `timeout option... duration command arg...`. This repair recognizes only the bounded subset `timeout <positive integer seconds> <literal command> <args...>`. It does not execute, probe, or rewrite the wrapped command.

Zero/dynamic durations, dynamic programs, missing operands, unknown timeout options, excessive duration, unsupported `--`, excessive nesting, and Windows `timeout.exe` are conservatively refused with a specific wrapper reason. After recognition, the real command continues through lifecycle, mutation, path, permission, dynamic execution, and final authorization checks. The supplied Bash commands are parsed as separate 250-second and 200-second subcommands; no `/d` scan ran. `2>/dev/null` is harmless diagnostic redirection; other output redirection remains mutation evidence. `find -delete`, `find -exec`, deletion commands, scripts, dynamic programs, pipelines, and nested wrappers retain conservative checks.

## C: Anthropic identity/authentication audit

Audited: `anthropic-messages.ts`, `providers/anthropic.ts`, `auth/oauth/anthropic.ts`, `auth/oauth/load.ts`, and `auth/resolve.ts`.

Previously generated identity information (now removed from the Anthropic request path):

| Information | Condition | Effect |
|---|---|---|
| `user-agent: claude-cli/<version>`, `x-app: cli` | API key string matches local `sk-ant-oat` heuristic | OAuth Messages request presents Claude CLI identity |
| Claude Code beta markers | Same OAuth condition | Couples OAuth requests to Claude Code protocol markers |
| Claude Code system text | Same condition | Prepends official-CLI identity to the system payload |
| Claude Code tool-name mapping | Same condition | Maps tools and tool results in request conversion |
| Claude subscription OAuth scopes | Built-in Anthropic OAuth login/refresh | Self-managed browser OAuth and token exchange |

Categories remain distinct: normal API/Client SDK (API key or configured provider headers), actual official Agent SDK/CLI (not evidenced here), self-managed OAuth plus Messages API simulation (the current subscription path), and other provider/proxy authentication. Using `@anthropic-ai/sdk` is Client SDK usage, not Agent SDK usage.

On 2026-09-19 the official sources were checked:

- [GNU timeout invocation](https://www.gnu.org/software/coreutils/manual/html_node/timeout-invocation.html)
- [Claude Code legal/compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude plan and Agent SDK support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

The legal page says OAuth is intended for native Anthropic applications and developers building products should use API-key authentication; the Agent SDK page distinguishes Agent SDK, CLI, Client SDK, and Managed Agents and gives the same API-key boundary. The support page says its announced subscription-credit changes are paused; it does not authorize a self-built OAuth client.

Migration guidance: use `npx @super-pi/ai login anthropic` and select API-key login, or set `ANTHROPIC_API_KEY` / pass a request-specific API key. If the application has a stored Anthropic OAuth credential, explicitly replace that provider credential through the API-key login flow before making requests. Do not copy the old OAuth token into `ANTHROPIC_API_KEY`; use a newly issued Anthropic Console API key. The old credential is retained for user-controlled cleanup and is never deleted by this repair.

After the explicit route choice, the retired subscription OAuth path is disabled locally. The old OAuth module is a tombstone that performs no browser callback, token exchange, refresh, or request. Stored OAuth credentials and history remain untouched, but resolution, login, refresh, direct `sk-ant-oat...` requests, and `ANTHROPIC_OAUTH_TOKEN` fail with a bounded migration message before network or retry work. Standard API-key requests retain normal `x-api-key` authentication, tool names and tool-call/result IDs, images, thinking, cache controls, stream handling, and supported beta headers. Explicit non-subscription proxy Bearer authentication remains available. No real credential, OAuth exchange, refresh, model request, or paid request was made.

## Verification

The focused regression `tests/session-clean-timeout-boundaries.test.ts` passes all 6 tests. It covers selector method output, Main/Alt frame delivery, 100 toggles, fixed detail bounds, timeout parsing, inner-command scanning, dangerous mutation preservation, redirections, dynamic values, Windows `timeout.exe`, and nesting.

The A/B focused regression passes all 6 tests. The C boundary regression `tests/anthropic-subscription-boundary.test.ts` passes all 5 tests and covers retired login/refresh/storage/env/direct-request paths, SDK-client default headers, no transport or retry effects, ordinary API/proxy auth, and standard Anthropic wire behavior. Final checks pass independently of PR #38 CI: `npm run check`, `npm run build:offline`, `npm run test:hot`, `npm test`, and `git diff --check`. The full suite reports no failures; Windows/POSIX signal and native-GC cases remain skipped where their existing environment gate applies.
