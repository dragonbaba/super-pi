import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  AudioContentSchema, BlobResourceContentsSchema, CallToolResultSchema,
  CursorSchema, EmbeddedResourceSchema, ImageContentSchema, ListToolsResultSchema, ResourceLinkSchema,
  TextContentSchema, TextResourceContentsSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MAX_CONTENT_ITEMS, canonicalJsonShape, validateJsonShape } from "./security.js";

export const MAX_TOOL_LIST_PAGES = 128;
export const MAX_TOOL_CATALOG_BYTES = 2 * 1024 * 1024;
const ToolPageSchema = ListToolsResultSchema.extend({
  nextCursor: CursorSchema.max(4096).nullish(),
  tools: ListToolsResultSchema.shape.tools.max(128),
});

// Retain the SDK's actual content shapes while replacing its atob refinement.
// Encoding/MIME/byte admission is performed without whole-payload decoding by
// the bridge's typed normalizer. Protocol decoding remains owned by the SDK.
const EncodedStringSchema = ImageContentSchema.shape.mimeType;
const BoundedImageSchema = ImageContentSchema.extend({ data: EncodedStringSchema });
const BoundedAudioSchema = AudioContentSchema.extend({ data: EncodedStringSchema });
const BoundedResourceSchema = EmbeddedResourceSchema.extend({
  resource: TextResourceContentsSchema.or(BlobResourceContentsSchema.extend({ blob: EncodedStringSchema })),
});
const ResultSchema = CallToolResultSchema.extend({
  content: TextContentSchema.or(BoundedImageSchema).or(BoundedAudioSchema)
    .or(BoundedResourceSchema).or(ResourceLinkSchema).array().max(MAX_CONTENT_ITEMS).default([]),
});

/** Adapter for the pinned SDK 1.32.1; transport and request ownership stay in the SDK. */
class McpClient extends Client {
  constructor() {
    super({ name: "@super-pi/mcp-bridge", version: "0.1.0" }, { capabilities: { roots: { listChanged: false } } });
    if (!(this._progressHandlers instanceof Map) || typeof this._onprogress !== "function" || typeof this.cacheToolMetadata !== "function") {
      throw new Error("MCP client progress boundary is incompatible.");
    }
    this.mcpLateProgress = 0;
    this.mcpProgressErrors = 0;
  }

  callTool(params, resultSchema = ResultSchema, options) {
    return super.callTool(params, resultSchema, options);
  }

  /** Discovery lifecycle only. Publish SDK validators once, after the complete bounded catalog. */
  async listAllTools(maxTools, options) {
    if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 128) throw new Error("Invalid MCP tool limit");
    const tools = [], cursors = new Set();
    const signal = options?.signal;
    let cursor, activeRequest, bytes = 0;
    // SDK request retains its signal listener. Forward only to the active page,
    // so completed pages neither accumulate parent listeners nor receive aborts.
    const abort = () => activeRequest?.abort(signal.reason);
    signal?.addEventListener("abort", abort);
    try {
      for (let pageIndex = 0; pageIndex < MAX_TOOL_LIST_PAGES; pageIndex++) {
        signal?.throwIfAborted();
        activeRequest = signal ? new AbortController() : undefined;
        const page = await this.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } },
          ToolPageSchema, { ...options, signal: activeRequest?.signal });
        activeRequest = undefined;
        signal?.throwIfAborted();
        if (tools.length + page.tools.length > maxTools) throw new Error("MCP catalog exceeds the tool limit");
        for (const tool of page.tools) {
          bytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
          if (bytes > MAX_TOOL_CATALOG_BYTES) throw new Error("MCP catalog exceeds the size limit");
          tool.inputSchema = canonicalJsonShape(validateJsonShape(tool.inputSchema));
          if (tool.outputSchema) tool.outputSchema = validateJsonShape(tool.outputSchema);
          tools.push(tool);
        }
        cursor = page.nextCursor;
        if (cursor === undefined || cursor === null || cursor === "") {
          this.cacheToolMetadata(tools);
          return { tools };
        }
        if (cursors.has(cursor)) throw new Error("MCP catalog repeated a cursor");
        cursors.add(cursor);
      }
      throw new Error("MCP catalog exceeds the page limit");
    } catch (error) {
      tools.length = 0;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      activeRequest = undefined;
      cursors.clear();
    }
  }

  _onnotification(notification) {
    if (notification.method !== "notifications/progress") return super._onnotification(notification);
    const params = notification.params;
    const progressToken = params?.progressToken;
    if ((typeof progressToken !== "number" && typeof progressToken !== "string") ||
      (typeof progressToken === "string" && progressToken.length > 64) ||
      !this._progressHandlers.has(Number(progressToken))) {
      this.mcpLateProgress++;
      return;
    }
    const progress = params.progress;
    const total = params.total;
    if (!Number.isFinite(progress) || progress < 0 || (total !== undefined && (!Number.isFinite(total) || total < progress))) return;
    try {
      // A bounded envelope prevents arbitrary message/_meta fields from entering
      // the SDK's rest-parameter copy. Its own active-request map remains authoritative.
      super._onprogress({ params: { progressToken, progress, total } });
    } catch { this.mcpProgressErrors++; }
  }
}

export function createMcpClient() { return new McpClient(); }
