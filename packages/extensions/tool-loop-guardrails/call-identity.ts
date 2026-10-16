import { createHash, type Hash } from "node:crypto";

// These are rejection bounds, never a lossy projection of accepted input.
export const MAX_IDENTITY_CHARACTERS = 16 * 1024 * 1024;
export const MAX_IDENTITY_NODES = 262_144;
export const MAX_IDENTITY_DEPTH = 128;
const HASH_CHUNK_CHARACTERS = 2048;

export class IdentityCounters {
  calls = 0;
  nodes = 0;
  characters = 0;
  hashUpdates = 0;
}

class InputHash {
  readonly hash: Hash = createHash("sha256");
  readonly ancestors = new Set<object>();
  nodes = 0;
  characters = 0;
  readonly counters: IdentityCounters | undefined;
  constructor(counters?: IdentityCounters) { this.counters = counters; }

  text(value: string): void {
    this.characters += value.length;
    if (this.characters > MAX_IDENTITY_CHARACTERS) throw new Error("[TOOL_ARGS_INVALID] Complete tool identity exceeds the character limit.");
    if (this.counters) this.counters.characters += value.length;
    this.hash.update(String(value.length)).update(":");
    // UTF-16LE preserves every code unit, including lone surrogates and chunk boundaries.
    for (let offset = 0; offset < value.length; offset += HASH_CHUNK_CHARACTERS) {
      this.hash.update(value.slice(offset, offset + HASH_CHUNK_CHARACTERS), "utf16le");
      if (this.counters) this.counters.hashUpdates++;
    }
  }

  visit(value: unknown, depth: number): void {
    if (++this.nodes > MAX_IDENTITY_NODES || depth > MAX_IDENTITY_DEPTH) {
      throw new Error("[TOOL_ARGS_INVALID] Complete tool identity exceeds the structural limit.");
    }
    if (this.counters) this.counters.nodes++;
    if (value === null) { this.hash.update("null;"); return; }
    switch (typeof value) {
      case "string": this.hash.update("string:"); this.text(value); return;
      case "boolean": this.hash.update(value ? "true;" : "false;"); return;
      case "number": this.hash.update("number:").update(Object.is(value, -0) ? "-0" : String(value)).update(";"); return;
      case "undefined": this.hash.update("undefined;"); return;
      case "object": break;
      default: throw new Error("[TOOL_ARGS_INVALID] Tool identity requires data arguments.");
    }
    if (this.ancestors.has(value)) throw new Error("[TOOL_ARGS_INVALID] Cyclic tool arguments cannot be identified.");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error("[TOOL_ARGS_INVALID] Tool identity requires plain data objects.");
    this.ancestors.add(value);
    try {
      this.hash.update(array ? "array:" : "object:");
      if (array) this.hash.update(String(value.length)).update(":");
      const keys = Object.keys(value);
      if (keys.length > MAX_IDENTITY_NODES - this.nodes) throw new Error("[TOOL_ARGS_INVALID] Tool identity has too many fields.");
      keys.sort();
      this.hash.update(String(keys.length)).update(":");
      for (const key of keys) {
        this.text(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("[TOOL_ARGS_INVALID] Tool identity does not evaluate accessors.");
        this.visit(descriptor.value, depth + 1);
      }
      this.hash.update("end;");
    } finally { this.ancestors.delete(value); }
  }
}

/** Hash complete typed content incrementally; key order is canonical, source text is never retained. */
export function callKey(toolName: string, input: unknown, counters?: IdentityCounters): string {
  if (counters) counters.calls++;
  const writer = new InputHash(counters);
  writer.text(toolName);
  writer.visit(input, 0);
  return `${toolName.slice(0, 80)}:${writer.hash.digest("base64url")}`;
}
