# CodeMode runtime source boundary — 2026-11-17

## Policy and production path

Retire the independent 131,072 UTF-16 source limit from both the model-visible
schema and `CodemodeSandbox.execute`. Structured arguments and raw source now
enter the same VM with the complete program. The nonempty string schema,
authorization, cancellation and tool protocols remain in force. There is no
replacement character cap, static source allowlist, truncation or automatic
splitting. The fixed tool description documents the resulting behavior.

The existing QuickJS heap limit is 256 MiB. This is not a total Node process
limit: source transport and compilation also consume host resources. The coding
agent's active execution clock defaults to 60 seconds, accepts at most 300
seconds, and pauses during drained tool/approval waits. Child tools retain their
own lifecycles. Existing bridge call, argument, result, output and store quotas
are implementation quotas with their own purposes, not source length limits.

## Verification

The new runtime regressions failed against the old source guard before edits.
Valid 191,310-character and greater-than-1-MiB programs reach their final tool
exactly once. Production session fixtures exercise both JSON and raw source
calls above 1 MiB. Invalid long source produces a VM SyntaxError. Actual heap
exhaustion, timeout and cancellation retire the worker, preserve completed tool
effects, and allow the next cell to execute without replay. Sandbox closure
balances workers started/stopped and leaves no active executions.

This changes request setup and source admission, not normal provider deltas,
progress delivery, rendering or frame production; no hot-path allocation
benchmark is required. These are offline fixtures, not live provider/session
execution. The original private incident script is not replayed.
