# Session-owned background shell tasks

Base: merged PR #73 (`eb36e30f7`). Scope: managed Bash/PowerShell commands in a
live TUI/RPC session, with a unified task-control surface. Persistence, checkpoints,
application-exit survival and distributed workers remain later milestones.

Status: implemented; focused local checks and allocation/lifecycle evidence are
recorded in [the performance audit](performance/background-shell-tasks.md).
Cross-platform CI and external review run on the new PR.

## Implementation and acceptance

1. Add explicit `background: true` to the existing shell tools. Require literal
   cwd, bind the flag into the existing final authorization, and reuse the exact
   local backend, pre-spawn directory checks, output capture and process cleanup.
   Unsupported/modified backends must fail before launch. No alternate shell
   parser, detached-command escape hatch or new permission path is introduced.
2. Own accepted work in the resource lifecycle extension. Publish effective
   concurrent/admitted limits before submission; queue bounded work, return an ID,
   allow explicit wait/cancel/status, and notify once after terminal cleanup.
   Shell and subagent capacities remain independently reported.
3. Share `/tasks` and the direct model `tasks` control tool across shell and
   subagent providers, keeping `subagent_tasks` compatible. Admission is not
   verification success; terminal shell facts update the existing result guard.
4. Cancel obsolete generations on permission changes, session replacement,
   reload and exit. Reject background mode without a live manager/control tool.
   Waiting timeout does not cancel execution; queued cancellation never spawns.
5. Audit stdout -> OutputAccumulator -> final shell facts -> task retention and
   notification -> AgentSession/TUI. Background chunks publish no progress and
   create no additional callbacks, Promises, arrays or AbortControllers per chunk.
   Bound history and release execution closures, listeners, timers and processes.
6. Add focused authorization, queue/cancel, Bash/PowerShell, shared-control and
   lifecycle regressions. Run relevant source invariants and allocation/release
   benchmarks, then self-review, commit, open a new PR and request `@codex review`.

Commands retain their approved filesystem scope. Schedule independent work only;
do not edit files while a background build/test is using them. Existing unmanaged
daemon/background shell syntax remains subject to the lifecycle guard.
