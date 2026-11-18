# Offline build after the Kimi catalog split

Refreshing the catalog removed the Kimi shard referenced by the provider (TS2307). The generated aggregator, JSON and manifest agreed with each other and passed their consistency check. OpenCode Go also gained a Google Generative AI model; its provider omitted the adapter for that protocol (TS2322).

The generator reads the CN plan for the registered kimi.com endpoint and accepts the previous source key for older catalogs. Strict generation fails before publication if the selected source yields no eligible models. OpenCode Go now maps the Google protocol to the existing lazy adapter.

A strict generation in a separate directory yielded six Kimi models. All 38 other provider JSON payload hashes matched the working catalog. The local type check, 41 catalog tests and all 12 offline package builds passed. A dist probe intercepted the Google SDK request to `/zen/go/v1/models/gemini-4-argon:streamGenerateContent` with a synthetic HTTP response. This covers adapter selection and URL construction. No live inference was exercised. The change touches catalog generation and provider setup; no hot path changed.

```powershell
npm run check
node --experimental-strip-types --test tests/model-catalog-pricing.test.ts
npm run build:offline
```
