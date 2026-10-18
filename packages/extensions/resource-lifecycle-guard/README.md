# Session permission and resource lifecycle guard

Existing Pi 0.84.x safety extension. It owns Session filesystem permission state, Bash/script preflight, and exact cleanup of agent-owned browser resources. It does not override `edit`, `write`, or `bash`.

## Threat model and maintenance scope

This guard helps prevent accidental deletion and unmanaged background processes in ordinary model-generated commands, such as direct `rm -rf`, `shutil.rmtree(x)`, `fs.rmSync(x, {recursive:true})`, `&` and `nohup`. Body inspection is a best-effort denylist for preventing mistakes, **not an adversarial security boundary**. Admission does not establish that a program is safe. Policy has three outcomes: allow, ask, or deny. Denial is reserved for known catastrophic targets, an unchanged user-rejected request, recognized unmanaged launches when session background management is available, and the PowerShell native-tool routing hint. Parser uncertainty is not a denial.

For example, `python3 script.py` can run in full-access even though this guard does not inspect the script file. Inline and heredoc checks likewise cannot establish the behavior of arbitrary code. D3 sends unrecognized scripts to permission-mode handling: workspace-write asks and full-access permits when no independent recognized violation applies. OS sandboxing and process containment, including Windows Job Objects, are tracked separately in [issue #163](https://github.com/dragonbaba/super-pi/issues/163); extending this text scanner cannot provide that isolation.

Further recognition work is limited to missed ordinary commands and false refusals of normal commands. Additional escape, Unicode, concatenation, alias, dynamic-evaluation, descriptor and path-normalization variants are accepted limits, recorded in [issue #161](https://github.com/dragonbaba/super-pi/issues/161), rather than new parsing work or repeated scope questions. Existing bounded recognition remains as documented below; it is not a promise to cover all equivalent spellings.

In particular, same-command descriptor heredocs such as `python3 /proc/thread-self/fd/3 3<<'EOF'`, persistent descriptors, `/proc/*/fd` paths, redundant separators/dot components, symlinks and relative descriptor paths are not comprehensively modeled. The existing exact descriptor checks remain, without adding path normalization or a blanket non-stdin-heredoc refusal. Backslash-newline variants within Bash function-substitution or prompt-transform syntax also remain outside the recognized forms. These limits can differ from main's blanket refusals; they are accepted under this threat model.

Regression tests are organized by behavior. Keep one representative per distinct implementation path plus a harmless control; run both permission modes only when the expected result differs. Do not add spelling × interpreter × mode matrices for the accepted limits.

## Two-axis Session model

Filesystem access scope remains independent from approval behavior:

- `read-only`: only read-only operations fit the active scope.
- `workspace-write` (default): statically bounded operations fit the scope only inside the primary or explicitly added workspaces.
- `full-access`: statically bounded operations may target any canonical path.

Approval policy is selected separately:

- `ask` (default): operations outside the active scope, high-risk operations, and opaque scripts require a user decision. A Bash approval may optionally add the exact command or an explicit command prefix to the current Session allowlist.
- `never-ask`: in-scope known operations proceed without a dialog. In `full-access`, this includes known non-catastrophic high-risk operations and opaque scripts. High-risk requests with uncertain targets still require a one-time decision in every mode. Headless requests that need a decision return `confirmation_required`.

All modes and policies can be switched at any time with the existing `/permissions` command and persist on the active Session branch. In interactive use it is one continuous two-stage wizard: first select one of the three access scopes, then select `ask`, `never-ask`, or Session-rule management. A normal scope+policy choice is persisted once; cancelling stage two or returning from nested rule management leaves both axes unchanged. A new Session starts in `workspace-write + ask`. `/add_workspace <path>` and `/remove_workspace <same-path>` manage at most 16 existing canonical directory grants. Each grant stores requested path, canonical path, and filesystem identity; symlink/junction or directory identity drift invalidates authorization.

The footer shows scope, approval policy, workspace count, and rule count. `/permissions status` reports the complete state.

## Session command allowlist and rejection feedback

In `ask` mode, a shell permission dialog offers `allow once`, add the exact current command, and an eligible command prefix. Non-high-risk opaque commands can offer and match prefix rules; high-risk commands can only use exact rules. Exact rules compare the trimmed complete command. Prefix rules require a whitespace token boundary and never match compound shell syntax (`COMMAND_COMPOUND_SYNTAX_PATTERN`). For example, `npm test *` matches `npm test -- --watch=false`, and `npm run *` matches both `npm run lint` and `npm run build`, but neither `npm install lodash` nor `npm run build && rm -rf x` matches `npm run *`. A matching rule is an explicit Session authorization within its existing access, backend and cwd scope, and remains effective after switching approval policy. The approval dialog does not create rules under `never-ask`.

Suggested prefixes use the first two words for `git`, `npm`, `pnpm`, `yarn`, `bun`, `cargo`, `go`, `dotnet`, `uv`, `pip`, `docker` and `kubectl`, retaining the existing requirement for a literal subcommand rather than an option. Other tools use their executable name: approving `make *` also covers `make test`; `pytest`, `tsc`, `jest` and `vitest` work the same way. The dialog does not suggest prefixes for `bash`, `sh`, `zsh`, `pwsh`, `powershell`, `python*`, `node`, `deno`, `ruby`, `perl`, `sudo`, `doas`, `env`, `xargs`, `timeout`, `nice`, `npx`, `bunx`, `pnpx`, `uvx` or `pipx`. This restriction applies only to suggestions: manually adding `/permissions add-rule prefix python3 *` permits `python3 b.py`, while a recognized high-risk command such as `python3 -c "import shutil; shutil.rmtree('x')"` still requires approval. `rm -rf node_modules` likewise has no prefix option. Rule persistence and its schema are unchanged.

`/permissions rules`, `/permissions add-rule <exact|prefix> <command>`, `/permissions remove-rule <id>`, and `/permissions clear-rules` manage at most 32 rules. The TUI management screen can also add, remove, or clear rules. IDs are deterministic SHA-256 values; removal accepts a full ID or unique prefix. Rules and their visible bounded command patterns exist only on the active Session branch.

The dialog displays any optional model purpose, exact canonical targets, and the bounded command. Missing purpose does not create a failed preflight. The user may allow once, create an eligible Session command rule, switch an eligible access mode and allow, reject, or reject with a bounded free-form reason. An unchanged rejected request is blocked without another dialog.

TUI and RPC use Pi's structured `select` and `input` protocol. Dialogs have no automatic timeout and wait for an explicit choice or manual cancellation. Print/JSON modes fail closed whenever confirmation is required; a matching Session rule or a known in-scope `never-ask` operation remains non-interactive. A static `workspace_escape` blocked only by scope or unavailable confirmation names the legal `/add_workspace` or `/permissions` route and forbids Bash/script bypasses. Explicit rejection, unchanged rejection and cancellation do not advertise alternate authorization. Uncertain targets require a one-time decision.

## High-risk and script policy

A bounded quote/escape/command-boundary parser recognizes recursive deletion, PowerShell/Windows deletion, Python/Node deletion calls, `find -delete`, `xargs rm`, `git clean -fd`, and `git reset --hard`. Catastrophic root checks apply to operands themselves being deleted or moved: filesystem roots, HOME, the primary and registered workspace roots, their `.git` and `.sp` roots, or a canonical operand containing any of those roots. These are denied before allow-rule or approval-policy handling. Descendant files such as `.git/config` retain high-risk approval handling. The same root rule covers native `delete`, `move` and destructive `file_batch` items; their parent-directory access is not itself deletion. Ordinary `mv`/`move` into an existing directory adds a child without replacing that root; rename operands retain root checks. Batch dry-run remains a preview.

Content scopes are not operands being removed. `workspaceWide` keeps `git reset --hard` and `git clean -fd`/`-fdx` high risk without declaring the workspace root deleted. A `find -delete` search scope is denied only when it is the filesystem root, equals or contains HOME, or is equal to or inside a workspace `.git`/`.sp` root. Searching the workspace root or an ordinary child directory follows normal high-risk policy: F allows, W asks. These distinctions reuse existing bounded scan evidence without new parsing or another command scan.

The existing Remove-Item operand walk also supplies root checks without `-Recurse`: `.git` can be a worktree pointer file. Ordinary non-root operands retain F allow / W ask.

Unknown targets (variables, `~user`, intermediate wildcards, over 16 targets, uninspected move options or an unverifiable target assessment) always ask, including `full-access + never-ask`. Move option grammar is not expanded: source/destination roles are uncertain when options have not been interpreted. The only choices are **allow once**, **reject**, and **reject with a reason**. No exact/prefix rule can match these requests, and the dialog cannot create a rule or switch modes. Allowing once does not suppress the next question; rejecting remembers the unchanged request. With no UI, the result is `confirmation_required`.

An unquoted leading `~` or `~/...` resolves to HOME. An unquoted wildcard (`*`, `?`, `[`) only in the last path segment is bounded by its parent directory: `./out/*` targets `./out`, while `~/*` targets HOME and is denied. Other dynamic forms remain uncertain. Known non-catastrophic high-risk requests still follow the selected approval policy and may use an exact Session rule.

A second conservative classifier distinguishes strict read-only shell commands, ordinary statically bounded mutation commands, and opaque runners/scripts. It emits bounded classes such as `runner:npm:test`, `git:commit`, and `wrapper:bash` without retaining arguments or secrets. Opaque scripts follow the selected approval policy and access scope. Quoted query text and documentation examples are not interpreted as execution.

`mutation-guard-write` consumes a non-enumerable, one-call canonical path approval attached during `tool_call`. It revalidates canonical target and violation categories immediately before edit/write. The hardened `subagent` tool similarly consumes a separate non-enumerable `subagent-workspace-delegation-v1` contract. Each single/parallel/chain task receives one exact canonical cwd grant with mode, write capability, source, Session sequence, tool-call identity, and filesystem device/inode identity; primary and identity-valid additional workspaces are eligible, while outside roots require `full-access` and follow `ask`/`never-ask`. The deeply frozen contract is not serialized into model-visible arguments, is consumed once, and is revalidated immediately before child launch. `structured_readonly_command` receives separate frozen one-call grants for its canonical cwd root and up to 16 recognizable absolute argument roots. A shared syntax-aware argv classifier excludes rg patterns and ordinary option values鈥攅ven Windows-root-looking backslash regexes鈥攚hile retaining search roots and pattern/ignore files. The grant is bound to a hash of `command + cwd + args`, so primary, added, and exact `full-access` Session boundaries apply consistently without granting ambient filesystem access or allowing post-authorization argument substitution. If this extension is absent, protected edit/write, structured read-only inspection, and subagent delegation remain fail-closed.

## Persistence and audit

`session-permission-state-v1` custom entries use a schema-v3 payload containing access mode, approval policy, at most 32 bounded exact/prefix command rules, workspace grants, and sequence. In-memory mutations are checkpointed and roll back to the last committed state if Session-entry persistence fails. Schema-v1/v2 access settings still restore; legacy structural rules are dropped because their original commands cannot be reconstructed safely. `session-permission-audit-v1` entries contain bounded categories, modes, approval policy, primitive identifiers, counts and outcomes. Audit entries do not duplicate command text, model purpose, rejection text, rule IDs, or target paths; visible command patterns exist only in the Session state required to manage the allowlist. Existing high-risk metrics continue through bounded `resource-mutation-policy-v1` entries.

## Bounded inspection and PR1 acceptance

The existing analyzers retain their bounded recognition; PR1 adds no interpreter, alias, descriptor or general expansion evaluator. Lifecycle diagnostics for heredocs, substitutions, unsupported shell wrappers, dynamic executables, uncertain structure and inspection limits are passed to authorization as `opaqueScript`. PowerShell uncertainty follows the same rule. Visible recognized deletions still receive target checks. A supported literal body may be inspected recursively; an uninspected body is not evidence of safety.

One `ShellAnalysisOwner` shares existing heredoc/substitution views across lifecycle, mutation and permission checks. It retains at most 128 entries and 512 KiB of analysis references, checks command/cwd/permission generation, and releases the views on success, denial, cancellation and exceptions. PR1 adds no repeated full-command scan or object pool. The guard is outside the hot-path list; no allocation benchmark is required.

The representative table is exercised by one table-driven test in `tests/guard-relax-1-ask.test.ts`. F = `full-access + never-ask`; W = `workspace-write + ask`.

| Request | F | W |
| --- | --- | --- |
| `rm -rf /`, `~`, `~/*`, `.`, `./*`, `..`, `.git`, `sub/../.git`, absolute HOME | Deny | Deny |
| `rm -rf ~/.cache/foo`, `rm -rf /tmp/x` | Allow | Ask |
| `rm -rf ./out/*`, `rm -rf node_modules`, `rm -rf dist build` | Allow | Ask |
| `git reset --hard HEAD~1`, `git clean -fd`, `git clean -fdx`, `find . -name '*.log' -delete` | Allow | Ask |
| `find .git -name x -delete`, `find / -name x -delete`, `find ~ -name x -delete` | Deny | Deny |
| `rm -rf ./*`, `rm -rf .`, `rename git moved .git`, `mv .git/* /tmp/x` | Deny | Deny |
| `Remove-Item .git` where `.git` is a worktree pointer file | Deny | Deny |
| `printf x > out; mv .git moved` (combined existing scan evidence) | Deny | Deny |
| `printf x > .git; rm -rf out` (write and deletion retain separate targets) | Allow | Ask |
| `mv /tmp/report .` (existing destination directory receives a child) | Allow | Ask |
| `mv --target-directory=/tmp .git` (uninspected move options) | Ask once only | Ask once only |
| `rm -rf .git` with explicit cwd in an added workspace | Deny | Deny |
| `rm -rf $BUILD_DIR`, `rm -rf "$TMPDIR/foo"`, `rm -rf "$HOME"`, `rm -rf */node_modules` | Ask once only | Ask once only |
| `bash scripts/build.sh`, `sh -x scripts/build.sh`, `$CMD --version` | Allow | Ask |
| Expanded Bash heredoc containing `$X`; command exceeding inspection length | Allow | Ask |
| `git status && git diff`, `ls -la` | Allow | Allow |
| No UI: `rm -rf $BUILD_DIR` | confirmation_required | confirmation_required |

The same test covers PowerShell, native destructive operations, repeated one-time approval, rejection memory and a manually installed exact rule. Existing R0 F-S1/S4 admission assertions remain unchanged. Unusual-spelling findings remain accepted boundaries under [#161](https://github.com/dragonbaba/super-pi/issues/161), without parsing fixes or additional spelling matrices.

## Resource lifecycle

Docker detached containers and system-managed services follow ordinary opaque-command permissions: F allows, W asks. They are owned by Docker or the service manager, so they do not trigger unmanaged-process refusals. This includes the existing Bash docker/service/pm2 cases and PowerShell's systemctl and service-cmdlet paths; their lifecycle-only special parsing has been removed.

Raw `&`, `nohup`, `setsid`, `disown`, and Start-Process without literal `-Wait` retain lifecycle evidence. When the existing background manager can offer live TUI/RPC control through the registered `tasks` tool, they are refused with one line: remove `&` or the detaching launcher, set `background: true` with explicit `cwd`. Without that capability (print/JSON/headless, missing or conflicting tasks tool), the same evidence becomes opaque permission input: F allows; W asks if a UI is present, otherwise returns `confirmation_required`. Missing tasks alone does not remove an existing UI. Catastrophic targets and native PowerShell routing still take precedence.

The `background: true` managed path, its availability checks, process ownership, timeout, cancellation and cleanup are unchanged. Submit the foreground command with explicit `cwd`, and use `tasks` to observe completion or cancel. Default managed Chrome screenshots and managed Chrome itself are cleaned by exact identity at `agent_settled` and `session_shutdown`.

PR3 uses one representative table-driven test in `tests/guard-relax-3-lifecycle.test.ts`; commands are authorization inputs, and the managed row runs a controlled in-memory executor. Existing background-shell integration tests retain real managed-process coverage. F/W have the same definitions as above.

| Request / environment | F | W |
| --- | --- | --- |
| `docker run -d nginx`, `docker compose up -d`, `systemctl restart nginx` | Allow | Ask |
| `npm run dev &`, `nohup node s.js > log 2>&1 &`; live TUI with tasks | Deny with one-line `background: true` guidance | Deny |
| Same raw launches; print/JSON/headless with or without tasks | Allow | confirmation_required |
| Same raw launches; TUI without tasks | Allow | Ask |
| `npm run dev` with `background: true` and explicit cwd; live TUI with tasks | Managed execution | Managed execution after approval |

The table also covers existing service/PowerShell paths, RPC, catastrophic deletion and native-tool routing. It adds no syntax grammar or command-wide scan and reuses `ShellAnalysisOwner`. R0's obsolete Docker-denial control is separately migrated to `setsid` with real tasks availability; all refusal assertions and F-S1/S4 remain intact.

The owned-job recipe permits up to 16 literal `curl`, `test`, `true`, `false` or `echo` use commands (4096 characters total) between installing cleanup and explicitly killing/waiting on the captured PID. Expansion, PID reassignment and arbitrary runners in this interval are unsupported; do not interpret an unsupported recipe as permission to detach or switch launchers.

Launcher-prefixed owned jobs (including env/sudo/nice/timeout and shell/multicall wrappers) are unsupported rather than inferring the effective executable from mutable launcher semantics. Recognizer acceptance is not proof against arbitrary executable behavior, aliases outside the inspected call or process forking. Existing permission policy still applies.

`wget` is excluded from owned-job use because its options/configuration can start background work outside the captured PID. Shell comments inside command substitutions are skipped when locating the actual closing delimiter.

`printf` is also excluded from the use interval: its `-v` option can overwrite the captured PID even without assignment syntax.

Command substitutions containing `case` syntax are conservatively uncertain because pattern parentheses are outside this recognizer. Shell wrappers support only a direct `-c` script operand; script files, preceding option variants and later positional `-c` tokens are not inferred safe. Bash/sh/zsh/dash/ksh/fish executable names are recognized; this does not claim complete grammar support for those shells.

### Bounded input and transport

Bash heredocs use the unchanged local transport, including the existing Windows MSYS bridge. Custom backends, command prefixes and arbitrary spawn hooks retain their transport constraints; those are separate from resource-lifecycle policy. The original command/body is executed unchanged after authorization. Parser bounds remain 128 KiB, 64 segments, 16 substitutions and four nesting levels; exhaustion produces opacity, not a policy veto.

Literal Shell/Node/Python input retains existing best-effort inspection. Unsupported wrappers, `eval`/trap operands, descriptor provenance, arithmetic, aliases, interpolation and transformed or expanded input follow opaque permissions unless an independently recognized mutation requires target approval or a known lifecycle violation applies. No new recognition is added for the accepted limits in #161.

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
cwd. The bounded CDPATH query-prefix and closed-subshell hash forms above now pass
their actual Bash and default SDK guard paths; broader state changes remain limited.


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

Session tree/branch restore revalidates the existing primary grant rather than
replacing its trusted identity. If restoration fails, the controller invalidates
current authority and refuses guarded calls until a successful identity-preserving
restore. A caught session event error cannot silently enable the replacement root.
Opening a different physical workspace requires a fresh permission/trust owner.


Permission restoration becomes usable only after status publication succeeds.
File-backed SettingsManager ownership pins the trusted project's physical identity
across extension rebuilds; reload rejects root replacement before loading project
settings, packages or extensions. Trust toggling on the same owner cannot replace
that pin. Custom and in-memory settings stores retain their existing behavior.
Explicit cwd validates both root and target before selecting shell settings, and
uses an invocation-owned Bash definition so a failed call cannot poison the
omitted-cwd definition cache. Final spawn still performs the identity check.
These checks run at invocation/reload boundaries, not on output or render updates.


File settings pin the root even while initially untrusted, before any trust UI wait.
Explicit-cwd consumers request identity revalidation from the persistent Session
trust owner via `ctx.isProjectTrusted(true)`, including standalone scoped Bash
without the permission extension. Default boolean queries and omitted cwd retain
their no-traversal behavior. Definition argument preparation receives the optional
Session context before permission hooks, so project command prefixes unsupported
with explicit cwd refuse before an approval or allow-rule change. These are bounded
invocation/startup operations; no progress/render callback or regex was added.

A memory/custom settings store without an identity assertion retains its ordinary
trust boolean, but explicit identity-revalidated queries return false. Such a
store cannot promote newly read on-disk project shell settings as trusted.

### Native PowerShell and failure summaries (2026-10-15)

Native `powershell` uses a bounded preflight for explicit lifecycle syntax before
normal authorization. Assignments, types, ordinary member calls, dynamic data and
compilation are not Bash executable positions and are not rejected simply because
they can carry code. The previous review iteration incorrectly grew capability,
provider and member-name blacklists; those rules have been removed. In particular,
Add-Type compilation, COM/reflection metadata, New-Object data, provider cmdlet
values and intrinsic ForEach dispatch retain ordinary permission classification.
A method named Start may be Stopwatch.Start; its name does not establish a process
launch. Native start.exe/cp.exe are not the start/cp PowerShell aliases.

The preflight retains explicit Start-Job/thread-job/scheduled-task checks,
trailing background `&`, owned Start-Process Wait checks, and cmdlet-specific AsJob,
BITS Asynchronous/Suspended and literal WhatIf behavior. Nested expressions and
script blocks within its supported grammar receive the same bounded token walk.
Quoted flags, filenames after redirection, native executable arguments and data
containing equals signs do not become cmdlet switches. Literal Bash operands still
use the existing Bash lifecycle inspection. Parameter prefixes and colon-separated
native boolean literals are checked against the relevant cmdlet metadata.

Boundary follow-up: opaque string subexpressions, here-strings and indirect call
targets no longer end inspection of the remaining command. Bounded delimiter
scans retain the following statement; quoted and indexed assignment targets keep
the right-hand command position, and attribute argument lists preserve declaration
context before param(). Native AST checks confirm the reported forms are valid;
ordinary counterparts remain accepted. Invoke-Command/icm and Invoke-WmiMethod/iwmi
check their own AsJob option against native 5.1/7.6 parameter metadata, without
banning their foreground forms. System-managed services now follow normal opaque
permissions. No service or remote job was run. Attribute boundaries retain their argument tokens so literal
ValidateScript bodies receive ordinary lifecycle inspection; the same bounded
primitive stack is reused for lexical attribute ends and expression contexts.
Invoke-Command also checks InDisconnectedSession and its Disconnected alias/prefixes
using native parameter metadata; literal false stays foreground. No blanket ban on
attributes, remote-command types or member names is introduced. The independent
legacy high-risk scanner may require one-time approval for some validation-attribute declarations;
lifecycle acceptance is not evidence of whole-chain acceptance for those forms.
Attribute argument names remain metadata; only their script-block bodies enter
command position. A harmless custom attribute with a Start property confirms the
distinction on native 5.1/7.6. Native parameter binding also confirms that a
backtick touching -As/-InDis before a newline stays in the parameter name and
fails binding; it must not be normalized into an async switch. Ordinary spaced
line continuations already preserve the native switch and remain covered.
Literal flat cmd /c start retains its lifecycle evidence, accepting
its own /wait before the program but not a title, directory or program argument
spelled /wait. Plain cmd commands still reach normal authorization. Arbitrary
batch source/indirection remains opaque; this does not add a general cmd parser.
An expandable quoted title remains title data before the start options; a quote
inside an executable name does not turn that program into a title. The guard is
not an exhaustive command catalog: Disconnect-PSSession/dnsn and native sc.exe
service controls were not covered by the preceding Bash gate and remain under
normal authorization. No new blacklist for these command families is introduced.
The same scope applies to previously uncovered conditional systemctl restart verbs.
Nested PowerShell interpreter source also follows normal opaque-script authorization;
the former Bash-only launcher refusal is intentionally not restored on native calls.
These are documented coverage limits, not claims that such commands cannot detach work.
Dot invocation retains the following literal command position without splitting
decimal/member/path dots. Class/enum declaration names stay metadata; method
bodies and commands after a declaration still receive the existing checks.
Adjacent typed hashtables retain key/value context. Native smart quote groups
use the same literal/data rules as ASCII quotes, including here-strings and
doubled quote escapes. Invoke-Item/ii accepts its own literal enabled WhatIf,
using native parameter metadata; false/dynamic values retain the existing check.
These are invocation-only bounded scans, with no new progress/render work, retained
owners, per-event callbacks or pools. Existing source/AST/allocation evidence for
the unchanged render chain remains applicable.

This is a bounded preflight, not a complete PowerShell parser, dataflow analyzer or
sandbox. Here-strings, expandable string subexpressions and indirect call targets
defer to normal permission classification. It does not prove arbitrary authorized
programs, reflection, aliases, preference tables, modules, scripts or COM methods
cannot detach work. That broader claim cannot be established by a growing list of
type/member names. Explicit background work uses session-owned tasks when that capability is available; otherwise it follows opaque-command permissions.
The local Windows Job Object is used for managed background execution; ordinary
foreground execution has timeout/cancel process-tree cleanup, not a general
normal-exit containment guarantee for indirect or external-service launches.

Lifecycle acceptance grants no permission. Existing high-risk/protected-target
analysis, opaque-script approval policy, cwd identity, exact Session rules, rejection
handling and immutable final invocation authority remain unchanged. The normal
permission policy treats unresolvable high-risk targets as one-time decisions and
unsupported shell state as opaque execution. Bare `@(...).ForEach(...)`, inline
param(), some for/foreach pipeline forms and type block comments retain their
independent parser limits, without those limits directly denying authorization.
Lifecycle-only fixtures must not be presented as
proof that the entire authorization chain accepts a request. The real integration
fixture covers harmless compilation, Stopwatch.Start, dynamic file/environment
data, variable-based intrinsic ForEach, approval/denial and explicit job refusal.
Reported WMI/process-launch examples are inspected as offline strings only.

Bash-to-PowerShell recovery distinguishes an active native tool, a configured
discoverable tool, and an unavailable tool. Discovery is suggested only when
`tool_search` is active and the filtered catalog contains `powershell`; neither
tool activation nor authorization is automatic. Catalog lookup runs only on the
relevant refusal, through one extension-owned callback, with no cached catalog.
Catalog metadata also carries host/probe availability, including the current
disabled runtime state. Recovery and tool_search exclude unavailable tools even
when their definitions, or a stale active entry, remain present. This is explicit
discovery/refusal work, not progress/render work, and does not run another probe.

Collapsed Codemode errors skip policy headings and npm startup banners, prefer
the first file/line compiler error (including colored output), and show short HTTP
failure causes. A later specific exception, concrete Node spawn/spawnSync OS error,
or missing-path diagnostic supersedes compiler output; generic Error wrappers do
not. Model summaries retain concrete diagnostics and policy recovery;
expanded output and canonical results retain all diagnostics. Output scanning
remains capped at 2,048 characters, with 160/512-character display/model limits.

Performance audit: shell completion → Codemode facts/model summary → session event
delivery → InteractiveMode → retained tree/Text/Box → Main/Alt frame → terminal
queue → release. Error projection occurs once when its bounded source changes;
redraw/expand/collapse reuse it. Added regexes are module-owned. There are no new
per-progress/frame closures, Promises, controllers, wrappers, arrays, full-frame
copies or pools. The PowerShell lexer is invocation-local (128 KiB source, at most
2,048 tokens, 64 primitive expression contexts); source spans avoid
per-character string building.
All parser references become unreachable on return/refusal/throw, before any await.
Cast recognition balances type brackets linearly with depth capped at 64, preserving
nested generics and jagged arrays. The balanced scan cannot repartition overlapping regex matches. Context arrays are call-owned and
become unreachable together with lexer tokens on every return/refusal/throw.

Source-loaded validation on Windows x64 / Node 26.4.0, without a build or global
runtime replacement, extended existing tests only. Real isolated PowerShell
execution covers member calls, ordinary approval/denial and refusal before spawn;
Codemode provider-wire and retained-tree tests cover npm-before-TS diagnostics,
policy recovery, full-output preservation, cached projection and reference release.
Existing authorization and allocation source invariants cover the adjacent chain.

| Allocation fixture | Samples | Sampled bytes/update | CPU p95 (ms) |
| --- | ---: | ---: | ---: |
| Codemode compiler failure, collapsed | 4,096 | 1,620 | 0.0018 |
| Codemode native PowerShell refusal, collapsed | 4,096 | 1,490 | 0.0018 |
| Codemode compiler followed by spawn UNKNOWN, collapsed | 4,096 | 1,704 | 0.0018 |
| Codemode three consecutive quoted diagnostics, collapsed | 4,096 | 1,564 | 0.0018 |
| Main production frame | 1,024 | 7,629 | 0.0602 |
| Alt production frame | 1,024 | 11,796 | 0.0680 |
| Terminal frame queue | 2,048 | 217 | 0.1767 |

These are sampling observations, not an optimization claim. Leading sites remain
retained-item render/viewport cleanup, Main image-line/reset handling, Alt layout,
and benchmark timing in the queue fixture. The compiler fixture has one row, one
output projection, one failure projection and zero event Promises across redraws.
Release clears rows, timers, text and result references; controlled GC retains
0/2 weak owners. Main/Alt each materialize one frame, make zero full-size copies,
and create zero frame Promises/controllers/wrappers. Active/pending frame bytes
and retained references after disposal are zero, including four lifecycle cycles.
No running user session, provider service or browser authorization was replayed.
The native-refusal follow-up reran the affected summary/provider-wire tests,
Codemode source invariants and its existing tree benchmark fixture. It retains
one row/output/failure projection, zero event Promises and 0/2 weak owners after
release; the leading samples remain retained-item render/viewport maintenance.
The unchanged Main/Alt/queue chain uses the earlier evidence above.
After tightening npm banner recognition, the compiler fixture was sampled again;
the table records that latest run, with the same deterministic/release counters.
Versionless npm output retains possible headers and quoted diagnostics as bounded
source offsets until a substantive diagnostic is found. If only an exit code
follows, the quoted span remains the cause instead of disappearing as presumed noise.
Materialization occurs only for the selected fallback; there is no per-line container or
callback. Standalone and consecutive `>` diagnostics remain visible, and provider-wire coverage verifies
the actionable shell error alongside retained full output. The completion →
Codemode/session → InteractiveMode → retained Text/Box → Main/Alt → terminal queue
and release chain was re-audited; unchanged frame/queue evidence remains above.
Ten related source/AST invariants pass. The consecutive quoted-error fixture sampled
1,700 bytes/redraw and 0.0018 ms p95 across 4,096 redraws after 256 warmups, with one row,
one output/failure projection, zero event Promises and 0/2 retained weak owners.
Row/timer/text/result references are zero after release. Leading allocation sites
remain retained-item render and prepared-viewport cleanup. No pools were added.
The terminal-exception follow-up re-audited the same completion-to-release chain.
It adds one call-owned string reference, no scan or allocation per redraw. Four
focused behavioral tests and all ten source/AST invariants pass. Its allocation
fixture retains one row/output/failure projection, zero event Promises and 0/2
weak owners after controlled GC; row/timer/text/result references clear to zero.
Leading samples remain retained-item render, prepared-viewport cleanup/layout and
benchmark timing. Unchanged Main/Alt/queue code reuses the recorded evidence.

Longer quoted diagnostic runs retain their bounded source span as a fallback; only
a substantive non-quoted cause replaces it, while canonical output keeps all lines.
The same completion-to-release audit and ten invariants pass. The three-line fixture
above retains one row/output/failure projection, zero event Promises, zero released
row/timer/text/result references and 0/2 weak owners after controlled GC. No new
per-redraw scan, arrays, callbacks or pools; unchanged frame/queue evidence applies.
Native grammar coverage also preserves switch patterns, Unicode loop variables and
command position after workflow parallel/sequence/inlinescript blocks. Native 5.1
metadata confirms Start-Process -wi with an operand binds WindowStyle, not WhatIf.
Only that colliding form stops proving a dry run; explicit -WhatIf, standalone -wi,
literal -wi:$true and foreground -Wait remain accepted. The boolean colon form
cannot bind the legacy enum, as confirmed by a harmless proxy binding probe.
Redirection operators/destinations do not become WindowStyle operands; bounded
lookahead also covers parenthesized and member-expression destinations. Native 5.1
metadata permits Register-ScheduledJob WhatIf, but not guessed dry-run support for
the other scheduled-task commands. Unicode labels/type names and static-property
assignment targets preserve grammar without treating member names as capabilities.
Special foreach targets $$/$^ retain the iterator command position. Grouping around
one literal invocation target preserves the actual argument boundary, including Wait
and quoted foreach aliases; arbitrary computed targets remain opaque. Leading file
redirections also tokenize without whitespace before the destination. All these
checks are bounded invocation-only work and reuse the existing token storage.
Grouped literal targets skip newline trivia only inside their parentheses; a newline
after the group still ends the invocation. Redirections immediately after a leading
quoted target are separate tokens, while embedded unquoted data> stays argument text.
Native stop-parsing (`--%`) keeps its payload opaque through the next newline or
unquoted pipe/`&&`; ASCII and smart double quotes preserve those characters as
payload. Semicolons and command-like text inside it do not become PowerShell
lifecycle commands. Only the existing flat literal `cmd /c start` check reads its
raw native arguments, preserving `/wait` and title boundaries. Its additional
call-owned token list is capped at 2,048 and is never retained; expansion, escapes
and arbitrary batch operators remain opaque. Unescaped commas establish comment
boundaries and newline continuation, including escaped LF/CRLF trivia, so commented
`-Wait` text cannot prove a foreground launch. Escaped commas retain their literal
meaning. These are grammar fixes, not additions to the command/type catalog.
The spawn-failure fixture reuses the same completion-to-release audit: one row,
one output/failure projection, zero event Promises, zero released row/timer/text/
result references and 0/2 retained weak owners after controlled GC. Four focused
behavioral tests, type checking and all ten source/AST invariants pass. No new
test file or unchanged frame/queue benchmark rerun was needed.
The latest fixture also covers Windows `UNKNOWN`, with or without a target path,
and provider-wire coverage preserves the full earlier compiler diagnostics. The
table records its latest sample; source/AST and release counters are unchanged.
