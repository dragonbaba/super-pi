# MCP project overrides (F02.1)

## Design gate

Baseline: 501a660683e7ebbcdc2b7c60673b085cdbf274dc. F01 is merged. User authorized the next phase;
F02.1 is the project-override goal. Manager and CIMD remain separate goals.
Baseline repro: a trusted project overriding only toolTimeoutMs for a global
server ID fails with `Project MCP server duplicates global server id`.

Global `allowProjectConfig: true` AND current project trust remain required before
reading the project file. Combine raw same-ID definitions before normalization;
an absent project field inherits the global value. Arrays and objects (args,
env, envFrom, headers, oauth) replace whole fields, never recursively merge.
Explicit null is not a deletion syntax for overrides. Empty arrays/maps clear
their fields; oauth:false disables OAuth. A partial definition for a new ID must
still supply all fields required by its transport. The existing HTTPS, path,
OAuth, file and capacity checks validate the final configuration.

A changed transport/url/command/args/cwd does not inherit headers, OAuth settings,
env or envFrom; the project must explicitly supply them. Changing command or
transport also drops inherited args. This prevents new endpoints/executables
from silently receiving global connection credentials. Basic OS environment
allowlist is unchanged. Comparison is on configured values, before expansion;
equivalent but differently spelled targets may therefore require explicit fields.

Every effective project definition (including a same-ID override) has source
project and canonical project directory scope. OAuth credentials are keyed by
that scope as well as existing server ID/URL/source/OAuth identity. Global keys
remain unchanged; legacy project credentials are left on disk but not reused,
requiring explicit login. Schema/activation fingerprints include this scope;
changed project identity cannot restore a global/other project's activation.
No credential migration, deletion, automatic login or configuration write occurs.

Audited chain: trusted session_start → loadMcpConfig/raw composition → existing
normalizeServer → schema/activation fingerprints → McpBridgeRuntime → OAuth
owner key → transport/discovery → activation restoration → reload/shutdown.
Only startup/config reload and OAuth construction change. Provider deltas,
progress, rendering, ordinary remote calls and warm token lookups are untouched.
Both input files keep their 256 KiB limits, the effective catalog stays at 16
servers; raw map/composed records live only during load and are discarded on
return/throw. Existing runtime/cache owners retain only normalized config and
release it through existing close/replacement. No pool/cache/timer/listener or
asynchronous boundary is added; no unrelated streaming allocation benchmark.

## Verification

Verified: trust gates without reading malformed project input; shallow
replacement/defaults/disabled state and untouched source bytes; final validation
and 16-server bound; target changes strip inherited sensitive fields; global,
project-A and project-B OAuth cache isolation with fake stored credentials;
real bridge lifecycle fails to restore old activations after an override and
does not connect a disabled override. Existing schema and OAuth boundary tests
were selected by impact. No repeated full local suite or external OAuth server.

Windows x64, Node v26.4.0; baseline 501a660683e7ebbcdc2b7c60673b085cdbf274dc.
Raw local logs: `.git/f02-1-mcp-project-overrides-20261011/`.

| Check | Result |
| --- | --- |
| New override/identity tests plus matching bridge regressions | 10 passed |
| Existing OAuth login/identity and keyed schema regressions | 5 passed |
| `tests/source-invariants.test.ts` | 4 passed |
| `npm run check` | Passed |

Commands:

```powershell
node --experimental-strip-types --test --test-name-pattern 'project|changed project targets|same-ID' tests/mcp-project-overrides.test.ts tests/mcp-background-activation.test.ts
node --experimental-strip-types --test --test-name-pattern 'schema cache persists only|keyed schema cache still isolates|changing or removing the override isolates|ordinary connections require explicit login|explicit PKCE login, state validation' tests/mcp-oauth.test.ts tests/mcp-schema-cache.test.ts
node --experimental-strip-types --test tests/source-invariants.test.ts
npm run check
```

Real loopback MCP sequence: global activation → trusted override/re-discovery →
disabled override produced exactly 2 initialize requests, 2 lists, 0 calls;
the disabled phase added 0 requests and restored no activation. Fake saved OAuth
credentials returned only the matching global/project token, made 0 network
requests, and left credential/configuration bytes unchanged. Existing explicit
PKCE login still persisted credentials and closed its callback. OAuth owners,
bridge hosts and HTTP connections close in finally/after hooks; fixture-owned
temporary directories are removed and environment/entrypoint values restored.
No live provider/browser login or cross-platform local run is claimed; repository
CI supplies its normal separate validation after submission.
