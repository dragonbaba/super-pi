# @super-pi/mcp-bridge

A guarded generic MCP client extension for Pi `0.84.x` hosts that provide the internal typed-source adapter. It exposes configured MCP server tools as namespaced Pi tools and supports stdio, Streamable HTTP, and legacy HTTP+SSE. Older hosts in the same version line are detected before runtime loading and receive an upgrade warning instead of a missing-export crash.

Large text and typed resource/audio results require configured ToolResult presentation and a sufficient token budget. Recovery uses the existing session artifact owner (`session.readToolResultArtifact`); it is local recovery, not server pagination. Small inline text and supported inline images retain their existing path. If a configured budget cannot contain even failure text, the final error has zero model text and preserves its explicit configuration reason in canonical ToolResult details.

## Commands

- `/mcp` — interactive server status, tool inspection, sign-in/sign-out and reload.
- `/mcp-status` — connection state, transport, server version, and tool count.
- `/mcp-tools` — Pi tool name → MCP server/tool mapping.
- `/mcp-reload` — reload Pi resources and reconnect from disk.
- `/mcp-login <server>` — explicitly authorize an HTTP/SSE server using its browser URL.
- `/mcp-logout <server>` — remove that server's stored OAuth credentials and reload.

The `/mcp` manager opens immediately while discovery continues. Select a server
to inspect its source, transport, connection state and available tool names;
**Refresh status** reads the latest snapshot. Viewing tools does not activate or
execute them. **Reload configuration** reloads resources from disk and reconnects
using the current trust and configuration rules.

OAuth servers offer **Sign in** and **Sign out**, sharing the same credential
identity and lifecycle as the standalone commands. Sign-in shows the authorization
URL in a scrollable status view. Escape or **Cancel** stops the operation and waits
for cleanup; shutdown/reload also cancels and waits. Only one manager or manager
authentication flow can open at a time. Successful auth closes the status view
before reloading resources. Noninteractive modes retain the standalone commands,
and `--no-mcp` prevents the manager from opening.

The manager uses explicit status refresh, without polling. Configuration editing
and persistent enable/disable remain in the configuration files; the manager
does not rewrite them. Connection credentials, environment values and command
arguments are omitted from its status/tool views.

Remote tools are registered as `mcp__<server>__<tool>` (bounded and collision-checked) and execute sequentially. They are deferred by default: call `tools.mcp_search_tools` with capability words to activate up to eight matching tools, then use `callTool(name, args)` in the same Codemode script. Changed schemas are refreshed on reconnect; tools removed from the server catalog are rejected before any remote execution. Remote `readOnlyHint` alone does not authorize concurrent execution.

## Startup and restoring activated tools

Session startup performs local configuration/cache setup, then connects uncached
servers in the background. `/mcp-status` shows connections in progress. Tool
search waits for outstanding discovery so it does not incorrectly report an
empty catalog; a call to an already registered cached tool waits only for that
tool's server. Concurrent callers share the connection attempt. Cancelling a
search or a cached-tool waiter stops that wait without cancelling another
caller's connection. Shutdown/reload cancels and closes the old runtime.

A transient connection or discovery failure keeps the last fully registered
catalog searchable and its activated tools available. `/mcp-status` retains the
connection error; the next explicit tool call reconnects without requiring
`/mcp-reload`. Once a replacement catalog arrives, it must register completely
before becoming eligible; rejected catalogs and tools removed by the server do
not inherit the old catalog's availability.

Successful `mcp_search_tools` activation records an intent in the current session
branch, only for tools the host actually activated: names ignored by a host tool
policy (such as an allowlist) are reported as not activated and never recorded. Reload and session reopen restore only tools whose exact server/tool
identity, workspace and configuration still match the available catalog.
Cached catalogs remain lazy and are checked against the server before a call;
uncached tools become active when background discovery confirms them. Removed,
disabled or renamed tools are not restored. Changing configuration requires a
new search to activate its tools. Navigating the session tree uses that branch's
latest activation state.

A remote tool activated by other means (not through search) stays active while
its server's catalog still contains it, including after later discovery or
reconnects. It is not recorded, so startup, reload, session reopen and tree
navigation apply only the recorded search intent.

Records contain tool names and identity hashes, not connection settings or
credentials. Because the configuration digest covers header, environment and
argument values, each identity is an HMAC under a random machine-local key
(`~/.sp/agent/mcp-activation.key`, created on first use), so a copied session
file cannot be used to test guesses of those secrets offline. A session opened
with a different key, or a missing/unreadable key, restores no activations;
without a usable key, intent is not recorded.

Repeating a search without changing intent does not append another record. A
changed search appends only the changed identities; a full snapshot replaces
them once the deltas since the previous snapshot would be at least as large, so
persisted data grows linearly with activation changes. At most 2,048 intents are
retained; recording a changed identity for an existing name makes it the most
recent, and the least recently recorded identity is displaced when that bound is
reached. Existing sessions without these records begin with
remote tools deferred and acquire records on subsequent searches. Tool failures
are never automatically replayed.

## Global configuration

Create `~/.sp/agent/config/mcp.json`:

```json
{
  "version": 1,
  "allowProjectConfig": false,
  "servers": {
    "godot": {
      "enabled": true,
      "transport": "stdio",
      "command": "C:\\absolute\\path\\to\\node.exe",
      "args": ["C:\\absolute\\path\\to\\godot-mcp\\server.js", "--project", "${workspace}"],
      "cwd": "${workspace}",
      "envFrom": ["GODOT_PATH"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 120000,
      "maxTools": 64
    }
  }
}
```

`command` must be an existing absolute, non-symlink file. Arguments are passed directly without a shell. `${workspace}` may be used in `args` and `cwd`. The child environment is an allowlist consisting of basic OS process variables, explicit `envFrom` names, and explicit `env` values.

### Streamable HTTP

```json
{
  "version": 1,
  "allowProjectConfig": false,
  "servers": {
    "engine": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "${ENV:MCP_ENGINE_TOKEN}"
      }
    }
  }
}
```

Use `"transport": "sse"` for a legacy SSE endpoint. Remote URLs require HTTPS; loopback HTTP is allowed for local engine integrations. Redirects and cross-origin transport endpoints are rejected so configured authorization headers cannot be silently forwarded elsewhere.

For OAuth, replace the `Authorization` header with `"oauth": true`, or `"oauth": {"scope": "tools.read", "clientId": "registered-client", "callbackPort": 49152}`. A fixed client ID requires a registered loopback callback port; otherwise configure CIMD below or use a server that supports dynamic registration. Run `/mcp-login engine`, open the displayed authorization URL, and complete the browser flow. Login uses PKCE and a state-checked `http://127.0.0.1:<port>/callback`, closes after completion/cancellation, and expires after three minutes. Ordinary connections do not open browsers or start registration automatically.

### Client ID Metadata Documents (CIMD)

For a server that advertises `client_id_metadata_document_supported: true`,
configure your own publicly reachable HTTPS client metadata document:

```json
"oauth": {
  "clientMetadataUrl": "https://your-domain.example/oauth/super-pi.json",
  "callbackPort": 49152
}
```

Publish the following JSON at that URL, replacing the example domain with a host
you control. Serve it as `application/json` without authentication or redirects.
The `client_id` must exactly match the configured URL, and `redirect_uris` must
include the exact loopback callback port. This bridge uses Super Pi's identity;
do not copy another application's client document, including upstream Pi's.

```json
{
  "client_id": "https://your-domain.example/oauth/super-pi.json",
  "client_name": "Super Pi MCP",
  "client_uri": "https://github.com/dragonbaba/super-pi",
  "application_type": "native",
  "redirect_uris": ["http://127.0.0.1:49152/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

There is no built-in hosted document or default CIMD URL. `clientMetadataUrl`
accepts a canonical HTTPS URL of at most 4096 characters with a non-root path,
no credentials, dot segments or fragment, and requires `callbackPort`. Unlike
authorization-server metadata URLs, loopback HTTP is not accepted. The bridge
preserves the URL exactly, without normalization; the authorization server fetches
and validates the document. Super Pi does not fetch it or host it on the callback
listener. Publishing and keeping that document consistent is the operator's responsibility.

Existing/pre-registered client information takes priority (including `clientId`
if both settings are present). Without existing information, the SDK uses CIMD
only when advertised, and otherwise attempts dynamic registration. A server that
supports neither requires a pre-registered client. Once CIMD is selected, a failed
authorization is reported without silently switching registration methods.
The URL client ID remains issuer-bound through code exchange, reopening and
refresh. Changing/removing the URL or changing the callback port isolates stored
credentials and requires login again. HTTP and SSE, trusted project overrides,
scope and `authServerMetadataUrl` use the same configuration and ownership rules.

### Issuer validation and authorization-server metadata

OAuth/OIDC discovery validates the metadata issuer before registration or token
requests, including when reusing stored discovery. Callback `iss` must match the
issuer bound to that login; it is required when the server advertises support.
Duplicate or mismatched issuers fail before code exchange. Legacy servers that
do not advertise support may omit `iss`. Discovery comparison removes at most one
trailing slash from each issuer, matching upstream Pi; all other characters must
match. The metadata issuer is preserved unchanged. Callback values and the issuer
bound to a login compare exactly, including case, encoding and trailing slashes.
Previously stored metadata is rediscovered on the first login or refresh to
recover issuer support flags omitted by older versions. Successful upgrades are
cached; failed discovery leaves existing credentials intact and requires a retry.

Stored tokens and client registrations must also carry the authorization server's
`issuer`. Caches from versions that did not save it cannot be used for requests or
refresh: run `/mcp-login <server>` to sign in again. That explicit login discards
unbound credentials and discovery only in its temporary draft, obtains fresh
credentials, and replaces the stored record after success. Failed or cancelled
migration preserves the old record, but does not make its credentials usable.
Old client secrets and refresh tokens are never assigned an issuer by inference.

Fixed `clientId` values are bound to the validated discovery issuer during the
explicit login, before code exchange. SDK retries cannot erase an operation's
issuer binding, fall back to an unbound fixed client, or silently register a new
client while refreshing. If an already-bound authorization server changes, first
verify the new server, then run `/mcp-logout <server>` and `/mcp-login <server>`.
Valid cached token lookups reuse the initial validation without repeated
discovery, JSON parsing or URL construction.

If the MCP server advertises the wrong authorization server, or none, configure
the correct **metadata document URL**:

```json
"oauth": {
  "authServerMetadataUrl": "https://identity.example.com/tenant/metadata.json"
}
```

This works with both HTTP and SSE transports and can be combined with `scope`,
`clientId` and `callbackPort`. The URL must use HTTPS (loopback HTTP is allowed)
and must not contain credentials or a fragment. OAuth and OIDC metadata documents
are supported; the path does not need to be a standard `.well-known` path.

The configured document supplies the initial issuer, which may differ from the
document's host/path and from the MCP server's advertised authorization server.
Protected resource and scope checks still apply. Callback `iss` and any SDK
rediscovery remain bound to that login's issuer. Metadata is validated and cached
with the credentials; reopening a valid cache or refreshing tokens reuses it.
Missing or outdated metadata is reloaded from the configured URL, preserving the
cached issuer so existing credentials cannot follow an issuer change. A failed
load stops authorization without falling back to another metadata document.
These requests retain the 1 MiB limit, cancellation and redirect restrictions,
and do not inherit MCP request headers. Changing or removing this setting changes
the credential identity: run `/mcp-login <server>` again.

This cache policy intentionally differs from upstream Pi v1.0.0, which reloads
configured metadata on each authorization flow. Repeating `/mcp-login <server>`
with the same configuration still reuses complete cached metadata. If the server
changes its endpoint addresses, run `/mcp-logout <server>` followed by
`/mcp-login <server>` to fetch fresh metadata. This trades automatic endpoint
updates for fewer requests and a stable cached issuer binding.

Credentials are isolated by server identity in `~/.sp/agent/mcp-auth.json`, using
the host's file locking and atomic persistence. Interactive login reserves a
bounded attempt, releases the lock during browser authorization, then re-reads
and merges the current file when committing. Another service's writes are
preserved; logout invalidates a pending login, and a second active login for the
same server is rejected. Cancellation removes its own reservation, with an expiry
for abandoned attempts. Sync and async access use the same lease parameters.
Metadata/token requests do not inherit MCP headers. OAuth and a static
`Authorization` header cannot be combined.

Successful authorization-code and refresh responses require a non-empty
`token_type`, matching upstream Pi v1.0.0. An empty string is rejected rather
than defaulted to `Bearer`; missing, null, or non-string `token_type` values
are still rejected by the SDK.
Invalid login or refresh responses do not replace saved credentials. An invalid
refresh response follows the SDK's existing explicit-reauthorization path.

If an OAuth server returns HTTP 401 or 403 with a Bearer
`error="insufficient_scope"` challenge, the bridge saves the requested scopes and
reports `authorization-required`. Run `/mcp-login <server-id>`, review the
authorization URL and consent screen, and then explicitly retry the denied tool.
The login combines configured scopes, previously granted scopes, and the new
request, removing duplicates while retaining case. A missing challenge scope
still requires explicit login using the known scopes. This flow never opens a
browser automatically, refreshes to try to gain permissions, or replays the
denied tool. An ordinary 401 without this challenge retains the existing single
refresh/retry; a plain 403 does not trigger authorization.

HTTP and SSE connections both report `authorization-required` with
`/mcp-login <server-id>` when token lookup or refresh requires explicit login.
This includes an ordinary 401 without a usable refresh token. A 401 alone is
not classified as a login requirement: a successful refresh can still connect,
and a second 401 is returned to the SDK after the single retry. Network errors,
cancellation and startup timeouts retain their existing classifications.

Scope requests are hints, not grants. They survive restart in the same credential
entry until consumed by a successful login or cleared by logout; changing the
OAuth configuration selects a different credential identity. Concurrent requests
are combined under the file lock, and requirements arriving during consent remain
for the next explicit login. Denial or cancellation preserves old credentials and
pending requirements. An explicit token-response scope is authoritative, even
when narrower than requested; an omitted scope retains the authorization request
scope (or the previous grant on refresh). A dynamically registered client whose
registered scope does not cover the step-up request (or whose registration did
not report one) is registered again for the combined scopes; a fixed `clientId`
is never replaced.

Challenge parsing is limited to 8,192 characters and accumulated scopes to
4,096 characters. Malformed, ambiguous or oversized challenge headers are not
accepted as scope requirements. They retain the ordinary response handling:
401 permits at most one refresh/retry, and 403 is returned to the SDK unchanged.
No scope hint is saved for an unrecognized challenge. Only Bearer scope
requirements are consumed: `resource_metadata` in a challenge does
not change discovery or the authorization server. Existing resource matching,
issuer validation, configured metadata URLs, PKCE and callback checks still apply.
Browser/provider interoperability needs testing against the chosen server; the
repository tests use offline OAuth responses, real loopback callbacks and MCP
HTTP/SSE transports, including a separate process writing during authorization.

## Project configuration

A trusted project may define `.sp/config/mcp.json` only when the global file sets
`"allowProjectConfig": true`. Both gates are checked before reading the project
file. Keep this disabled unless repositories containing MCP configuration are
fully trusted: a stdio MCP server is executable code with the user's permissions.

Project definitions may add servers or override individual fields of a global
server with the same ID. For example, a project can change only the timeout of a
global `docs` server:

```json
{
  "version": 1,
  "servers": {
    "docs": { "toolTimeoutMs": 60000 }
  }
}
```

Absent fields inherit the global value. Arrays and objects replace the entire
field: `headers: {}` clears configured headers, `args: []` clears arguments, and
`oauth: false` disables OAuth. `env: {}` clears explicit environment values;
`envFrom: []` clears additional inherited names. The basic OS environment
allowlist remains. Nested OAuth settings are not merged, and `null` is not a
deletion syntax for overrides. Use `enabled: false` to disable a server. New IDs
must provide a complete definition. The resulting configuration retains all
existing path, transport, OAuth and capacity validation, including 16 total
servers. Neither configuration file is rewritten.

If an override changes `transport`, `url`, `command`, `args` or `cwd`, it must
explicitly provide any needed `headers`, `oauth`, `env` and `envFrom`; these fields
are no longer inherited from the global target. Changing `transport` or `command`
also drops inherited arguments. Targets are compared as configured, before
expansion, so differently spelled equivalent paths/URLs can require explicit
settings too.

Each project definition, including an override, has its own project identity.
OAuth credentials and schema/activation identities include the canonical project
directory; global credentials and other projects' credentials are not reused.
Existing global OAuth keys stay compatible. Legacy unscoped project credentials
remain on disk but require a new explicit `/mcp-login`; they are not migrated or
automatically used. Global tool activation history cannot authorize a project
override. Search for its tools again to activate the project definition.

## Safety boundaries

- Pi runtime gate: only `0.84.x`.
- Validated schema metadata is cached under `~/.sp/agent/cache/mcp-schemas-v1.json` (2 MiB total, 16 entries, 30-day age bound). The filename is retained for upgrades; its current payload version is 2. Commands, URLs, environment values, and headers contribute to an in-memory configuration digest. Only an HMAC of that digest is persisted, using the existing `mcp-activation.key` with a schema-cache-specific domain. Cache metadata is not encrypted, and the HMAC identifies the configuration rather than authenticating the whole file.
- Without a usable local key, schema caching is disabled and servers are discovered normally. A different key cannot reuse the previous cache. Legacy version-1 caches are never reused and are replaced with an empty version-2 cache on load before rediscovery, even if the key is unavailable. If file permissions prevent replacement, the legacy file remains on disk but is not used; it must be removed or made writable separately. Previously copied legacy files are outside this upgrade's protection.
- Startup checks for a legacy cache before parsing global or trusted-project
  MCP configuration, so missing, empty, or invalid configuration cannot prevent
  migration. This preparation does not create a key, construct an MCP runtime,
  or load the MCP SDK. Valid version-2 caches stay unchanged; missing caches
  are not created. Configured runtimes reuse the bounded read snapshot instead
  of reading and parsing the cache a second time; configuration errors still
  appear unchanged.
- Readable regular cache files within the size limit are also reset when their
  JSON is malformed or their top-level format lacks numeric version 2 and an
  `entries` array. A truncated legacy fingerprint is therefore scrubbed even
  when its version can no longer be parsed. This recognizes the v2 format;
  existing per-entry/schema validation still applies, and it does not authenticate
  the file. Missing files, symlinks, directories, oversized files and read failures
  remain outside the replacement path. Failed replacements are never reused.
- A cache hit registers deferred tools without starting the MCP server; the first actual remote call connects and refreshes the cache. A cache miss connects once at startup to discover schemas.
- At most 16 configured servers, 128 tools per server, and 64 KiB per tool schema.
- Tool descriptions, errors, and text/resource output are stripped of ANSI/OSC/control sequences.
- Text is bounded to approximately 50 KiB; images are bounded to 5 MiB each and 10 MiB total. Response bodies are capped at 10 MiB, SSE events at 4 MiB, and content arrays at 256 items before conversion.
- MCP audio/blob content is not injected; metadata is returned instead.
- Calls support cancellation and hard total timeouts; pre-aborted calls do not create a new client, and oversized/aborted readers are explicitly cancelled.
- A disconnected server may reconnect before a new call. A failed or timed-out tool call is never automatically replayed because it may have performed a destructive action.
- Session shutdown closes every MCP client and stdio transport and clears stale remote-tool names.
- Tool results are data, not trusted instructions. Only configure MCP servers you trust.

## Activation

The package is loaded by the repository-owned `.sp/config/settings.json`. After changing the extension itself, fully restart Super Pi. After changing only `mcp.json`, use `/mcp-reload`; treat reload as terminal for that command.
