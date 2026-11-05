# @super-pi/codemode

QuickJS WASI execution in a separate, terminable worker. Imported from official Pi
v1.0.0 (`a13d35a74`), under the retained [MIT notice](LICENSE-MIT), then adapted to Super Pi's
bounded resource and allocation contracts. The low-level Agent has no VM dependency.

The modified Super Pi package is licensed under [GPL-3.0-only](LICENSE);
see [NOTICE.md](NOTICE.md) for the scope and upstream attribution.

The coding agent loads this package on first script execution. Only injected tools
and helpers are available; scripts have no host filesystem, network or Node globals.
Host tool policy remains the caller's responsibility.

`setTimeout(callback, ms, ...args)` returns a numeric ID for `clearTimeout(id)`.
Use `await new Promise(resolve => setTimeout(resolve, 1000))` to wait. Each script
may create at most 256 timers; delays must be finite numbers from 0 to 300000 ms.
Callbacks must be functions. Timer waits consume the execution budget, including
in active-time mode alongside pending host calls. Script completion, `exit()`,
failure and cancellation release pending timers. Unawaited timers do not keep a
completed script alive; `setInterval` and string callbacks are unsupported.

VM built-ins and their global bindings are read-only before scripts run. Patching
built-in prototypes is unsupported (strict writes throw); use your own objects
or classes instead. Common instance overrides such as `toJSON`, `toString`, and
Error `name`/`message` remain supported. This protects the bridge's shared
intrinsics while retaining native JSON serialization and the existing limits.
Configured globals and namespaces must not shadow a VM built-in or bridge helper
(for example `JSON` or `Math.read`); the sandbox constructor rejects these names.

Limits are defined in `src/limits.ts`: 60 s default / 300 s maximum, 256 MiB VM
memory, 256 bridge calls, 128 Ki UTF-16 source characters, 1 Mi output characters,
and 8 Mi cumulative bridge characters in each direction. The host controller adds
four-way trusted-read concurrency and serial mutation execution. The coding
agent reuses one Worker per sandbox, with a fresh QuickJS VM, bridge budget and
message port for every script. Low-level callers opt in with `reuseWorker: true`
(default: false). Only a successful result sent after VM disposal returns a slot.
Script errors, timeouts, cancellation, Worker failures, or WASM linear memory
above 64 MiB retire the thread. A slot also expires after 30 idle seconds or
64 executions; `close()` waits for termination. Idle threads do not keep Node alive.
Overlapping executions still fail immediately; there is no pool queue or shared VM.
This trades a bounded idle thread's memory for faster consecutive scripts.

Low-level `timeoutMs` remains a wall-time deadline by default. The coding agent
uses `timeoutMode: "active"`: the budget includes startup, bridge delivery and
VM computation, but pauses after the VM and its microtasks drain while waiting
for host tools or approval. Reply sequence counters fence stale idle messages;
an unawaited tool cannot suspend a spinning VM's deadline. Tools retain their
own deadlines and cancellation; a caller that needs a total wall-time limit
can supply a deadline signal. Active mode does not impose a tool wait limit.

Terminating the Worker stops sandbox JavaScript. Host tools must honor their abort
signal: arbitrary host JavaScript that ignores cancellation cannot be forcibly
killed by this package. The controller waits for host calls to settle so it can
report their real effects; Worker timeout is not a hard deadline for such tools.

See the repository's `docs/codemode-default-execution-plan.md` and execution log for
integration, quotas, validation and measured limitations. Tests live in the root
`tests/` runner. The distributed worker and `quickjs-wasi/quickjs.wasm` must both be
available at runtime; bundled hosts must supply an explicit worker URL and WASM.
