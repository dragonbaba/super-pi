# N3 shell input and result evidence

Status: **实现中**. Current parent N2: `fb0c0f1fbf21acbb6a416b0e4504dab7513bb099`,
including N1 `d1bad1788e620810caf60914dd330b78ea26981d`. First input slice is
implemented; structured execution results and CDPATH/hash compatibility remain.
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
has no separately owned program-stdin pipe; independent streamed stdin, EPIPE and
slow-consumer flow control are outside this capability, not claimed as implemented.
Normal execution and chunk/render callbacks allocate no new input payload when
the command has no heredoc operator. Full final result call-chain work follows.

## Structured result audit (in progress)

Local shell execution currently loses observed signals and collapses timeout/cancel
into Error strings. The tool discards details when it throws; Agent normalization
then retains only error text. Output finish failure can replace the main execution
reason; null exit is accepted as success. The inspected call chain is local shell
operations → waitForChildProcess/output accumulator → shell tool → Agent execute
catch/finalize → extension tool_result → Session/provider projection/TUI and
false-success/session-tool-errors. The hot-path allocation contract was read before
this audit; final-result metadata must not introduce per-chunk/delta allocations.
