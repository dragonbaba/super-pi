# MCP Client ID Metadata Documents (F02.3)

## Design gate

Baseline: `3fdc4c32cb43b165205f2af6fc2c0548322b6409` (PR #116 merged).
The pinned MCP SDK 1.32.1 already supports `OAuthClientProvider.clientMetadataUrl`,
but configuration drops that field and the bridge never supplies it. A CIMD-only
authorization server therefore reaches unsupported dynamic registration.

Add an explicit `oauth.clientMetadataUrl` and require a fixed `callbackPort`.
The URL must be bounded, canonical HTTPS with a non-root path, no credentials,
dot segments or fragment. Preserve its exact string: the hosted document's
`client_id` must match it. The SDK selects existing/pre-registered information
first, advertised CIMD second, and DCR otherwise. Keep the SDK's issuer-stamped
client record for code exchange and refresh. Changing URL or callback port
already changes the OAuth configuration identity; project scope remains isolated.

Use operator-owned Super Pi metadata with the documented Super Pi name and
repository identity. There is no configured project homepage/metadata host;
provide an opt-in setting and publishable example, without an invented live
endpoint or an upstream Pi identity. Hosting is an explicit deployment prerequisite.

Audited chain: configuration load -> explicit login/manager auth -> existing
callback listener -> McpOAuth.authorize -> pinned SDK discovery/registration
selection -> state/issuer/PKCE checks -> atomic credential commit -> callback
close; refresh retains the same issuer-bound client. This is configuration and
explicit authentication/credential-expiry work, outside ordinary tool execution,
provider deltas, progress, rendering and terminal writes. Warm token lookup is
unchanged. One additional string (maximum 4096 characters) belongs to each of at
most 16 normalized server configurations; provider scope references it only for
the existing authorization lifecycle. No new network fetch, cache, timer,
listener, Promise owner or pool. Existing 1 MiB response, 2 MiB storage, 15-second
request and three-minute login bounds remain. No unrelated allocation benchmark.

Focused verification will cover the pre-fix CIMD-only failure, configuration,
real loopback login/close, SDK selection and refresh, credential identity,
cancellation and reservation cleanup, plus existing issuer/PKCE and source
invariants. No full local suite.

References: [MCP 2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents)
and [CIMD draft-00](https://www.ietf.org/archive/id/draft-ietf-oauth-client-id-metadata-document-00.html),
the protocol basis used by the pinned SDK. The upstream Pi-specific
`clientMetadataDocument(metadata)` API is not this SDK's API.

## Verification (2026-10-12, Windows)

The baseline CIMD-only fixture failed with `Incompatible auth server: does not
support dynamic client registration`. After the adapter change:

- Seven CIMD cases pass: configuration; discovered OAuth and configured OIDC
  login/reopen/refresh; absent/false support fallback; configured and cached client
  priority; cancellation and retry.
- Each CIMD-only success performs zero registrations, one code exchange and one
  refresh, with the document URL in both token requests. Ordinary token lookup
  before login performs zero discovery requests. Reopen/refresh add zero discovery
  requests. Issuer stamps and PKCE remain present, and the fixed callback closes.
- Changing/removing the document URL, changing port or switching to project
  identity cannot read the saved credential. Cancellation leaves an empty store,
  clears the owner cache, closes the callback and permits a successful retry.
- 27 selected existing OAuth regressions pass (scope step-up, metadata setting,
  issuer mismatch, explicit PKCE and ordinary connection identity). Four source
  invariants and `npm run check` pass. No full local suite was run.

Fixtures own temporary directories through `t.after` removal, close the temporary
port reservation and actual login listeners, and close CIMD OAuth owners. No
child process or hosted service is added by this change. The production delta is
13 configuration lines and one provider property; allocation and lifecycle
ownership on hot paths are unchanged.

Raw local evidence: `.git/f02-3-mcp-cimd-20261012/` (`design.md`, `baseline.log`,
`cimd.log`, `regression.log`, `source-invariants.log`, `typecheck.log`). Hosted
metadata and a real external authorization server have not been deployed or
tested; the operator must publish the Super Pi document before enabling CIMD.
