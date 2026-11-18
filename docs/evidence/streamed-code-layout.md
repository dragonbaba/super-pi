# Streamed code layout

An incomplete closing fence can change Markdown source without changing the parsed code. Incremental rendering now compares the rendered inputs of a solitary code token. Its language and body use the existing bounded component signature cache. Width, parser eligibility, invalidation and release still govern reuse. Multi-token spacing retains its lookahead guard. On a cache miss the renderer can emit a fitting single line directly and share adjacent equal-width padding within one render.

The audited path runs from latest observer delivery through InteractiveMode, AssistantMessage, Markdown, retained viewport, alternate screen and frame queue to the sink. The new signature and padding are strings. The change adds no per-update callbacks, promises, controllers, wrappers, retained arrays or global scratch.

Windows x64, i7-14700KF, Node 26.13.0, base `3055eecad`. At 10,000 code rows and 80 fence updates, full output SHA-256 stayed `98b3f7c080a4215cad925e3f6ab574f10f3012af25026baa33473c5258520a1a`. Sampled bytes fell from 807,106,352 to 66,398,088. Update p50/p95 under sampling changed from 5.94/10.63 to 0.49/0.87 ms. Observed peak heap changed from 283.7 to 33.2 MB, post-release controlled heap from 20.9 to 11.7 MB. All 81 tracked references were released on each side. The regression counts one highlighter invocation across three equivalent fence states and checks fresh output across body, width, language, token-neighbor and invalidation changes.

For continuously growing highlighted TypeScript, sampled bytes per delivery changed from 6.52 to 4.83 MB with identical full output. Separate timing-only p95 was 121.40 versus 122.24 ms. The leading baseline CPU site was the TypeScript grammar matcher in highlight.js. Full rehighlighting of a changing multiline token remains expensive. Prose p95 was 0.52 versus 0.53 ms. Mixed production layout p95 was 0.131 versus 0.132 ms with zero frame promises and full-frame copies. Queue-only control wrote all 2,000 frames and retained zero active/pending frames after flush.

```sh
npm run build:offline
node --expose-gc scripts/bench/markdown-code-tail.ts
node --expose-gc scripts/bench/tui-paced-real-leaf.ts --growing --timing-only
node --expose-gc scripts/bench/tui-paced-real-leaf.ts --growing
node --expose-gc scripts/bench/tui-frame-allocations.ts --frames 2000 --warmup 200 --alt-control mixed
node --expose-gc scripts/bench/tui-frame-queue-allocations.ts --frames 2000
```
