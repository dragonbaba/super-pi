# @super-pi/codemode

QuickJS WASI execution in a separate, terminable worker. Imported from official Pi
v1.0.0 (`a13d35a74`), under the accompanying MIT license, then adapted to Super Pi's
bounded resource and allocation contracts. The low-level Agent has no VM dependency.

The coding agent loads this package on first script execution. Only injected tools
and helpers are available; scripts have no host filesystem, network, Node globals
or timers. Host tool policy remains the caller's responsibility.

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
four-way trusted-read concurrency and serial mutation execution. No Worker or
object pool is used; only the compiled WASM and unchanged catalog are reused.

Terminating the Worker stops sandbox JavaScript. Host tools must honor their abort
signal: arbitrary host JavaScript that ignores cancellation cannot be forcibly
killed by this package. The controller waits for host calls to settle so it can
report their real effects; Worker timeout is not a hard deadline for such tools.

See the repository's `docs/codemode-default-execution-plan.md` and execution log for
integration, quotas, validation and measured limitations. Tests live in the root
`tests/` runner. The distributed worker and `quickjs-wasi/quickjs.wasm` must both be
available at runtime; bundled hosts must supply an explicit worker URL and WASM.
