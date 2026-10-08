# Subagent scheduling and managed tasks

Status: first session-owned subagent release implemented and locally verified.
Base: `8b7308691`. Cross-restart recovery remains a subsequent milestone.

## Intended behavior

Expose effective limits before delegation, permit larger useful batches, and keep
every child owned by a session. Limits are ceilings, not fan-out targets. Delegate
only independently useful work with an objective, scope, evidence, deliverable,
and stop condition. Keep dependent edits sequential or in isolated workspaces.

## Delivery sequence

1. Introduce a bounded user configuration for concurrent children and batch size.
   Defaults: 16 concurrent children and 64 tasks per batch. Hard ceilings: 64
   concurrent children and 256 tasks per batch. Reject invalid configuration;
   never silently clamp it. Expose effective and hard limits in the tool schema,
   description, and a user-facing inspection command before a task is submitted.
2. Share a FIFO scheduler across calls in one extension/session runtime. Bound
   slots retained by unfinished calls (including completed siblings), reserve admission atomically, and release all
   reservations on preflight errors, cancellation, and call completion. Report
   running, active/queued and reserved counts separately. Prevent
   overlapping writer workspaces across batches; queue time is not runtime.
3. Add session-owned background subagent tasks with stable IDs, status/list,
   bounded waiting, explicit cancellation, bounded result retention, and one
   completion notification. Keep the existing foreground interface compatible.
   Waiting timeout does not cancel execution. Cancelled work only becomes
   terminal after its process and prompt-file cleanup settle.
4. Invalidate tasks on session replacement, permission changes, reload, and exit.
   Recheck workspace identity immediately before process launch. Never treat a
   background task or another agent's message as new permission. Headless modes
   must not silently exit while claiming that an in-memory task will continue.
5. Audit and remove per-progress batch copies, callback construction and full
   output projection. Keep mutable child state private; publish bounded owned
   snapshots only at explicit delivery boundaries. Retained arrays, messages,
   listeners, timers, and process references have named owners and release points.
6. Add focused regressions for advertised/enforced limits, FIFO admission,
   cancellation, cross-batch conflicts, invalidation, waiting, notification and
   capacity. Run the relevant AST invariants, allocation profiles and controlled
   GC release checks, then typecheck and review the final diff before opening PR.

## Subsequent milestones

- Session-owned shell adaptation is implemented in the
  [background shell phase](background-shell-tasks-plan.md), through the existing
  permission and resource controllers with unified task management.
- Bounded task metadata/results and honest interrupted-state recovery are
  implemented in the [task history phase](task-history-persistence-plan.md).
  It never automatically replays edits or external side effects.
- Add resumable child checkpoints, with renewed workspace and permission checks,
  and enforce parent/child turn and token budgets. Label cost estimates and the
  granularity of budget enforcement.
- Only introduce a daemon when tasks must survive application exit. Distributed
  workers and inter-agent messaging are separate compatibility decisions.

## Performance and acceptance contract

Follow `docs/performance/hot-path-allocation-contract.md`. Audit child stdout ->
bounded event ingestion -> progress publication -> agent observer snapshot ->
AgentSession -> InteractiveMode -> tool renderer -> terminal delivery/release.
Track deterministic publication/copy counts, queue/running high-water marks,
sampled allocation sites and bytes, and weak-reference release after normal,
failed, cancelled and disposed lifecycles. No object pool, polling repaint loop,
unbounded history, or per-delta Promise/AbortController is introduced.

Only task-owned resources may be removed. Existing credentials, user settings,
workspaces and unrelated processes are never test fixtures. Use offline synthetic
children to verify orchestration without paid model calls. Validate only affected
behavior locally; retain the repository's normal CI checks for the PR.
