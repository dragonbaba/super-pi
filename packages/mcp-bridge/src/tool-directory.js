import { createHash, randomUUID } from "node:crypto";
import { piToolName, piToolServerPrefix } from "./security.js";

const PAGE_SIZE = 32;
const WHITESPACE = /\s/u;

export function discoveryScope(runtime, query, server) {
  if (server !== undefined) return { server, term: query };
  const qualified = query.startsWith("mcp__");
  const split = qualified ? -1 : query.search(WHITESPACE);
  if (!qualified && split < 0) return { term: query };
  const word = split < 0 ? "" : query.slice(0, split).toLowerCase();
  const owners = [];
  for (const { config } of runtime.states.values()) {
    if (!config.enabled) continue;
    if (qualified ? query.startsWith(piToolServerPrefix(config.id)) : word === config.id.toLowerCase()) owners.push(config.id);
  }
  if (owners.length > 1) return { ambiguous: owners };
  const term = qualified || !owners.length ? query : query.slice(split).trimStart();
  return { server: owners[0], term, qualified };
}

export function visibleServers(runtime, eligible, ids = runtime.states.keys()) {
  const servers = [];
  for (const id of ids) {
    const state = runtime.states.get(id);
    if (!state?.config.enabled) continue;
    if (eligible && state.catalogReady) {
      let visible = false;
      for (const raw of state.tools.keys()) {
        if (eligible.has(piToolName(id, raw))) { visible = true; break; }
      }
      if (!visible) continue;
    } else if (eligible && !eligible.has("mcp_search_tools")) continue;
    servers.push(id);
  }
  return servers;
}

export function directoryResult(status, text, fields = {}) {
  return { content: [{ type: "text", text }], details: { status, ...fields } };
}

export function listNames(state, eligible, offset, revision, generation) {
  if (!state.catalogReady) return directoryResult("not_ready", "The selected MCP catalog is unavailable. Check /mcp-status.", { names: [] });
  const id = state.config.id;
  const names = [];
  // A cursor belongs to the exact catalog, session boundary and visible order.
  state.directoryId ??= randomUUID();
  const hash = createHash("sha256").update(state.directoryId).update(String(generation));
  let count = 0;
  for (const raw of state.tools.keys()) {
    const name = piToolName(id, raw);
    if (eligible && !eligible.has(name)) continue;
    hash.update("\0").update(name);
    if (count >= offset && names.length < PAGE_SIZE) names.push(name);
    count++;
  }
  const current = hash.digest("hex");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > count || ((offset > 0 || revision !== undefined) && revision !== current)) {
    return directoryResult("stale_page", "Restart the names directory at offset 0 without a revision.", { names: [] });
  }
  const nextOffset = offset + names.length < count ? offset + names.length : null;
  const next = nextOffset === null ? "" : `\nNext page: offset ${nextOffset}, revision ${current}`;
  return directoryResult("names", `MCP tools for ${id} (${count} visible):\n${names.join("\n")}${next}`, { server: id, names, total: count, nextOffset, revision: current });
}

export function exactTools(runtime, term, server, eligible) {
  const names = [];
  const owners = [];
  const config = runtime.toolConfig(term);
  if (config && (server === undefined || server === config.id)) {
    if (!eligible || eligible.has(term)) { names.push(term); owners.push(config.id); }
    return { names, owners, known: true };
  }
  let known = false;
  for (const state of runtime.states.values()) {
    const id = state.config.id;
    if (!state.catalogReady || !state.config.enabled || (server !== undefined && server !== id)) continue;
    if (!state.tools.has(term)) continue;
    const name = piToolName(id, term);
    known = true;
    if (eligible && !eligible.has(name)) continue;
    names.push(name);
    owners.push(id);
  }
  return { names, owners, known };
}
