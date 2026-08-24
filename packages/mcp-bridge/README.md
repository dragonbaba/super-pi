# @super-pi/mcp-bridge

A guarded generic MCP client extension for Pi `0.84.x`. It exposes configured MCP server tools as namespaced Pi tools and supports stdio, Streamable HTTP, and legacy HTTP+SSE.

## Commands

- `/mcp-status` — connection state, transport, server version, and tool count.
- `/mcp-tools` — Pi tool name → MCP server/tool mapping.
- `/mcp-reload` — reload Pi resources and reconnect from disk.

Remote tools are registered as `mcp__<server>__<tool>` (bounded and collision-checked) and use Pi's sequential execution mode so sibling calls cannot race an editor or game engine. They are deferred by default: call `mcp_search_tools` with capability words to activate up to eight matching tools for the next model request.

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

Use `"transport": "sse"` for a legacy SSE endpoint. Remote URLs require HTTPS; loopback HTTP is allowed for local engine integrations. Redirects are rejected so configured authorization headers cannot be silently forwarded elsewhere. Interactive OAuth is not implemented in this first version; use fixed headers sourced from environment variables.

## Project configuration

A trusted project may define `.sp/config/mcp.json` only when the global file sets `"allowProjectConfig": true`. Project server IDs may not override global IDs. Keep this disabled unless repositories containing MCP configuration are fully trusted: a stdio MCP server is executable code with the user's permissions.

## Safety boundaries

- Pi runtime gate: only `0.84.x`.
- Validated schema metadata is cached under `~/.sp/agent/cache/mcp-schemas-v1.json` (2 MiB total, 16 entries, 30-day age bound). Commands, URLs, environment values, and headers participate only in an in-memory SHA-256 fingerprint and are never written to the cache.
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
