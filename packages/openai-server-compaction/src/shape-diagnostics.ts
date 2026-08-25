import { createHash } from "node:crypto";
import { setOwnProperty } from "@super-pi/ai";

const IDENTITY_ROUTING_HEADERS = new Set([
  "chatgpt-account-id",
  "originator",
  "openai-beta",
  "session-id",
  "thread-id",
  "user-agent",
  "x-client-request-id",
  "x-codex-installation-id",
  "x-codex-beta-features",
  "x-codex-routing-hint",
  "x-codex-turn-metadata",
  "x-codex-window-id",
]);

export type PayloadShapeHashes = {
  instructions: string;
  inputPrefix: string;
  tools: string;
  bodyNonInput: string;
  promptCacheKey: string;
  tier: string;
};

export type CompactionShapeDiagnostics = {
  schemaVersion: 2;
  regularPayload: PayloadShapeHashes;
  compactionPayload: PayloadShapeHashes;
  compactionIdentityRoutingHeaders: string;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

function withoutInput(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
		if (key !== "input") setOwnProperty(result, key, payload[key]);
  }
  return result;
}

function identityRoutingHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
	const names = Object.keys(headers).sort();
  for (const name of names) {
    const normalized = name.toLowerCase();
		if (IDENTITY_ROUTING_HEADERS.has(normalized)) setOwnProperty(result, normalized, headers[name]);
  }
  return result;
}

function payloadShape(
  payload: Record<string, unknown>,
  inputPrefix: unknown[],
): PayloadShapeHashes {
  return {
    instructions: digest(payload.instructions),
    inputPrefix: digest(inputPrefix),
    tools: digest(payload.tools),
    bodyNonInput: digest(withoutInput(payload)),
    promptCacheKey: digest(payload.prompt_cache_key),
    tier: digest(payload.service_tier),
  };
}

export function buildCompactionShapeDiagnostics(params: {
  regularPayload: Record<string, unknown>;
  compactionPayload: Record<string, unknown>;
  compactionHeaders: Record<string, string>;
}): CompactionShapeDiagnostics {
  const regularInput = Array.isArray(params.regularPayload.input) ? params.regularPayload.input : [];
  const compactionInput = Array.isArray(params.compactionPayload.input) ? params.compactionPayload.input : [];
  return {
    schemaVersion: 2,
    regularPayload: payloadShape(params.regularPayload, regularInput),
    compactionPayload: payloadShape(params.compactionPayload, compactionInput.slice(0, -1)),
    compactionIdentityRoutingHeaders: digest(identityRoutingHeaders(params.compactionHeaders)),
  };
}
