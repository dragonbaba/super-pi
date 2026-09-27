# N3 shell input and result evidence

Status: **实现中，完整候选验证中**. Incorporated parent N2: `cffd2dbd1390b1fe73d16a74430a32f56af06b1c`,
including N1 `f044d73c27912528a3655bfea8a10b60881f6b56`. Input, structured
results and bounded CDPATH/hash are implemented locally; complete gates remain.
No complete N3 acceptance yet.

## Input capability decision

The current local Bash backend normally passes commands via `-c`; legacy WSL and
the Windows paired-backslash bridge use the shell's stdin. Independent program
stdin would therefore require a second transport with different ownership and
argument/environment behavior. This slice chooses the plan's bounded quoted
heredoc alternative: exactly one standalone bare `cat` (UTF-8 data) or `node`
(source), one ASCII single-quoted delimiter and at most 12 KiB for the complete
UTF-8 command. No command wrapping or temporary files are added, and the original
bytes are executed unchanged through the existing transport. CRLF command framing,
arguments, extra redirects, pipelines, nested/multiple heredocs and trailing commands
are outside this initial capability; PowerShell receives shared result work only.

Node source is converted only for analysis into the existing quoted node -e path;
both source and cat data retain opaque-input authorization. The original command
including its body remains in request hashing and final invocation binding. Quoted
delimiters do not establish permission. Real Linux/Windows bytes, denial, changed
approved input, process ownership, bounds and paired-backslash cases must pass before
this capability is considered delivered. No stdin schema, generic shell interpreter,
directory stack or automatic permission is added.

Windows Node 22.19.0 targeted input tests pass through the actual local backend
and default SDK assembly. They cover Chinese bytes, literal `$()`/backticks,
paired backslashes, empty EOF, multiline Node source, exact/over 12 KiB boundaries,
unsupported extra syntax/backends/hooks, denied approval, post-approval input
tampering, pending-authority release and Session reopen without execution.
Linux CI must independently execute these cases. The selected heredoc transport
has no separately owned program-stdin pipe; no independent stdin tool schema is
added. The existing internal command-stdin transport now has real slow-reader and
early-exit/EPIPE stress tests, separately from the public 12 KiB heredoc bound.
Normal execution and chunk/render callbacks allocate no new input payload when
the command has no heredoc operator. Full final result call-chain work follows.

## Structured result audit (in progress)

The baseline local shell execution loses observed signals and collapses timeout/cancel
into Error strings. The tool discards details when it throws; Agent normalization
then retains only error text. Output finish failure can replace the main execution
reason; null exit is accepted as success. The inspected call chain is local shell
operations → waitForChildProcess/output accumulator → shell tool → Agent execute
catch/finalize → extension tool_result → Session/provider projection/TUI and
false-success/session-tool-errors. The hot-path allocation contract was read before
this audit; final-result metadata must not introduce per-chunk/delta allocations.

The result producer now records start/launch status, actual canonical spawn cwd,
exit code, signal/termination, conservative side effects/retry guidance, output
drain/tail/log/cap/cleanup state and bounded input/log/cleanup errors. Null custom
backend termination stays unknown. Agent-issued pre-execution refusals report no
start. A typed result-bearing error carries captured content and details through
Agent normalization; a later observer failure preserves original producer facts
and appends its own short failure. The plain Session/JSON result contains no native
objects, pointers or Error instance; actual OpenAI serializer/fake-fetch tests
confirm internal facts do not leak into provider wire requests. No paid model is
called. Actual saved/reopened Session results retain the same normalized facts.

False-success only clears a verification obligation after a complete observed
local success in the matching actual cwd. Missing/custom/unknown/capture-failed
facts cannot clear it. Session-tool-errors and loop guard consume facts before
legacy text heuristics; TUI status uses producer values and treats stdout/stderr
as diagnostic data. Legitimate short nonzero/timeout/cancel text remains. Output
spill failures preserve the bounded memory tail and primary process reason;
secondary close/unlink failures are separate fields. Owned-file cleanup keeps its
error listener until stream close and does not delete an unowned marker collision.

The user-requested audit moves the heredoc pattern into `bash-regex.ts`, and the
touched false-success consumer's eighteen patterns into its dedicated `regex.ts`.
The AST consumer inventory covers both, including untracked new files. In the
full data→accumulator→throttled progress→Agent/Session→TUI→release chain, new facts
are created at completion only. Input observers have per-pipe instance callbacks,
retained until close; execution deadlines and output callbacks are initialized
once by their exact execution owner. Callback-body AST gates reject nested
closures/Promise tails, and child output reuses one idle timer with `refresh()`.
The deterministic 12-chunk post-exit case reports one timer, twelve refreshes and
zero wait listeners/timers after completion. No object pool was added. Existing
bounded snapshot/progress envelopes and renderer output strings still allocate;
this is not a blanket zero-allocation claim.

Windows Node 22.19 focused validation: check passes; 48 tests, 46 pass and two
explicit skips (POSIX signal and the real inherited-pipe descendant fixture).
Both slow input and real early-exit input pass; input close is awaited before facts
are finalized, preventing a late EPIPE from disappearing. Windows diagnostics with
both numeric/inherited stdio variants showed EOF at the Node parent exit, so the
Linux CI executes the real continuing-descendant test. `output.complete` describes
the observed stream drain, not a guarantee about future descendant output.

The actual failed-tool TUI fixture rendered 20,000 times at varying widths with
zero repeated failure analyses. Its Node 22.19 sample was 338,800 bytes total
(16.94/render); controlled heap 45,228,128→45,629,240 bytes. All twelve derived
reference counters and pending timers were zero after release. This one sample
does not establish a speedup or flat lifetime heap. Full local checks/build/hot/
tests and the existing Bash/shell/tool-leaf allocation gates are running; this
slice's final two-platform CI and actual review have not yet completed.

## Bounded compatibility and result review corrections

The literal temporary `declare -p CDPATH` and `typeset -p CDPATH` queries execute through actual Bash,
Agent/permission/lifecycle and default SDK/provider/Session paths. A hash change
as the final command of a closed child no longer taints its parent. Same/nested
child lookup, lastpipe, persistent assignments, added operands, dynamic/append
prefixes and POSIX mode remain refused before authorization/spawn. The new pattern
lives in the dedicated regex module; the recognizer is a module function with no
callback. No command rewriting, generic evaluation or authority exemption is used.
GNU Bash documents different assignment persistence for [POSIX special builtins](https://www.gnu.org/s/bash/manual/html_node/Special-Builtins.html)
and [subshell environments](https://www.gnu.org/s/bash/manual/html_node/Command-Execution-Environment.html).
The initial outer-shell export-n exception was removed after review demonstrated
that configured Bash invoked as `sh` enters POSIX mode. Its assignment can persist
despite environment filtering, so export-n prefixes before dependent operations
are refused on every backend. Actual Linux sh-symlink regression proves the changed
cwd directly and no guarded spawn/effects. The two regular-builtin queries remain
implemented and tested. Ambient POSIXLY_CORRECT is removed alongside the
already filtered Bash startup variables; explicit changes remain inspected.

Review 3f23591 findings are fixed: pre-execution verification uses an attached
canonical cwd binding, including an aliased Session root with explicit `cwd: .`;
legacy SHELL status prefixes remain first and runtime exit text stays visible;
custom backend rejected timeout/abort conventions populate termination facts
without pretending the process was unstarted or had no effects. Existing custom
rg no-match classification is retained for its exact empty-result shape, while
unknown/custom facts still cannot clear false-success obligations. Log failure
prefixes remain first when no earlier process failure exists. Structured facts
continue to take precedence over stdout that imitates control messages.

Windows Node22 targeted result/input/compatibility/callback regression: 158 pass,
zero skips, including default SDK four compatibility positives. Earlier full
tests revealed two old unconditional heredoc-refusal assertions; they now test
the actual supported quoted-data form plus the still-refused operand/redirect/
multiple/wrapper forms. No existing guard counterexample was removed.

The fourth 3f23591 review finding, observer-failure identity, is also fixed.
Agent completion failures add a bounded `observationError` to a copy of the
preserved shell facts, retaining start/exit/cwd/output and the original immutable
producer object. A secondary progress-drain failure is retained alongside a
typed primary tool failure. Consumers classify a successful process followed by
an observer failure as `observation_failed`, and keep a nonzero process outcome
as the primary category. Such a result cannot satisfy verification. Real Node
exit-0/23 through Agent plus post-tool observer failure are tested; focused tests
pass 62 with two platform skips after rebuilding the package consumer. No field
is created on normal delta/progress/render delivery. Two remaining postmerge
fixtures now use unsupported `cat -n` heredocs for their negative assertions;
default SDK supported bare-cat authorization continues to be tested positively.

The 0c9af9 review found the analogous PowerShell executable-status persistence
boundary. A rejected onConfirmed callback now adds a bounded observationError to
the preserved process result, and the common shell producer copies it to structured
facts. Real Windows PowerShell exit-0/23 tests append exactly once to an owned file,
retain started/cwd/exit/output facts and classify observation_failed/command_failed
respectively. The command is never rediscovered or replayed. Seventy-six focused
cases pass after check/build. Full-suite old heredoc fixtures now distinguish the
supported quoted data form from unsupported arguments, and progress-failure
assertions require both completed result content and the observation diagnostic.

Both 6f5d1f4bc and its parent-integration f9c4510aa pass all fixed-head local gates,
including full tests and Bash/shell/tool-leaf allocation checks. The next actual
review found primary-observer retention, implicit alias cwd and a guidance consumer
still using only stdout. Agent failure facts now preserve the first bounded
observationError, record the first bounded secondaryObservationError separately,
and explicitly flag further omissions. The facts reader validates these fields.
Real PowerShell exit-0/23 plus persistence and subsequent Agent observer failures
retain both errors, one actual file effect and the original process outcome.

Before-execution false-success observations without a cwd binding resolve the
implicit Session directory to the same canonical form as local producer facts.
Missing/unreadable paths retain their unresolved obligation; this is observation,
not execution authority. Real symlink/junction tests exercise explicit and implicit
cwd and prove a canonical retry clears only its matching key. Tool-loop recovery
now receives the same details as error recording. Structured shell facts prevent
stdout-driven path/parser/policy guesses; legacy non-structured diagnostics retain
their existing bounded hints. The actual default SDK/serializer test prints forged
ENOENT, policy and syntax markers while exiting 23, retains command_failed facts,
and appends no contradictory advisory. New-head complete checks/CI/review are still
required, independently of the preceding full passes.

The 2acbc654f review and full suite exposed four additional boundaries. A final
structured shell preview now retains its first bounded diagnostic when no known
marker matches, alongside the trusted status; resize does not repeat analysis.
Missing content from an untyped JavaScript tool is normalized before appending an
observer error. Agent-produced not-started refusals preserve structured policy,
duplicate and repeated-call categories; real child output carrying identical JSON
still classifies by its execution facts. Recovery guidance for started/unknown
shells preserves the original diagnostic and asks for state inspection using the
recorded facts, without asserting a parser/path/policy cause. The older runtime
recovery test now asserts this factual guidance, actual exit 1 and unchanged original
syntax/location text; the legacy no-facts Node advisory remains tested separately.
Check, offline build and focused Agent/default-SDK/serializer/TUI/recovery tests pass.
Latest N2 3bac07bf1 and N1 197f5ff0c are normal ancestors. Full gates, allocation
profile, current-head CI and actual re-review remain necessary.

The next review identified a configured-sh POSIX variant, producer status text
hiding an unrecognized compiler diagnostic, and guard refusals poisoning the
failure chain. The export-n exception is removed as described above; regular-builtin
queries and closed-child hash remain supported. A final preview skips standalone
producer markers and exit footers when selecting its first bounded diagnostic.
Agent-produced duplicate/repeated refusals do not count as execution failures;
real stdout with the same JSON still counts by recorded exit facts. The actual
default SDK executes one of three duplicate siblings, records two refusals, then
successfully executes a fresh identical call on the next turn. New focused and
parent-integration tests pass. Full checks/profile, Linux sh-symlink execution,
two-platform CI and current-head review remain required.

The 724045e0 review found that direct Session/RPC Bash execution could treat exit
zero as successful after failed stdin delivery, and frozen extension errors could
lose their original observation. The direct completion boundary now throws a
producer-tagged error for input/observation failure or incomplete completion before
persisting a successful BashResult; it preserves the real exit code and does not
retry. Ordinary observed exit 23 remains a recorded exit 23. Immutable errors are
wrapped with their original cause/message and new process facts. Real child/Session
tests cover early stdin close with zero exit and clean subsequent execution;
beforeSpawn tests cover frozen/sealed errors and an immutable existing tag. No
callback or regex is added to delivery paths. Linux's configured-sh fixture now
correctly asserts its two pre-existing victims retain their contents, rather than
asserting those fixtures never existed. Final gates, both CI jobs and review remain
required on the resulting full commit.

Current corrections preserve stdin delivery failure ahead of nonzero-exit command
classification while retaining real exit diagnostics and partial output. Actual
children closing stdin at exits 0 and 23 both report input_transport_failed.
Bash set parsing stops at -- or the first positional operand: literal posix or
physical arguments remain usable, while actual -P/-o physical/-o posix changes
remain conservatively refused by real guarded execution tests. Trusted Agent
preflight schema/incomplete-argument/output-limit results retain input_validation;
actual provider SSE -> Agent -> next serialized request tests prove zero tool
execution and preserved repair markers. The same text from real child stdout
cannot forge preflight facts. The production changes introduce no inline regex
or callback. On Windows Node22.19: check, offline build and 180 focused tests pass,
with one platform skip. New full gates, Linux CI and exact-head review are pending.

Linux CI isolated one fixture assertion that counted Node's own socket end
listener as a leaked wait listener. The real-child test now captures pre-existing
listener identities before waitForChildProcess and verifies that no new end
listener survives, while retaining full tail, one idle timer/refresh and zero
wait-owned child/data-listener assertions. Windows targeted observations pass;
Linux's real inherited-pipe case must run in the new CI. Runtime behavior is not
changed by this correction.

### Review follow-up: resolved failures, typed observers and rejected spills

Public Bash/PowerShell backends resolving exitCode=0 with non-exit termination or
an observation error now produce a failed tool result while preserving the facts.
Eight actual Agent dispatch regressions cover both tools and timeout/output
failure/unknown/observation outcomes. A completed tool result also takes precedence
over a ToolResultError thrown by an awaited progress observer: its real content
and execution facts survive, with a separately appended observation failure.

Direct Session/RPC post-execution rejection closes and removes the exact owned
spill before rethrowing. If unlink fails, the error preserves the original process
facts/cause and exposes fullOutputPath plus a cleanup message, so the retained log
is reachable. Six actual stream/file regressions cover three rejection reasons
with successful cleanup and injected unlink denial, checking real bytes and closed
streams. No new progress-time callback or regex was introduced. Focused tests:
65 passed, two platform skips; the hot-path source gate passes. Final combined
checks, both CI platforms and review still apply.

Review r26: shopt -o can change set-option semantics, including posix and physical.
The bounded analyzer recognizes separate/combined option flags and skips literal
redirections with its existing parser; later cd authorization then fails closed.
An isolated actual Bash fixture demonstrates persistent CDPATH resolving outside
the inner workspace under four POSIX flag spellings. The actual guard refuses the
following mutation before spawn; both inner and outer victim bytes remain intact.
No regex or closure was introduced. Windows Node22 compatibility/source tests:
147 pass, one Linux-only skip. This covers Bash's documented
[shopt -o behavior](https://www.gnu.org/s/bash/manual/html_node/The-Shopt-Builtin.html),
without expanding the supported shell evaluator.

Review r27: shopt query/print flags no longer taint later cd; changing -s/-u
options remain conservatively refused. A primitive segment marker distinguishes
a closed subshell from a sibling at the same depth, including nested siblings.
Actual guarded Bash positive/negative execution tests cover these distinctions.
After a real parent exits, abort/timeout/output failure remain active until its
inherited output settles. They stop the owned process group and close its local
pipes while retaining the observed parent exit code and incomplete-output facts.
Three Linux-only real descendant regressions exercise timeout, cancellation and
asynchronous spill failure, including exact PID/closed stream checks. Windows's
Node inherited sockets cannot represent this POSIX pipe case and are explicitly
skipped. Existing stable execution callbacks are reused; no callback or regex was
added to production. Windows focused/source tests and check pass; Linux behavior
is subject to the new CI run.
