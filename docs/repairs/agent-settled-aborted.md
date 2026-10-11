# Agent settlement cancellation

F05.1 follows fixed upstream v1.1.0 `abe508e1b89912adde45528136c3221eb69acdd7`.
OSC 7501 terminal reporting is the separate F05.2 goal.

## Design gate

`agent_settled` currently has no outcome field. The final assistant stop reason
cannot distinguish cancellation during retry backoff or after a successful
response while final listeners are still running. Local interactive consumers
also cancel the core Agent directly, so tracking only `AgentSession.abort()`
would miss a production cancellation path.

Keep one primitive explicit-abort flag on Agent, reset only when a run is
admitted (and on idle reset), and readable after its signal is released. Internal
failure cleanup also aborts that signal, so signal.aborted alone is unsuitable:
ordinary provider/consumer errors must not be classified as user cancellation.
AgentSession accumulates cancellation across its low-level attempts, including
retry and automatic-compaction cancellation, then snapshots one boolean before
extension settlement callbacks. Two existing event records carry that boolean;
extension mutation or a new run cannot change the later listener/JSON value.

Production chain audited: prompt admission or host dispatch -> Agent lifecycle
-> provider/tool event processing -> AgentSession final message and agent_end
handling -> retry/compaction/queued continuation -> pending custom-message flush
-> extension `agent_settled` -> synchronous session listener dispatch -> JSON/RPC
serialization or interactive shutdown check -> idle waiter release. Normal
coalesced Agent observer -> session observer bridge -> interactive updates and
frame queue remain unchanged. New work occurs only at admission, explicit
cancellation and settlement; no per-delta closure, Promise, controller, wrapper,
array, timer or listener is added. The existing two settlement records gain one
boolean; two owner-held booleans retain no references. No object pool is needed.

The outbound event always includes `aborted: boolean`. Its type/name/order and
existing fields remain unchanged; old consumers can ignore the additive field.
New clients interoperating with older hosts should treat an absent field as
false. A provider error or a request for user input is not itself cancellation.
Rejected prompt admission must not clear an already active run's outcome.

Verify real offline session runs, both cancellation APIs, successful/error/
aborted responses, retry recovery/cancellation, a new run after cancellation,
extension versus JSON delivery and resource cleanup. Use the existing event
allocation benchmark before/after and relevant source gates; do not run a full
local suite or unrelated terminal-frame benchmark.

## Verification

Windows / Node v26.4.0, baseline `34b0fd328f825c938a3f3d123981f31fde11a113`:

- The initial eight real-session assertions fail without the new field. All 11
  final settlement tests pass with `--expose-gc`, including successful retry,
  automatic compaction cancellation, rejected admission and extension reentry.
- 116 existing checks pass across custom-message ordering, Agent streaming,
  final frame delivery and relevant hot-path/source invariants. `npm run check`
  and Agent, coding-agent and server package builds pass. No full local suite.
- The lifecycle probe covers success, error and abort. Nine WeakRefs to session,
  Agent and run signal have zero survivors after disposal and controlled GC.
  Retry/compaction controllers and idle wait references are explicitly released.

The existing session-event allocation benchmark ran before and after with
100,000 updates and 10,000 warmup updates per fixture:

| Fixture | Sampled bytes/update before -> after | Controlled-GC heap delta before -> after |
| --- | --- | --- |
| Message update | 9.446 -> 9.386 | 115,176 -> 114,240 B |
| Tool update | 20.364 -> 21.202 | 127,608 -> 131,656 B |
| Full coalesced observer chain | 151.077 -> 148.486 | 855,784 -> 835,632 B |

Both runs retain zero built-in listener/bridge Promises and rejection observers
per update/delivery. Source counters remain zero for per-update wrappers,
closures, Promise tails/arrays and direct-lane arrays. The coalesced chain
delivers one snapshot for 100,000 raw updates; every final-update check passes.
Sampling and controlled-heap differences are noisy process measurements, not
evidence of a performance improvement or of zero total allocations. This
benchmark uses real observer delivery and stub UI leaves, not rendered frames.
The WeakRef probe supplies separate owner-release evidence.

Raw logs and before/after JSON are local under
`.git/f05-1-agent-settled-20261012/`. No new cache, pool, timer, listener or
background service is introduced by the implementation. OSC 7501 remains F05.2.
