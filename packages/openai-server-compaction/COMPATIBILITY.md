# Pi 0.84 compatibility overlay

This local package is based on `algal/pi-openai-server-compaction` commit
`8a3de2f` and is loaded globally from the repository-owned `.sp/config/settings.json`.

Compatibility validation performed against Pi `0.84.0` and `0.84.1`:

- TypeScript typecheck with `@super-pi/*` `0.84.1`
- Package smoke test, including `ProviderHeaders` null-deletion semantics
- Pi extension/resource startup through `pi --list-models`

The overlay accepts only `>=0.84.0 <0.85.0`. Pi 0.84 changed resolved provider
headers to `string | null`; pi-ai stream calls preserve those markers unchanged,
while direct remote-compaction HTTP requests apply deletions case-insensitively
and never serialize null as a header value. The legacy `compact()` fallback is
skipped when deletion markers cannot be represented safely.

The full live compaction regression suite is intentionally separate because it
makes paid/provider calls. Remote compaction failures normally retain the
extension's portable Pi summary fallback.
