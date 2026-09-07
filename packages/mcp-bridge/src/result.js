import { createMcpTypedSource, McpSourceError, MCP_SOURCE_BYTES, serializeMcpStructured } from "@super-pi/coding-agent/internal/tool-result-source";
import { decodedBase64Bytes, MAX_CONTENT_ITEMS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, sanitizeText } from "./security.js";

function typedBlock(kind, value, text) {
  return { type: "text", text, mcpSource: createMcpTypedSource(kind, value) };
}

function binarySize(data, mimeType) {
  const bytes = decodedBase64Bytes(data);
  if (bytes === null || typeof mimeType !== "string" || mimeType.length > 200 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u.test(mimeType)) {
    throw new McpSourceError("invalid-typed-content");
  }
  return bytes;
}

/** Source normalization, not a registry, estimator, cursor or presentation owner. */
export function convertMcpResult(result, allowRecovery = true) {
  const items = Array.isArray(result?.content) ? result.content : [];
  const extras = Number(result?.structuredContent !== undefined) + Number(result?.toolResult !== undefined) + Number(result?._meta !== undefined);
  if (items.length + extras > MAX_CONTENT_ITEMS) throw new McpSourceError("result-size-limit");
  let bytes = 0;
  let imageBytes = 0;
  let typedPayloadBytes = 0;
  // Size/shape preflight before allocating normalized result wrappers.
  for (const item of items) {
    if (item?.type === "text") {
      if (typeof item.text !== "string") throw new McpSourceError("invalid-typed-content");
      bytes += Buffer.byteLength(item.text);
    } else if (item?.type === "image" || item?.type === "audio") {
      const size = binarySize(item.data, item.mimeType);
      bytes += item.data.length;
      if (item.type === "audio") typedPayloadBytes += item.data.length;
      if (item.type === "image") {
        if (!item.mimeType.startsWith("image/")) throw new McpSourceError("invalid-typed-content");
        imageBytes += size;
        if (size > MAX_IMAGE_BYTES || imageBytes > MAX_IMAGE_BYTES * 2) throw new McpSourceError("result-size-limit");
      }
    } else if (item?.type === "resource") {
      if (typeof item.resource?.uri !== "string") throw new McpSourceError("invalid-typed-content");
      const resourceBytes = typeof item.resource.text === "string" ? Buffer.byteLength(item.resource.text) : item.resource.blob?.length;
      if (typeof item.resource.text !== "string") binarySize(item.resource.blob, item.resource.mimeType ?? "application/octet-stream");
      bytes += resourceBytes;
      typedPayloadBytes += resourceBytes;
    } else if (item?.type !== "resource_link") throw new McpSourceError("invalid-typed-content");
    if (bytes > MCP_SOURCE_BYTES) throw new McpSourceError("result-size-limit");
    if (!allowRecovery && (bytes > MAX_TEXT_BYTES || (item.type !== "text" && item.type !== "image"))) throw new McpSourceError("budget-not-configured");
  }
  const content = [];
  let accountedSources = 0;
  for (const item of items) {
    if (item.type === "text") {
      // Preserve legacy small-text sanitization; the complete large canonical
      // string goes to G2, never through truncateUtf8 or a complete-file Buffer.
      const text = bytes <= MAX_TEXT_BYTES ? sanitizeText(item.text, Number.MAX_SAFE_INTEGER) : item.text;
      if (text) content.push(bytes > MAX_TEXT_BYTES ? { type: "text", text, mcpInput: true } : { type: "text", text });
    } else if (item.type === "image") {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else {
      const kind = item.type;
      const block = typedBlock(kind, item, `[MCP ${kind} retained for local session artifact recovery.]`);
      accountedSources += block.mcpSource.bytes;
      if (accountedSources + bytes - typedPayloadBytes > MCP_SOURCE_BYTES) throw new McpSourceError("result-size-limit");
      content.push(block);
    }
  }
  for (const key of ["structuredContent", "toolResult"]) {
    if (result?.[key] === undefined) continue;
    const value = result[key];
    if (!allowRecovery) {
      let text;
      try { text = serializeMcpStructured(value, MAX_TEXT_BYTES - bytes); }
      catch (error) { if (error?.code === "result-size-limit") throw new McpSourceError("budget-not-configured"); throw error; }
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_TEXT_BYTES) throw new McpSourceError("budget-not-configured");
      content.push({ type: "text", text });
      continue;
    }
    const source = createMcpTypedSource("structured", value);
    accountedSources += source.bytes;
    if (accountedSources + bytes - typedPayloadBytes > MCP_SOURCE_BYTES) throw new McpSourceError("result-size-limit");
    const text = serializeMcpStructured(value);
    content.push({ type: "text", text, mcpSource: source });
  }
  if (result?._meta !== undefined) {
    if (!allowRecovery) throw new McpSourceError("budget-not-configured");
    const block = typedBlock("metadata", result._meta, "[MCP server metadata retained opaquely; no tool pagination contract is configured. Recovery is local.]");
    accountedSources += block.mcpSource.bytes;
    if (accountedSources + bytes - typedPayloadBytes > MCP_SOURCE_BYTES) throw new McpSourceError("result-size-limit");
    content.push(block);
  }
  if (content.length === 0) content.push({ type: "text", text: "MCP tool completed without content." });
  return content;
}
