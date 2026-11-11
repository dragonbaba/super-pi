# Sandbox workspace paths and optional networking

> Historical record. The Windows Sandbox VM procedures and acceptance commands below are retired. See [current MXC behavior](../execution-environments.md) and the [archive](../documentation-status.md#windows-sandbox-vm-retirement).

## Evidence and scope

- Baseline: `24663237e2e1aebe403215c27f8e7fd9d89dc303` (PR #213).
- Report: PowerShell 7 / Node / npm run, but DNS fails and `ls` rejects an absolute project path with `Invalid search scope`.
- Host inspection: the reported project directory exists and currently contains no entries. An empty guest copy alone is not evidence of snapshot loss.
- Mechanism: the production workspace VM hardcodes `<Networking>Disable</Networking>`; the file-tool adapter forwards host absolute paths unchanged to a guest that accepts relative paths only.
- User explicitly requested optional network access. Preserve default network isolation, global-only configuration, PowerShell 7, workspace boundaries, snapshot/writeback authorization and physical VM ownership. No host execution fallback or whole-drive mapping.
- Scratch owner: `.task-tmp/sandbox-workspace-a58426776bbf/`; process and artifact records remain there until final cleanup.

## Implementation

The backend translates workspace-contained host absolute paths before VM startup, including batch paths and move destinations. It preserves the original authorization arguments and relative-path grammar, refuses external/UNC/device paths, and never rewrites shell source. Tool descriptions provide the actual host workspace, guest cwd and effective network state. The global-only `sandboxNetwork` setting accepts `disabled` (default) or `enabled`, fails closed on malformed values, and takes effect on a new VM after reload. Project settings cannot enable it; the legacy explicit-input task protocol stays offline.

Guest-installed `node_modules` stays private to the VM and is omitted from search/writeback enumeration. Ordinary package manifests and lockfiles still use the unchanged native publication checks and limits. Direct file operations cannot publish dependency paths. Network access uses the Windows Sandbox virtual network, including reachable LAN services; there is no domain allowlist, implicit proxy credential forwarding or firewall modification.

## Acceptance

- Both absolute-path regressions failed on the baseline, then passed with the fix. The final focused set passed **62/62** tests, including permissions, reload, malformed/global-only configuration, batch translation, UTF-8/writeback limits, source invariants, runtime packaging, lifecycle and the PowerShell 7 process gate.
- `npm run check`, `npm run build:offline` (all 12 packages, 11,056 ms), `git diff --check` and offline launcher version `1.0.0` passed. All **41** runtime manifest hashes and the source/distribution guest-worker hash matched.
- Final compiled-distribution live acceptance ran **two VMs / seven calls**: read-only/offline denied DNS and HTTPS; read/write/online resolved the npm registry, fetched HTTPS, installed `is-number@7.0.0` with lifecycle scripts disabled and loaded it with Node. Both used PowerShell **7.6.9**. Candidate files were only `package.json` and `package-lock.json`; no dependency bytes were returned and the host fixture stayed unchanged.
- A separate compiled-distribution probe used the reported real project, confirmed its empty host/guest contents, accepted its absolute `ls` path and resolved DNS. It made no project changes. Each VM closed with `pending=false`, `vm=false`, `sourceFiles=0`, `ownedArtifacts=0`.
- An initial unrelated host-path fixture assumed TEMP and home shared a Windows drive. Its invalid `~/D:/...` spelling is now tested only where a home-relative path exists, with absolute-path coverage on every platform. Production host path rules did not change. A type annotation, fixture cleanup omission and scratch import typo were corrected before final acceptance; no failed run is counted as passing.

Raw counters, hashes and compact receipts: [acceptance evidence](../evidence/sandbox-workspace-network-2026-11-04.json). The former VM acceptance entry points are in the [archive](../documentation-status.md#windows-sandbox-vm-retirement).

## Allocation and ownership audit

Reviewed settings → AgentSession/reload → permission authorization → WorkspaceSandboxTools → WorkspaceSandboxBackend → guest catalog/path checks → C# Job/Pump → CapturedProcess → result/writeback → VM/artifact release. Authorization, publication and output callbacks remain unchanged. New path translation runs once per explicit operation, returns unchanged relative arguments directly, and creates bounded copies only for translated arguments/batches (at most 16 items). Network parsing and tool descriptions belong to configuration/session startup.

The touched guest path validator previously allocated an `every` callback, a regex literal and a protected-name array in its component loop. It now uses a loop, one module regex and string comparisons; AST checks reject those component allocations. The existing split/path-library strings remain. A 200,000-check synthetic-filesystem profile of the actual production helper sampled 834,521,992 bytes total (4,172.61 bytes/check), mostly Node path join/normalize/resolve internals; this is an allocation sample, not retained memory or a before/after speedup. Both tracked helper references released after four GC rounds. No object pool was introduced.

Existing output/permission allocation acceptance observed 272 chunks / 17 MiB, two fixed buffers totaling 32,768 bytes, 200,000 workspace checks and 200,000 ordinary permission checks. Hot callback closures/arrays/wrappers/Promises/controllers stayed zero; all nine tracked references released after four GC rounds. Sampled repeated workspace/ordinary checks were 1,104 / 3,888 bytes. Search performed 200,000 constant-scope comparisons with no per-entry closure/regex/object allocation; dependency directories were traversed zero times and contributed zero writebacks. Catalog hashing retains its one bounded scratch buffer per invocation; guest request state ends with its worker process.

Scratch is retained only through review/CI and will be closed out with exact recorded identities after merge. The evidence file records this historical pending state; the final PR receipt records cleanup and local activation.
