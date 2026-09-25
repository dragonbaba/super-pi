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

`mutation-guard-write` consumes a non-enumerable, one-call canonical path approval attached during `tool_call`. It revalidates canonical target and violation categories immediately before edit/write. The hardened `subagent` tool similarly consumes a separate non-enumerable `subagent-workspace-delegation-v1` contract. Each single/parallel/chain task receives one exact canonical cwd grant with mode, write capability, source, Session sequence, tool-call identity, and filesystem device/inode identity; primary and identity-valid additional workspaces are eligible, while outside roots require `full-access` and follow `ask`/`never-ask`. The deeply frozen contract is not serialized into model-visible arguments, is consumed once, and is revalidated immediately before child launch. `structured_readonly_command` receives separate frozen one-call grants for its canonical cwd root and up to 16 recognizable absolute argument roots. A shared syntax-aware argv classifier excludes rg patterns and ordinary option values鈥攅ven Windows-root-looking backslash regexes鈥攚hile retaining search roots and pattern/ignore files. The grant is bound to a hash of `command + cwd + args`, so primary, added, and exact `full-access` Session boundaries apply consistently without granting ambient filesystem access or allowing post-authorization argument substitution. If this extension is absent, protected edit/write, structured read-only inspection, and subagent delegation remain fail-closed.

## Persistence and audit

`session-permission-state-v1` custom entries use a schema-v3 payload containing access mode, approval policy, at most 32 bounded exact/prefix command rules, workspace grants, and sequence. In-memory mutations are checkpointed and roll back to the last committed state if Session-entry persistence fails. Schema-v1/v2 access settings still restore; legacy structural rules are dropped because their original commands cannot be reconstructed safely. `session-permission-audit-v1` entries contain bounded categories, modes, approval policy, primitive identifiers, counts and outcomes. Audit entries do not duplicate command text, model purpose, rejection text, rule IDs, or target paths; visible command patterns exist only in the Session state required to manage the allowlist. Existing high-risk metrics continue through bounded `resource-mutation-policy-v1` entries.

## Bounded Bash support in PR #43

This is a policy analysis boundary, not a complete Bash parser or a sandbox. The submitted source runs unchanged only after lifecycle, target, permission, and final execution checks. A refusal saying that a target or shell state cannot be established does **not** assert that a dangerous operation ran or was proven to occur.

| Form | Current behavior |
| --- | --- |
| `command -v/-V` with literal or simple variable names, including finite literal `for` lists | Query semantics are distinct from bounded `command`/`exec` execution prefixes. Normal permission checks still apply. |
| Bounded literal `command`/`builtin` prefix chains | The cwd guard continues through the prefixes to the actual command. A plain nested `command ... printf` executes through the real guard; a nested `builtin` chain may still require opaque-script approval. Assignment-prefixed or otherwise unprovable `cd` chains refuse before approval and spawn, so a different path cannot be authorized. |
| `time -- [[ ... ]]` and `time -p -- [[ ... ]]` | Safe literal comparisons run as Bash tests without a spurious file-redirection classification. External output redirects still show their actual target for approval; a denied request does not spawn. Stateful expansions and process substitutions inside the test still refuse before spawn. Prefix chains whose option quote provenance exceeds the first three words, such as `! time -p -- ...`, refuse before approval and spawn. |
| Literal `bash -c -- 'script'`, one literal `eval 'script'` operand, and bounded `builtin [--] eval` | The bounded script operand is inspected before approval, including recursive Bash expansion risk. Harmless literal examples still run through the real guard. Dynamic, multi-operand or over-depth evaluation remains conservative; this is not general wrapper/evaluator support. |
| Static numeric descriptor copies such as `2>&1`, literal input-file redirection, groups and pipelines | Analyzed in source order without deleting or rewriting redirects. Output-file targets retain their normal path and permission checks. Dynamic/closed descriptors, Bash network-device input, and uncertain targets remain guarded. |
| Bare, same-shell `cd sub && operation` with a dependent operation | Accepted only when the scanner can establish the target cwd and the operation passes its own checks. The real Agent/guard/permission/Bash fixture verifies `cd sub && ls` and a dependent write. An independent later target after `cd sub;` refuses because cd itself can fail; a bounded `cd sub || exit; operation` remains supported. A separate later tool call starts from its own configured cwd. |
| `(cd sub && ls)` and a subshell `cd` followed by a parent-shell write | Currently refused before spawn when the cwd cannot be tracked. The child shell's cwd is never used to authorize a parent-shell target. Do not present the grouped form as a supported recovery. |
| `CDPATH=...; cd workspace && write`, persistent `export`/`declare`/`typeset`/`readonly CDPATH=...`, and a later `bash -c`, `timeout ... bash -c`, `eval` or command substitution using `cd` | Refused before authorization and spawn when the changed cwd lookup can reach a later direct or nested command, including inside a subshell or under `lastpipe`. The analyzer does not propagate exported `CDPATH` into nested source. `env bash -c` already receives a lifecycle launcher refusal. A closed subshell's change does not taint a later parent-shell `cd`; an assignment followed only by ordinary data output remains eligible for normal checks. |
| Conditional-predicate or nested-control `cd` (also after bounded `!`/`time` prefixes), a command substitution after a changing `cd`, `source`/`eval` followed by another command, a function or alias definition before later commands, or a trap action | Refused before authorization when the later target or shell state cannot be attributed to one cwd or the trap action cannot be inspected. This includes `EXIT` writes at shutdown and pipeline traps that may persist under `lastpipe`. A bounded standalone literal `eval 'printf ...'`, an unshadowed `trap -p DEBUG` query, harmless alias listings and the exact owned-job `EXIT` cleanup recipe remain eligible for ordinary checks; this does not imply general evaluator, function, alias or trap state propagation. |
| Literal `for`/`select` lists, simple variable queries, and single-quoted syntax text | Bounded cases remain inspectable. Assignment expansions in a list, lookup-sensitive loop variables, and loop forms whose later shell state cannot be established are refused before spawn. This does not disable all loops. |
| Ordinary expansion data; uncertain recursive evaluation; explicit shell-state changes | Ordinary data stays in its normal class. Recursive arithmetic, indirection and dynamic subscripts are a separate uncertainty class, but inherited values can execute a hidden substitution against a protected target; without bounded values and targets, the full tool path refuses them before approval even for a lone `echo`. Definite current-shell assignment or code evaluation, and unprovable cwd or target changes, also refuse. The diagnostic describes missing proof, not a confirmed dangerous operation. |
| Bare arithmetic command `(( ... ))` | Refused before authorization because it can change later executable lookup or other shell state, which this bounded analyzer does not evaluate. Quoted arithmetic-looking data and ordinary `echo $((1+2))` keep their existing behavior. |
| Lookup-sensitive assignments such as `PATH=0; cat`, final-pipeline `export PATH=0` under `lastpipe`, `let PATH=0`, `read PATH <file`, `getopts 0 PATH -0`, or `let BASH_CMDS=0; 0` | Refused before authorization when a later or same-segment executable could use changed lookup state. The full tool fixture proves synthetic `0/cat` or `0` writes protected `.git/config` before these checks and has zero approvals/spawns afterward. Bounded literal `let candidate=1`, ordinary `read`/`mapfile` destinations, and `getopts` writing an ordinary variable still run through normal permission checks. `readarray`/`mapfile` lookup destinations, nameref definitions, and uncertain arithmetic remain conservative refusals; the analyzer does not propagate their values. An indexed `BASH_CMDS[cat]=...` assignment already gets a lifecycle dynamic-executable refusal before authorization. |
| `hash` with operands before a later command, including bounded `builtin`/`command` dispatch | Refused before authorization because it can pin or clear command lookup; the analyzer does not propagate the hash table. A closed-subshell hash override is also currently refused despite its parent-shell isolation. Bare `hash` listing with a later harmless command remains eligible for ordinary checks. |
| PowerShell `echo $((1 + $null))` | The PowerShell subexpression follows its opaque-script approval path, without a Bash recursive-expansion reason. Bash scripts launched from PowerShell still receive Bash expansion checks, and recursive `Remove-Item` remains high-risk. This does not imply general cross-shell syntax equivalence. |
| `pushd`/`popd`, option-bearing/indirect or unresolved `cd`, temporary `CDPATH=... declare/typeset -p` and `export -n` prefixes before `cd`, and currently uninspectable loop structures | Deliberate limits for this round. The temporary assignment forms can be safe in Bash, but the full permission path still displays the prefix as an opaque executable rather than a proven target; they remain refused before approval. These limits are not promises of full Bash support, and changing shell or language is not an authorization bypass. |

The real-chain regressions are in `tests/shell-common-compatibility.test.ts`; they use synthetic temporary workspaces and run on Linux Bash and Windows Git Bash in required CI. Native delete/move and explicit per-call Bash/PowerShell cwd are separate future scopes, not features of PR #43.

## Resource lifecycle

Unmanaged detached/background services remain blocked unless one foreground Bash call owns cleanup and wait. Default managed Chrome screenshots and managed Chrome itself are cleaned by exact identity at `agent_settled` and `session_shutdown`.

The owned-job recipe permits up to 16 literal `curl`, `test`, `true`, `false` or `echo` use commands (4096 characters total) between installing cleanup and explicitly killing/waiting on the captured PID. Expansion, PID reassignment and arbitrary runners in this interval are unsupported; do not interpret an unsupported recipe as permission to detach or switch launchers.

Launcher-prefixed owned jobs (including env/sudo/nice/timeout and shell/multicall wrappers) are unsupported rather than inferring the effective executable from mutable launcher semantics. Recognizer acceptance is not proof against arbitrary executable behavior, aliases outside the inspected call or process forking. Existing permission policy still applies.

`wget` is excluded from owned-job use because its options/configuration can start background work outside the captured PID. Shell comments inside command substitutions are skipped when locating the actual closing delimiter.

`printf` is also excluded from the use interval: its `-v` option can overwrite the captured PID even without assignment syntax.

Command substitutions containing `case` syntax are conservatively uncertain because pattern parentheses are outside this recognizer. Shell wrappers support only a direct `-c` script operand; script files, preceding option variants and later positional `-c` tokens are not inferred safe. Bash/sh/zsh/dash/ksh/fish executable names are recognized; this does not claim complete grammar support for those shells.

### Heredoc exemption withdrawn

The experimental heredoc data-masking exemption and its coupled consumer-binding launch machinery have been removed together. The original quoted-heredoc bitwise false positive is **deferred, not solved**. Actual heredocs are conservatively uncertain on all platforms; no consumer name, inherited function or startup environment earns a data-masking exemption.

The existing bounded quote/arithmetic scanner detects heredoc operators without removing source text. Ordinary `printf` quoted text, Bash arithmetic shifts and Node expression strings no longer receive a substring-triggered launch refusal. Node remains an opaque script subject to normal permission policy. Quoted operands of supported shell wrappers are inspected as executable scripts; heredoc-looking eval operands remain uncertain. Ordinary command prefixes, spawn hooks and process ownership retain accepted-base behavior.

There is no new Windows/MSYS heredoc support, non-usrmerge support or universal bare-cat support. The withdrawn environment snapshot, callable registry and installation checks add no remaining launch allocations or I/O. Their historical profile is not evidence for a retained feature, and its automatic profile fixture has been retired. This correction makes no runtime speedup or model-token claim.

Current prefix/case/coprocess protections and bounded validation/recovery guidance remain. Timed/coprocess substitutions and case pattern ambiguity stay uncertain; quoted words remain data. The recognizer is policy evidence, not a shell sandbox or a proof of arbitrary program behavior. A refusal is not permission to switch language or launcher around policy.

### Post-merge classification compatibility

The global shell-text prefilter selects work only. Literal option-free `env`/`sudo`/`doas` operands are resolved within their own segment (`env` NAME=VALUE operands, including non-Bash names, `sudo` assignments and an initial `--` are recognized); ambiguous options, interleaved redirections, other launcher grammars and launcher-selected shells remain conservative refusals. Unrelated `sh` text does not turn a plain `env ... printenv` or `env echo` into a shell wrapper. This does not grant permission or validate arbitrary executable behavior.

Direct wrapper operands retain one layer of Bash double-quote backslash semantics, including backslash-newline removal; the mutation and permission tokenizers use the same rule. Outer dynamic expansion of wrapper/launcher operands remains uninspectable. Substitution scans distinguish termination failure from unsupported grammar without claiming the latter is syntactically complete. Permission scope stays opaque for uninspected substitutions, and independently recognized mutations remain recorded.

Bash lifecycle refusal now occurs in a side-effect-free preflight before permission interaction; lifecycle acceptance still passes through the unchanged permission controller. The verdict and approval apply only to the same captured command string; a command changed during awaited permission handling is refused without executing or automatically reauthorizing the replacement. This avoids presenting unsupported syntax as a fabricated high-risk unterminated mutation. Both guard-produced lifecycle refusal forms receive policy classification and concise recovery guidance; parser limitations are not solved by broader permissions or by moving denied work to another language/tool.

Recovery guidance for unsupported shell syntax is part of the preflight refusal itself, so immediate Agent results carry it into the next model context without post-execution transforms. For otherwise authorized diagnostics, native file creation/editing and subsequent foreground execution are separate requests with their own evidence, path, permission, and lifecycle rules. Tool/language changes cannot legalize denied behavior. The capability statement is added only when this guard is loaded. Bash timeout uses seconds (`60` is one minute); documentation does not rescale supplied values or change runtime policy.

Preflight errors retain the first actual refusal: `SHELL_DYNAMIC_EXECUTABLE`, `SHELL_HEREDOC`, `SHELL_WRAPPER`, `SHELL_SUBSTITUTION`, `SHELL_INSPECTION_LIMIT`, or `SHELL_UNINSPECTABLE`. In the loop and pipeline Chrome fixtures the first refusal is executable expansion at `$CHROME`; only a bounded simple variable name is echoed. A quoted literal path removes that inspectability problem and still requires normal checks and current authorization. Dynamic data arguments do not become executable-position errors. Only detected heredocs receive script-staging advice; wrapper/eval uncertainty does not imply a heredoc. No variable propagation, command evaluation or automatic retry is added. “Not executed” describes this Bash call, not sibling calls in the response.

### Explicit Shell cwd

Bash and PowerShell accept optional literal `cwd`, relative to the Session cwd.
The local backend resolves one canonical directory and inode identity before scope
analysis and permission matching, then rechecks the requested alias and that identity
synchronously (metadata only) immediately before spawn. No `cd` text is synthesized,
no shell expansion is performed, and Session/process cwd remains unchanged. Omission
retains the existing execution path without new directory traversal. Directory identity
checks do not provide a filesystem sandbox or an OS-level compare-and-swap.

The first implementation supports the built-in local backend. Custom/remote operations,
commandPrefix and custom spawnHook configurations reject explicit cwd before authorization;
the existing bounded built-in MSYS stdin bridge retains its verified transport semantics and cwd;
omitted cwd keeps their existing behavior. There is no local realpath claim for remote
paths. Native Windows drive paths work; `/c/...` is not translated as MSYS syntax and
`~/...` is not home expansion (a literal local directory of that spelling is allowed).
The final PowerShell transport retains its fixed UTF-8 setup prefix. Permission changes,
request substitution and detected symlink/junction or directory replacement invalidate
the old approval; they never trigger automatic reauthorization or command replay.

Invocation-owned directory bindings carry one stable final-spawn callback; authority
references are released when execution finishes. Output/progress callbacks and renderer
ownership remain unchanged. TUI shows supplied cwd and final details record the canonical
cwd. Existing #43 CDPATH query-prefix and closed-subshell hash limitations remain.


Review follow-up: terminal handoff rejects released bindings as well as replaced
bindings. A transfer-aware finally releases preparation on every permission/lifecycle
refusal or exception. Standalone tool-loop-guardrails canonicalizes explicit cwd
before project-trust/settings selection and owns cleanup even without this guard.
The authorization AST gate counts the single actual terminal consume call and its
single approved argument container, including the pinned-binding handoff; no new
per-progress/per-render allocations or caches were introduced.

Standalone repeated calls renew released bindings through the shared preparation
function; final guarded handoff still rejects a released binding within the same
authorized invocation. Explicit cwd compares canonical target and canonical trusted
Session root, preserving project settings when the workspace itself is a symlink.
Omitted cwd adds no realpath traversal. Both regressions failed before this fix.

Fresh input reuse can switch explicit cwd back to omission: preparation clears only
a previously released binding without filesystem lookup. Removing cwd from a live
binding remains an identity violation; default shell execution keeps its existing
no-binding fast path. Bash, PowerShell, standalone and guarded cases have regression
coverage, including before-fail evidence.

Explicit-cwd preparation also pins the Session root canonical path and identity
before permission awaits. The wrapper checks that root before project settings
selection, uses the pinned root for containment, and rechecks it at final spawn.
A retargeted Session alias cannot promote an outside project's shell settings.
The permission controller also compares this root to its established primary grant.
Omitted-cwd rule scope reuses that grant's canonical string without extra filesystem
work, while command analysis and execution retain their previous omitted-cwd path.
Known legacy Session-root rule spellings remain compatible; target/scope checks
still precede rule matching. Alias regressions cover exact and prefix rule reuse.
