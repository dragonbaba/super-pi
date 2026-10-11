# Codemode worker installation replacement (T09.4)

## Design gate and reproduction

Baseline: `b94c3e5e49985453b5afde17e15a81cf230347e2` (PR #111 merged).
The supported source launcher is `scripts/superpi.mjs`, which loads the built
coding-agent CLI. `CodemodeController.ensureSandbox` lazily imports the Codemode
package; its default worker URL is a sibling `worker.ts` for source or `worker.js`
for dist. Each execution loads a fresh worker from that location. The recorded
2026-10-05 global launcher delivery also resolves to this source launcher and
dist CLI (`.git/global-superpi-rebuild-20261005/global-summary.json`); this is
historical delivery evidence, not a new global-install acceptance run.

A real-worker fixture warms the sandbox, moves its isolated installation
directory, and executes again using the retained worker URL. Baseline returns
only `Cannot find module '.../installed/worker.ts'`, with no recovery guidance.
The fixture fails its restart-hint assertion. No actual installation is moved.

The smallest repair is a bounded diagnostic at the existing worker startup/error
boundary for Node's missing-file/module codes (`ENOENT`, `MODULE_NOT_FOUND`,
`ERR_MODULE_NOT_FOUND`). Explain that a running process may refer to replaced
files, recommend restarting and resuming after an update, and rebuilding or
reinstalling if the failure persists. Preserve the original error and sandbox
classification. Do not guess another installation, add a retry loop, or replay a
script: tool effects are not transactional. Unrelated errors keep their messages.

## Call chain and ownership

Audited chain: `CodemodeController.execute` → lazy `ensureSandbox` →
`CodemodeSandbox.execute` → WASM readiness → `Execution.start` / Worker →
constructor failure or worker error → `finish` → worker termination / listeners
removed → sandbox running-set removal → controller `[CODEMODE_SANDBOX]` result,
existing token cap and invocation cleanup. A fresh explicit execution may load
restored files; there is no automatic re-execution.

The change is confined to worker startup/fatal diagnostics. It does not run on
provider deltas, worker output/tool messages, progress, render, large-output
projection or Evidence Ledger lookup. The helper adds no state, collection,
Promise, callback, timer, cache or pool. A missing-file error creates one bounded
diagnostic string within the existing `MAX_ERROR_CHARS` limit. Existing worker,
deadline and abort ownership remain with `Execution`; `finish` clears the timer,
abort listener, pending calls and tool/global references, waits for termination,
then removes worker listeners before resolving. Tests own their temporary roots
and remove only those recorded roots after closing the sandbox.

## Verification

Windows x64 / Node 26.4.0: 20 checks passed, zero skipped; the type check and
Codemode package build passed:

```powershell
npm.cmd run build --workspace @super-pi/codemode
node --experimental-strip-types --test tests/codemode-worker-recovery.test.ts
node --experimental-strip-types --test --test-name-pattern 'shares the compiled|abort releases|catalog snapshots|store preserves' tests/codemode-runtime.test.ts
node --experimental-strip-types --test tests/codemode-hot-paths.test.ts tests/source-invariants.test.ts
npm.cmd run check
```

The four new reported checks cover source and compiled workers using the public
`workerUrl` option. Tiny isolated entry/dependency files import the real source
or dist worker, so files can disappear without touching the installed runtime.
Each variant warms successfully, fails with a missing entry, fails with a missing
dependency, then succeeds on an explicit execution after restoring the files.
Both failure results contain no output, child calls or committed store writes;
the host tool call count remains unchanged. Abort-listener and active-execution
counts return to zero, and started/stopped workers match after every failure.

The diagnostic check preserves an unrelated worker error even when its text
contains `Cannot find module`, bounds an oversized `ENOENT` error to 16,384
characters while keeping the guidance, and preserves the synchronous invalid
worker-path diagnostic. New fixtures start and stop 10/10 workers in total;
the invalid path starts zero. Each fixture closes its sandbox and verifies its
recorded temporary root is gone. Four existing runtime checks cover ordinary
execution/isolation, script-error store rollback, cancellation, overlapping
execution and close. Eight Codemode hot-path and four global source invariants
also pass.

No production hot path changes: only the existing worker constructor catch and
fatal error callback call the helper. It uses the existing bounded error text,
an optional startup prefix, a bounded tail slice and a fixed hint concatenation;
all additional text work is on failure. No allocation benchmark, controlled-GC
experiment, full local suite or unrelated build was added for this diagnostic
change. The deterministic cleanup assertions exercise the existing ownership
contract; they are not a new heap-retention measurement.

Limits: the isolated fixtures do not replace a real user installation, launch a
real interactive session, test an embedded Bun executable, or prove that a
restart repairs a persistently broken installation. Early Codemode package
import or QuickJS WASM-loading failures retain their separate existing paths.
There is no change to the installer, module resolver, session replay or quotas.
Raw evidence: `.git/t09-4-codemode-worker-recovery-20261011/`.
