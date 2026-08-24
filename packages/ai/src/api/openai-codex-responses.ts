// @ts-nocheck -- migrated from the proven local 0.84.1 runtime; public types remain explicit.
import type * as NodeOs from "node:os";
import type * as NodeZlib from "node:zlib";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}
// NEVER convert to top-level runtime imports - breaks browser/Vite builds
const _os: typeof NodeOs | null = loadNodeOs();

import { clampThinkingLevel } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: "auto" | "none" | "required";
}

export interface OpenAICodexRequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

export type OpenAICodexDispatchTransport = "sse" | "websocket-full" | "websocket-delta";

export interface OpenAICodexCompactionDiagnostics {
	schemaVersion: 1;
	regularTransport: OpenAICodexDispatchTransport;
	compactionTransport: "sse" | "websocket-delta";
	usedPreviousResponseId: boolean;
	instructions: boolean;
	inputPrefix: boolean;
	tools: boolean;
	bodyWithoutInput: boolean;
	promptCacheKey: boolean;
	serviceTier: boolean;
	headers: boolean;
	hashes: Record<string, string | undefined>;
}

export interface OpenAICodexCompactionResult {
	compactionItem: Record<string, unknown>;
	usage?: unknown;
	diagnostics?: OpenAICodexCompactionDiagnostics;
}

export interface OpenAICodexCompactionOptions extends StreamOptions {
	apiKey: string;
	shapeDiagnostics?: boolean;
}

export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

// ============================================================================
// Configuration
// ============================================================================
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const X_CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
const X_CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";
const REMOTE_COMPACTION_CAPABILITY_KEY = Symbol.for("@super-pi/ai/codex-remote-compaction-sessions");
const TERMINAL_RATE_LIMIT_PATTERN = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const RETRYABLE_ERROR_PATTERN = /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const WSS_PROTOCOL_PATTERN = /^wss:/;
const WS_PROTOCOL_PATTERN = /^ws:/;
const USAGE_LIMIT_ERROR_CODE_PATTERN = /usage_limit_reached|usage_not_included|rate_limit_exceeded/i;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
// The Codex backend accepts zstd-compressed request bodies on the SSE responses
// endpoint (the same endpoint the official Codex client compresses against).
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";
export function setOpenAICodexRemoteCompactionCapability(sessionId, enabled) {
    const state = globalThis;
    let sessions = state[REMOTE_COMPACTION_CAPABILITY_KEY];
    if (!(sessions instanceof Set)) {
        if (!enabled)
            return;
        sessions = new Set();
        state[REMOTE_COMPACTION_CAPABILITY_KEY] = sessions;
    }
    if (enabled)
        sessions.add(sessionId);
    else
        sessions.delete(sessionId);
}
function isOpenAICodexRemoteCompactionCapabilityEnabled(sessionId) {
    const sessions = globalThis[REMOTE_COMPACTION_CAPABILITY_KEY];
    return sessions instanceof Set && (sessions.has("*") || (sessionId !== undefined && sessions.has(sessionId)));
}
const CODEX_RESPONSE_STATUSES = new Set([
    "completed",
    "incomplete",
    "failed",
    "cancelled",
    "queued",
    "in_progress",
]);
function assertSuccessfulOutput(output) {
    if (output.stopReason === "pending") {
        throw new Error("Codex stream ended without a stop reason");
    }
    if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(output.errorMessage || "An unknown error occurred");
    }
}
// ============================================================================
// Retry Helpers
// ============================================================================
function isTerminalRateLimitError(errorText) {
    return TERMINAL_RATE_LIMIT_PATTERN.test(errorText);
}
function isRetryableError(status, errorText) {
    if (status === 429 && isTerminalRateLimitError(errorText)) {
        return false;
    }
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
        return true;
    }
    return RETRYABLE_ERROR_PATTERN.test(errorText);
}
function getRetryAfterDelayMs(headers) {
    const retryAfterMs = headers.get("retry-after-ms");
    if (retryAfterMs !== null) {
        const millis = Number(retryAfterMs);
        if (Number.isFinite(millis)) {
            return Math.max(0, millis);
        }
    }
    const retryAfter = headers.get("retry-after");
    if (!retryAfter) {
        return undefined;
    }
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return undefined;
}
class RetryDelayExceededError extends Error {
}
function validateRetryDelayMs(delayMs, options) {
    const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
        throw new RetryDelayExceededError(`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`);
    }
    return delayMs;
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Request was aborted"));
            return;
        }
        const timeout = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new Error("Request was aborted"));
        });
    });
}
function normalizeTimeoutMs(value) {
    if (value === undefined)
        return undefined;
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid timeoutMs: ${String(value)}`);
    }
    return Math.floor(value);
}
function loadNodeZlib() {
    if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
        return null;
    }
    return (process.getBuiltinModule?.("node:zlib") ?? null);
}
function loadNodeCrypto() {
    if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun))
        return null;
    return (process.getBuiltinModule?.("node:crypto") ?? null);
}
function sha256Json(value) {
    const crypto = loadNodeCrypto();
    if (!crypto)
        return undefined;
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requiredSha256Json(value) {
    const hash = sha256Json(value);
    if (!hash)
        throw new Error("Codex compaction stopped: SHA-256 request diagnostics are unavailable.");
    return hash;
}
// Returns the zstd-compressed body bytes, or null when compression is
// unavailable (browser/Vite builds). Callers fall back to sending the
// uncompressed JSON when this returns null.
function compressRequestBodyZstd(bodyJson) {
    const zlib = loadNodeZlib();
    if (!zlib || typeof zlib.zstdCompressSync !== "function") {
        return null;
    }
    try {
        const compressed = zlib.zstdCompressSync(bodyJson, {
            params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
        });
        return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
    }
    catch {
        return null;
    }
}
// ============================================================================
// Main Stream Function
// ============================================================================
export const stream = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    (async () => {
        const output = {
            role: "assistant",
            content: [],
            api: "openai-codex-responses",
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "pending",
            timestamp: Date.now(),
        };
        try {
            const apiKey = options?.apiKey;
            if (!apiKey) {
                throw new Error(`No API key for provider: ${model.provider}`);
            }
            const accountId = extractAccountId(apiKey);
            const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, model.compat?.supportsOpenAIGrammarTools ?? false);
            const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
            const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
            let body = buildOpenAICodexRequestBody(model, context, options, codexSessionId, grammarToolInputProperties);
            const nextBody = await options?.onPayload?.(body, model);
            if (nextBody !== undefined) {
                body = nextBody;
            }
            const requestServiceTier = body.service_tier;
            const websocketRequestId = codexSessionId || uuidv7();
            const routingHint = buildCodexRoutingHint(body.model, requestServiceTier);
            const remoteCompactionEnabled = isOpenAICodexRemoteCompactionCapabilityEnabled(codexSessionId);
            const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, routingHint, codexSessionId, remoteCompactionEnabled);
            const websocketHeaders = buildWebSocketHeaders(model.headers, options?.headers, accountId, apiKey, routingHint, websocketRequestId, remoteCompactionEnabled);
            let bodyJson;
            const getBodyJson = () => (bodyJson ??= JSON.stringify(body));
            const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
            const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
            const transport = options?.transport || "auto";
            let startEmitted = false;
            const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
            if (websocketDisabledForSession) {
                recordWebSocketSseFallback(cacheSessionId);
            }
            if (transport !== "sse" && !websocketDisabledForSession) {
                let websocketStarted = false;
                let retriedWebSocketConnectionLimit = false;
                let retriedMissingWebSocketContinuation = false;
                while (true) {
                    websocketStarted = false;
                    try {
                        await processWebSocketStream(resolveCodexWebSocketUrl(model.baseUrl), body, websocketHeaders, output, stream, model, () => {
                            websocketStarted = true;
                            if (!startEmitted) {
                                startEmitted = true;
                                stream.push({ type: "start", partial: output });
                            }
                        }, httpTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, requestServiceTier, options);
                        if (options?.signal?.aborted) {
                            throw new Error("Request was aborted");
                        }
                        assertSuccessfulOutput(output);
                        stream.push({
                            type: "done",
                            reason: output.stopReason,
                            message: output,
                        });
                        stream.end();
                        return;
                    }
                    catch (error) {
                        const aborted = options?.signal?.aborted;
                        const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
                        const previousResponseNotFound = isPreviousResponseNotFoundError(error);
                        if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {
                            retriedMissingWebSocketContinuation = true;
                            continue;
                        }
                        if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
                            retriedWebSocketConnectionLimit = true;
                            continue;
                        }
                        if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
                            throw error;
                        }
                        appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("provider_transport_failure", error, {
                            configuredTransport: transport,
                            fallbackTransport: websocketStarted ? undefined : "sse",
                            eventsEmitted: websocketStarted,
                            phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
                            requestBytes: new TextEncoder().encode(getBodyJson()).byteLength,
                        }));
                        recordWebSocketFailure(cacheSessionId, error);
                        if (websocketStarted) {
                            throw error;
                        }
                        recordWebSocketSseFallback(cacheSessionId);
                        break;
                    }
                }
            }
            // Compress the request body once for the SSE path. The Codex backend
            // decodes Content-Encoding: zstd; the WebSocket transport above sends the
            // uncompressed JSON frame, matching the official Codex client.
            bodyJson = getBodyJson();
            const compressedBody = compressRequestBodyZstd(bodyJson);
            if (compressedBody) {
                sseHeaders.set("content-encoding", "zstd");
            }
            const sseBody = compressedBody ?? bodyJson;
            // Fetch with retry logic for rate limits and transient errors
            let response;
            let lastError;
            const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                if (options?.signal?.aborted) {
                    throw new Error("Request was aborted");
                }
                try {
                    const headerTimeoutSignal = httpTimeoutMs !== undefined && httpTimeoutMs > 0 ? AbortSignal.timeout(httpTimeoutMs) : undefined;
                    const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
                    try {
                        response = await (options?.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
                            method: "POST",
                            headers: sseHeaders,
                            body: sseBody,
                            signal: combinedSignal.signal,
                        });
                    }
                    catch (error) {
                        if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
                            throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`);
                        }
                        throw error;
                    }
                    finally {
                        combinedSignal.cleanup();
                    }
                    await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
                    if (response.ok) {
                        break;
                    }
                    const errorText = await response.text();
                    if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
                        const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
                        const delayMs = retryAfterDelayMs === undefined
                            ? BASE_DELAY_MS * 2 ** attempt
                            : validateRetryDelayMs(retryAfterDelayMs, options);
                        await sleep(delayMs, options?.signal);
                        continue;
                    }
                    // Parse error for friendly message on final attempt or non-retryable error
                    const fakeResponse = new Response(errorText, {
                        status: response.status,
                        statusText: response.statusText,
                    });
                    const info = await parseErrorResponse(fakeResponse);
                    throw new Error(info.friendlyMessage || info.message);
                }
                catch (error) {
                    if (error instanceof Error) {
                        if (error.name === "AbortError" || error.message === "Request was aborted") {
                            throw new Error("Request was aborted");
                        }
                    }
                    lastError = error instanceof Error ? error : new Error(String(error));
                    // Network errors are retryable
                    if (attempt < maxRetries &&
                        !(lastError instanceof RetryDelayExceededError) &&
                        !lastError.message.includes("usage limit")) {
                        const delayMs = BASE_DELAY_MS * 2 ** attempt;
                        await sleep(delayMs, options?.signal);
                        continue;
                    }
                    throw lastError;
                }
            }
            if (!response?.ok) {
                throw lastError ?? new Error("Failed after retries");
            }
            if (!response.body) {
                throw new Error("No response body");
            }
            if (!startEmitted) {
                startEmitted = true;
                stream.push({ type: "start", partial: output });
            }
            await processStream(response, output, stream, model, grammarToolInputProperties, requestServiceTier, options);
            if (options?.signal?.aborted) {
                throw new Error("Request was aborted");
            }
            assertSuccessfulOutput(output);
            const responseItems = convertAssistantResponseItems(model, output, grammarToolInputProperties);
            recordSuccessfulDispatch(cacheSessionId, body, body, sseHeaders, "sse", responseItems, output.responseId);
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            for (const block of output.content) {
                // Streaming scratch buffers are only used during parsing; never persist them.
                delete block.partialJson;
                delete block.customInput;
            }
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = formatProviderError(normalizeProviderError(error));
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();
    return stream;
};
export const streamSimple = (model, context, options) => {
    const apiKey = options?.apiKey;
    if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
    }
    const base = buildBaseOptions(model, context, options, apiKey);
    const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
    return stream(model, context, {
        ...base,
        reasoningEffort,
    });
};
// ============================================================================
// Request Building
// ============================================================================
export function buildOpenAICodexRequestBody(model, context, options, cacheSessionId, grammarToolInputProperties = createGrammarToolInputProperties(context.tools, model.compat?.supportsOpenAIGrammarTools ?? false)) {
    const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
    const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
    const toolPlacement = splitDeferredTools(context, model.compat?.supportsToolSearch ?? false);
    const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
        includeSystemPrompt: false,
        grammarToolInputProperties,
        deferredTools: toolPlacement.deferred,
        toolOptions: {
            strict: null,
            supportsStrictMode,
            supportsOpenAIGrammarTools,
        },
    });
    const body = {
        model: model.id,
        store: false,
        stream: true,
        instructions: context.systemPrompt || "You are a helpful assistant.",
        input: messages,
        text: { verbosity: options?.textVerbosity || "low" },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: cacheSessionId,
        tool_choice: options?.toolChoice ?? "auto",
        parallel_tool_calls: true,
    };
    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    }
    if (options?.serviceTier !== undefined) {
        body.service_tier = options.serviceTier;
    }
    if (toolPlacement.immediate.length > 0) {
        body.tools = convertResponsesTools(toolPlacement.immediate, {
            strict: null,
            supportsStrictMode,
            supportsOpenAIGrammarTools,
        });
    }
    if (options?.reasoningEffort !== undefined) {
        const effort = options.reasoningEffort === "none"
            ? (model.thinkingLevelMap?.off ?? "none")
            : (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
        if (effort !== null) {
            body.reasoning = {
                effort,
                summary: options.reasoningSummary ?? "auto",
            };
        }
    }
    return body;
}
function getServiceTierCostMultiplier(model, serviceTier) {
    switch (serviceTier) {
        case "flex":
            return 0.5;
        case "priority":
            return model.id.startsWith("gpt-5.5") || model.id.startsWith("gpt-5.6") ? 2.5 : 2;
        default:
            return 1;
    }
}
function applyServiceTierPricing(usage, serviceTier, model) {
    const multiplier = getServiceTierCostMultiplier(model, serviceTier);
    if (multiplier === 1)
        return;
    usage.cost.input *= multiplier;
    usage.cost.output *= multiplier;
    usage.cost.cacheRead *= multiplier;
    usage.cost.cacheWrite *= multiplier;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
function resolveCodexServiceTier(responseServiceTier, requestServiceTier) {
    return responseServiceTier ?? requestServiceTier;
}
function buildCodexRoutingHint(model, serviceTier) {
    return serviceTier === undefined ? `model=${model}` : `model=${model};tier=${serviceTier}`;
}
function resolveCodexUrl(baseUrl) {
    const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
    const normalized = raw.replace(TRAILING_SLASHES_PATTERN, "");
    if (normalized.endsWith("/codex/responses"))
        return normalized;
    if (normalized.endsWith("/codex"))
        return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
}
function resolveCodexWebSocketUrl(baseUrl) {
    const url = new URL(resolveCodexUrl(baseUrl));
    if (url.protocol === "https:")
        url.protocol = "wss:";
    if (url.protocol === "http:")
        url.protocol = "ws:";
    return url.toString();
}
// ============================================================================
// Response Processing
// ============================================================================
async function processStream(response, output, stream, model, grammarToolInputProperties, requestServiceTier, options) {
    await processResponsesStream(mapCodexEvents(parseSSE(response, options?.signal)), output, stream, model, {
        serviceTier: requestServiceTier,
        grammarToolInputProperties,
        resolveServiceTier: resolveCodexServiceTier,
        applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
    });
}
class CodexApiError extends Error {
    code;
    payload;
    constructor(message, options) {
        super(message);
        this.name = "CodexApiError";
        this.code = options?.code;
        this.payload = options?.payload;
        this.cause = options?.cause;
    }
}
class CodexProtocolError extends Error {
    payload;
    constructor(message, options) {
        super(message);
        this.name = "CodexProtocolError";
        this.payload = options?.payload;
        this.cause = options?.cause;
    }
}
class PostCompactionContinuationError extends CodexProtocolError {
    constructor() {
        super("Codex request stopped: the post-compaction continuation boundary was missing or ambiguous.");
        this.name = "PostCompactionContinuationError";
    }
}
class InvalidContinuationPayloadError extends CodexProtocolError {
    constructor() {
        super("Codex request stopped: cached continuation comparison requires JSON-compatible plain data.");
        this.name = "InvalidContinuationPayloadError";
    }
}
function isCodexNonTransportError(error) {
    return error instanceof CodexApiError || error instanceof CodexProtocolError;
}
function isWebSocketConnectionLimitReachedError(error) {
    return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}
function isPreviousResponseNotFoundError(error) {
    return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}
function extractCodexEventError(event) {
    const nested = event.error && typeof event.error === "object" ? event.error : undefined;
    return {
        code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
        message: typeof event.message === "string"
            ? event.message
            : typeof nested?.message === "string"
                ? nested.message
                : undefined,
    };
}
async function* mapCodexEvents(events) {
    for await (const event of events) {
        const type = typeof event.type === "string" ? event.type : undefined;
        if (!type)
            continue;
        if (type === "error") {
            const { code, message } = extractCodexEventError(event);
            throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
                code,
                payload: event,
            });
        }
        if (type === "response.failed") {
            const response = event.response;
            const code = response?.error?.code;
            const message = response?.error?.message;
            throw new CodexApiError(message || "Codex response failed", { code, payload: event });
        }
        if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
            const response = event.response;
            const normalizedResponse = response
                ? { ...response, status: normalizeCodexStatus(response.status) }
                : response;
            yield { ...event, type: "response.completed", response: normalizedResponse };
            return;
        }
        yield event;
    }
}
function normalizeCodexStatus(status) {
    if (typeof status !== "string")
        return undefined;
    return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}
// ============================================================================
// SSE Parsing
// ============================================================================
async function* parseSSE(response, signal) {
    if (!response.body)
        return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const onAbort = () => {
        void reader.cancel().catch(() => { });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            const { done, value } = await reader.read();
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let idx = buffer.indexOf("\n\n");
            while (idx !== -1) {
                const chunk = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLines = chunk
                    .split("\n")
                    .filter((l) => l.startsWith("data:"))
                    .map((l) => l.slice(5).trim());
                if (dataLines.length > 0) {
                    const data = dataLines.join("\n").trim();
                    if (data && data !== "[DONE]") {
                        try {
                            yield JSON.parse(data);
                        }
                        catch (cause) {
                            throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
                                cause,
                                payload: data,
                            });
                        }
                    }
                }
                idx = buffer.indexOf("\n\n");
            }
        }
    }
    finally {
        signal?.removeEventListener("abort", onAbort);
        try {
            await reader.cancel();
        }
        catch { }
        try {
            reader.releaseLock();
        }
        catch { }
    }
}
// ============================================================================
// WebSocket Parsing
// ============================================================================
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const DEFAULT_SESSION_WEBSOCKET_CACHE_TTL_MS = 15 * 60 * 1000;
const MIN_SESSION_WEBSOCKET_CACHE_TTL_MS = 60 * 1000;
const MAX_SESSION_WEBSOCKET_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CACHED_WEBSOCKET_ENTRIES = 4;
const MAX_CACHED_WEBSOCKET_ENTRIES_LIMIT = 16;
function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
    const raw = typeof process === "undefined" ? undefined : process.env?.[name];
    if (raw === undefined || raw === "")
        return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
const SESSION_WEBSOCKET_CACHE_TTL_MS = boundedEnvironmentInteger("SP_CODEX_WEBSOCKET_IDLE_TTL_MS", DEFAULT_SESSION_WEBSOCKET_CACHE_TTL_MS, MIN_SESSION_WEBSOCKET_CACHE_TTL_MS, MAX_SESSION_WEBSOCKET_CACHE_TTL_MS);
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const MAX_CACHED_WEBSOCKET_ENTRIES = boundedEnvironmentInteger("SP_CODEX_WEBSOCKET_MAX_CACHED_ENTRIES", DEFAULT_MAX_CACHED_WEBSOCKET_ENTRIES, 1, MAX_CACHED_WEBSOCKET_ENTRIES_LIMIT);
const websocketSessionCache = new Map();
const websocketDebugStats = new Map();
const websocketSseFallbackSessions = new Set();
const successfulDispatchCommitments = new Map();
const consumedDispatchCommitments = new Set();
const MAX_SUCCESSFUL_DISPATCH_COMMITMENTS = 16;
function getOrCreateWebSocketDebugStats(sessionId) {
    let stats = websocketDebugStats.get(sessionId);
    if (!stats) {
        stats = {
            requests: 0,
            connectionsCreated: 0,
            connectionsReused: 0,
            cachedContextRequests: 0,
            storeTrueRequests: 0,
            fullContextRequests: 0,
            deltaRequests: 0,
            lastInputItems: 0,
            websocketFailures: 0,
            sseFallbacks: 0,
        };
        websocketDebugStats.set(sessionId, stats);
    }
    return stats;
}
export function getOpenAICodexWebSocketDebugStats(sessionId) {
    const stats = websocketDebugStats.get(sessionId);
    return stats ? { ...stats } : undefined;
}
export function resetOpenAICodexWebSocketDebugStats(sessionId) {
    if (sessionId) {
        websocketDebugStats.delete(sessionId);
        websocketSseFallbackSessions.delete(sessionId);
        return;
    }
    websocketDebugStats.clear();
    websocketSseFallbackSessions.clear();
}
export function closeOpenAICodexWebSocketSessions(sessionId) {
    const closeEntry = (entry) => {
        if (entry.idleTimer)
            clearTimeout(entry.idleTimer);
        closeWebSocketSilently(entry.socket, 1000, "debug_close");
    };
    if (sessionId) {
        for (const entry of websocketSessionCache.get(sessionId)?.values() ?? [])
            closeEntry(entry);
        websocketSessionCache.delete(sessionId);
        successfulDispatchCommitments.delete(sessionId);
        consumedDispatchCommitments.delete(sessionId);
        return;
    }
    for (const accountEntries of websocketSessionCache.values()) {
        for (const entry of accountEntries.values())
            closeEntry(entry);
    }
    websocketSessionCache.clear();
    successfulDispatchCommitments.clear();
    consumedDispatchCommitments.clear();
}
function cleanupOpenAICodexSessionResources(sessionId) {
    closeOpenAICodexWebSocketSessions(sessionId);
    resetOpenAICodexWebSocketDebugStats(sessionId);
}
registerSessionResourceCleanup(cleanupOpenAICodexSessionResources);
function isWebSocketSseFallbackActive(sessionId) {
    return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}
function recordWebSocketSseFallback(sessionId) {
    if (!sessionId)
        return;
    const stats = getOrCreateWebSocketDebugStats(sessionId);
    stats.sseFallbacks++;
    stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}
function recordWebSocketFailure(sessionId, error) {
    if (!sessionId)
        return;
    websocketSseFallbackSessions.add(sessionId);
    const stats = getOrCreateWebSocketDebugStats(sessionId);
    stats.websocketFailures++;
    stats.lastWebSocketError = formatThrownValue(error);
    stats.websocketFallbackActive = true;
}
let _cachedWebsocket = null;
async function getWebSocketConstructor(env) {
    if (!env && _cachedWebsocket)
        return _cachedWebsocket;
    // bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
    // TODO: remove this when bun supports proxy envs in websocket.
    if (typeof process !== "undefined" && process.versions?.bun) {
        const WebSocketWithProxy = class extends WebSocket {
            constructor(url, options) {
                let _opts = {};
                if (Array.isArray(options) || typeof options === "string") {
                    _opts = { protocols: options };
                }
                else {
                    _opts = { ...options };
                }
                const proxyUrl = resolveHttpProxyUrlForTarget(url.toString().replace(WSS_PROTOCOL_PATTERN, "https:").replace(WS_PROTOCOL_PATTERN, "http:"), env);
                super(url, { ..._opts, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) });
            }
        };
        if (!env) {
            _cachedWebsocket = WebSocketWithProxy;
        }
        return WebSocketWithProxy;
    }
    const ctor = globalThis.WebSocket;
    if (typeof ctor !== "function")
        return null;
    return ctor;
}
class WebSocketCloseError extends Error {
    code;
    reason;
    wasClean;
    constructor(message, options) {
        super(message);
        this.name = "WebSocketCloseError";
        this.code = options?.code;
        this.reason = options?.reason;
        this.wasClean = options?.wasClean;
    }
}
function getWebSocketReadyState(socket) {
    const readyState = socket.readyState;
    return typeof readyState === "number" ? readyState : undefined;
}
function isWebSocketReusable(socket) {
    const readyState = getWebSocketReadyState(socket);
    // If readyState is unavailable, assume the runtime keeps it open/reusable.
    return readyState === undefined || readyState === 1;
}
function isWebSocketSessionExpired(entry) {
    return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}
function closeWebSocketSilently(socket, code = 1000, reason = "done") {
    try {
        socket.close(code, reason);
    }
    catch { }
}
function removeCachedWebSocketSession(sessionId, accountId, entry, reason) {
    if (entry.idleTimer)
        clearTimeout(entry.idleTimer);
    closeWebSocketSilently(entry.socket, 1000, reason);
    const accountEntries = websocketSessionCache.get(sessionId);
    if (accountEntries?.get(accountId) === entry)
        accountEntries.delete(accountId);
    if (accountEntries?.size === 0)
        websocketSessionCache.delete(sessionId);
}
function pruneWebSocketSessionCache() {
    for (const [sessionId, accountEntries] of websocketSessionCache) {
        for (const [accountId, entry] of accountEntries) {
            if (!entry.busy && (isWebSocketSessionExpired(entry) || !isWebSocketReusable(entry.socket)))
                removeCachedWebSocketSession(sessionId, accountId, entry, "cache_prune");
        }
    }
}
function reserveWebSocketSessionCacheSlot() {
    pruneWebSocketSessionCache();
    let cachedEntryCount = 0;
    let oldestSessionId;
    let oldestAccountId;
    let oldestEntry;
    for (const [sessionId, accountEntries] of websocketSessionCache) {
        for (const [accountId, entry] of accountEntries) {
            cachedEntryCount++;
            if (!entry.busy && (!oldestEntry || entry.lastUsedAt < oldestEntry.lastUsedAt)) {
                oldestSessionId = sessionId;
                oldestAccountId = accountId;
                oldestEntry = entry;
            }
        }
    }
    if (cachedEntryCount < MAX_CACHED_WEBSOCKET_ENTRIES)
        return true;
    if (!oldestEntry)
        return false;
    removeCachedWebSocketSession(oldestSessionId, oldestAccountId, oldestEntry, "cache_lru_eviction");
    return true;
}
function expireSessionWebSocket(sessionId, accountId, entry) {
    if (entry.busy)
        return;
    removeCachedWebSocketSession(sessionId, accountId, entry, "idle_timeout");
}
function scheduleSessionWebSocketExpiry(sessionId, accountId, entry) {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
    }
    entry.lastUsedAt = Date.now();
    entry.idleTimer = setTimeout(expireSessionWebSocket, SESSION_WEBSOCKET_CACHE_TTL_MS, sessionId, accountId, entry);
}
async function connectWebSocket(url, headers, signal, connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, env) {
    const WebSocketCtor = await getWebSocketConstructor(env);
    if (!WebSocketCtor) {
        throw new Error("WebSocket transport is not available in this runtime");
    }
    const wsHeaders = headersToRecord(headers);
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeout;
        let socket;
        try {
            socket = new WebSocketCtor(url, { headers: wsHeaders });
        }
        catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            socket.removeEventListener("open", onOpen);
            socket.removeEventListener("error", onError);
            socket.removeEventListener("close", onClose);
            signal?.removeEventListener("abort", onAbort);
        };
        const fail = (error, closeReason) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (closeReason) {
                closeWebSocketSilently(socket, 1000, closeReason);
            }
            reject(error);
        };
        const onOpen = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(socket);
        };
        const onError = (event) => {
            fail(extractWebSocketError(event));
        };
        const onClose = (event) => {
            fail(extractWebSocketCloseError(event));
        };
        const onAbort = () => {
            fail(new Error("Request was aborted"), "aborted");
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
        signal?.addEventListener("abort", onAbort);
        if (connectTimeoutMs > 0) {
            timeout = setTimeout(() => {
                fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
            }, connectTimeoutMs);
        }
        if (signal?.aborted) {
            onAbort();
        }
    });
}
async function acquireWebSocket(url, headers, sessionId, accountId, signal, connectTimeoutMs, env) {
    if (!sessionId) {
        const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
        return {
            socket,
            reused: false,
            release: () => closeWebSocketSilently(socket),
        };
    }
    const connectionHeadersKey = JSON.stringify(headersToRecord(headers));
    let accountEntries = websocketSessionCache.get(sessionId);
    const cached = accountEntries?.get(accountId);
    if (cached) {
        if (cached.idleTimer) {
            clearTimeout(cached.idleTimer);
            cached.idleTimer = undefined;
        }
        if (!cached.busy && cached.connectionHeadersKey !== connectionHeadersKey) {
            closeWebSocketSilently(cached.socket, 1000, "headers_changed");
            accountEntries?.delete(accountId);
            if (accountEntries?.size === 0)
                websocketSessionCache.delete(sessionId);
        }
        else if (!cached.busy && isWebSocketSessionExpired(cached)) {
            closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
            accountEntries?.delete(accountId);
            if (accountEntries?.size === 0)
                websocketSessionCache.delete(sessionId);
        }
        else if (!cached.busy && isWebSocketReusable(cached.socket)) {
            cached.busy = true;
            return {
                socket: cached.socket,
                entry: cached,
                reused: true,
                release: ({ keep } = {}) => {
                    if (!keep || !isWebSocketReusable(cached.socket)) {
                        closeWebSocketSilently(cached.socket);
                        const currentEntries = websocketSessionCache.get(sessionId);
                        if (currentEntries?.get(accountId) === cached)
                            currentEntries.delete(accountId);
                        if (currentEntries?.size === 0)
                            websocketSessionCache.delete(sessionId);
                        return;
                    }
                    cached.busy = false;
                    scheduleSessionWebSocketExpiry(sessionId, accountId, cached);
                },
            };
        }
        if (cached.busy) {
            const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
            return {
                socket,
                reused: false,
                release: () => {
                    closeWebSocketSilently(socket);
                },
            };
        }
        if (!isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            accountEntries?.delete(accountId);
            if (accountEntries?.size === 0)
                websocketSessionCache.delete(sessionId);
        }
    }
    const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
    // A concurrent request may have populated this session/account pair while connect awaited.
    // Keep this connection request-scoped rather than replacing credential-bound continuation state.
    accountEntries = websocketSessionCache.get(sessionId);
    if (accountEntries?.has(accountId) || !reserveWebSocketSessionCacheSlot()) {
        return {
            socket,
            reused: false,
            release: () => closeWebSocketSilently(socket),
        };
    }
    const now = Date.now();
    const entry = {
        socket,
        connectionHeadersKey,
        busy: true,
        createdAt: now,
        lastUsedAt: now,
    };
    accountEntries = websocketSessionCache.get(sessionId);
    if (!accountEntries) {
        accountEntries = new Map();
        websocketSessionCache.set(sessionId, accountEntries);
    }
    accountEntries.set(accountId, entry);
    return {
        socket,
        entry,
        reused: false,
        release: ({ keep } = {}) => {
            if (!keep || !isWebSocketReusable(entry.socket)) {
                removeCachedWebSocketSession(sessionId, accountId, entry, "done");
                return;
            }
            entry.busy = false;
            scheduleSessionWebSocketExpiry(sessionId, accountId, entry);
        },
    };
}
function extractWebSocketError(event) {
    if (event && typeof event === "object") {
        const message = "message" in event ? event.message : undefined;
        if (typeof message === "string" && message.length > 0) {
            return new Error(message);
        }
        const nestedError = "error" in event ? event.error : undefined;
        if (nestedError instanceof Error && nestedError.message.length > 0) {
            return nestedError;
        }
        if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
            const nestedMessage = nestedError.message;
            if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
                return new Error(nestedMessage);
            }
        }
    }
    return new Error("WebSocket error");
}
function extractWebSocketCloseError(event) {
    if (event && typeof event === "object") {
        const code = "code" in event ? event.code : undefined;
        const reason = "reason" in event ? event.reason : undefined;
        const wasClean = "wasClean" in event ? event.wasClean : undefined;
        const codeText = typeof code === "number" ? ` ${code}` : "";
        let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
        if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
            reasonText = " message too big";
        }
        return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
            code: typeof code === "number" ? code : undefined,
            reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
            wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
        });
    }
    return new Error("WebSocket closed");
}
async function decodeWebSocketData(data) {
    if (typeof data === "string")
        return data;
    if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(new Uint8Array(data));
    }
    if (ArrayBuffer.isView(data)) {
        const view = data;
        return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    if (data && typeof data === "object" && "arrayBuffer" in data) {
        const blobLike = data;
        const arrayBuffer = await blobLike.arrayBuffer();
        return new TextDecoder().decode(new Uint8Array(arrayBuffer));
    }
    return null;
}
async function* parseWebSocket(socket, signal, idleTimeoutMs) {
    const queue = [];
    let pending = null;
    let done = false;
    let failed = null;
    let sawCompletion = false;
    const wake = () => {
        if (!pending)
            return;
        const resolve = pending;
        pending = null;
        resolve();
    };
    const onMessage = (event) => {
        void (async () => {
            let text = null;
            try {
                if (!event || typeof event !== "object" || !("data" in event))
                    return;
                text = await decodeWebSocketData(event.data);
                if (!text)
                    return;
                const parsed = JSON.parse(text);
                const type = typeof parsed.type === "string" ? parsed.type : "";
                if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
                    sawCompletion = true;
                    done = true;
                }
                queue.push(parsed);
                wake();
            }
            catch (cause) {
                failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
                    cause,
                    payload: text,
                });
                done = true;
                wake();
            }
        })();
    };
    const onError = (event) => {
        failed = extractWebSocketError(event);
        done = true;
        wake();
    };
    const onClose = (event) => {
        if (sawCompletion) {
            done = true;
            wake();
            return;
        }
        if (!failed) {
            failed = extractWebSocketCloseError(event);
        }
        done = true;
        wake();
    };
    const onAbort = () => {
        failed = new Error("Request was aborted");
        done = true;
        wake();
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (queue.length > 0) {
                yield queue.shift();
                continue;
            }
            if (done)
                break;
            let timeout;
            await new Promise((resolve, reject) => {
                pending = resolve;
                if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
                    timeout = setTimeout(() => {
                        const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
                        failed = error;
                        done = true;
                        pending = null;
                        closeWebSocketSilently(socket, 1000, "idle_timeout");
                        reject(error);
                    }, idleTimeoutMs);
                }
            }).finally(() => {
                if (timeout) {
                    clearTimeout(timeout);
                }
            });
        }
        if (failed) {
            throw failed;
        }
        if (!sawCompletion) {
            throw new Error("WebSocket stream closed before response.completed");
        }
    }
    finally {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
    }
}
function requestBodyWithoutInput(body) {
    const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
    return rest;
}
function isJsonCompatiblePlainData(value, ancestors = new WeakSet()) {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (typeof value !== "object")
        return false;
    if (ancestors.has(value))
        return false;
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (isArray ? prototype !== Array.prototype && prototype !== null : prototype !== Object.prototype && prototype !== null)
        return false;
    for (let owner = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
        const toJsonDescriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
        if (!toJsonDescriptor)
            continue;
        if (!("value" in toJsonDescriptor) || typeof toJsonDescriptor.value === "function")
            return false;
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
        if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable)
            return false;
    }
    ancestors.add(value);
    try {
        if (isArray) {
            for (let index = 0; index < value.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (descriptor && !("value" in descriptor))
                    return false;
                if (!isJsonCompatiblePlainData(value[index], ancestors))
                    return false;
            }
            for (const key of Object.keys(value)) {
                const index = Number(key);
                if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key)
                    return false;
            }
            return true;
        }
        for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor) || !isJsonCompatiblePlainData(descriptor.value, ancestors))
                return false;
        }
        return true;
    }
    finally {
        ancestors.delete(value);
    }
}
function jsonValuesEqual(a, b) {
    if (a === b)
        return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
            return false;
        for (let index = 0; index < a.length; index++) {
            const left = a[index] === undefined ? null : a[index];
            const right = b[index] === undefined ? null : b[index];
            if (!jsonValuesEqual(left, right))
                return false;
        }
        return true;
    }
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
        return false;
    const leftKeys = Object.keys(a).filter((key) => a[key] !== undefined);
    const rightKeys = Object.keys(b).filter((key) => b[key] !== undefined);
    if (leftKeys.length !== rightKeys.length)
        return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || b[key] === undefined || !jsonValuesEqual(a[key], b[key]))
            return false;
    }
    return true;
}
function responseInputsEqual(a, b) {
    return jsonValuesEqual(a ?? [], b ?? []);
}
function requestBodiesMatchExceptInput(a, b) {
    return jsonValuesEqual(requestBodyWithoutInput(a), requestBodyWithoutInput(b));
}
function normalizedHeadersForCommitment(headers) {
    const values = [];
    for (const [rawName, rawValue] of headers.entries()) {
        const name = rawName.toLowerCase();
        values.push([name, name === "authorization" ? "<redacted>" : rawValue]);
    }
    values.sort();
    return values;
}
function createSuccessfulDispatchCommitment(fullBody, actualBody, headers, transport, responseItems, responseId) {
    const instructionsHash = sha256Json(fullBody.instructions ?? null);
    const inputHash = sha256Json(fullBody.input ?? []);
    const responseItemsHash = sha256Json(responseItems);
    const toolsHash = sha256Json(fullBody.tools ?? []);
    const bodyWithoutInputHash = sha256Json(requestBodyWithoutInput(fullBody));
    const promptCacheKeyHash = sha256Json(fullBody.prompt_cache_key ?? null);
    const serviceTierHash = sha256Json(fullBody.service_tier ?? null);
    const headersHash = sha256Json(normalizedHeadersForCommitment(headers));
    const actualBodyHash = sha256Json(actualBody);
    if (!instructionsHash ||
        !inputHash ||
        !responseItemsHash ||
        !toolsHash ||
        !bodyWithoutInputHash ||
        !promptCacheKeyHash ||
        !serviceTierHash ||
        !headersHash ||
        !actualBodyHash) {
        return undefined;
    }
    return {
        transport,
        instructionsHash,
        inputHash,
        inputItems: fullBody.input?.length ?? 0,
        responseItemsHash,
        responseItems: responseItems.length,
        toolsHash,
        bodyWithoutInputHash,
        promptCacheKeyHash,
        serviceTierHash,
        headersHash,
        actualBodyHash,
        ...(responseId ? { responseId } : {}),
    };
}
function recordSuccessfulDispatch(sessionId, fullBody, actualBody, headers, transport, responseItems, responseId) {
    if (!sessionId)
        return;
    const commitment = createSuccessfulDispatchCommitment(fullBody, actualBody, headers, transport, responseItems, responseId);
    if (!commitment)
        return;
    successfulDispatchCommitments.delete(sessionId);
    consumedDispatchCommitments.delete(sessionId);
    while (successfulDispatchCommitments.size >= MAX_SUCCESSFUL_DISPATCH_COMMITMENTS) {
        const oldest = successfulDispatchCommitments.keys().next().value;
        if (typeof oldest !== "string")
            break;
        successfulDispatchCommitments.delete(oldest);
    }
    successfulDispatchCommitments.set(sessionId, commitment);
}
function markDispatchCommitmentConsumed(sessionId) {
    consumedDispatchCommitments.delete(sessionId);
    while (consumedDispatchCommitments.size >= MAX_SUCCESSFUL_DISPATCH_COMMITMENTS) {
        const oldest = consumedDispatchCommitments.values().next().value;
        if (typeof oldest !== "string")
            break;
        consumedDispatchCommitments.delete(oldest);
    }
    consumedDispatchCommitments.add(sessionId);
}
function convertAssistantResponseItems(model, output, grammarToolInputProperties) {
    const converted = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
        includeSystemPrompt: false,
        grammarToolInputProperties,
    });
    const responseItems = [];
    for (const item of converted) {
        if (item.type === "function_call_output" || item.type === "custom_tool_call_output")
            continue;
        responseItems.push(item);
    }
    return responseItems;
}
function getCachedWebSocketInputDelta(body, continuation) {
    if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
        return undefined;
    }
    const currentInput = body.input ?? [];
    if (continuation.compactionBoundary) {
        const responseItems = continuation.lastResponseItems;
        let matchedBoundary;
        const lastStart = currentInput.length - responseItems.length;
        for (let start = 0; start <= lastStart; start += 1) {
            if (!responseInputsEqual(currentInput.slice(start, start + responseItems.length), responseItems))
                continue;
            if (matchedBoundary !== undefined)
                return undefined;
            matchedBoundary = start + responseItems.length;
        }
        return matchedBoundary === undefined ? undefined : currentInput.slice(matchedBoundary);
    }
    const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
    if (currentInput.length < baseline.length) {
        return undefined;
    }
    const prefix = currentInput.slice(0, baseline.length);
    if (!responseInputsEqual(prefix, baseline)) {
        return undefined;
    }
    return currentInput.slice(baseline.length);
}
const NO_RESPONSE_CONTINUATION_MATCH = -1;
const AMBIGUOUS_RESPONSE_CONTINUATION_MATCH = -2;
function responseItemContinuationIdentity(item, includeItemId) {
    if (!item || typeof item !== "object")
        return undefined;
    const candidate = item;
    const type = typeof candidate.type === "string" ? candidate.type : undefined;
    if (!type)
        return undefined;
    const identity = { type };
    // A live WebSocket continuation cannot survive a process restart. Within the
    // owning process, Pi preserves provider item ids in response signatures.
    if (includeItemId && typeof candidate.id === "string")
        identity.id = candidate.id;
    for (const key of ["call_id", "name", "role"]) {
        const value = candidate[key];
        if (typeof value === "string")
            identity[key] = value;
    }
    return JSON.stringify(identity);
}
function findUniqueResponseContinuationBoundary(currentInput, responseItems, includeItemId) {
    if (responseItems.length === 0 || currentInput.length < responseItems.length)
        return NO_RESPONSE_CONTINUATION_MATCH;
    const expectedIdentities = new Array(responseItems.length);
    for (let index = 0; index < responseItems.length; index += 1) {
        const identity = responseItemContinuationIdentity(responseItems[index], includeItemId);
        if (!identity)
            return NO_RESPONSE_CONTINUATION_MATCH;
        expectedIdentities[index] = identity;
    }
    let matchedBoundary;
    const lastStart = currentInput.length - responseItems.length;
    for (let start = 0; start <= lastStart; start += 1) {
        let matches = true;
        for (let offset = 0; offset < expectedIdentities.length; offset += 1) {
            if (responseItemContinuationIdentity(currentInput[start + offset], includeItemId) !== expectedIdentities[offset]) {
                matches = false;
                break;
            }
        }
        if (!matches)
            continue;
        if (matchedBoundary !== undefined)
            return AMBIGUOUS_RESPONSE_CONTINUATION_MATCH;
        matchedBoundary = start + responseItems.length;
    }
    return matchedBoundary ?? NO_RESPONSE_CONTINUATION_MATCH;
}
function getCompactionWebSocketInputDelta(body, continuation, commitment) {
    if (!isJsonCompatiblePlainData(body) ||
        !isJsonCompatiblePlainData(continuation.lastRequestBody) ||
        !isJsonCompatiblePlainData(continuation.lastResponseItems)) {
        throw new InvalidContinuationPayloadError();
    }
    if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody))
        return undefined;
    const currentInput = body.input ?? [];
    const requestInput = continuation.lastRequestBody.input ?? [];
    const responseItems = continuation.lastResponseItems;
    if (requestInput.length !== commitment.inputItems ||
        responseItems.length !== commitment.responseItems ||
        commitment.responseId !== continuation.lastResponseId)
        return undefined;
    let boundary = findUniqueResponseContinuationBoundary(currentInput, responseItems, true);
    if (boundary === AMBIGUOUS_RESPONSE_CONTINUATION_MATCH)
        return undefined;
    if (boundary === NO_RESPONSE_CONTINUATION_MATCH) {
        boundary = findUniqueResponseContinuationBoundary(currentInput, responseItems, false);
    }
    if (boundary < 0)
        return undefined;
    return currentInput.slice(boundary);
}
function buildCachedWebSocketRequestBody(entry, body) {
    const continuation = entry.continuation;
    if (!continuation) {
        return body;
    }
    if (!isJsonCompatiblePlainData(body) ||
        !isJsonCompatiblePlainData(continuation.lastRequestBody) ||
        !isJsonCompatiblePlainData(continuation.lastResponseItems)) {
        throw new InvalidContinuationPayloadError();
    }
    const delta = getCachedWebSocketInputDelta(body, continuation);
    if (!delta || !continuation.lastResponseId) {
        if (continuation.compactionBoundary) {
            throw new PostCompactionContinuationError();
        }
        entry.continuation = undefined;
        return body;
    }
    return {
        ...body,
        previous_response_id: continuation.lastResponseId,
        input: delta,
    };
}
async function* startWebSocketOutputOnFirstEvent(events, onStart) {
    let started = false;
    for await (const event of events) {
        if (!started) {
            started = true;
            onStart();
        }
        yield event;
    }
}
async function processWebSocketStream(url, body, headers, output, stream, model, onStart, idleTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, requestServiceTier, options) {
    const { socket, entry, reused, release } = await acquireWebSocket(url, headers, cacheSessionId, accountId, options?.signal, websocketConnectTimeoutMs, options?.env);
    let keepConnection = true;
    const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
    // ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
    // WebSocket continuation still works via connection-scoped previous_response_id state.
    const fullBody = body;
    try {
        const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
        const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;
        if (stats) {
            stats.requests++;
            if (reused)
                stats.connectionsReused++;
            else
                stats.connectionsCreated++;
            if (useCachedContext)
                stats.cachedContextRequests++;
            if (requestBody.store === true)
                stats.storeTrueRequests++;
            stats.lastInputItems = requestBody.input?.length ?? 0;
            if (requestBody.previous_response_id) {
                stats.deltaRequests++;
                stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
                stats.lastPreviousResponseId = requestBody.previous_response_id;
            }
            else {
                stats.fullContextRequests++;
                stats.lastDeltaInputItems = undefined;
                stats.lastPreviousResponseId = undefined;
            }
        }
        socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
        await processResponsesStream(startWebSocketOutputOnFirstEvent(mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs)), onStart), output, stream, model, {
            serviceTier: requestServiceTier,
            grammarToolInputProperties,
            resolveServiceTier: resolveCodexServiceTier,
            applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
        });
        if (options?.signal?.aborted) {
            keepConnection = false;
        }
        else {
            const responseItems = convertAssistantResponseItems(model, output, grammarToolInputProperties);
            recordSuccessfulDispatch(cacheSessionId, fullBody, requestBody, headers, requestBody.previous_response_id ? "websocket-delta" : "websocket-full", responseItems, output.responseId);
            if (useCachedContext && entry && output.responseId) {
                entry.continuation = {
                    lastRequestBody: fullBody,
                    lastResponseId: output.responseId,
                    lastResponseItems: responseItems,
                };
            }
        }
    }
    catch (error) {
        const preserveCachedContinuation = (error instanceof PostCompactionContinuationError || error instanceof InvalidContinuationPayloadError) && entry !== undefined;
        if (entry && !preserveCachedContinuation) {
            entry.continuation = undefined;
        }
        keepConnection = preserveCachedContinuation;
        throw error;
    }
    finally {
        release({ keep: keepConnection });
    }
}
function asOpenAICodexRequestBody(payload) {
    if (typeof payload.model !== "string" || !Array.isArray(payload.input)) {
        throw new Error("Codex compaction requires a canonical Responses payload with model and input.");
    }
    return payload;
}
function buildCompactionRequestBody(regularPayload) {
    const regularBody = asOpenAICodexRequestBody(regularPayload);
    return {
        ...regularBody,
        input: [...(regularBody.input ?? []), { type: "compaction_trigger" }],
    };
}
function compareCompactionToSuccessfulDispatch(commitment, body, headers, compactionTransport) {
    const input = body.input ?? [];
    const priorInput = input.slice(0, commitment.inputItems);
    const responseEnd = commitment.inputItems + commitment.responseItems;
    const priorResponseItems = input.slice(commitment.inputItems, responseEnd);
    const compactionInstructionsHash = requiredSha256Json(body.instructions ?? null);
    const compactionInputPrefixHash = requiredSha256Json(priorInput);
    const compactionResponseItemsHash = requiredSha256Json(priorResponseItems);
    const compactionToolsHash = requiredSha256Json(body.tools ?? []);
    const compactionBodyWithoutInputHash = requiredSha256Json(requestBodyWithoutInput(body));
    const compactionPromptCacheKeyHash = requiredSha256Json(body.prompt_cache_key ?? null);
    const compactionServiceTierHash = requiredSha256Json(body.service_tier ?? null);
    const compactionHeadersHash = requiredSha256Json(normalizedHeadersForCommitment(headers));
    const instructions = compactionInstructionsHash === commitment.instructionsHash;
    const inputPrefix = compactionTransport === "websocket-delta"
        ? false
        : input.length > responseEnd &&
            compactionInputPrefixHash === commitment.inputHash &&
            compactionResponseItemsHash === commitment.responseItemsHash;
    const tools = compactionToolsHash === commitment.toolsHash;
    const bodyWithoutInput = compactionBodyWithoutInputHash === commitment.bodyWithoutInputHash;
    const promptCacheKey = compactionPromptCacheKeyHash === commitment.promptCacheKeyHash;
    const serviceTier = compactionServiceTierHash === commitment.serviceTierHash;
    const headerParity = compactionHeadersHash === commitment.headersHash;
    return {
        schemaVersion: 1,
        regularTransport: commitment.transport,
        compactionTransport,
        usedPreviousResponseId: compactionTransport === "websocket-delta",
        instructions,
        inputPrefix,
        tools,
        bodyWithoutInput,
        promptCacheKey,
        serviceTier,
        headers: headerParity,
        hashes: {
            regularActualBody: commitment.actualBodyHash,
            regularInstructions: commitment.instructionsHash,
            compactionInstructions: compactionInstructionsHash,
            regularInputPrefix: commitment.inputHash,
            compactionInputPrefix: compactionInputPrefixHash,
            regularResponseItems: commitment.responseItemsHash,
            compactionResponseItems: compactionResponseItemsHash,
            regularTools: commitment.toolsHash,
            compactionTools: compactionToolsHash,
            regularBodyWithoutInput: commitment.bodyWithoutInputHash,
            compactionBodyWithoutInput: compactionBodyWithoutInputHash,
            regularPromptCacheKey: commitment.promptCacheKeyHash,
            compactionPromptCacheKey: compactionPromptCacheKeyHash,
            regularServiceTier: commitment.serviceTierHash,
            compactionServiceTier: compactionServiceTierHash,
            regularHeaders: commitment.headersHash,
            compactionHeaders: compactionHeadersHash,
        },
    };
}
function assertCompactionParity(diagnostics) {
    if (!diagnostics.instructions)
        throw new Error("Codex compaction stopped: instructions differ from the last successful request.");
    if (!diagnostics.inputPrefix && diagnostics.compactionTransport === "sse")
        throw new Error("Codex compaction stopped: input prefix differs from the last successful request.");
    if (!diagnostics.tools)
        throw new Error("Codex compaction stopped: tools differ from the last successful request.");
    if (!diagnostics.bodyWithoutInput) {
        throw new Error("Codex compaction stopped: cache-relevant non-input body fields differ from the last successful request.");
    }
    if (!diagnostics.promptCacheKey) {
        throw new Error("Codex compaction stopped: prompt_cache_key differs from the last successful request.");
    }
    if (!diagnostics.serviceTier)
        throw new Error("Codex compaction stopped: service tier differs from the last successful request.");
    if (!diagnostics.headers) {
        throw new Error("Codex compaction stopped: cache-relevant headers differ from the last successful request.");
    }
}
function discardCompactionWebSocket(sessionId, accountId, entry, reason) {
    closeWebSocketSilently(entry.socket, 1000, reason);
    if (entry.idleTimer)
        clearTimeout(entry.idleTimer);
    const accountEntries = websocketSessionCache.get(sessionId);
    if (accountEntries?.get(accountId) === entry)
        accountEntries.delete(accountId);
    if (accountEntries?.size === 0)
        websocketSessionCache.delete(sessionId);
}
function acquireExistingCompactionWebSocket(sessionId, accountId, headers) {
    const accountEntries = websocketSessionCache.get(sessionId);
    const entry = accountEntries?.get(accountId);
    if (!entry)
        throw new Error("Codex compaction stopped: the last successful WebSocket connection is unavailable.");
    if (entry.busy)
        throw new Error("Codex compaction stopped: the session WebSocket is busy.");
    if (!entry.continuation) {
        discardCompactionWebSocket(sessionId, accountId, entry, "compaction_continuation_unavailable");
        throw new Error("Codex compaction stopped: the WebSocket continuation is unavailable.");
    }
    if (entry.connectionHeadersKey !== JSON.stringify(headersToRecord(headers))) {
        discardCompactionWebSocket(sessionId, accountId, entry, "compaction_headers_drifted");
        throw new Error("Codex compaction stopped: WebSocket connection headers drifted.");
    }
    if (!isWebSocketReusable(entry.socket) || isWebSocketSessionExpired(entry)) {
        discardCompactionWebSocket(sessionId, accountId, entry, "compaction_connection_expired");
        throw new Error("Codex compaction stopped: the last successful WebSocket connection expired.");
    }
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
    }
    entry.busy = true;
    return {
        entry,
        release: (keep) => {
            if (!keep || !isWebSocketReusable(entry.socket)) {
                closeWebSocketSilently(entry.socket);
                if (accountEntries?.get(accountId) === entry)
                    accountEntries.delete(accountId);
                if (accountEntries?.size === 0)
                    websocketSessionCache.delete(sessionId);
                return;
            }
            entry.busy = false;
            scheduleSessionWebSocketExpiry(sessionId, accountId, entry);
        },
    };
}
async function collectRemoteCompactionEvents(events) {
    let completed = false;
    let compactionItem;
    let compactionItems = 0;
    let usage;
    let responseId;
    for await (const event of events) {
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "error") {
            const error = extractCodexEventError(event);
            throw new CodexApiError(`Codex compaction failed: ${error.message || error.code || "provider error"}`, {
                code: error.code,
                payload: event,
            });
        }
        if (type === "response.failed") {
            const response = event.response && typeof event.response === "object"
                ? event.response
                : undefined;
            throw new CodexApiError(response?.error?.message || "Codex compaction response failed", {
                code: response?.error?.code,
                payload: event,
            });
        }
        if (type === "response.output_item.done") {
            const item = event.item;
            if (item &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                item.type === "compaction") {
                compactionItems++;
                compactionItem = item;
            }
            continue;
        }
        if (type === "response.incomplete")
            throw new Error("Codex compaction stopped: provider returned an incomplete response.");
        if (type === "response.completed" || type === "response.done") {
            completed = true;
            const response = event.response && typeof event.response === "object" ? event.response : undefined;
            usage = response?.usage;
            if (typeof response?.id === "string")
                responseId = response.id;
        }
    }
    if (!completed)
        throw new Error("Codex compaction stopped: response stream ended before completion.");
    if (compactionItems !== 1 || !compactionItem) {
        throw new Error(`Codex compaction stopped: expected one compaction item, received ${compactionItems}.`);
    }
    return { compactionItem, usage, ...(responseId ? { responseId } : {}) };
}
async function performCodexSseCompaction(model, body, headers, options, onDispatch) {
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const timeoutSignal = timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const combinedSignal = combineAbortSignals([options.signal, timeoutSignal]);
    try {
        onDispatch();
        const response = await (options.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
            method: "POST",
            headers,
            body,
            signal: combinedSignal.signal,
        });
        await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
        if (!response.ok) {
            const info = await parseErrorResponse(response);
            throw new Error(info.friendlyMessage || info.message);
        }
        const { responseId: _responseId, ...result } = await collectRemoteCompactionEvents(parseSSE(response, combinedSignal.signal));
        return result;
    }
    finally {
        combinedSignal.cleanup();
    }
}
async function performCodexWebSocketCompaction(params) {
    const acquired = acquireExistingCompactionWebSocket(params.sessionId, params.accountId, params.headers);
    let keepConnection = false;
    try {
        const continuation = acquired.entry.continuation;
        if (!continuation ||
            (params.commitment.responseId && continuation.lastResponseId !== params.commitment.responseId)) {
            throw new Error("Codex compaction stopped: WebSocket continuation identity drifted.");
        }
        const delta = getCompactionWebSocketInputDelta(params.body, continuation, params.commitment);
        if (!delta) {
            throw new Error("Codex compaction stopped: WebSocket continuation response boundary was not unique.");
        }
        params.diagnostics.inputPrefix = true;
        const requestBody = {
            ...params.body,
            previous_response_id: continuation.lastResponseId,
            input: delta,
        };
        params.diagnostics.hashes.compactionActualBody = requiredSha256Json(requestBody);
        params.onDispatch();
        acquired.entry.socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
        const result = await collectRemoteCompactionEvents(parseWebSocket(acquired.entry.socket, params.options.signal, normalizeTimeoutMs(params.options.timeoutMs)));
        if (result.responseId) {
            acquired.entry.continuation = {
                lastRequestBody: params.body,
                lastResponseId: result.responseId,
                lastResponseItems: [result.compactionItem],
                compactionBoundary: true,
            };
            keepConnection = true;
        }
        const { responseId: _responseId, ...publicResult } = result;
        return publicResult;
    }
    catch (error) {
        if (error instanceof InvalidContinuationPayloadError)
            keepConnection = true;
        throw error;
    }
    finally {
        if (!keepConnection)
            acquired.entry.continuation = undefined;
        // A successful compaction response becomes the next connection-scoped
        // continuation boundary. The following ordinary request sends only items
        // after the exact provider artifact; missing/ambiguous artifacts fail the
        // delta match instead of guessing a cache boundary.
        acquired.release(keepConnection);
    }
}
export async function compactOpenAICodexRequest(model, regularPayload, options) {
    const sessionId = clampOpenAIPromptCacheKey(options.sessionId);
    if (!sessionId)
        throw new Error("Codex compaction stopped: a stable session id is required.");
    const commitment = successfulDispatchCommitments.get(sessionId);
    if (!commitment) {
        throw new Error("Codex compaction stopped: no successful regular request commitment exists for this process.");
    }
    let providerDispatched = false;
    const markProviderDispatched = () => {
        providerDispatched = true;
    };
    try {
        const accountId = extractAccountId(options.apiKey);
        const body = buildCompactionRequestBody(regularPayload);
        const routingHint = buildCodexRoutingHint(body.model, body.service_tier);
        const useSse = commitment.transport === "sse";
        const headers = useSse
            ? buildSSEHeaders(model.headers, options.headers, accountId, options.apiKey, routingHint, sessionId, true)
            : buildWebSocketHeaders(model.headers, options.headers, accountId, options.apiKey, routingHint, sessionId, true);
        let sseBody;
        if (useSse) {
            const bodyJson = JSON.stringify(body);
            const compressedBody = compressRequestBodyZstd(bodyJson);
            if (compressedBody)
                headers.set("content-encoding", "zstd");
            sseBody = compressedBody ?? bodyJson;
        }
        const diagnostics = compareCompactionToSuccessfulDispatch(commitment, body, headers, useSse ? "sse" : "websocket-delta");
        assertCompactionParity(diagnostics);
        if (useSse) {
            diagnostics.hashes.compactionActualBody = requiredSha256Json(body);
            const result = await performCodexSseCompaction(model, sseBody ?? JSON.stringify(body), headers, options, markProviderDispatched);
            return { ...result, ...(options.shapeDiagnostics ? { diagnostics } : {}) };
        }
        const result = await performCodexWebSocketCompaction({
            sessionId,
            accountId,
            commitment,
            body,
            diagnostics,
            headers,
            options,
            onDispatch: markProviderDispatched,
        });
        return { ...result, ...(options.shapeDiagnostics ? { diagnostics } : {}) };
    }
    finally {
        if (providerDispatched) {
            successfulDispatchCommitments.delete(sessionId);
            markDispatchCommitmentConsumed(sessionId);
        }
    }
}
// ============================================================================
// Error Handling
// ============================================================================
async function parseErrorResponse(response) {
    const raw = await response.text();
    let message = raw || response.statusText || "Request failed";
    let friendlyMessage;
    try {
        const parsed = JSON.parse(raw);
        const err = parsed?.error;
        if (err) {
            const code = err.code || err.type || "";
            if (USAGE_LIMIT_ERROR_CODE_PATTERN.test(code) || response.status === 429) {
                const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
                const mins = err.resets_at
                    ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
                    : undefined;
                const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
                friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
            }
            message = err.message || friendlyMessage || message;
        }
    }
    catch { }
    return { message, friendlyMessage };
}
// ============================================================================
// Auth & Headers
// ============================================================================
function extractAccountId(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            throw new Error("Invalid token");
        const payload = JSON.parse(atob(parts[1]));
        const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
        if (!accountId)
            throw new Error("No account ID in token");
        return accountId;
    }
    catch {
        throw new Error("Failed to extract accountId from token");
    }
}
function buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token) {
    const headers = new Headers(initHeaders);
    for (const [key, value] of Object.entries(additionalHeaders || {})) {
        if (value === null) {
            headers.delete(key);
        }
        else {
            headers.set(key, value);
        }
    }
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("chatgpt-account-id", accountId);
    headers.set("originator", "pi");
    const userAgent = _os ? `Super Pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "Super Pi (browser)";
    headers.set("User-Agent", userAgent);
    return headers;
}
function addRemoteCompactionFeature(headers) {
    const configured = headers.get(X_CODEX_BETA_FEATURES_HEADER);
    if (!configured) {
        headers.set(X_CODEX_BETA_FEATURES_HEADER, REMOTE_COMPACTION_V2_FEATURE);
        return;
    }
    const features = configured.split(",");
    for (const value of features) {
        if (value.trim() === REMOTE_COMPACTION_V2_FEATURE)
            return;
    }
    headers.set(X_CODEX_BETA_FEATURES_HEADER, `${configured},${REMOTE_COMPACTION_V2_FEATURE}`);
}
function buildSSEHeaders(initHeaders, additionalHeaders, accountId, token, routingHint, sessionId, remoteCompactionEnabled = false) {
    const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
    if (remoteCompactionEnabled) {
        addRemoteCompactionFeature(headers);
        headers.set(X_CODEX_ROUTING_HINT_HEADER, routingHint);
    }
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("accept", "text/event-stream");
    headers.set("content-type", "application/json");
    if (sessionId) {
        headers.set("session-id", sessionId);
        headers.set("x-client-request-id", sessionId);
    }
    return headers;
}
function buildWebSocketHeaders(initHeaders, additionalHeaders, accountId, token, routingHint, requestId, remoteCompactionEnabled = false) {
    const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
    if (remoteCompactionEnabled) {
        addRemoteCompactionFeature(headers);
        headers.set(X_CODEX_ROUTING_HINT_HEADER, routingHint);
    }
    headers.delete("accept");
    headers.delete("content-type");
    headers.delete("OpenAI-Beta");
    headers.delete("openai-beta");
    headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
    headers.set("x-client-request-id", requestId);
    headers.set("session-id", requestId);
    return headers;
}
