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
import { capabilityCacheRetention, contextForModelCapabilities, getModelCapabilities } from "../model-capabilities.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	EffectiveDispatchObservation,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";

export const streamedToolArgumentOwnership = "mutation-with-generation" as const;
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { requestBodyUtf8Bytes } from "../utils/request-body-observer.ts";
import { annotateRequestBodyFailure } from "../utils/request-body-size.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { deliverEffectiveDispatchObservation } from "../utils/effective-dispatch.ts";
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

type RequestBody = OpenAICodexRequestBody;
type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";
type SuccessfulAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" | "deferred" };

interface CodexErrorRecord extends Record<string, unknown> {
	code?: string;
	message?: string;
}

interface CodexResponseRecord extends Record<string, unknown> {
	error?: CodexErrorRecord;
	id?: string;
	status?: unknown;
	usage?: unknown;
}

interface CodexEvent extends Record<string, unknown> {
	code?: string;
	error?: CodexErrorRecord;
	item?: unknown;
	message?: string;
	response?: CodexResponseRecord;
	type?: string;
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
	hashes: {
		regularActualBody: string;
		compactionActualBody?: string;
		regularInstructions: string;
		compactionInstructions?: string;
		regularInputPrefix: string;
		compactionInputPrefix?: string;
		regularResponseItems: string;
		compactionResponseItems?: string;
		regularTools: string;
		compactionTools?: string;
		regularBodyWithoutInput: string;
		compactionBodyWithoutInput?: string;
		regularPromptCacheKey: string;
		compactionPromptCacheKey?: string;
		regularServiceTier: string;
		compactionServiceTier?: string;
		regularHeaders: string;
		compactionHeaders?: string;
	};
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
const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
    "completed",
    "incomplete",
    "failed",
    "cancelled",
    "queued",
    "in_progress",
]);
function assertSuccessfulOutput(output: AssistantMessage): asserts output is SuccessfulAssistantMessage {
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
function isTerminalRateLimitError(errorText: string) {
    return TERMINAL_RATE_LIMIT_PATTERN.test(errorText);
}
function isRetryableError(status: number, errorText: string, code?: string) {
    if (status === 413 || isCodexBodySizeCode(code)) return false;
    if (status === 429 && isTerminalRateLimitError(errorText)) {
        return false;
    }
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
        return true;
    }
    return RETRYABLE_ERROR_PATTERN.test(errorText);
}
function getRetryAfterDelayMs(headers: Headers) {
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
function validateRetryDelayMs(delayMs: number, options: StreamOptions) {
    const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
        throw new RetryDelayExceededError(`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`);
    }
    return delayMs;
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Request was aborted"));
            return;
        }

        let timeout: ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
            reject(new Error("Request was aborted"));
        };
        const onTimeout = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };

        timeout = setTimeout(onTimeout, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function normalizeTimeoutMs(value: number | undefined) {
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
function sha256Json(value: unknown): string | undefined {
    const crypto = loadNodeCrypto();
    if (!crypto)
        return undefined;
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requiredSha256Json(value: unknown): string {
    const hash = sha256Json(value);
    if (!hash)
        throw new Error("Codex compaction stopped: SHA-256 request diagnostics are unavailable.");
    return hash;
}
// Returns the zstd-compressed body bytes, or null when compression is
// unavailable (browser/Vite builds). Callers fall back to sending the
// uncompressed JSON when this returns null.
function compressRequestBodyZstd(bodyJson: string) {
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
function streamOwned(owner: CodexTransportOwner, model: Model<"openai-codex-responses">, context: Context, callerOptions?: OpenAICodexResponsesOptions): AssistantMessageEventStream {
    const admitted = owner.admit(callerOptions);
    const options = admitted.options;
    const stream = new AssistantMessageEventStream();
    const operation = Promise.resolve().then(async () => {
        const output: AssistantMessage = {
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
            options.signal?.throwIfAborted();
            const apiKey = options?.apiKey;
            if (!apiKey) {
                throw new Error(`No API key for provider: ${model.provider}`);
            }
            const accountId = extractAccountId(apiKey);
			const capabilityContext = contextForModelCapabilities(model, context);
            const grammarToolInputProperties = createGrammarToolInputProperties(capabilityContext.tools, model.compat?.supportsOpenAIGrammarTools ?? false);
			const cacheSessionId =
				capabilityCacheRetention(model, options?.cacheRetention ?? "short") === "none"
					? undefined
					: options?.sessionId;
            const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
            let body = buildOpenAICodexRequestBody(model, context, options, codexSessionId, grammarToolInputProperties);
            const nextBody = await options?.onPayload?.(body, model, options);
            if (nextBody !== undefined) {
                body = nextBody as OpenAICodexRequestBody;
            }
            options.signal?.throwIfAborted();
            const requestServiceTier = body.service_tier;
			const capabilities = getModelCapabilities(model);
            const websocketRequestId = codexSessionId || uuidv7();
            const routingHint = buildCodexRoutingHint(body.model, requestServiceTier);
			const remoteCompactionEnabled =
				capabilities.remoteCompaction && options?.codexRemoteCompaction === true &&
				!!codexSessionId && codexSessionId === options.sessionId;
            const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, routingHint, codexSessionId, remoteCompactionEnabled);
            const websocketHeaders = buildWebSocketHeaders(model.headers, options?.headers, accountId, apiKey, routingHint, websocketRequestId, remoteCompactionEnabled);
            let bodyJson;
            const getBodyJson = () => (bodyJson ??= JSON.stringify(body));
            const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
            const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
			const transport = capabilities.websocketContinuation ? options?.transport || "auto" : "sse";
            let startEmitted = false;
            let failedWebSocketBytes: number | undefined;
            const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(owner, cacheSessionId);
            if (websocketDisabledForSession) {
                recordWebSocketSseFallback(owner, cacheSessionId);
            }
            if (transport !== "sse" && !websocketDisabledForSession) {
                let websocketStarted = false;
                let retriedWebSocketConnectionLimit = false;
                let retriedMissingWebSocketContinuation = false;
                while (true) {
                    websocketStarted = false;
                    try {
                        await processWebSocketStream(owner, resolveCodexWebSocketUrl(model.baseUrl), body, websocketHeaders, output, stream, model, () => {
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
                            requestBytes: webSocketRequestBytes(error),
                        }));
                        recordWebSocketFailure(owner, cacheSessionId, error);
                        if (websocketStarted) {
                            if (!(error instanceof WebSocketCloseError && error.requestBytes !== undefined)) activateWebSocketSseFallback(owner, cacheSessionId);
                            throw error;
                        }
                        if (error instanceof WebSocketCloseError && error.requestBytes !== undefined) {
                            if (error.afterCompaction) throw error;
                            failedWebSocketBytes = error.requestBytes;
                        } else recordWebSocketSseFallback(owner, cacheSessionId);
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
            const serializedJsonBytes = requestBodyUtf8Bytes(bodyJson);
            const wireBytes = typeof sseBody === "string" ? serializedJsonBytes : sseBody.byteLength;
            if (failedWebSocketBytes !== undefined) {
                if (wireBytes >= failedWebSocketBytes) throw new CodexApiError("The SSE fallback would not reduce the rejected WebSocket upload. Reduce new images/text before retrying.", { code: "request_body_too_large" });
                recordWebSocketSseFallback(owner, cacheSessionId);
            }
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
                        observeCodexRequestBody(options, wireBytes, serializedJsonBytes);
                        options.signal?.throwIfAborted(); owner.assertCurrent();
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
                    try {
                        await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
                        options.signal?.throwIfAborted();
                    } catch (error) { await cancelUnconsumedResponse(owner, response); throw error; }
                    if (response.ok) {
                        break;
                    }
                    const errorText = await response.text();
                    const info = await parseErrorResponse(response, errorText);
                    if (attempt < maxRetries && isRetryableError(response.status, errorText, info.code)) {
                        const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
                        const delayMs = retryAfterDelayMs === undefined
                            ? BASE_DELAY_MS * 2 ** attempt
                            : validateRetryDelayMs(retryAfterDelayMs, options);
                        await sleep(delayMs, options?.signal);
                        continue;
                    }
                    throw new CodexApiError(info.friendlyMessage || info.message, { status: response.status, code: info.code });
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
                        !isCodexNonTransportError(lastError) &&
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
            recordSuccessfulDispatch(owner, cacheSessionId, body, body, sseHeaders, "sse", responseItems, model, options, output.responseId);
            options.signal?.throwIfAborted();
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = formatProviderError(normalizeProviderError(error));
            annotateRequestBodyFailure(error, output);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    });
    void owner.track(operation, admitted.cleanup).catch(ignoreSettledRequestFailure);
    return stream;
}
function streamSimpleOwned(owner: CodexTransportOwner, model: Model<"openai-codex-responses">, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const apiKey = options?.apiKey;
    if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
    }
    const base: OpenAICodexResponsesOptions = {
        ...buildBaseOptions(model, context, options, apiKey),
        toolChoice: options?.toolChoice,
    };
    const clampedReasoning = clampThinkingLevel(model, options?.reasoning ?? "off");
    const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
    return streamOwned(owner, model, context, {
        ...base,
        reasoningEffort,
    });
};
// ============================================================================
// Request Building
// ============================================================================
export function buildOpenAICodexRequestBody(
    model: Model<"openai-codex-responses">,
    context: Context,
    options: OpenAICodexResponsesOptions | undefined,
    cacheSessionId: string | undefined,
    grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(context.tools, model.compat?.supportsOpenAIGrammarTools ?? false),
): OpenAICodexRequestBody {
	const capabilities = getModelCapabilities(model);
    const supportsStrictMode = (model.compat?.supportsStrictMode ?? true) && capabilities.strictToolSchema;
    const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
	const wireContext = contextForModelCapabilities(model, context);
	const toolPlacement = splitDeferredTools(
		wireContext,
		(model.compat?.supportsToolSearch ?? false) && capabilities.deferredTools,
	);
    const messages = convertResponsesMessages(model, wireContext, CODEX_TOOL_CALL_PROVIDERS, {
        includeSystemPrompt: false,
        grammarToolInputProperties,
        deferredTools: toolPlacement.deferred,
        toolOptions: {
            strict: null,
            supportsStrictMode,
            supportsOpenAIGrammarTools,
        },
    });
    const body: OpenAICodexRequestBody = {
        model: model.id,
        store: false,
        stream: true,
		instructions: wireContext.systemPrompt || "You are a helpful assistant.",
        input: messages,
        text: { verbosity: options?.textVerbosity || "low" },
		...(capabilities.reasoning.mode !== "none" ? { include: ["reasoning.encrypted_content"] } : {}),
		prompt_cache_key:
			capabilityCacheRetention(model, options?.cacheRetention ?? "short") !== "none" ? cacheSessionId : undefined,
		...(capabilities.toolCalling ? { tool_choice: options?.toolChoice ?? "auto" } : {}),
		...(capabilities.toolCalling ? { parallel_tool_calls: capabilities.parallelTools } : {}),
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
	if (capabilities.reasoning.mode !== "none" && options?.reasoningEffort !== undefined) {
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
// OpenAI renamed Priority processing to Fast mode (2026-07-30) at the same price; GPT-6 reports "fast".
function getServiceTierCostMultiplier(model: Pick<Model<"openai-codex-responses">, "id">, serviceTier: ResponseCreateParamsStreaming["service_tier"] | "fast" | undefined): number {
    switch (serviceTier) {
        case "flex":
            return 0.5;
        case "priority":
        case "fast":
            return model.id.startsWith("gpt-5.5") ? 2.5 : 2;
        default:
            return 1;
    }
}
function applyServiceTierPricing(usage: Usage, serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined, model: Pick<Model<"openai-codex-responses">, "id">): void {
    const multiplier = getServiceTierCostMultiplier(model, serviceTier);
    if (multiplier === 1)
        return;
    usage.cost.input *= multiplier;
    usage.cost.output *= multiplier;
    usage.cost.cacheRead *= multiplier;
    usage.cost.cacheWrite *= multiplier;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
function resolveCodexServiceTier(responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined, requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined): ResponseCreateParamsStreaming["service_tier"] | undefined {
    return responseServiceTier ?? requestServiceTier;
}
function buildCodexRoutingHint(model: string, serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined): string {
    return serviceTier === undefined ? `model=${model}` : `model=${model};tier=${serviceTier}`;
}
function resolveCodexUrl(baseUrl: string): string {
    const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
    const normalized = raw.replace(TRAILING_SLASHES_PATTERN, "");
    if (normalized.endsWith("/codex/responses"))
        return normalized;
    if (normalized.endsWith("/codex"))
        return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
}
function resolveCodexWebSocketUrl(baseUrl: string): string {
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
async function processStream(
    response: Response,
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    model: Model<"openai-codex-responses">,
    grammarToolInputProperties: ReadonlyMap<string, string>,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    options: OpenAICodexResponsesOptions | undefined,
): Promise<void> {
    await processResponsesStream(mapCodexEvents(parseSSE(response, options?.signal), output), output, stream, model, {
        serviceTier: requestServiceTier,
        grammarToolInputProperties,
        resolveServiceTier: resolveCodexServiceTier,
        applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
    });
}
class CodexApiError extends Error {
    readonly status?: number;
    readonly code?: string;
    readonly payload?: unknown;
    constructor(message: string, options?: { cause?: unknown; status?: number; code?: string; payload?: unknown }) {
        super(options?.status === 413 ? `HTTP 413: ${message}` :
            isCodexBodySizeCode(options?.code) ? `[REQUEST_BODY_TOO_LARGE] ${message}` : message);
        this.name = "CodexApiError";
        this.status = options?.status;
        this.code = options?.code;
        this.payload = options?.payload;
        this.cause = options?.cause;
    }
}
function isCodexBodySizeCode(code: string | undefined): boolean {
    return code === "request_too_large" || code === "request_body_too_large" || code === "payload_too_large";
}
class CodexProtocolError extends Error {
    readonly payload?: unknown;
    constructor(message: string, options?: { cause?: unknown; payload?: unknown }) {
        super(message);
        this.name = "CodexProtocolError";
        this.payload = options?.payload;
        this.cause = options?.cause;
    }
}
class CodexBodyObserverError extends CodexProtocolError {
    constructor(cause: unknown) {
        super(`Request preparation blocked: body byte observer failed: ${formatThrownValue(cause)}`, { cause });
        this.name = "CodexBodyObserverError";
    }
}
function observeCodexRequestBody(options: StreamOptions | undefined, wireBytes: number, serializedJsonBytes: number): void {
    try { options?.onRequestBodyBytes?.(wireBytes, serializedJsonBytes); }
    catch (cause) { throw new CodexBodyObserverError(cause); }
}
// Weak, numeric failure metadata cannot retain request strings or old errors.
const WEBSOCKET_REQUEST_BYTES = new WeakMap<object, number>();
function webSocketRequestBytes(error: unknown): number | undefined {
    return error && typeof error === "object" ? WEBSOCKET_REQUEST_BYTES.get(error) : undefined;
}
function recordWebSocketBodyFailure(error: unknown, bytes: number | undefined, afterCompaction: boolean): void {
    if (!error || typeof error !== "object" || bytes === undefined) return;
    WEBSOCKET_REQUEST_BYTES.set(error, bytes);
    if (error instanceof WebSocketCloseError && error.code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
        error.requestBytes = bytes; error.afterCompaction = afterCompaction;
        error.message += " [REQUEST_BODY_TOO_LARGE]";
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
function isCodexNonTransportError(error: unknown): boolean {
    return error instanceof CodexApiError || error instanceof CodexProtocolError;
}
function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
    return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}
function isPreviousResponseNotFoundError(error: unknown): boolean {
    return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}
function extractCodexEventError(event: CodexEvent): CodexErrorRecord {
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
async function* mapCodexEvents(
    events: AsyncIterable<CodexEvent>,
    output: AssistantMessage,
): AsyncGenerator<ResponseStreamEvent> {
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
            const response = event.response as (typeof event.response & { end_turn?: unknown }) | undefined;
            if (typeof response?.end_turn === "boolean") {
                output.endTurn = response.end_turn;
            }
            const normalizedResponse = response
                ? { ...response, status: normalizeCodexStatus(response.status) }
                : response;
            yield { ...event, type: "response.completed", response: normalizedResponse } as unknown as ResponseStreamEvent;
            return;
        }
        yield event as unknown as ResponseStreamEvent;
    }
}
function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
    if (typeof status !== "string")
        return undefined;
    return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? status as CodexResponseStatus : undefined;
}
// ============================================================================
// SSE Parsing
// ============================================================================
async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<CodexEvent> {
    if (!response.body)
        return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Unterminated line residue and the current frame's data lines; both owned by this stream.
    let buffer = "";
    let data: string | undefined;
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
            // At EOF, flush the decoder and terminate a residual final line and frame so they are parsed.
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            if (done)
                buffer += "\n\n";
            // Scan complete LF/CRLF lines in place; a CR that ends a read waits for its LF.
            let lineStart = 0;
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
                const lineEnd = newline > lineStart && buffer.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
                if (lineEnd === lineStart) {
                    const payload = data?.trim();
                    data = undefined;
                    if (payload && payload !== "[DONE]") {
                        try {
                            yield JSON.parse(payload) as CodexEvent;
                        }
                        catch (cause) {
                            throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
                                cause,
                                payload,
                            });
                        }
                    }
                }
                else if (buffer.startsWith("data:", lineStart)) {
                    // Skip the conventional space so trim() usually returns the slice unchanged.
                    const valueStart = buffer.charCodeAt(lineStart + 5) === 32 ? lineStart + 6 : lineStart + 5;
                    const line = buffer.slice(valueStart, lineEnd).trim();
                    data = data === undefined ? line : `${data}\n${line}`;
                }
                lineStart = newline + 1;
                newline = buffer.indexOf("\n", lineStart);
            }
            // Drop the consumed prefix once per read.
            if (lineStart > 0)
                buffer = buffer.slice(lineStart);
            if (done)
                break;
        }
    }
    finally {
        // Release unread residue/current frame before cancellation can await transport cleanup.
        buffer = "";
        data = undefined;
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
function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
    const raw = typeof process === "undefined" ? undefined : process.env?.[name];
    if (raw === undefined || raw === "")
        return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
const SESSION_WEBSOCKET_CACHE_TTL_MS = boundedEnvironmentInteger("SP_CODEX_WEBSOCKET_IDLE_TTL_MS", DEFAULT_SESSION_WEBSOCKET_CACHE_TTL_MS, MIN_SESSION_WEBSOCKET_CACHE_TTL_MS, MAX_SESSION_WEBSOCKET_CACHE_TTL_MS);
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const MAX_CACHED_WEBSOCKET_ENTRIES = boundedEnvironmentInteger("SP_CODEX_WEBSOCKET_MAX_CACHED_ENTRIES", DEFAULT_MAX_CACHED_WEBSOCKET_ENTRIES, 1, MAX_CACHED_WEBSOCKET_ENTRIES_LIMIT);

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
    readonly readyState?: number;
    close(code?: number, reason?: string): void;
    send(data: string): void;
    addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
    removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

type WebSocketConstructor = new (
    url: string,
    protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

interface CachedWebSocketContinuationState {
    lastRequestBody: RequestBody;
    lastResponseId: string;
    lastResponseItems: ResponseInput;
    compactionBoundary?: boolean;
}

interface CachedWebSocketConnection {
    url: string;
    socket: WebSocketLike;
    connectionHeadersKey: string;
    busy: boolean;
    createdAt: number;
    lastUsedAt: number;
    idleTimer?: ReturnType<typeof setTimeout>;
    continuation?: CachedWebSocketContinuationState;
}

interface SuccessfulDispatchCommitment {
    transport: OpenAICodexDispatchTransport;
    instructionsHash: string;
    inputHash: string;
    inputItems: number;
    responseItemsHash: string;
    responseItems: number;
    toolsHash: string;
    bodyWithoutInputHash: string;
    promptCacheKeyHash: string;
    cacheRetentionHash: string;
    cachePolicyHash: string;
    cacheBoundaryHash: string;
    serviceTierHash: string;
    headersHash: string;
    actualBodyHash: string;
    instructionsBytes: number;
    toolOrderHash: string;
    toolIdentifierSetHash: string;
    toolCount: number;
    previousResponseMode: "none" | "response-id";
    responseId?: string;
}

interface WebSocketLease {
    socket: WebSocketLike;
    entry?: CachedWebSocketConnection;
    reused: boolean;
    release(options?: { keep?: boolean }): void;
}

const MAX_SUCCESSFUL_DISPATCH_COMMITMENTS = 16;
export interface OpenAICodexTransportOwner {
    readonly generation: number;
    readonly stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions>;
    readonly streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions>;
    compact(model: Model<"openai-codex-responses">, payload: Record<string, unknown>, options: OpenAICodexCompactionOptions): Promise<OpenAICodexCompactionResult>;
    getDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined;
    readonly diagnostics: { pending: number; sockets: number; cached: number; timers: number; commitments: number; consumed: number; debug: number; fallbacks: number };
    assertCurrent(): void;
    resume(expectedGeneration?: number): void;
    reset(): void;
    revoke(): void;
    drain(): Promise<void>;
    dispose(): Promise<void>;
}

function ignoreSettledRequestFailure(): void {} // Request errors are delivered to their caller; drain joins settlement.

class CodexTransportOwner implements OpenAICodexTransportOwner {
    readonly websocketSessionCache = new Map<string, Map<string, CachedWebSocketConnection>>();
    readonly websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
    readonly websocketSseFallbackSessions = new Set<string>();
    readonly successfulDispatchCommitments = new Map<string, SuccessfulDispatchCommitment>();
    readonly consumedDispatchCommitments = new Set<string>();
    readonly sockets = new Set<WebSocketLike>();
    private readonly pending = new Set<Promise<unknown>>();
    private cancellation = new AbortController();
    private accepting = true;
    private epoch = 0;
    private disposed = false;
    private draining: Promise<void> | undefined;
    private disposal: Promise<void> | undefined;
    private cleanupFailed = false;
    private cleanupFailure: unknown;

    readonly stream: OpenAICodexTransportOwner["stream"] = (model, context, options) => streamOwned(this, model, context, options);
    readonly streamSimple: OpenAICodexTransportOwner["streamSimple"] = (model, context, options) => streamSimpleOwned(this, model, context, options);
    compact(model: Model<"openai-codex-responses">, payload: Record<string, unknown>, options: OpenAICodexCompactionOptions): Promise<OpenAICodexCompactionResult> {
        const admitted = this.admit(options);
        return this.track(Promise.resolve().then(() => compactOpenAICodexRequestOwned(this, model, payload, admitted.options)), admitted.cleanup);
    }
    getDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined { return getOpenAICodexWebSocketDebugStatsOwned(this, sessionId); }
    get diagnostics() {
        let cached = 0, timers = 0;
        for (const entries of this.websocketSessionCache.values()) for (const entry of entries.values()) {
            cached++; if (entry.idleTimer) timers++;
        }
        return { pending: this.pending.size, sockets: this.sockets.size, cached, timers,
            commitments: this.successfulDispatchCommitments.size, consumed: this.consumedDispatchCommitments.size,
            debug: this.websocketDebugStats.size, fallbacks: this.websocketSseFallbackSessions.size };
    }
    get isActive(): boolean { return this.accepting && !this.disposed; }
    get generation(): number { return this.epoch; }
    assertCurrent(): void { if (!this.isActive) throw new Error("Codex transport owner is revoked or disposed"); }
    admit<T extends StreamOptions>(options: T | undefined): { options: T; cleanup: () => void } {
        this.assertCurrent();
        if (this.pending.size >= 128) throw new Error("Codex transport owner request capacity exceeded");
        const combined = combineAbortSignals([options?.signal, this.cancellation.signal]);
        return { options: { ...options, signal: combined.signal } as T, cleanup: combined.cleanup };
    }
    track<T>(operation: Promise<T>, cleanup: () => void): Promise<T> {
        const tracked = operation.finally(() => { cleanup(); this.pending.delete(tracked); });
        this.pending.add(tracked);
        return tracked;
    }
    closeSocket(socket: WebSocketLike, code: number, reason: string): void {
        if (!this.sockets.has(socket)) return;
        try { socket.close(code, reason); this.sockets.delete(socket); }
        catch (error) { this.recordCleanupFailure(error); }
    }
    recordCleanupFailure(error: unknown): void { this.cleanupFailed = true; this.cleanupFailure = error; }
    revoke(): void {
        this.epoch++;
        this.accepting = false;
        if (!this.cancellation.signal.aborted) this.cancellation.abort(new Error("Codex transport owner revoked"));
        closeOpenAICodexWebSocketSessionsOwned(this);
        for (const socket of this.sockets) this.closeSocket(socket, 1000, "owner_revoked");
        if (this.cleanupFailed) throw this.cleanupFailure;
    }
    drain(): Promise<void> {
        if (this.accepting) return Promise.reject(new Error("Revoke Codex transport owner before draining"));
        return this.draining ??= this.finishPending().catch(error => {
            this.cleanupFailed = true; this.cleanupFailure = error; throw error;
        }).finally(() => { this.draining = undefined; });
    }
    private async finishPending(): Promise<void> {
        await Promise.allSettled(this.pending);
        closeOpenAICodexWebSocketSessionsOwned(this);
        resetOpenAICodexWebSocketDebugStatsOwned(this);
        if (this.cleanupFailed) throw this.cleanupFailure;
    }
    resume(expectedGeneration = this.epoch): void {
        if (expectedGeneration !== this.epoch) throw new Error("Codex transport request belongs to a previous generation");
        if (this.disposed) throw new Error("Codex transport owner is disposed");
        if (this.cleanupFailed) throw this.cleanupFailure;
        if (this.accepting) return;
        if (this.pending.size || this.draining) throw new Error("Codex transport owner is still draining");
        this.cancellation = new AbortController(); this.accepting = true;
    }
    reset(): void {
        // Model selection may originate in a payload hook: do not await that same request.
        try { this.revoke(); } finally { void this.drain().catch(ignoreSettledRequestFailure); }
    }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        this.disposed = true;
        this.disposal = Promise.resolve().then(() => this.drain());
        try { this.revoke(); } catch { /* drain retains and reports cleanup failure */ }
        return this.disposal;
    }
}

export function createOpenAICodexTransportOwner(): OpenAICodexTransportOwner { return new CodexTransportOwner(); }

// Compatibility domain only. Explicit owners are never registered in global ID-based cleanup.
const legacyDefaultOwner = new CodexTransportOwner();
export const stream = legacyDefaultOwner.stream;
export const streamSimple = legacyDefaultOwner.streamSimple;
export function compactOpenAICodexRequest(model: Model<"openai-codex-responses">, payload: Record<string, unknown>, options: OpenAICodexCompactionOptions): Promise<OpenAICodexCompactionResult> {
    return legacyDefaultOwner.compact(model, payload, options);
}
export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined { return legacyDefaultOwner.getDebugStats(sessionId); }
export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void { resetOpenAICodexWebSocketDebugStatsOwned(legacyDefaultOwner, sessionId); }
export function closeOpenAICodexWebSocketSessions(sessionId?: string): void { closeOpenAICodexWebSocketSessionsOwned(legacyDefaultOwner, sessionId); }

function getOrCreateWebSocketDebugStats(owner: CodexTransportOwner, sessionId: string): OpenAICodexWebSocketDebugStats {
    owner.assertCurrent();
    let stats = owner.websocketDebugStats.get(sessionId);
    if (!stats) {
        while (owner.websocketDebugStats.size >= 128) {
            const oldest = owner.websocketDebugStats.keys().next().value;
            if (oldest === undefined) break;
            owner.websocketDebugStats.delete(oldest); owner.websocketSseFallbackSessions.delete(oldest);
        }
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
        owner.websocketDebugStats.set(sessionId, stats);
    }
    return stats;
}
function getOpenAICodexWebSocketDebugStatsOwned(owner: CodexTransportOwner, sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
    const stats = owner.websocketDebugStats.get(sessionId);
    return stats ? { ...stats } : undefined;
}
function resetOpenAICodexWebSocketDebugStatsOwned(owner: CodexTransportOwner, sessionId?: string): void {
    if (sessionId) {
        owner.websocketDebugStats.delete(sessionId);
        owner.websocketSseFallbackSessions.delete(sessionId);
        return;
    }
    owner.websocketDebugStats.clear();
    owner.websocketSseFallbackSessions.clear();
}
function closeOpenAICodexWebSocketSessionsOwned(owner: CodexTransportOwner, sessionId?: string): void {
    const closeEntry = (entry: CachedWebSocketConnection) => {
        if (entry.idleTimer)
            clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
        entry.continuation = undefined;
        closeWebSocketSilently(owner, entry.socket, 1000, "debug_close");
    };
    if (sessionId) {
        for (const entry of owner.websocketSessionCache.get(sessionId)?.values() ?? [])
            closeEntry(entry);
        owner.websocketSessionCache.delete(sessionId);
        owner.successfulDispatchCommitments.delete(sessionId);
        owner.consumedDispatchCommitments.delete(sessionId);
        return;
    }
    for (const accountEntries of owner.websocketSessionCache.values()) {
        for (const entry of accountEntries.values())
            closeEntry(entry);
    }
    owner.websocketSessionCache.clear();
    owner.successfulDispatchCommitments.clear();
    owner.consumedDispatchCommitments.clear();
}
function cleanupOpenAICodexSessionResources(sessionId?: string): void {
    closeOpenAICodexWebSocketSessionsOwned(legacyDefaultOwner, sessionId);
    resetOpenAICodexWebSocketDebugStatsOwned(legacyDefaultOwner, sessionId);
}
registerSessionResourceCleanup(cleanupOpenAICodexSessionResources);
function isWebSocketSseFallbackActive(owner: CodexTransportOwner, sessionId: string | undefined): boolean {
    return sessionId ? owner.websocketSseFallbackSessions.has(sessionId) : false;
}
function recordWebSocketSseFallback(owner: CodexTransportOwner, sessionId: string | undefined): void {
    if (!sessionId || !owner.isActive)
        return;
    activateWebSocketSseFallback(owner, sessionId);
    const stats = getOrCreateWebSocketDebugStats(owner, sessionId);
    stats.sseFallbacks++;
}
function activateWebSocketSseFallback(owner: CodexTransportOwner, sessionId: string | undefined): void {
    if (!sessionId || !owner.isActive) return;
    owner.websocketSseFallbackSessions.add(sessionId);
    getOrCreateWebSocketDebugStats(owner, sessionId).websocketFallbackActive = true;
}
function recordWebSocketFailure(owner: CodexTransportOwner, sessionId: string | undefined, error: unknown): void {
    if (!sessionId || !owner.isActive)
        return;
    const stats = getOrCreateWebSocketDebugStats(owner, sessionId);
    stats.websocketFailures++;
    stats.lastWebSocketError = formatThrownValue(error);
    stats.websocketFallbackActive = isWebSocketSseFallbackActive(owner, sessionId);
}
let _cachedWebsocket: WebSocketConstructor | null = null;
async function getWebSocketConstructor(env?: ProviderEnv): Promise<WebSocketConstructor | null> {
    if (!env && _cachedWebsocket)
        return _cachedWebsocket;
    // bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
    // TODO: remove this when bun supports proxy envs in websocket.
    if (typeof process !== "undefined" && process.versions?.bun) {
        const WebSocketWithProxy = class extends WebSocket {
            constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
                let _opts: Record<string, unknown> = {};
                if (Array.isArray(options) || typeof options === "string") {
                    _opts = { protocols: options };
                }
                else {
                    _opts = { ...options };
                }
                const proxyUrl = resolveHttpProxyUrlForTarget(url.toString().replace(WSS_PROTOCOL_PATTERN, "https:").replace(WS_PROTOCOL_PATTERN, "http:"), env);
                super(url, { ..._opts, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) } as never);
            }
        };
        if (!env) {
            _cachedWebsocket = WebSocketWithProxy;
        }
        return WebSocketWithProxy;
    }
    const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
    if (typeof ctor !== "function")
        return null;
    return ctor as WebSocketConstructor;
}
class WebSocketCloseError extends Error {
    requestBytes: number | undefined;
    afterCompaction = false;
    readonly code?: number;
    readonly reason?: string;
    readonly wasClean?: boolean;
    constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
        super(message);
        this.name = "WebSocketCloseError";
        this.code = options?.code;
        this.reason = options?.reason;
        this.wasClean = options?.wasClean;
    }
}
function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
    const readyState = socket.readyState;
    return typeof readyState === "number" ? readyState : undefined;
}
function isWebSocketReusable(socket: WebSocketLike): boolean {
    const readyState = getWebSocketReadyState(socket);
    // If readyState is unavailable, assume the runtime keeps it open/reusable.
    return readyState === undefined || readyState === 1;
}
function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
    return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}
function closeWebSocketSilently(owner: CodexTransportOwner, socket: WebSocketLike, code = 1000, reason = "done"): void {
    owner.closeSocket(socket, code, reason);
}
function removeCachedWebSocketSession(owner: CodexTransportOwner, sessionId: string, accountId: string, entry: CachedWebSocketConnection, reason: string): void {
    if (entry.idleTimer)
        clearTimeout(entry.idleTimer);
    closeWebSocketSilently(owner, entry.socket, 1000, reason);
    const accountEntries = owner.websocketSessionCache.get(sessionId);
    if (accountEntries?.get(accountId) === entry)
        accountEntries.delete(accountId);
    if (accountEntries?.size === 0)
        owner.websocketSessionCache.delete(sessionId);
}
function pruneWebSocketSessionCache(owner: CodexTransportOwner): void {
    for (const [sessionId, accountEntries] of owner.websocketSessionCache) {
        for (const [accountId, entry] of accountEntries) {
            if (!entry.busy && (isWebSocketSessionExpired(entry) || !isWebSocketReusable(entry.socket)))
                removeCachedWebSocketSession(owner, sessionId, accountId, entry, "cache_prune");
        }
    }
}
function reserveWebSocketSessionCacheSlot(owner: CodexTransportOwner): boolean {
    pruneWebSocketSessionCache(owner);
    let cachedEntryCount = 0;
    let oldestSessionId;
    let oldestAccountId;
    let oldestEntry;
    for (const [sessionId, accountEntries] of owner.websocketSessionCache) {
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
    removeCachedWebSocketSession(owner, oldestSessionId!, oldestAccountId!, oldestEntry, "cache_lru_eviction");
    return true;
}
function expireSessionWebSocket(owner: CodexTransportOwner, sessionId: string, accountId: string, entry: CachedWebSocketConnection): void {
    if (entry.busy)
        return;
    removeCachedWebSocketSession(owner, sessionId, accountId, entry, "idle_timeout");
}
function scheduleSessionWebSocketExpiry(owner: CodexTransportOwner, sessionId: string, accountId: string, entry: CachedWebSocketConnection) {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = undefined;
    if (!owner.isActive || owner.websocketSessionCache.get(sessionId)?.get(accountId) !== entry) {
        entry.continuation = undefined;
        closeWebSocketSilently(owner, entry.socket);
        return;
    }
    entry.lastUsedAt = Date.now();
    entry.idleTimer = setTimeout(expireSessionWebSocket, SESSION_WEBSOCKET_CACHE_TTL_MS, owner, sessionId, accountId, entry);
}
async function connectWebSocket(owner: CodexTransportOwner, url: string, headers: Headers, signal?: AbortSignal, connectTimeoutMs: number | undefined = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, env?: ProviderEnv): Promise<WebSocketLike> {
    const WebSocketCtor = await getWebSocketConstructor(env);
    signal?.throwIfAborted();
    owner.assertCurrent();
    if (!WebSocketCtor) {
        throw new Error("WebSocket transport is not available in this runtime");
    }
    const wsHeaders = headersToRecord(headers);
    return new Promise<WebSocketLike>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let socket: WebSocketLike;
        try {
            socket = new WebSocketCtor(url, { headers: wsHeaders });
            owner.sockets.add(socket);
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
        const fail = (error: Error, closeReason?: string) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (closeReason) {
                closeWebSocketSilently(owner, socket, 1000, closeReason);
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
        const onError = (event: unknown) => {
            fail(extractWebSocketError(event), "connect_error");
        };
        const onClose = (event: unknown) => {
            fail(extractWebSocketCloseError(event), "connect_closed");
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
async function acquireWebSocket(owner: CodexTransportOwner,
    url: string,
    headers: Headers,
    sessionId: string | undefined,
    accountId: string,
    signal: AbortSignal | undefined,
    connectTimeoutMs: number | undefined,
    env: ProviderEnv | undefined,
): Promise<WebSocketLease> {
    if (!sessionId) {
        const socket = await connectWebSocket(owner, url, headers, signal, connectTimeoutMs, env);
        return {
            socket,
            reused: false,
            release: () => closeWebSocketSilently(owner, socket),
        };
    }
    const connectionHeadersKey = JSON.stringify(headersToRecord(headers));
    let accountEntries = owner.websocketSessionCache.get(sessionId);
    const cached = accountEntries?.get(accountId);
    if (cached) {
        if (cached.idleTimer) {
            clearTimeout(cached.idleTimer);
            cached.idleTimer = undefined;
        }
        if (!cached.busy && (cached.url !== url || cached.connectionHeadersKey !== connectionHeadersKey)) {
            closeWebSocketSilently(owner, cached.socket, 1000, "headers_changed");
            accountEntries?.delete(accountId);
            if (accountEntries?.size === 0)
                owner.websocketSessionCache.delete(sessionId);
        }
        else if (!cached.busy && isWebSocketSessionExpired(cached)) {
            closeWebSocketSilently(owner, cached.socket, 1000, "connection_age_limit");
            accountEntries?.delete(accountId);
            if (accountEntries?.size === 0)
                owner.websocketSessionCache.delete(sessionId);
        }
        else if (!cached.busy && isWebSocketReusable(cached.socket)) {
            cached.busy = true;
            return {
                socket: cached.socket,
                entry: cached,
                reused: true,
                release: ({ keep } = {}) => {
                    if (!keep || !isWebSocketReusable(cached.socket)) {
                        closeWebSocketSilently(owner, cached.socket);
                        const currentEntries = owner.websocketSessionCache.get(sessionId);
                        if (currentEntries?.get(accountId) === cached)
                            currentEntries.delete(accountId);
                        if (currentEntries?.size === 0)
                            owner.websocketSessionCache.delete(sessionId);
                        return;
                    }
                    cached.busy = false;
                    scheduleSessionWebSocketExpiry(owner, sessionId, accountId, cached);
                },
            };
        }
        if (cached.busy) {
            const socket = await connectWebSocket(owner, url, headers, signal, connectTimeoutMs, env);
            return {
                socket,
                reused: false,
                release: () => {
                    closeWebSocketSilently(owner, socket);
                },
            };
        }
        if (!isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(owner, cached.socket);
            accountEntries?.delete(accountId);
            if (accountEntries?.size === 0)
                owner.websocketSessionCache.delete(sessionId);
        }
    }
    const socket = await connectWebSocket(owner, url, headers, signal, connectTimeoutMs, env);
    if (!owner.isActive || signal?.aborted) { closeWebSocketSilently(owner, socket); signal?.throwIfAborted(); owner.assertCurrent(); }
    // A concurrent request may have populated this session/account pair while connect awaited.
    // Keep this connection request-scoped rather than replacing credential-bound continuation state.
    accountEntries = owner.websocketSessionCache.get(sessionId);
    if (accountEntries?.has(accountId) || !reserveWebSocketSessionCacheSlot(owner)) {
        return {
            socket,
            reused: false,
            release: () => closeWebSocketSilently(owner, socket),
        };
    }
    const now = Date.now();
    const entry: CachedWebSocketConnection = {
        url,
        socket,
        connectionHeadersKey,
        busy: true,
        createdAt: now,
        lastUsedAt: now,
    };
    accountEntries = owner.websocketSessionCache.get(sessionId);
    if (!accountEntries) {
        accountEntries = new Map();
        owner.websocketSessionCache.set(sessionId, accountEntries);
    }
    accountEntries.set(accountId, entry);
    return {
        socket,
        entry,
        reused: false,
        release: ({ keep } = {}) => {
            if (!keep || !isWebSocketReusable(entry.socket)) {
                removeCachedWebSocketSession(owner, sessionId, accountId, entry, "done");
                return;
            }
            entry.busy = false;
            scheduleSessionWebSocketExpiry(owner, sessionId, accountId, entry);
        },
    };
}
function extractWebSocketError(event: unknown): Error {
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
function extractWebSocketCloseError(event: unknown): Error {
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
function decodeWebSocketBuffer(data: ArrayBuffer): string { return new TextDecoder().decode(new Uint8Array(data)); }

function decodeWebSocketData(data: unknown): string | null | Promise<string> {
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
        const blobLike = data as { arrayBuffer(): Promise<ArrayBuffer> };
        return blobLike.arrayBuffer().then(decodeWebSocketBuffer);
    }
    return null;
}
async function* parseWebSocket(owner: CodexTransportOwner,
    socket: WebSocketLike,
    signal: AbortSignal | undefined,
    idleTimeoutMs: number | undefined,
): AsyncGenerator<CodexEvent> {
    const queue: CodexEvent[] = [];
    let pending: (() => void) | null = null;
    let done = false;
    let failed: Error | null = null;
    let sawCompletion = false;
    let closed = false, decoding = 0;
    let decodeDrain: Promise<void> | undefined;
    let finishDecodeDrain: (() => void) | undefined;
    const wake = () => {
        if (!pending)
            return;
        const resolve = pending;
        pending = null;
        resolve();
    };
    const onDecoded = (text: string | null) => {
        if (closed || !text) return;
        try {
                const parsed = JSON.parse(text) as CodexEvent;
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
    };
    const onDecodeFailure = (cause: unknown) => {
        if (closed) return;
        failed = new CodexProtocolError(`Invalid Codex WebSocket data: ${formatThrownValue(cause)}`, { cause });
        done = true; wake();
    };
    const finishDecode = () => {
        if (--decoding !== 0) return;
        const finish = finishDecodeDrain;
        finishDecodeDrain = undefined; decodeDrain = undefined; finish?.();
    };
    const beginDecodeCycle = () => {
        // Blob conversion owns one shared deferred per idle-to-busy cycle, never per text delta.
        decodeDrain = new Promise<void>(resolve => { finishDecodeDrain = resolve; });
    };
    const onMessage = (event: unknown) => {
        if (closed || !event || typeof event !== "object" || !("data" in event)) return;
        try {
            if (decoding >= 128) throw new Error("Codex WebSocket decode capacity exceeded");
            const decoded = decodeWebSocketData(event.data);
            if (typeof decoded === "string" || decoded === null) { onDecoded(decoded); return; }
            if (decoding++ === 0) beginDecodeCycle();
            void decoded.then(onDecoded, onDecodeFailure).finally(finishDecode);
        } catch (error) { onDecodeFailure(error); }
    };
    const onError = (event: unknown) => {
        failed = extractWebSocketError(event);
        done = true;
        wake();
    };
    const onClose = (event: unknown) => {
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
                yield queue.shift()!;
                continue;
            }
            if (done)
                break;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            await new Promise<void>((resolve, reject) => {
                pending = resolve;
                if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
                    timeout = setTimeout(() => {
                        const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
                        failed = error;
                        done = true;
                        pending = null;
                        closeWebSocketSilently(owner, socket, 1000, "idle_timeout");
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
        closed = true;
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        queue.length = 0; pending = null;
        await decodeDrain;
    }
}
function requestBodyWithoutInput(body: RequestBody): RequestBody {
    const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
    return rest;
}
function isJsonCompatiblePlainData(value: unknown, ancestors = new WeakSet<object>()): boolean {
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
function jsonValuesEqual(a: unknown, b: unknown): boolean {
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
    const leftKeys = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
    const rightKeys = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
    if (leftKeys.length !== rightKeys.length)
        return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || (b as Record<string, unknown>)[key] === undefined || !jsonValuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
            return false;
    }
    return true;
}
function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
    return jsonValuesEqual(a ?? [], b ?? []);
}
function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
    return jsonValuesEqual(requestBodyWithoutInput(a), requestBodyWithoutInput(b));
}
function normalizedHeadersForCommitment(headers: Headers): Array<[string, string]> {
    const values: Array<[string, string]> = [];
    for (const [rawName, rawValue] of headers.entries()) {
        const name = rawName.toLowerCase();
        values.push([name, name === "authorization" ? "<redacted>" : rawValue]);
    }
    values.sort();
    return values;
}
function createSuccessfulDispatchCommitment(
    fullBody: RequestBody,
    actualBody: RequestBody,
    headers: Headers,
    transport: OpenAICodexDispatchTransport,
    responseItems: ResponseInput,
    responseId?: string,
): SuccessfulDispatchCommitment | undefined {
    const instructionsHash = sha256Json(actualBody.instructions ?? null);
    const inputHash = sha256Json(fullBody.input ?? []);
    const responseItemsHash = sha256Json(responseItems);
    const toolsHash = sha256Json(actualBody.tools ?? []);
    const bodyWithoutInputHash = sha256Json(requestBodyWithoutInput(actualBody));
    const promptCacheKeyHash = sha256Json(actualBody.prompt_cache_key ?? null);
    const cacheRetentionHash = sha256Json({
        promptCacheRetention: actualBody.prompt_cache_retention ?? null,
    });
    const cachePolicyHash = sha256Json({
        promptCacheOptions: actualBody.prompt_cache_options ?? null,
    });
    const cacheBoundaryHash = sha256Json(null);
    const serviceTierHash = sha256Json(actualBody.service_tier ?? null);
    const headersHash = sha256Json(normalizedHeadersForCommitment(headers));
    const actualBodyHash = sha256Json(actualBody);
    const toolOrderHash = sha256Json((actualBody.tools ?? []).map((tool) => {
        const record = tool as unknown as Record<string, unknown>;
        return typeof record.name === "string" ? record.name : (typeof record.type === "string" ? record.type : "unknown");
    }));
    const toolIdentifierSetHash = sha256Json((actualBody.tools ?? []).map((tool) => {
        const record = tool as unknown as Record<string, unknown>;
        return typeof record.name === "string" ? record.name : (typeof record.type === "string" ? record.type : "unknown");
    }).sort());
    if (!instructionsHash ||
        !inputHash ||
        !responseItemsHash ||
        !toolsHash ||
        !bodyWithoutInputHash ||
        !promptCacheKeyHash ||
        !cacheRetentionHash ||
        !cachePolicyHash ||
        !cacheBoundaryHash ||
        !serviceTierHash ||
        !headersHash ||
        !actualBodyHash ||
        !toolOrderHash ||
        !toolIdentifierSetHash) {
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
        cacheRetentionHash,
        cachePolicyHash,
        cacheBoundaryHash,
        serviceTierHash,
        headersHash,
        actualBodyHash,
        instructionsBytes: requestBodyUtf8Bytes(typeof actualBody.instructions === "string" ? actualBody.instructions : JSON.stringify(actualBody.instructions ?? null)),
        toolOrderHash,
        toolIdentifierSetHash,
        toolCount: actualBody.tools?.length ?? 0,
        previousResponseMode: actualBody.previous_response_id ? "response-id" : "none",
        ...(responseId ? { responseId } : {}),
    };
}
function recordSuccessfulDispatch(owner: CodexTransportOwner,
    sessionId: string | undefined,
    fullBody: RequestBody,
    actualBody: RequestBody,
    headers: Headers,
    transport: OpenAICodexDispatchTransport,
    responseItems: ResponseInput,
    model: Model<"openai-codex-responses">,
    options: OpenAICodexResponsesOptions | undefined,
    responseId?: string,
): void {
    if (!owner.isActive || options?.signal?.aborted) return;
    const commitment = createSuccessfulDispatchCommitment(fullBody, actualBody, headers, transport, responseItems, responseId);
    if (!commitment)
        return;
    const observation: EffectiveDispatchObservation = {
        transport: transport === "sse" ? "sse" : "websocket",
        previousResponseMode: commitment.previousResponseMode,
        instructionsHash: commitment.instructionsHash,
        instructionsBytes: commitment.instructionsBytes,
        toolOrderHash: commitment.toolOrderHash,
        toolIdentifierSetHash: commitment.toolIdentifierSetHash,
        toolsHash: commitment.toolsHash,
        toolCount: commitment.toolCount,
        cacheKeyHash: commitment.promptCacheKeyHash,
        cacheRetentionHash: commitment.cacheRetentionHash,
        cachePolicyHash: commitment.cachePolicyHash,
        cacheBoundaryHash: commitment.cacheBoundaryHash,
        prefixHash: commitment.bodyWithoutInputHash,
        requestTransformOutputHash: commitment.actualBodyHash,
    };
    deliverEffectiveDispatchObservation(options, model, observation);
    if (!sessionId || !owner.isActive || options?.signal?.aborted)
        return;
    owner.successfulDispatchCommitments.delete(sessionId);
    owner.consumedDispatchCommitments.delete(sessionId);
    while (owner.successfulDispatchCommitments.size >= MAX_SUCCESSFUL_DISPATCH_COMMITMENTS) {
        const oldest = owner.successfulDispatchCommitments.keys().next().value;
        if (typeof oldest !== "string")
            break;
        owner.successfulDispatchCommitments.delete(oldest);
    }
    owner.successfulDispatchCommitments.set(sessionId, commitment);
}
function markDispatchCommitmentConsumed(owner: CodexTransportOwner, sessionId: string): void {
    owner.consumedDispatchCommitments.delete(sessionId);
    while (owner.consumedDispatchCommitments.size >= MAX_SUCCESSFUL_DISPATCH_COMMITMENTS) {
        const oldest = owner.consumedDispatchCommitments.values().next().value;
        if (typeof oldest !== "string")
            break;
        owner.consumedDispatchCommitments.delete(oldest);
    }
    owner.consumedDispatchCommitments.add(sessionId);
}
function convertAssistantResponseItems(
    model: Model<"openai-codex-responses">,
    output: AssistantMessage,
    grammarToolInputProperties: ReadonlyMap<string, string>,
): ResponseInput {
    const converted = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
        includeSystemPrompt: false,
        grammarToolInputProperties,
    });
    const responseItems: ResponseInput = [];
    for (const item of converted) {
        if (item.type === "function_call_output" || item.type === "custom_tool_call_output")
            continue;
        responseItems.push(item);
    }
    return responseItems;
}
function getCachedWebSocketInputDelta(body: RequestBody, continuation: CachedWebSocketContinuationState): ResponseInput | undefined {
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
function responseItemContinuationIdentity(item: unknown, includeItemId: boolean): string | undefined {
    if (!item || typeof item !== "object")
        return undefined;
    const candidate = item as Record<string, unknown>;
    const type = typeof candidate.type === "string" ? candidate.type : undefined;
    if (!type)
        return undefined;
    const identity: Record<string, string> = { type };
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
function findUniqueResponseContinuationBoundary(currentInput: ResponseInput, responseItems: ResponseInput, includeItemId: boolean): number {
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
function getCompactionWebSocketInputDelta(
    body: RequestBody,
    continuation: CachedWebSocketContinuationState,
    commitment: SuccessfulDispatchCommitment,
): ResponseInput | undefined {
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
function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
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
async function* startWebSocketOutputOnFirstEvent(events: AsyncIterable<ResponseStreamEvent>, onStart: () => void) {
    let started = false;
    for await (const event of events) {
        if (!started) {
            started = true;
            onStart();
        }
        yield event;
    }
}
async function processWebSocketStream(owner: CodexTransportOwner,
    url: string,
    body: RequestBody,
    headers: Headers,
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    model: Model<"openai-codex-responses">,
    onStart: () => void,
    idleTimeoutMs: number | undefined,
    websocketConnectTimeoutMs: number | undefined,
    cacheSessionId: string | undefined,
    accountId: string,
    grammarToolInputProperties: ReadonlyMap<string, string>,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    options: OpenAICodexResponsesOptions | undefined,
): Promise<void> {
    const { socket, entry, reused, release } = await acquireWebSocket(owner, url, headers, cacheSessionId, accountId, options?.signal, websocketConnectTimeoutMs, options?.env);
    let keepConnection = true;
	const capabilities = getModelCapabilities(model);
	const useCachedContext =
		capabilities.previousResponseId &&
		capabilities.websocketContinuation &&
		(options?.transport === "websocket-cached" || options?.transport === "auto");
    // ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
    // WebSocket continuation still works via connection-scoped previous_response_id state.
    const fullBody = body;
    let requestBytes: number | undefined;
    let dispatched = false;
    try {
        options?.signal?.throwIfAborted();
        owner.assertCurrent();
        const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
        const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(owner, cacheSessionId) : undefined;
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
        let frame: string | undefined = JSON.stringify({ type: "response.create", ...requestBody });
        requestBytes = requestBodyUtf8Bytes(frame);
        try {
            observeCodexRequestBody(options, requestBytes, requestBytes);
            options?.signal?.throwIfAborted(); owner.assertCurrent();
            dispatched = true;
            socket.send(frame);
        } finally { frame = undefined; }
        await processResponsesStream(startWebSocketOutputOnFirstEvent(mapCodexEvents(parseWebSocket(owner, socket, options?.signal, idleTimeoutMs), output), onStart), output, stream, model, {
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
            recordSuccessfulDispatch(owner, cacheSessionId, fullBody, requestBody, headers, requestBody.previous_response_id ? "websocket-delta" : "websocket-full", responseItems, model, options, output.responseId);
            options?.signal?.throwIfAborted();
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
        recordWebSocketBodyFailure(error, requestBytes, entry?.continuation?.compactionBoundary === true);
        const preserveCachedContinuation = !dispatched && owner.isActive && entry !== undefined && isWebSocketReusable(socket) &&
            (error instanceof PostCompactionContinuationError || error instanceof InvalidContinuationPayloadError || error instanceof CodexBodyObserverError || options?.signal?.aborted === true);
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
function asOpenAICodexRequestBody(payload: Record<string, unknown>): RequestBody {
    if (typeof payload.model !== "string" || !Array.isArray(payload.input)) {
        throw new Error("Codex compaction requires a canonical Responses payload with model and input.");
    }
    return payload as RequestBody;
}
function buildCompactionRequestBody(regularPayload: Record<string, unknown>): RequestBody {
    const regularBody = asOpenAICodexRequestBody(regularPayload);
    return {
        ...regularBody,
        input: [...(regularBody.input ?? []), { type: "compaction_trigger" } as unknown as ResponseInput[number]],
    };
}
function compareCompactionToSuccessfulDispatch(
    commitment: SuccessfulDispatchCommitment,
    body: RequestBody,
    headers: Headers,
    compactionTransport: "sse" | "websocket-delta",
): OpenAICodexCompactionDiagnostics {
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
function assertCompactionParity(diagnostics: OpenAICodexCompactionDiagnostics): void {
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
function discardCompactionWebSocket(owner: CodexTransportOwner, sessionId: string, accountId: string, entry: CachedWebSocketConnection, reason: string): void {
    closeWebSocketSilently(owner, entry.socket, 1000, reason);
    if (entry.idleTimer)
        clearTimeout(entry.idleTimer);
    const accountEntries = owner.websocketSessionCache.get(sessionId);
    if (accountEntries?.get(accountId) === entry)
        accountEntries.delete(accountId);
    if (accountEntries?.size === 0)
        owner.websocketSessionCache.delete(sessionId);
}
function acquireExistingCompactionWebSocket(owner: CodexTransportOwner, sessionId: string, accountId: string, headers: Headers): {
    entry: CachedWebSocketConnection;
    release(keep: boolean): void;
} {
    const accountEntries = owner.websocketSessionCache.get(sessionId);
    const entry = accountEntries?.get(accountId);
    if (!entry)
        throw new Error("Codex compaction stopped: the last successful WebSocket connection is unavailable.");
    if (entry.busy)
        throw new Error("Codex compaction stopped: the session WebSocket is busy.");
    if (!entry.continuation) {
        discardCompactionWebSocket(owner, sessionId, accountId, entry, "compaction_continuation_unavailable");
        throw new Error("Codex compaction stopped: the WebSocket continuation is unavailable.");
    }
    if (entry.connectionHeadersKey !== JSON.stringify(headersToRecord(headers))) {
        discardCompactionWebSocket(owner, sessionId, accountId, entry, "compaction_headers_drifted");
        throw new Error("Codex compaction stopped: WebSocket connection headers drifted.");
    }
    if (!isWebSocketReusable(entry.socket) || isWebSocketSessionExpired(entry)) {
        discardCompactionWebSocket(owner, sessionId, accountId, entry, "compaction_connection_expired");
        throw new Error("Codex compaction stopped: the last successful WebSocket connection expired.");
    }
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
    }
    entry.busy = true;
    return {
        entry,
        release: (keep: boolean) => {
            if (!keep || !isWebSocketReusable(entry.socket)) {
                closeWebSocketSilently(owner, entry.socket);
                if (accountEntries?.get(accountId) === entry)
                    accountEntries.delete(accountId);
                if (accountEntries?.size === 0)
                    owner.websocketSessionCache.delete(sessionId);
                return;
            }
            entry.busy = false;
            scheduleSessionWebSocketExpiry(owner, sessionId, accountId, entry);
        },
    };
}
interface RemoteCompactionEventResult extends OpenAICodexCompactionResult {
    responseId?: string;
}

async function collectRemoteCompactionEvents(events: AsyncIterable<CodexEvent>): Promise<RemoteCompactionEventResult> {
    let completed = false;
    let compactionItem: Record<string, unknown> | undefined;
    let compactionItems = 0;
    let usage: unknown;
    let responseId: string | undefined;
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
                (item as Record<string, unknown>).type === "compaction") {
                compactionItems++;
                compactionItem = item as Record<string, unknown>;
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
async function cancelUnconsumedResponse(owner: CodexTransportOwner, response: Response): Promise<void> {
    if (!response.body) return;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = response.body.getReader(); } catch (error) { owner.recordCleanupFailure(error); return; }
    // A native fetch abort may have already errored the stream. That terminal state
    // differs from an underlying cancel() failure on an otherwise readable body.
    let errored = false;
    const closed = reader.closed.catch(() => { errored = true; });
    try { await reader.cancel(); }
    catch (error) { await closed; if (!errored) owner.recordCleanupFailure(error); }
    finally { reader.releaseLock(); }
}

async function performCodexSseCompaction(owner: CodexTransportOwner,
    model: Model<"openai-codex-responses">,
    body: string | Uint8Array,
    headers: Headers,
    options: OpenAICodexCompactionOptions,
    onDispatch: () => void,
    serializedJsonBytes: number,
): Promise<OpenAICodexCompactionResult> {
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const timeoutSignal = timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const combinedSignal = combineAbortSignals([options.signal, timeoutSignal]);
    try {
        options.signal?.throwIfAborted();
        observeCodexRequestBody(options, typeof body === "string" ? serializedJsonBytes : body.byteLength, serializedJsonBytes);
        options.signal?.throwIfAborted(); owner.assertCurrent();
        onDispatch();
        const response = await (options.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
            method: "POST",
            headers,
            body: body as never,
            signal: combinedSignal.signal,
        });
        try {
            await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
            options.signal?.throwIfAborted();
        } catch (error) { await cancelUnconsumedResponse(owner, response); throw error; }
        if (!response.ok) {
            const info = await parseErrorResponse(response);
            throw new CodexApiError(info.friendlyMessage || info.message, { status: response.status, code: info.code });
        }
        const { responseId: _responseId, ...result } = await collectRemoteCompactionEvents(parseSSE(response, combinedSignal.signal));
        return result;
    }
    finally {
        combinedSignal.cleanup();
    }
}
interface CodexWebSocketCompactionParams {
    sessionId: string;
    accountId: string;
    headers: Headers;
    commitment: SuccessfulDispatchCommitment;
    body: RequestBody;
    diagnostics: OpenAICodexCompactionDiagnostics;
    options: OpenAICodexCompactionOptions;
    onDispatch(): void;
}

async function performCodexWebSocketCompaction(owner: CodexTransportOwner, params: CodexWebSocketCompactionParams): Promise<OpenAICodexCompactionResult> {
    const acquired = acquireExistingCompactionWebSocket(owner, params.sessionId, params.accountId, params.headers);
    let keepConnection = false;
    let requestBytes: number | undefined;
    let dispatched = false;
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
        params.options.signal?.throwIfAborted();
        owner.assertCurrent();
        let frame: string | undefined = JSON.stringify({ type: "response.create", ...requestBody });
        requestBytes = requestBodyUtf8Bytes(frame);
        try {
            observeCodexRequestBody(params.options, requestBytes, requestBytes);
            params.options.signal?.throwIfAborted(); owner.assertCurrent();
            dispatched = true;
            params.onDispatch();
            acquired.entry.socket.send(frame);
        } finally { frame = undefined; }
        const result = await collectRemoteCompactionEvents(parseWebSocket(owner, acquired.entry.socket, params.options.signal, normalizeTimeoutMs(params.options.timeoutMs)));
        params.options.signal?.throwIfAborted();
        if (result.responseId) {
            acquired.entry.continuation = {
                lastRequestBody: params.body,
                lastResponseId: result.responseId,
                lastResponseItems: [result.compactionItem as unknown as ResponseInput[number]],
                compactionBoundary: true,
            };
            keepConnection = true;
        }
        const { responseId: _responseId, ...publicResult } = result;
        return publicResult;
    }
    catch (error) {
        recordWebSocketBodyFailure(error, requestBytes, acquired.entry.continuation?.compactionBoundary === true);
        if (!dispatched && owner.isActive && isWebSocketReusable(acquired.entry.socket) &&
            (error instanceof InvalidContinuationPayloadError || error instanceof CodexBodyObserverError || params.options.signal?.aborted))
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
async function compactOpenAICodexRequestOwned(owner: CodexTransportOwner,
    model: Model<"openai-codex-responses">,
    regularPayload: Record<string, unknown>,
    options: OpenAICodexCompactionOptions,
): Promise<OpenAICodexCompactionResult> {
    options.signal?.throwIfAborted();
    owner.assertCurrent();
    const sessionId = clampOpenAIPromptCacheKey(options.sessionId);
    if (!sessionId)
        throw new Error("Codex compaction stopped: a stable session id is required.");
    const commitment = owner.successfulDispatchCommitments.get(sessionId);
    if (!commitment) {
        throw new Error("Codex compaction stopped: no successful regular request commitment exists for this owner.");
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
        let sseJsonBytes = 0;
        if (useSse) {
            const bodyJson = JSON.stringify(body);
            sseJsonBytes = requestBodyUtf8Bytes(bodyJson);
            const compressedBody = compressRequestBodyZstd(bodyJson);
            if (compressedBody)
                headers.set("content-encoding", "zstd");
            sseBody = compressedBody ?? bodyJson;
        }
        const diagnostics = compareCompactionToSuccessfulDispatch(commitment, body, headers, useSse ? "sse" : "websocket-delta");
        assertCompactionParity(diagnostics);
        if (useSse) {
            diagnostics.hashes.compactionActualBody = requiredSha256Json(body);
            const result = await performCodexSseCompaction(owner, model, sseBody!, headers, options, markProviderDispatched, sseJsonBytes);
            options.signal?.throwIfAborted();
            return { ...result, ...(options.shapeDiagnostics ? { diagnostics } : {}) };
        }
        const result = await performCodexWebSocketCompaction(owner, {
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
        if (providerDispatched && owner.isActive && owner.successfulDispatchCommitments.get(sessionId) === commitment) {
            owner.successfulDispatchCommitments.delete(sessionId);
            markDispatchCommitmentConsumed(owner, sessionId);
        }
    }
}
// ============================================================================
// Error Handling
// ============================================================================
async function parseErrorResponse(response: Response, providedRaw?: string) {
    const raw = providedRaw ?? await response.text();
    let message = raw || response.statusText || "Request failed";
    let friendlyMessage;
    let code: string | undefined;
    try {
        const parsed = JSON.parse(raw);
        const err = parsed?.error;
        if (err) {
            const rawCode = err.code || err.type;
            code = typeof rawCode === "string" ? rawCode : undefined;
            if (USAGE_LIMIT_ERROR_CODE_PATTERN.test(code ?? "") || response.status === 429) {
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
    return { message, friendlyMessage, code };
}
// ============================================================================
// Auth & Headers
// ============================================================================
function extractAccountId(token: string) {
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
function buildBaseCodexHeaders(initHeaders: Record<string, string> | undefined, additionalHeaders: ProviderHeaders | undefined, accountId: string, token: string) {
    const headers = new Headers(initHeaders);
    // Model headers replace defaults; caller headers may override or remove either.
    if (!headers.has("originator")) {
        headers.set("originator", "pi");
    }
    if (!headers.has("User-Agent")) {
        const userAgent = _os ? `Super Pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "Super Pi (browser)";
        headers.set("User-Agent", userAgent);
    }
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
    return headers;
}
function addRemoteCompactionFeature(headers: Headers): void {
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
function buildSSEHeaders(
    initHeaders: Record<string, string> | undefined,
    additionalHeaders: ProviderHeaders | undefined,
    accountId: string,
    token: string,
    routingHint: string,
    sessionId: string | undefined,
    remoteCompactionEnabled = false,
): Headers {
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
function buildWebSocketHeaders(
    initHeaders: Record<string, string> | undefined,
    additionalHeaders: ProviderHeaders | undefined,
    accountId: string,
    token: string,
    routingHint: string,
    requestId: string,
    remoteCompactionEnabled = false,
): Headers {
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
