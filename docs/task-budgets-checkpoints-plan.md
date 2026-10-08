# Subagent responsibilities, checkpoints and confirmed quit

Base: PR #75, f9680c578. Scope: explicit child responsibilities, bounded checkpoint
continuation and one manual-quit confirmation for active managed work. Token and
turn quotas are excluded. Existing usage statistics remain informational.
Application-exit survival, daemons, distributed workers and agent messaging remain
out of scope. All children must be stopped and joined before a successful quit.

## Delivery

1. Validate task scope, deliverable and stopCondition for every single/parallel/chain
   item before launching any child. Give each child one objective and relevant
   evidence; expose concurrency and task ceilings before invocation. Define scout,
   planner, reviewer and worker responsibilities, skip unnecessary roles, and stop
   at completion or a blocker. Prose scope does not replace workspace permissions.
2. Save explicitly enabled checkpoints at initialization and turn boundaries only.
   A continuation is a fresh authorized task with the same role/workspace identity
   and current permissions/model. Preserve completed tool-call/result pairs without
   replaying unfinished calls. Its new instruction enters durable history only when
   the first turn completes. Mark uncertain post-checkpoint side effects.
3. Ask once on manual quit while the UI is alive. Repeated requests join the same
   operation; declining preserves tasks. User selection has no safety-hook timeout.
   Signals bypass or cancel the dialog and still join process cleanup. Failure in
   one shutdown handler cannot skip the remaining owners.
4. Keep checkpoint storage and retention bounded by the task-history owner; no
   per-delta IPC or persistence. Ordinary children exchange initialization only.
   Release process handles, IPC listeners, pending requests and temporary prompts
   on success, failure, cancellation, reload and quit.
5. Self-review complete ownership and authorization paths. Run focused offline
   regressions, source/AST gates and allocation/controlled-GC checks under the
   performance contract, then request @codex review on the submitted revision.

## Performance audit scope

Assignment admission -> delegated authorization -> scheduler -> child initialization
-> provider stream -> stdout ingestion -> optional completed-turn checkpoint -> task
result -> observer -> AgentSession -> InteractiveMode -> renderer -> terminal
cleanup. Streaming deltas gain no callbacks, timers, Promises, controllers, copies
or disk writes. Assignment compilation is once per launch. No object pools.
