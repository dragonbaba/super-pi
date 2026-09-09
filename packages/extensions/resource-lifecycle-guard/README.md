# Session permission and resource lifecycle guard

Existing Pi 0.84.x safety extension. It owns Session filesystem permission state, Bash/script preflight, and exact cleanup of agent-owned browser resources. It does not override `edit`, `write`, or `bash`.

## Two-axis Session model

Filesystem access scope remains independent from approval behavior:

- `read-only`: only read-only operations fit the active scope.
- `workspace-write` (default): statically bounded operations fit the scope only inside the primary or explicitly added workspaces.
- `full-access`: statically bounded operations may target any canonical path.

Approval policy is selected separately:

- `ask` (default): operations outside the active scope, high-risk operations, and opaque scripts require a user decision. A Bash approval may optionally add the exact command or an explicit command prefix to the current Session allowlist.
- `never-ask`: known operations inside the active scope proceed without a dialog. In TUI mode, unknown, opaque, or high-risk commands still ask instead of being rejected automatically; headless modes fail closed when confirmation is unavailable.

All modes and policies can be switched at any time with the existing `/permissions` command and persist on the active Session branch. In interactive use it is one continuous two-stage wizard: first select one of the three access scopes, then select `ask`, `never-ask`, or Session-rule management. A normal scope+policy choice is persisted once; cancelling stage two or returning from nested rule management leaves both axes unchanged. A new Session starts in `workspace-write + ask`. `/add_workspace <path>` and `/remove_workspace <same-path>` manage at most 16 existing canonical directory grants. Each grant stores requested path, canonical path, and filesystem identity; symlink/junction or directory identity drift invalidates authorization.

The footer shows scope, approval policy, workspace count, and rule count. `/permissions status` reports the complete state.

## Session command allowlist and rejection feedback

In `ask` mode, a Bash permission dialog offers `allow once`, add the exact current command, or add the visible executable prefix such as `bun *`. Exact rules compare the trimmed complete command. Prefix rules require a whitespace token boundary, so `bun *` matches `bun run typecheck` but not `bundle` or `bunx`. A matching rule is an explicit Session authorization: it remains effective after switching access mode or approval policy and does not ask again. Rules are not created while the approval policy is `never-ask`.

`/permissions rules`, `/permissions add-rule <exact|prefix> <command>`, `/permissions remove-rule <id>`, and `/permissions clear-rules` manage at most 32 rules. The TUI management screen can also add, remove, or clear rules. IDs are deterministic SHA-256 values; removal accepts a full ID or unique prefix. Rules and their visible bounded command patterns exist only on the active Session branch.

The dialog displays any optional model purpose, exact canonical targets, and the bounded command. Missing purpose does not create a failed preflight. The user may allow once, create an eligible Session command rule, switch an eligible access mode and allow, reject, or reject with a bounded free-form reason. An unchanged rejected request is blocked without another dialog.

TUI and RPC use Pi's structured `select` and `input` protocol. Dialogs have no automatic timeout and wait for an explicit choice or manual cancellation. Print/JSON modes fail closed whenever confirmation is required; a matching Session rule or a known in-scope `never-ask` operation remains non-interactive. A static `workspace_escape` blocked only by scope or unavailable confirmation names the legal `/add_workspace` or `/permissions` route and forbids Bash/script bypasses. Explicit rejection, unchanged rejection, cancellation, and unverifiable targets never advertise alternate authorization.

## High-risk and script policy

A bounded quote/escape/command-boundary parser recognizes recursive deletion, PowerShell/Windows deletion, Python/Node deletion calls, `find -delete`, `xargs rm`, `git clean -fd`, and `git reset --hard`. Dynamic destructive targets fail closed before UI. Exact high-risk operations follow the selected approval policy and may use an exact Session rule.

A second conservative classifier distinguishes strict read-only shell commands, ordinary statically bounded mutation commands, and opaque runners/scripts. It emits bounded classes such as `runner:npm:test`, `git:commit`, and `wrapper:bash` without retaining arguments or secrets. Opaque scripts follow the selected approval policy and access scope. Quoted query text and documentation examples are not interpreted as execution.

`mutation-guard-write` consumes a non-enumerable, one-call canonical path approval attached during `tool_call`. It revalidates canonical target and violation categories immediately before edit/write. The hardened `subagent` tool similarly consumes a separate non-enumerable `subagent-workspace-delegation-v1` contract. Each single/parallel/chain task receives one exact canonical cwd grant with mode, write capability, source, Session sequence, tool-call identity, and filesystem device/inode identity; primary and identity-valid additional workspaces are eligible, while outside roots require `full-access` and follow `ask`/`never-ask`. The deeply frozen contract is not serialized into model-visible arguments, is consumed once, and is revalidated immediately before child launch. `structured_readonly_command` receives separate frozen one-call grants for its canonical cwd root and up to 16 recognizable absolute argument roots. A shared syntax-aware argv classifier excludes rg patterns and ordinary option values—even Windows-root-looking backslash regexes—while retaining search roots and pattern/ignore files. The grant is bound to a hash of `command + cwd + args`, so primary, added, and exact `full-access` Session boundaries apply consistently without granting ambient filesystem access or allowing post-authorization argument substitution. If this extension is absent, protected edit/write, structured read-only inspection, and subagent delegation remain fail-closed.

## Persistence and audit

`session-permission-state-v1` custom entries use a schema-v3 payload containing access mode, approval policy, at most 32 bounded exact/prefix command rules, workspace grants, and sequence. In-memory mutations are checkpointed and roll back to the last committed state if Session-entry persistence fails. Schema-v1/v2 access settings still restore; legacy structural rules are dropped because their original commands cannot be reconstructed safely. `session-permission-audit-v1` entries contain bounded categories, modes, approval policy, primitive identifiers, counts and outcomes. Audit entries do not duplicate command text, model purpose, rejection text, rule IDs, or target paths; visible command patterns exist only in the Session state required to manage the allowlist. Existing high-risk metrics continue through bounded `resource-mutation-policy-v1` entries.

## Resource lifecycle

Unmanaged detached/background services remain blocked unless one foreground Bash call owns cleanup and wait. Default managed Chrome screenshots and managed Chrome itself are cleaned by exact identity at `agent_settled` and `session_shutdown`.

Literal quoted heredoc bodies are data; unquoted bodies still expose executable substitutions to the bounded lifecycle recognizer. Unsupported delimiters, line folding and shell wrappers are explicitly uncertain. Merely mentioning `wait`, `kill` or `trap` does not establish ownership: the recognized simple background recipe binds `$!` to the same PID used by its EXIT cleanup and wait. Detached services and opaque Node/Python background wrappers remain blocked. This classifier is evidence for policy, not a process sandbox.

The owned-job recipe permits up to 16 literal `curl`, `test`, `true`, `false` or `echo` use commands (4096 characters total) between installing cleanup and explicitly killing/waiting on the captured PID. Expansion, PID reassignment and arbitrary runners in this interval are unsupported; do not interpret an unsupported recipe as permission to detach or switch launchers.

Body masking is limited to literal `cat` data-consumer headers. Evaluator stdin, compound/multiline substitution headers and unsupported consumers are uncertain and rejected rather than having executable input silently removed. Arithmetic shifts remain expression syntax; substitutions inside arithmetic are still inspected.

The supported data-only heredoc is a standalone literal cat call (multiple bodies on that call are supported). Preceding executable setup/overrides and subsequent staged execution are uncertain: this recognizer does not prove the lifecycle of generated shell, JavaScript or Python programs. Submit independently authorized operations through their appropriate registered tools; uncertainty is not permission to switch launchers around a denial. Bare and expanded arithmetic contexts are recognized without treating shifts as redirections.

Launcher-prefixed owned jobs (including env/sudo/nice/timeout and shell/multicall wrappers) are unsupported rather than inferring the effective executable from mutable launcher semantics. Recognizer acceptance is not proof against arbitrary executable behavior, aliases outside the inspected call or process forking. Existing permission policy still applies.

`wget` is excluded from owned-job use because its options/configuration can start background work outside the captured PID. Shell comments inside command substitutions are skipped when locating the actual closing delimiter.

`printf` is also excluded from the use interval: its `-v` option can overwrite the captured PID even without assignment syntax.

Command substitutions containing `case` syntax are conservatively uncertain because pattern parentheses are outside this recognizer. Shell wrappers support only a direct `-c` script operand; script files, preceding option variants and later positional `-c` tokens are not inferred safe. Bash/sh/zsh/dash/ksh/fish executable names are recognized; this does not claim complete grammar support for those shells.


### Execution-bound heredoc limitation

The recognizer's data classification is provisional. The built-in local Bash launch now checks the final command/cwd after configured prefixes and spawn hooks, pins its local execution callable, and privately snapshots the effective environment. A command containing `<<` must fit the supported launch below; nested commands, arithmetic/string lookalikes and other ambiguous forms are conservatively refused at execution, even when syntax inspection alone permits them. This restriction does not broaden permission: the full original request still goes through normal approval.

The supported route is one standalone quoted literal `cat` heredoc on native Linux with a merged-`/usr` installation and standard `/bin/bash` or `/usr/bin/bash`, a direct `-c` invocation, and `/bin/cat` or `/usr/bin/cat` resolving to the trusted system installation. Bare `cat` additionally requires `/bin` or `/usr/bin` first in the captured PATH; the ordinary application-added bin directory can therefore make bare `cat` unsupported. Multiple bodies, unquoted delimiters, output redirects, extra arguments, command/cwd transformations, custom backends and Windows/MSYS nested-shell transport are refused. Existing syntax tests do not imply execution support for those forms.

Inherited exported functions and applicable startup/loader inputs are rejected without opening or executing a startup file. The child receives the private validated environment, never a later reconstruction from the parent. No parent environment, global PATH or startup configuration is changed. Two targeted realpath calls and five stat calls check the root-owned, non-group/other-writable standard shell/utility installation; there is no probe process or content hash. The trust root is the host-approved installation, not executable attestation or a sandbox against compromised OS components, hostile in-process extensions or privileged concurrent replacement.

Call-owned environment metadata is bounded to 1024 entries and 256 Ki code units, then released with the existing process lifecycle. Ordinary commands without `<<` do not take this snapshot or perform the installation checks. A refused form must be resolved within the existing policy; another language or launcher is not permission to evade the refusal.

Separate non-usrmerge `/bin` installations remain unsupported in this deliberately narrow slice, even if host approved. Assignment/redirection prefixes before a shell wrapper are uncertain, rather than skipping them and hiding its executable operand.
