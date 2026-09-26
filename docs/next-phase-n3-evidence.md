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

The three literal temporary CDPATH query forms now execute through actual Bash,
Agent/permission/lifecycle and default SDK/provider/Session paths. A hash change
as the final command of a closed child no longer taints its parent. Same/nested
child lookup, lastpipe, persistent assignments, added operands, dynamic/append
prefixes and POSIX mode remain refused before authorization/spawn. The new pattern
lives in the dedicated regex module; the recognizer is a module function with no
callback. No command rewriting, generic evaluation or authority exemption is used.
GNU Bash documents different assignment persistence for [POSIX special builtins](https://www.gnu.org/s/bash/manual/html_node/Special-Builtins.html)
and [subshell environments](https://www.gnu.org/s/bash/manual/html_node/Command-Execution-Environment.html).
Consequently export-n is limited to the outer sanitized Bash; nested evaluators
do not inherit that exception. Ambient POSIXLY_CORRECT is removed alongside the
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
