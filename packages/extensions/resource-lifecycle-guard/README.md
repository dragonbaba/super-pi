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

A finite literal read loop is also recognized without opaque-script approval:
`for f in data/a.json data/b.json; do echo "@@@ $f"; tr -s ' \n' ' ' < "$f"; echo; done`.
This bounded form accepts up to 16 literal file names and 32 `echo`/`cat`/`tr`
commands in 4096 characters. Each `cat`/`tr` uses one quoted input redirect to
the loop variable; `echo` may interpolate that variable for labels. Lowercase
local variable names (excluding `_`, `path`, `cdpath`, and `fpath`) are supported.
The latter three exclusions avoid granting this exemption to lookup-sensitive
variables of alternate shells; they do not imply general zsh support.
Quoted `";"` / `';'` remains data. Only adjacent unquoted separators are coalesced,
so an actual separator after quoted punctuation still ends the command. Regression
tests exercise hidden commands after both `echo` and `cat`, and use the real guard
to reject protected file creation before spawn in all three permission modes.
Source bytes are executed
unchanged. This exemption accepts LF line endings only; CR-bearing input uses
the existing checks because Bash builds/options can interpret CR differently.
Glob/command-generated lists, network-device input, assignments,
output redirects, wrappers, nested loops, excluded shell variables and commands
outside the recipe fall back to the existing checks. This does not turn `full-access`
into arbitrary-script execution or change approval policy. Standalone `tr` is
classified with the other read-only commands; its redirects are still checked.

A separate bounded find-list recipe accepts, for example:
`for f in $(find js -name '*.js' | sort -u); do node --check -- "$f" 2>&1 || echo "FAIL $f" | head -n 5; done`.
The root must be one literal relative path that does not start with an option.
Only the existing read-only find predicates and stdin-only sort options
`-u`, `-r`, `-n`, `-V`, `-f` (including short-option combinations) qualify.
The same sort option rule applies to standalone commands. Output files, temporary
directories, compressor programs and arbitrary sort options do not qualify.

In this recipe dynamic filenames must be quoted operands after `--` for
`node --check`, `cat`, `head -n N` or `wc -l`, or data inside an echo label.
Only `2>&1`, sequential/conditional commands and pipes to `head -n N` are accepted;
the whole source remains limited to 4096 characters, 256 words and 32 body commands.
Assignments such as `out=$(...)`, dynamic input redirection, nested/background
loops, output redirection and pipes to other programs remain outside the exemption.
All three scanners share the full-source decision and retain quote provenance.
Unquoted find output still undergoes Bash word splitting and globbing: this recipe
prevents option/redirection interpretation of those pieces, but does not guarantee
lossless processing of filenames containing whitespace. Original bytes execute unchanged.

| Form | Current behavior |
| --- | --- |
| Literal read commands, bounded query/loop forms and static descriptor copies | Keep their existing read-only classification; output redirections retain target checks. |
| Bare same-shell `cd sub && operation`, or `cd sub || exit; operation` | The dependent operation uses the verified cwd. A separate call starts from its own configured cwd. |
| Grouped/conditional cwd, source activation, PATH/hash changes, dynamic executables and unresolved arithmetic | Classified as opaque when the state cannot be established. Without a recognized mutation, `full-access + never-ask` allows them; narrower modes request authorization. The analyzer does not evaluate variables or infer arbitrary executable behavior. |
| Recognized writes/deletes with uncertain cwd or targets | Refused before approval, including `rm -rf "$X"`, `cd sub; touch target` and writes after untracked state changes. Literal interpreter heredoc bodies, trap actions and visible arithmetic/test substitutions are inspected for recognized operations. |
| Bounded heredoc data | Bodies are not parsed as shell argv. Unquoted body substitutions remain executable and are checked. Data and unknown consumers remain opaque for permission review. |
| Literal shell wrappers and bounded substitutions | Their source is inspected recursively. Unsupported wrapper grammar, malformed executable substitutions and inspection limits retain their existing refusal codes; these are not general Bash parsing guarantees. |
| Native PowerShell | Uses its own lifecycle and permission classifier. Nested Bash source receives Bash checks; recursive deletion with unknown targets remains blocked. |

D3 interpreter recognition is limited to the supported Shell, Node and Python forms. Other interpreters, including Perl/Ruby heredocs and `-e` programs, are opaque scripts; this does not mean their bodies were inspected or found safe. Node/Python heredoc bodies expanded by the shell through unquoted `$VAR` or `$(...)` likewise remain unanalyzed executable source. Without a separately recognized mutation or lifecycle violation, `workspace-write` asks once and `full-access + never-ask` allows them. Visible command-substitution operations retain their own checks, and an outer background operator such as `perl -e '...' &` still refuses. The original `eval` `[SHELL_WRAPPER]` refusal for unsupported/dynamic operands is unchanged.

Literal Node interactive eval/print input and all three supported brace-body function declaration forms retain executable-stdin checks. Embedded Node/Python mutation scanning collects each recognized call, with at most 64 calls per pattern and 16 targets; overflow remains unverifiable. A later locally detected shell-state change does not retrospectively invalidate an earlier fixed mutation target. `find` predicate and format operands remain data when they spell output actions. Dynamic executable names, including a variable assigned immediately beforehand, retain the D3 opaque-input boundary; no general executable-variable resolver is provided.

D3 trap actions are inspected recursively when literal, including a direct variable resolved from an immediately adjacent literal assignment. Nonadjacent assignments, unknown variables and command substitutions do not establish a literal action; these retain main's lifecycle refusal, reported as `[SHELL_WRAPPER]` like unsupported `eval` operands, before permission-mode handling. No cross-statement binding tracking is added.

Heredoc consumer recognition follows the existing supported `env`, `sudo`, `doas` and literal-duration `timeout` launcher operands, up to four levels, before selecting Shell/Node/Python execution versus data input. Unsupported launcher grammar retains its existing lifecycle handling. This does not add general launcher option parsing or dynamic executable resolution.

Within a simple command, literal descriptor copies and moves preserve heredoc input in redirection order. Closing or overwriting the original descriptor does not erase a retained copy; overwriting the copy does. Binding lists are call-owned and limited to 16 descriptors per heredoc and 16 effective document/descriptor records per analysis. Overflow retains the existing inspection-limit refusal. Dynamic descriptors and general cross-command descriptor flow are not evaluated.

A persistent `exec N<<'TAG'` binding is tracked across only `true` and `:`. Known contents are recursively checked when `source`/`.` reads the matching descriptor. After any other intervening command, a later matching script read retains main's `[SHELL_HEREDOC]` refusal because the contents are no longer tracked. Binding alone and data reads do not trigger this rule. A subsequent unconditional literal binding replaces the earlier document. Extra POSIX descriptors supplied without close-on-exec can survive the built-in stdio configuration: the Linux CI probe found fd 63 still open, while all four Windows launch/transport combinations isolated the probe descriptors. Therefore direct `source`/`.` reads of `/dev/fd/N` or `/proc/self/fd/N`, N >= 3, without a preceding or same-command explicit binding retain `[SHELL_HEREDOC]` on every platform. A later binding or a binding of a different descriptor does not authorize the read. The regression probe supplies fds 3/7/63 and checks their sentinel contents without executing them. It never assumes every inherited descriptor was closed merely because 0/1/2 were explicitly configured.

Alias contents are not tracked. A command containing a heredoc retains `[SHELL_HEREDOC]` if it may enable alias expansion (`shopt -s expand_aliases` or dynamic options), define aliases (`alias` or `BASH_ALIASES` assignment), source an ordinary file, or use `eval`. This applies even without a same-name alias statement or an explicit `expand_aliases` setting, including these operations inside a known sourced heredoc body that could affect a later consumer. Literal descriptor sourcing is handled by the document checks above, preserving D3's known harmless script inputs. Ordinary noninteractive Bash heredocs without these conditions retain their existing admission, including checks of same-name literal functions. Unsupported `eval` without heredoc retains its original `[SHELL_WRAPPER]` behavior.

Pipeline heredoc inspection starts at the stage that owns the redirection and follows downstream consumers; upstream stages do not receive that document. Both high-risk and permission scans associate locally detected state uncertainty with subsequent mutations, while retaining conservative handling of compound state and explicit unknown targets. Both spellings of `sort --compress-program` are opaque because the compressor is a separate unassessed program.

Pipeline propagation respects explicit stdin/stdout redirections, including literal descriptor copy/move order and restoration. A producer redirected to a file does not send its heredoc to a downstream interpreter; restoring stdout to the pipe restores that inspection. Temporary connectivity lists are call-owned and capped at 16 entries; uncertainty/overflow retains conservative inspection. Function declarations may put their brace body after a newline. Node's documented value-free flags, including `--no-addons`, do not consume a following program filename; unknown option arities remain conservatively ambiguous. Literal shell wrappers preserve explicit descriptor provenance within the existing four-level bound. Wrapped `source`/`.` reads after content tracking is lost retain `[SHELL_HEREDOC]`, just like direct reads.

For a sequence of top-level simple commands, shell-state uncertainty begins at the affected source position. A later `PATH` assignment or lookup change does not invalidate an earlier fixed mutation target; mutations after that change remain unverifiable. Loops, conditions and compound state retain conservative whole-context handling.

GNU sort long options use exact matching followed by a unique prefix across the full 30-name catalog (`sort --help`; the source table's 31st entry is its NULL sentinel). Abbreviated output files and temporary directories retain their target checks; abbreviated compressors remain opaque. Required values accept both `--option=value` and `--option value`. Ambiguous prefixes exit without writing, while completely unknown options remain opaque and follow D3 permission mode. `--` ends option processing. More than 16 distinct recognized mutation targets remains unverifiable and cannot obtain authority.

Python recognition covers only supported ordinary calls, without evaluating f-string expressions. F-string executable source remains opaque and follows permission mode, without a claim that its body was checked or found safe. Python process lifecycle recognition remains limited: main also does not recognize an ordinary `subprocess.Popen` call. This PR does not expand that existing boundary into general Python lifecycle analysis.

Node test-runner mode does not execute heredoc bytes as a stdin program. Sort option operands are consumed before output-option matching, and explicit temporary directories are assessed as write targets alongside output files. Unquoted heredoc backslash-newline continuations are joined before matching an end delimiter and inspecting the effective body; quoted bodies preserve their literal newlines. The submitted command remains unchanged.

The real-chain regressions are in `tests/shell-common-compatibility.test.ts`; they use synthetic temporary workspaces and run on Linux Bash and Windows Git Bash in required CI. Native delete/move and explicit per-call Bash/PowerShell cwd are separate future scopes, not features of PR #43.

## Resource lifecycle

Unmanaged detached/background services remain blocked unless one foreground Bash call owns cleanup and wait. For session-managed long work, submit the foreground command with `background: true` and an explicit `cwd`; a live TUI/RPC session and the `tasks` tool are required. Poll or cancel through `tasks`. Headless environments use foreground execution. The flag does not authorize raw `&`, `nohup` or detached services. Default managed Chrome screenshots and managed Chrome itself are cleaned by exact identity at `agent_settled` and `session_shutdown`.

The owned-job recipe permits up to 16 literal `curl`, `test`, `true`, `false` or `echo` use commands (4096 characters total) between installing cleanup and explicitly killing/waiting on the captured PID. Expansion, PID reassignment and arbitrary runners in this interval are unsupported; do not interpret an unsupported recipe as permission to detach or switch launchers.

Launcher-prefixed owned jobs (including env/sudo/nice/timeout and shell/multicall wrappers) are unsupported rather than inferring the effective executable from mutable launcher semantics. Recognizer acceptance is not proof against arbitrary executable behavior, aliases outside the inspected call or process forking. Existing permission policy still applies.

`wget` is excluded from owned-job use because its options/configuration can start background work outside the captured PID. Shell comments inside command substitutions are skipped when locating the actual closing delimiter.

`printf` is also excluded from the use interval: its `-v` option can overwrite the captured PID even without assignment syntax.

Command substitutions containing `case` syntax are conservatively uncertain because pattern parentheses are outside this recognizer. Shell wrappers support only a direct `-c` script operand; script files, preceding option variants and later positional `-c` tokens are not inferred safe. Bash/sh/zsh/dash/ksh/fish executable names are recognized; this does not claim complete grammar support for those shells.

### Bounded quoted input (N3)

The specialized stdin transport still handles one standalone `cat <<'TAG'` or `node <<'TAG'` command within 12 KiB UTF-8 and its existing framing constraints. Broader heredoc forms use the ordinary Bash transport and the shared bounded policy analysis. This PR does not extend the specialized bridge or promise cross-platform transport compatibility for every heredoc grammar. The complete submitted source is bound to final authorization and is never rewritten by analysis.

The built-in Bash tool accepts no heredoc with `commandPrefix`, a non-default `spawnHook`, or a custom/changed backend. Preparation and the execution recheck both enforce this, including compound commands and commands after the delimiter, before any hook/backend/process starts. Existing standalone bounded inputs keep `[SHELL_INPUT_UNSUPPORTED]`; the broader forms use `[SHELL_HEREDOC]` and recovery guidance. The built-in MSYS bridge remains the default trusted hook. The gate performs one forward O(n) scan per checked phase using primitive locals, without an AST, command copy, match object, container or callback; its return value is a number. Unchanged built-in Bash skips this scan. It neither stores command references nor adds work to progress/render delivery. Nested lexical contexts use bounded call frames; after 64 levels a conservative linear candidate scan replaces recursion.

This configuration gate treats `${...}` parameter words as expanded data, including literal `<<` text and nested parameter words. Executable command/process substitutions inside those words remain scanned for real heredocs, using the same forward scan and bounded call frames. This lexical gate does not replace the lifecycle or permission analyzers.

The shared analyzer masks bounded data bodies, preserves executable substitutions, and inspects literal shell/Node/Python stdin consumers. Comments cannot introduce fake heredoc delimiters. Unknown state remains opaque rather than acquiring a read-only exemption. Interpreter support is bounded policy evidence, not a sandbox or a complete language parser.

The unchanged local Bash transport, including its existing Windows MSYS paired-backslash bridge, carries these bytes. Custom backends, command prefixes and arbitrary spawn hooks cannot opt into this bounded input path; preparation and execution both verify backend identity. No temporary input file, new environment snapshot or callable registry is added. PowerShell does not advertise this Bash input form. Real default SDK and Agent/permission tests cover literal expansions, Chinese text, paired backslashes, code execution, denied and changed approvals, bounds, EOF and process ownership. Final two-platform acceptance is tracked in `docs/next-phase-n3-evidence.md`; no speedup or model-token claim is made.

Current prefix/case/coprocess protections and bounded validation/recovery guidance remain. Timed/coprocess substitutions and case pattern ambiguity stay uncertain; quoted words remain data. The recognizer is policy evidence, not a shell sandbox or a proof of arbitrary program behavior. A refusal is not permission to switch language or launcher around policy.

### Post-merge classification compatibility

The global shell-text prefilter selects work only. Literal option-free `env`/`sudo`/`doas` operands are resolved within their own segment (`env` NAME=VALUE operands, including non-Bash names, `sudo` assignments and an initial `--` are recognized); ambiguous options, interleaved redirections, other launcher grammars and launcher-selected shells remain conservative refusals. Unrelated `sh` text does not turn a plain `env ... printenv` or `env echo` into a shell wrapper. This does not grant permission or validate arbitrary executable behavior.

Direct wrapper operands retain one layer of Bash double-quote backslash semantics, including backslash-newline removal; the mutation and permission tokenizers use the same rule. Outer dynamic expansion of wrapper/launcher operands remains uninspectable. Substitution scans distinguish termination failure from unsupported grammar without claiming the latter is syntactically complete. Permission scope stays opaque for uninspected substitutions, and independently recognized mutations remain recorded.

Scoped Bash metadata exposes the scanner's limits: 16 command substitutions per script, nesting at most 4 levels. Count/depth exhaustion reports `SHELL_INSPECTION_LIMIT` with a short, specific retry; unsupported grammar and unterminated input retain `SHELL_SUBSTITUTION`. Two substitutions per name require batches of at most eight names. Quoted and unquoted `$(...)` remain part of their original argv word while their bodies receive recursive lifecycle, mutation and permission inspection. Unsupported ANSI-C quote escapes refuse before a delimiter can truncate the body. Legacy backtick argv handling is unchanged. Executable substitutions and dynamic mutation targets remain conservative. The shared delimiter scanner returns primitive offsets without span arrays, result wrappers, caches or pools.

Focused verification includes `shell-analysis-authorization.test.ts`, `shell-analysis-hook-lifecycle.test.ts`, `shell-analysis-source-invariants.test.ts`, and `shell-observation-hot-paths.test.ts`. The existing shell substitution benchmark remains a standalone scanner comparison. `scripts/bench/shell-authorization-analysis.ts` additionally exercises the shared production analysis owner with real scanner-entry counters, sampling and controlled-GC release checks.

One authorization owns at most 128 cached syntax analyses and 512 KiB of conservatively counted UTF-16 analysis references, plus its borrowed root command/cwd identity. It shares heredoc/substitution analysis across lifecycle, mutation and permission checks. Contextual target analysis still runs in each nested cwd. Command, cwd or permission-generation drift invalidates the owner; a fresh request is analyzed again. Success, denial, throw and cancellation clear the cache before final authority is returned. Final invocation authority independently revalidates exact input, cwd and permissions; it retains no analysis owner.

Numeric counters record actual calls and UTF-16 input bytes at the `prepareShellAnalysis` and substitution-scanner entries, including recursive scans. They do not count every regex/character access or claim to measure V8 backing-store allocation. HeapProfiler samples and cache reference counters are separate evidence. No object pool is introduced.

Refusal prefixes consumed by loop guardrails and existing `[SHELL_*]` codes remain stable. A dynamic executable or a bounded heredoc alone no longer generates a lifecycle refusal. Genuine lifecycle failures describe foreground ownership and the managed-background alternative. Parser limits describe the unsupported grammar without treating a change of authorized syntax as forbidden behavior. A denial still requires fresh, current authorization; changing language cannot authorize a denied operation. “Not executed” describes this tool call, not its siblings. Timeout uses seconds (`60` is one minute).

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

The preflight retains explicit Start-Job/thread-job/service/scheduled-task checks,
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
banning their foreground forms. The native systemctl path recognizes explicit
start/restart/reload-or-restart/isolate verbs after supported global options;
option values are not verbs, and unknown/dynamic syntax remains ordinary opaque
execution rather than a new command whitelist. No service or remote job was run.
Combined systemctl short flags are consumed before the verb, including a final
value-taking option. Attribute boundaries retain their argument tokens so literal
ValidateScript bodies receive ordinary lifecycle inspection; the same bounded
primitive stack is reused for lexical attribute ends and expression contexts.
Invoke-Command also checks InDisconnectedSession and its Disconnected alias/prefixes
using native parameter metadata; literal false stays foreground. No blanket ban on
attributes, remote-command types or member names is introduced. The independent
legacy high-risk scanner already refuses some validation-attribute declarations;
lifecycle acceptance is not evidence of whole-chain acceptance for those forms.
Attribute argument names remain metadata; only their script-block bodies enter
command position. A harmless custom attribute with a Start property confirms the
distinction on native 5.1/7.6. systemctl enable plus --now is recognized on either
side of the verb, while plain enable, disable/mask, option values and -- operands
retain their normal meaning. Native parameter binding also confirms that a
backtick touching -As/-InDis before a newline stays in the parameter name and
fails binding; it must not be normalized into an async switch. Ordinary spaced
line continuations already preserve the native switch and remain covered.
reenable plus --now also requires owned execution because it try-restarts active
units. Literal flat cmd /c start restores the prior lifecycle check, accepting
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
type/member names. Explicit background work still belongs in session-owned tasks.
The local Windows Job Object is used for managed background execution; ordinary
foreground execution has timeout/cancel process-tree cleanup, not a general
normal-exit containment guarantee for indirect or external-service launches.

Lifecycle acceptance grants no permission. Existing high-risk/protected-target
analysis, opaque-script approval policy, cwd identity, exact Session rules, rejection
handling and immutable final invocation authority remain unchanged. The normal
permission policy may still reject unresolvable targets or unsupported shell state.
For example, the older scanner refuses a bare `@(...).ForEach(...)` statement,
whereas assigning the array before invoking its method reaches normal approval.
Inline param(), some for/foreach pipeline forms and type block comments also retain
those independent parser limits. Lifecycle-only fixtures must not be presented as
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
