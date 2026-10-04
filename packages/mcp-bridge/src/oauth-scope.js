const MAX_CHALLENGE_CHARS = 8192;
const MAX_SCOPE_CHARS = 4096;
const SCOPE_VALUE = /^[\x21\x23-\x5b\x5d-\x7e]+(?: +[\x21\x23-\x5b\x5d-\x7e]+)*$/;
const SCOPE_SEPARATOR = / +/;
const AUTH_PARAMETER = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\[\t\x20-\x7e])*)"|([!#$%&'*+\-.^_`|~0-9A-Za-z]+))$/;
const AUTH_SCHEME = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:[ \t]+(.*))?$/;
const QUOTED_PAIR = /\\([\t\x20-\x7e])/g;

export class McpAuthorizationRequiredError extends Error {
  constructor(serverId = "<server-id>") {
    super(`MCP authorization required. Run /mcp-login ${serverId}`);
    this.name = "McpAuthorizationRequiredError";
  }
}

// Called only while handling an auth challenge or explicit login, never per chunk.
export function mergeScopes(first, second, third) {
  const scopes = new Set();
  let length = 0;
  for (const value of [first, second, third]) {
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > MAX_SCOPE_CHARS) throw new Error("Invalid MCP OAuth scope");
    const text = value.trim();
    if (!text) continue;
    if (!SCOPE_VALUE.test(text)) throw new Error("Invalid MCP OAuth scope");
    for (const scope of text.split(SCOPE_SEPARATOR)) {
      if (scopes.has(scope)) continue;
      length += scope.length + (scopes.size > 0 ? 1 : 0);
      if (length > MAX_SCOPE_CHARS) throw new Error("MCP OAuth scopes exceed 4096 characters");
      scopes.add(scope);
    }
  }
  return scopes.size ? [...scopes].join(" ") : undefined;
}

function finishedChallenge(challenge) {
  if (!challenge?.bearer || challenge.error !== "insufficient_scope") return undefined;
  if (challenge.invalid) throw new Error("Invalid MCP OAuth scope challenge");
  return mergeScopes(challenge.scope) ?? "";
}

/** One unambiguous Bearer challenge; quoted commas and other schemes stay isolated. */
export function parseScopeChallenge(header) {
  if (!header) return undefined;
  if (header.length > MAX_CHALLENGE_CHARS) throw new Error("MCP OAuth challenge exceeds 8192 characters");
  const parts = [];
  let start = 0, quoted = false, escaped = false;
  for (let index = 0; index < header.length; index++) {
    const char = header.charCodeAt(index);
    if (escaped) { escaped = false; continue; }
    if (quoted && char === 92) { escaped = true; continue; }
    if (char === 34) quoted = !quoted;
    else if (!quoted && char === 44) { parts.push(header.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted || escaped) throw new Error("Invalid MCP OAuth scope challenge");
  parts.push(header.slice(start).trim());
  let current, result;
  for (let index = 0; index <= parts.length; index++) {
    const part = parts[index] ?? "";
    let parameter = AUTH_PARAMETER.exec(part);
    if (!parameter) {
      const scheme = AUTH_SCHEME.exec(part);
      if (part && !scheme && current?.bearer) throw new Error("Invalid MCP OAuth scope challenge");
      const scope = finishedChallenge(current);
      if (scope !== undefined) {
        if (result !== undefined) throw new Error("Ambiguous MCP OAuth scope challenge");
        result = scope;
      }
      current = scheme ? { bearer: scheme[1].toLowerCase() === "bearer", error: undefined, scope: undefined, invalid: false } : undefined;
      parameter = scheme?.[2] ? AUTH_PARAMETER.exec(scheme[2]) : null;
      if (current && scheme[2] && !parameter) current.invalid = true;
    }
    if (!current?.bearer || !parameter) continue;
    const name = parameter[1].toLowerCase();
    if (name !== "error" && name !== "scope") continue;
    if (current[name] !== undefined) { current.invalid = true; continue; }
    current[name] = parameter[2] === undefined ? parameter[3] : parameter[2].replace(QUOTED_PAIR, "$1");
  }
  return result;
}
