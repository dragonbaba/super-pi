import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  AudioContentSchema, BlobResourceContentsSchema, CallToolResultSchema,
  EmbeddedResourceSchema, ImageContentSchema, ResourceLinkSchema,
  TextContentSchema, TextResourceContentsSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MAX_CONTENT_ITEMS } from "./security.js";

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

/** Adapter for the pinned SDK 1.30.0; no transport, request or cursor owner. */
class McpClient extends Client {
  constructor() {
    super({ name: "@super-pi/mcp-bridge", version: "0.1.0" }, { capabilities: { roots: { listChanged: false } } });
    if (!(this._progressHandlers instanceof Map) || typeof this._onprogress !== "function") {
      throw new Error("MCP client progress boundary is incompatible.");
    }
    this.mcpLateProgress = 0;
    this.mcpProgressErrors = 0;
  }

  callTool(params, resultSchema = ResultSchema, options) {
    return super.callTool(params, resultSchema, options);
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
