# Discovering deferred MCP tool names

With the Windows desktop catalog, the old capability ranker put only 8 of 18 explicit server/tool pairs first. Other descriptions mentioned the requested tool, tied its score and displaced it from the first eight results. A cold fully qualified query also missed on-demand discovery.

The bridge lists enabled server IDs locally and enumerates the selected catalog in pages of 32 host-visible names. A unique exact match precedes capability ranking. Ambiguous server prefixes and identical visible remote names return server choices. Only search activates schemas. Each scoped lookup waits for its selected server, and the current host policy still determines acceptance. Cursor revisions include the catalog incarnation, session generation and visible name order.

On single-monitor Windows with mcp-windows 1.3.28, listing IDs started zero connections. The first fully qualified lookup opened one connection (541 ms in one cold run). The warm directory returned 18 names in 0.20 ms. Its newline-separated names were 447 UTF-8 bytes, compared with 53,047 bytes of descriptions and input schemas. These are catalog measurements, not provider request sizes. All 36 exact queries (raw plus server, and qualified) returned a single correct match. An independent loopback regression repeats the checks with reversed registration order and tied descriptions.

A live Agent using gpt-6.2-sol and the bridge discovery tool chose the correct names for six English tasks and the same six tasks in Chinese. Both model sessions selected servers then names without a prescribed browse sequence. The prompts requested tool selection only. A separate offline AgentSession test runs directory, exact activation and an actual fixture tool call inside one Codemode script, then reloads and reopens the session.

The changes affect explicit directory/search requests and the fixed Codemode instructions. They do not run on the delta, progress or frame paths.

```sh
npm run build:offline
node --test tests/mcp-background-activation.test.ts tests/mcp-pagination.test.ts tests/mcp-lifecycle.test.ts tests/mcp-refresh-shutdown.test.ts tests/mcp-host-compatibility.test.ts tests/mcp-disabled-cli.test.ts tests/mcp-schema-cache.test.ts
```
