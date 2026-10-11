# Codemode built-in mutation compatibility (T09.2)

## Design gate

Baseline: `b92d5df0140bacb008d8def133b9ec3dcda80e52`, Windows x64,
Node 26.4.0, QuickJS WASI 3.6.2. The two production-worker probes
`Array.prototype.toJSON = () => null` and `Object.prototype.toJSON = () => 5`,
followed by `store()` and `return 7`, both fail with the sandbox error
`Invalid Codemode store writes`. Each subsequent `return 7` succeeds. All four
workers stop before their execution promises resolve. No host crash or
cross-execution contamination was reproduced.

The prelude captures `JSON.stringify`, but the encoder still resolves inherited
`toJSON` dynamically on the bridge's own arrays and records. Its Map, Promise,
iterator and string operations also share intrinsics with the user script.

Two approaches were compared before changing production code:

| Approach | Compatibility and cost |
| --- | --- |
| Independent bridge serialization | Null-prototype records alone do not protect nested arrays, spread arguments, error records, Map iteration or Promise settlement. Protecting the whole bridge would require captured intrinsic operations and a separate encoder or realm. Skipping inherited `toJSON` changes ordinary JSON semantics, while an additional encoder risks repeated scans/copies on large results. |
| Freeze VM built-ins once before the script | Prevents mutation of the shared dependencies without replacing the native encoder or changing per-call serialization. Scripts that monkey-patch built-ins must use their own objects instead. Plain freezing also prevents common instance assignments; configurable prototype data properties need override accessors to retain Error subclasses and ordinary instance overrides. |

Choose the startup-only intrinsic freeze from the relevant part of upstream
[b223082bb](https://github.com/earendil-works/pi/commit/b223082bb2ceecd197e5477b8da183eea24f3984),
including instance override compatibility. Traverse built-in globals and the
intrinsics reachable only through iterators/generators/typed arrays, so replacing
an indirect prototype cannot re-open the same bridge failure. Built-in global
bindings become read-only; user globals remain extensible. Preserve instance
and user-class `toJSON`, Date JSON, tool/global calls, store deletion and `exit()`.
Bound error descriptions and provide a literal fallback when a thrown value has
unreadable fields. Do not import the upstream host rewrite: this host already
validates/bounds messages and catches decoding errors before `finish()`.

## Ownership and audited chain

`CodemodeController.execute/ensureSandbox` → `CodemodeSandbox.execute` → one
`Execution`/Worker → QuickJS `main` → prelude initialization → user script →
`caller`/output/store helpers → primitive bridge → worker `post`/`BridgeBudget` →
host message validation → `handleCall`/`BoundedJson` or `handleDone`/store parsing →
`finish` → worker termination/listener removal → execution removal → controller
result projection and invocation cleanup.

The new graph traversal runs once per fresh VM before user code, never per tool
call, output item, provider delta, progress event or frame. Its Set/queue and
property descriptors are bounded by that VM's built-in graph, not by script
input; the traversal locals leave scope before the script runs. Override
accessors retain only their built-in owner/key/value for the VM lifetime, which
ends with worker termination on success, failure, timeout, abort or close.
No pool, cross-execution cache, timer, process or persistent host owner is added.

Native JSON serialization and the existing argument/output/store/bridge limits
stay unchanged. Existing per-call Promise/executor, arguments array, pending
entry, host AbortController and reply objects are unchanged; added per-call,
per-output and per-frame allocations are zero. Error-description changes are a
bounded failure boundary. The named startup-only allocation owners are
`lockdown`, `add` and `allowOverride`; they are inaccessible to user code after
initialization. Relevant source invariants and the existing runtime benchmark
cover the unchanged hot bridge and host lifecycle; host sampling does not
measure the QuickJS heap inside workers.

## Verification

The three new runtime checks fail on the baseline and pass with the repair.
They cover prototype/global writes, indirect intrinsics, ordinary instance and
class JSON overrides, Date, Error subclasses, tool/global calls, text, store
set/delete, `exit`, strict/defineProperty/setPrototypeOf rejection, unreadable
thrown values and subsequent reuse. Twelve execution workers in these checks
all stop, with zero active executions. Host Array/Object prototypes are unchanged.
The compiled-package AgentSession fixture additionally verifies discovery,
`callTool`/`show` of a real read, committed state and discarded writes after failure.

Focused checks (39 passed, zero skipped):

```powershell
npm.cmd run build --workspace @super-pi/codemode
node --experimental-strip-types --test tests/codemode-runtime.test.ts tests/codemode-hot-paths.test.ts tests/source-invariants.test.ts
node --experimental-strip-types --test --test-name-pattern 'built-in patch attempts|successful state writes|unknown tool guidance' tests/codemode-session.test.ts
npm.cmd run check
```

This includes the existing CPU/microtask deadlines, cancellation/listener
release, unsettled Promise, output/call/argument/return/store limits, rollback,
catalog reuse and closed-sandbox checks. No full local suite was repeated.

One sequential baseline/candidate pair of
`node --expose-gc --experimental-strip-types scripts/bench/codemode-runtime.ts`
on the same machine, with no concurrent tests/builds:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Warm execution median (ms) | 40.4603 | 42.1491 |
| Warm execution p95 (ms) | 43.3090 | 45.1584 |
| 100-call batch (ms) | 47.6050 | 51.9165 |
| Sampled host bytes | 2,502,776 | 2,517,920 |
| Workers started / stopped | 32 / 32 | 32 / 32 |
| WeakRefs retained after five event-loop/GC turns | 0 / 128 | 0 / 128 |

The graph freeze adds VM startup work; these single-pair timings are observations,
not a claimed speedup or a precision estimate of VM allocation overhead. Host
allocation sampling excludes worker heaps and AgentSession/UI. Worker termination
releases the entire WASM instance; the GC probe verifies sandbox/catalog/tool/result
host owners. There is no new per-call encoder, result copy, pool or retained cache.

Candidate prelude SHA256:
`8743866734DEF03CBCE8759F296BF01A89BFF2B706462F17631215ED587EB4B5`.
Raw evidence is in `.git/t09-2-codemode-builtins-20261011/` (local only).
No online provider, real terminal or Bun executable acceptance was attempted.
T09.3 output presentation and T09.4 install replacement are separate tasks.
