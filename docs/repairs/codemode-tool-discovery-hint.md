# Codemode tool discovery hint (T09.1)

Baseline: `4a4d12f2e39fdbfec21abb04c7da103e85b12e86`, after PR #108.

The unknown-tool Proxy diagnostic recommends `searchTools(query)`, which is not
a script global in either the standalone sandbox or the coding-agent integration.
The actual catalog is `ALL_TOOLS` (script names and descriptions). The agent
additionally registers `describeTools` as a host global: although its host
implementation is synchronous, the VM bridge returns a Promise and scripts must
await it. Standalone sandboxes need not register that optional global.

The change is one fixed diagnostic string: tell scripts to filter `ALL_TOOLS`
by name/description and, when the host provides it, use
`await describeTools([names])` for schemas. No alias or new API is introduced.
Close-match suggestions, membership probes, catalog normalization, dispatch,
error classification and all existing limits remain unchanged.

This is not a provider/progress/render/large-result hot-path change. The literal
is captured during VM prelude initialization and appended only on an invalid
member access. No executable expression, callback, collection, cache, controller,
Promise or ownership state is added. Existing error formatting remains bounded
by `MAX_ERROR_CHARS`; the resulting diagnostic follows the existing script-error
bridge. An allocation benchmark of unrelated rendering would not measure this
literal replacement and is not required for this scope.

Audited route: CodemodeController execution -> sandbox worker -> QuickJS prelude
tool Proxy -> TypeError -> bounded describeError/done -> worker bridge ->
Execution.handleDone/finish -> worker terminate and listener removal -> session
error result. Recovery reads the existing catalog, awaits the registered global
through the same bridge, then dispatches the discovered tool through normal
policy. On success/error/abort, finish clears its deadline and abort listener,
pending calls and tool/global references, and awaits worker termination. The
controller clears invocation records/shown blocks and releases current in finally.
The change adds no resources or new cleanup requirement.

## Verification

Windows x64 / Node v26.4.0, 2026-10-11. Both new checks fail on the baseline
because the runtime/session error still names `searchTools` and omits the
awaited schema lookup. After the literal change:

- Standalone runtime: an unknown member remains a script TypeError with a close
  match and zero dispatched calls. Catalog lookup then calls the normalized
  tool successfully; neither `searchTools` nor `describeTools` has been invented
  as a standalone global. Final counters: active executions 0, workers started
  2, workers stopped 2, after awaiting sandbox close.
- Agent session: an initial unknown call returns the corrected guidance with
  zero child calls. The next script selects `read` from `ALL_TOOLS`, awaits its
  actual declaration through `describeTools`, and reads the fixture successfully.
  Existing session fixtures close their runtime and remove their owned directory.
- Three existing catalog invalidation/identifier-collision checks pass, covering
  both runtime aliases and session `describeTools` names. Eight Codemode hot-path
  invariants and four global source invariants also pass: 17 checks in total.
- Type checking and the Codemode build pass. No repeated local full suite and
  no allocation benchmark for a literal-only diagnostic edit. Complete platform
  coverage is left to the normal Linux/Windows PR CI.

```powershell
npm.cmd run build --workspace @super-pi/codemode
node --experimental-strip-types --test --test-name-pattern 'unknown tool|catalog snapshots|tool names that normalize|colliding tool names' tests/codemode-runtime.test.ts tests/codemode-session.test.ts
node --experimental-strip-types --test tests/codemode-hot-paths.test.ts tests/source-invariants.test.ts
npm.cmd run check
```

Raw logs: `.git/t09-1-codemode-tool-discovery-hint-20261011/`. The runtime fixture
loads source worker/prelude; the session fixture loads the built Codemode package,
so the package is rebuilt before candidate validation. No online provider or Bun
executable is exercised; prototype-mutation compatibility (T09.2), output
boundaries (T09.3) and installation replacement (T09.4) remain separate tasks.
