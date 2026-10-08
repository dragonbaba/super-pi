# Task budgets, checkpoints and confirmed quit

Base: PR #75, `f9680c578`. Scope: parent/child execution budgets, explicit subagent
checkpoint continuation, and one manual-quit confirmation for active managed work.
Application-exit survival, daemons, distributed workers and agent messaging are out
of scope. All children must be stopped and joined before a successful quit.

## Delivery

1. Add one cancellable manual-quit boundary while the UI is alive. The shared task
   directory counts unfinished shell/subagent work and asks once. Concurrent quit
   requests join one operation; declining leaves the session intact. Signals bypass
   or cancel a pending dialog and still run cleanup. Existing shutdown joins remain
   mandatory, including when another shutdown handler fails.
2. Advertise configured parent/session and individual child turn/token budgets
   before dispatch. Defaults remain unlimited unless configured. Reserve turns
   before model requests, aggregate parent and child usage, and persist bounded
   numeric accounting with the session. Token enforcement occurs at request
   boundaries using reported usage: already in-flight requests can overshoot and
   missing usage must be reported honestly. Cost is an estimate, not a hard cap.
3. Opt in via `checkpoint: true`; save bounded child context only at completed turn boundaries. Preserve completed
   tool-call/result pairs; never resume by replaying an unfinished call. A fresh
   explicitly authorized single-task request can reference a checkpoint. Recheck
   session ownership, task identity, role and canonical workspace identity, and use
   current permissions/model configuration. Report uncertain work after the last
   checkpoint and require inspection before deciding what to do next.
4. Keep checkpoint storage and retention bounded by the task-history owner; no
   per-delta persistence. Do not store auth/environment credentials or old execution
   grants. Release process handles, IPC listeners, pending requests and temporary
   context on success, rejection, cancellation, reload and quit.
5. Self-review authorization, accounting, crash boundaries and shutdown ordering.
   Run focused offline regressions, relevant AST/source gates, allocation profiles
   and controlled-GC lifecycle checks under the hot-path allocation contract before
   submission. Request `@codex review` after submitting the new PR.

## Performance audit scope

Parent request admission -> child request admission -> provider response -> child
JSON/IPC ingestion -> usage/checkpoint completion -> task result -> observer ->
AgentSession -> InteractiveMode -> renderer -> terminal disposal. Streaming deltas
must gain no timers, callbacks, Promises, controllers, copies or disk writes.
Request/turn completion, explicit continuation and quit are named ownership
boundaries. No pools or unbounded retained message/Promise collections.
