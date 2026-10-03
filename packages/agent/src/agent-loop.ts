const MCP_PROGRESS_SOURCE = Symbol.for("super-pi.mcp-progress-source.v1");

/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	hasIncompleteToolArguments,
	type ToolResultMessage,
	readPolicyDiagnostic,
	renderPolicyDiagnostic,
	sanitizePolicyFeedback,
	type TextContent,
	validateToolArguments,
} from "@super-pi/ai";
import { resolve as resolvePath, sep } from "node:path";
import { getDefaultStreamFn } from "./stream-fn.ts";
import { toolResultFromError } from "./tool-result-error.ts";
import { NESTED_CANCEL_GRACE_MS, NestedToolDispatch, isConcurrentNestedRead } from "./nested-tool-dispatch.ts";
import { isModelToolSelection, selectModelTools } from "./tool-exposure.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentEventInstrumentation,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	NestedObservationFailure,
	NestedToolResultMessage,
	ToolInvocationAuthorization,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const RESOLVED_VOID_PROMISE = Promise.resolve();
const NO_TOOLS: readonly AgentTool<any>[] = Object.freeze([]);

/** @internal Experimental single-call host dispatch. Never polls a provider or prompt queue. */
export async function runHostToolDispatch(
	call: AgentToolCall, context: AgentContext, config: AgentLoopConfig,
	emit: AgentEventSink, signal?: AbortSignal, complete?: () => Promise<void>,
): Promise<ToolResultMessage> {
	if (hasIncompleteToolArguments(call.arguments)) throw new Error("Incomplete host tool arguments");
	const selectedId = call.id;
	const selectedName = call.name;
	// Only this private dispatch snapshot is immutable; canonical history stays mutable.
	// The 6B1 caller supplies only bounded primitive path/content fields. Copy the
	// field container without duplicating payload strings or freezing policy inputs.
	const selectedCall = Object.freeze({ type: "toolCall" as const, id: selectedId, name: selectedName, arguments: { ...call.arguments } });
	const selectedTool = context.tools?.find(tool => tool.name === selectedName);
	const selectedContext = { ...context, tools: selectedTool ? [Object.freeze({ ...selectedTool, modelExposure: undefined })] : [] };
	// Explicit host origin in the existing message shape; zero provider usage.
	// Persist the association before its result, without replaying historical sibling calls.
	const association = { type: "toolCall" as const, id: selectedId, name: selectedName, arguments: {} };
	const origin: AssistantMessage = {
		role: "assistant", content: [association], api: "host-operation", provider: "host", model: "local-operation",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: Date.now(),
	};
	const executionOrigin = { ...origin, content: [selectedCall] };
	selectedContext.messages.push(executionOrigin);
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	await emit({ type: "message_start", message: origin });
	await emit({ type: "message_end", message: origin });
	if (origin.content.length !== 1 || origin.content[0] !== association || association.id !== selectedId || association.name !== selectedName) {
		throw new Error("Host dispatch association changed during delivery");
	}
	// One callback per host operation; only start publication allocates an observer container.
	const hostEmit: AgentEventSink = event => emit(event.type === "tool_execution_start"
		? { ...event, args: { ...event.args } } : event);
	const batch = await executeToolCalls(selectedContext, executionOrigin, config, signal, hostEmit);
	await complete?.();
	await emit({ type: "turn_end", message: origin, toolResults: batch.messages });
	await emit({ type: "agent_end", messages: [origin, ...batch.messages] });
	return batch.messages[0];
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			let interactionPaused = false;
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;
				interactionPaused = executedToolBatch.terminate && toolCalls.some(tc => currentContext.tools?.find(t => t.name === tc.name)?.interactionBoundary === true);

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			if (interactionPaused) {
				await emit({ type: "agent_end", messages: newMessages, requiresUserInput: true });
				return;
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	// A carried cache is stale after `{ ...context, tools }` replacement or in-place tool mutation.
	const modelTools = isModelToolSelection(context.tools, context.modelTools) ? context.modelTools : selectModelTools(context.tools);
	const llmMessages = await config.convertToLlm(messages, context.systemPrompt, modelTools, config.model, config.maxTokens);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: modelTools,
	};

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: partialMessage,
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const incomplete = hasIncompleteToolArguments(toolCall.arguments);
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createPreExecutionError(toolCall.name,
				`[${incomplete ? "TOOL_ARGS_INCOMPLETE" : "TOOL_RESPONSE_LIMIT"}] ${toolCall.name} was not executed: the response hit the output token limit; arguments ${incomplete ? "were incomplete" : "may be truncated"}.\nRetry: re-issue this tool call with complete arguments and a smaller payload.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	// Inspect the entire batch before starting ANY business call. Old arguments
	// cannot cross an answer boundary, including calls preceding the question.
	const question = toolCalls.find(tc => currentContext.tools?.find(t => t.name === tc.name)?.interactionBoundary);
	if (question) {
		const answered = await executeToolCallsSequential(currentContext, assistantMessage, [question], config, signal, emit);
		const remaining = toolCalls.filter(tc => tc !== question);
		const deferred = await finalizeUnexecutedToolCalls(remaining, 0, emit, "Not executed: user interaction boundary; replan with the user's answer.");
		await emitFinalizedToolResults(deferred, emit, answered.messages);
		return answered;
	}
	const hasSequentialToolCall = toolCalls.some(
		(tc) => {
			const tool = currentContext.tools?.find((t) => t.name === tc.name);
			return tool?.executionMode === "sequential" || tool?.orchestration === true;
		},
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	const batches = planToolCallBatches(currentContext.tools, toolCalls);
	if (batches.length === 1) {
		return executeToolCallsParallel(currentContext, assistantMessage, batches[0], config, signal, emit);
	}

	const messages: ToolResultMessage[] = [];
	let terminate = true;
	for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
		const result = await executeToolCallsParallel(
			currentContext,
			assistantMessage,
			batches[batchIndex],
			config,
			signal,
			emit,
		);
		messages.push(...result.messages);
		terminate = terminate && result.terminate;
		if (signal?.aborted) {
			const remaining = batches.slice(batchIndex + 1).flat();
			const canceled = await finalizeUnexecutedToolCalls(remaining, 0, emit);
			await emitFinalizedToolResults(canceled, emit, messages);
			return { messages, terminate: false };
		}
	}
	return { messages, terminate };
}

const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

type ToolExecutionScope = { path: string; access: "read" | "write" };

function getToolExecutionScope(tool: AgentTool<any> | undefined, args: unknown): ToolExecutionScope | undefined {
	const metadata = tool?.executionPath;
	if (!metadata || !args || typeof args !== "object") return undefined;
	const rawPath = (args as Record<string, unknown>)[metadata.argument];
	const selectedPath = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : metadata.defaultPath;
	if (typeof selectedPath !== "string") return undefined;
	let path = resolvePath(metadata.cwd, selectedPath);
	if (CASE_INSENSITIVE_PATHS) path = path.toLowerCase();
	return { path, access: metadata.access };
}

function pathsOverlap(left: string, right: string): boolean {
	return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
}

function scopesConflict(left: ToolExecutionScope, right: ToolExecutionScope): boolean {
	return pathsOverlap(left.path, right.path) && (left.access === "write" || right.access === "write");
}

function planToolCallBatches(tools: AgentTool<any>[] | undefined, toolCalls: AgentToolCall[]): AgentToolCall[][] {
	const planned = toolCalls.map((toolCall) => ({
		toolCall,
		scope: getToolExecutionScope(tools?.find((tool) => tool.name === toolCall.name), toolCall.arguments),
	}));
	if (!planned.some((entry) => entry.scope)) return [toolCalls];

	const batches: AgentToolCall[][] = [];
	let batch: AgentToolCall[] = [];
	let batchScopes: ToolExecutionScope[] = [];
	for (const entry of planned) {
		if (!entry.scope) {
			if (batch.length > 0) batches.push(batch);
			batches.push([entry.toolCall]);
			batch = [];
			batchScopes = [];
			continue;
		}
		if (batchScopes.some((scope) => scopesConflict(scope, entry.scope!))) {
			batches.push(batch);
			batch = [];
			batchScopes = [];
		}
		batch.push(entry.toolCall);
		batchScopes.push(entry.scope);
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

async function finalizeUnexecutedToolCalls(
	toolCalls: AgentToolCall[],
	startIndex: number,
	emit: AgentEventSink,
	reason = "Operation aborted before tool execution",
): Promise<FinalizedToolCallOutcome[]> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	for (let index = startIndex; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createPreExecutionError(toolCall.name, reason),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		finalizedCalls.push(finalized);
	}
	return finalizedCalls;
}

async function emitFinalizedToolResult(
	finalized: FinalizedToolCallOutcome,
	emit: AgentEventSink,
	messages: ToolResultMessage[],
): Promise<void> {
	const toolResultMessage = createToolResultMessage(finalized);
	await emitToolResultMessage(toolResultMessage, emit);
	messages.push(toolResultMessage);
}

async function emitFinalizedToolResults(
	finalizedCalls: FinalizedToolCallOutcome[],
	emit: AgentEventSink,
	messages: ToolResultMessage[],
): Promise<void> {
	for (const finalized of finalizedCalls) await emitFinalizedToolResult(finalized, emit, messages);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit, config.eventInstrumentation);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		finalizedCalls.push(finalized);
		await emitFinalizedToolResult(finalized, emit, messages);

		if (signal?.aborted) {
			const canceled = await finalizeUnexecutedToolCalls(toolCalls, index + 1, emit);
			finalizedCalls.push(...canceled);
			await emitFinalizedToolResults(canceled, emit, messages);
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	let authorizations: ToolInvocationAuthorization[] | undefined;
	try {

	let nextIndex = 0;
	for (; nextIndex < toolCalls.length; nextIndex++) {
		const toolCall = toolCalls[nextIndex];
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				nextIndex++;
				break;
			}
			continue;
		}

		if (preparation.finalAuthorization) (authorizations ??= []).push(preparation.finalAuthorization);
		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit, config.eventInstrumentation);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			nextIndex++;
			break;
		}
	}

	const pendingFinalizedCalls: Array<Promise<FinalizedToolCallOutcome>> = [];
	for (const entry of finalizedCalls)
		pendingFinalizedCalls.push(typeof entry === "function" ? entry() : Promise.resolve(entry));
	const canceled = await finalizeUnexecutedToolCalls(toolCalls, nextIndex, emit);
	const orderedFinalizedCalls = await Promise.all(pendingFinalizedCalls);
	orderedFinalizedCalls.push(...canceled);
	const messages: ToolResultMessage[] = [];
	await emitFinalizedToolResults(orderedFinalizedCalls, emit, messages);

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
	} finally { if (authorizations) for (const authorization of authorizations) authorization.release(); }
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
	finalAuthorization?: ToolInvocationAuthorization;
	authorizedExecute?: AgentTool<any>["execute"];
	parentDispatch?: NestedToolDispatch;
	concurrentNestedRead?: boolean;
	orchestration?: { context: AgentContext; assistantMessage: AssistantMessage; config: AgentLoopConfig };
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	/** Invocation was refused; retain the normal pre-execution block semantics. */
	authorizationVeto?: true;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	parentDispatch?: NestedToolDispatch,
	concurrentNestedRead?: boolean,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createPreExecutionError(toolCall.name, `Tool ${toolCall.name} not found`),
			isError: true,
		};
	}
	if (hasIncompleteToolArguments(toolCall.arguments)) {
		return {
			kind: "immediate",
			result: createPreExecutionError(toolCall.name,
				`[TOOL_ARGS_INCOMPLETE] ${tool.name} was not executed: arguments were incomplete when the response ended.\nRetry: re-issue only this tool call with complete JSON arguments.`,
			),
			isError: true,
		};
	}
	if (!parentDispatch && tool.modelExposure === "nested") {
		return { kind: "immediate", isError: true,
			result: createPreExecutionError(tool.name, `[TOOL_NESTED_ONLY] Use codemode to call tools[${JSON.stringify(tool.name)}](args).`) };
	}

	let finalAuthorization: ToolInvocationAuthorization | undefined;
	let handedOff = false;
	try {
		const selectedExecute = config.beforeToolCall || parentDispatch ? tool.execute : undefined;
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
					parentToolCallId: parentDispatch?.parentToolCallId,
				},
				signal,
			);
			finalAuthorization = beforeResult?.finalAuthorization;
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createPreExecutionError(tool.name, "Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const refusal = projectStructuredPolicyRefusal(beforeResult.reason);
				const directReason = nonEmptyReason(beforeResult.reason);
				const result = createPreExecutionError(tool.name, refusal?.text ?? (directReason ?? "Tool execution was blocked"), beforeResult.details ?? refusal?.details);
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createPreExecutionError(tool.name, "Operation aborted"),
				isError: true,
			};
		}
		const prepared: PreparedToolCall = {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
		if (parentDispatch) {
			prepared.parentDispatch = parentDispatch;
			prepared.concurrentNestedRead = concurrentNestedRead;
			prepared.authorizedExecute = selectedExecute;
		}
		if (tool.orchestration) prepared.orchestration = { context: currentContext, assistantMessage, config };
		if (finalAuthorization) {
			prepared.finalAuthorization = finalAuthorization;
			prepared.authorizedExecute = selectedExecute;
		}
		handedOff = true;
		return prepared;
	} catch (error) {
		return {
			kind: "immediate",
			result: createPreExecutionError(tool.name, error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally { if (!handedOff) finalAuthorization?.release(); }
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	instrumentation?: AgentEventInstrumentation,
): Promise<ExecutedToolCallOutcome> {
	const progress = new ToolProgressDelivery(prepared, emit, instrumentation);
	let acceptingUpdates = true;
	let checkingAuthorization = false;
	let completedResult: AgentToolResult<any> | undefined;
	let nested: NestedToolDispatch | undefined;

	try {
		const onUpdate = ((partialResult: AgentToolResult<any>) => {
			if (!acceptingUpdates) return;
			void progress.publish(partialResult);
		}) as AgentToolUpdateCallback<any>;
		onUpdate.awaited = (partialResult) =>
			acceptingUpdates ? progress.publish(partialResult) : RESOLVED_VOID_PROMISE;
		// Resolve the callable before the final check. The returned execution values
		// are private to this invocation, including across wrapper context callbacks.
		const execute = prepared.tool.execute;
		const id = prepared.toolCall.id;
		const name = prepared.toolCall.name;
		checkingAuthorization = prepared.finalAuthorization !== undefined || prepared.parentDispatch !== undefined;
		if (prepared.parentDispatch && !prepared.parentDispatch.isCurrentTool(prepared.tool)) {
			throw new Error("Blocked by policy: nested tool is no longer active");
		}
		if (prepared.concurrentNestedRead && !isConcurrentNestedRead(prepared.tool)) {
			throw new Error("Blocked by policy: nested tool lost its concurrent read authorization");
		}
		if (prepared.parentDispatch && (prepared.tool.orchestration || prepared.tool.modelOnly || prepared.tool.interactionBoundary)) {
			throw new Error("Blocked by policy: nested tool became a direct control tool before invocation");
		}
		if (checkingAuthorization && execute !== prepared.authorizedExecute) {
			throw new Error("Blocked by policy: authorized tool implementation changed before invocation");
		}
		const args = prepared.finalAuthorization
			? prepared.finalAuthorization.consume(prepared.args, id, name, signal)
			: prepared.args;
		checkingAuthorization = false;
		if (prepared.orchestration) nested = createNestedToolDispatch(prepared.toolCall.id, prepared.orchestration, emit, signal);
		let result = await execute.call(prepared.tool,
			id,
			args as never,
			signal,
			onUpdate,
			nested,
		);
		completedResult = result;
		if (nested) {
			await nested.close();
			if (nested.shouldTerminate) result = { ...result, terminate: true };
			// Abandoned children are reported even on a failed parent: they may still change state.
			const abandoned = nested.abandonedCalls;
			if (abandoned > 0 || (nested.hasErrors && !result.isError)) {
				result = { ...result, isError: true, content: [...(result.content ?? []), { type: "text", text: abandoned > 0
					? nestedAbandonedNotice(abandoned)
					: "[NESTED_TOOL_ERRORS] One or more child calls failed, were cancelled, or were refused. Completed side effects are not rolled back." }] };
			}
			completedResult = result;
		}
		acceptingUpdates = false;
		await progress.flush();
    return { result, isError: result.isError === true };
	} catch (error) {
		acceptingUpdates = false;
		if (checkingAuthorization) {
			return { result: createPreExecutionError(prepared.tool.name, error instanceof Error ? error.message : String(error)),
				isError: true, authorizationVeto: true };
		}
		let failedResult = completedResult ? undefined : toolResultFromError(error);
		// A thrown parent skipped the nested block above; close first so lingering children are reported.
		let abandoned = 0;
		if (nested && !completedResult) {
			await nested.close();
			abandoned = nested.abandonedCalls;
		}
		try {
			await progress.flush();
		} catch (observationError) {
			// Preserve the primary tool failure and record a separate drain failure.
			if (failedResult) failedResult = resultWithObservationFailure(failedResult, observationError);
		}
		let result = failedResult ?? (completedResult ? resultWithObservationFailure(completedResult, error)
			: createErrorToolResult(error instanceof Error ? error.message : String(error)));
		if (abandoned > 0) result = { ...result, content: [...(result.content ?? []), { type: "text", text: nestedAbandonedNotice(abandoned) }] };
		return { result, isError: true };
	} finally {
		acceptingUpdates = false;
		if (nested) await nested.close();
		if (prepared.finalAuthorization) {
			prepared.finalAuthorization.release();
			prepared.finalAuthorization = undefined;
		}
	}
}

function nestedAbandonedNotice(abandoned: number): string {
	return `[NESTED_TOOL_ABANDONED] ${abandoned} child call(s) ignored cancellation for ${NESTED_CANCEL_GRACE_MS} ms and may still be running or changing state. Verify current state before any retry.`;
}

/** One callback pair per orchestration invocation, never per child progress update. */
function createNestedToolDispatch(
	parentToolCallId: string,
	scope: NonNullable<PreparedToolCall["orchestration"]>,
	emit: AgentEventSink,
	signal?: AbortSignal,
): NestedToolDispatch {
	const emitNested: AgentEventSink = event => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			event.parentToolCallId = parentToolCallId;
		}
		return emit(event);
	};
	const turnTools = scope.context.tools ?? NO_TOOLS;
	const live = scope.config.getCurrentTools;
	// The active turn context, which a next-turn hook may replace, is the baseline; live changes made afterwards win.
	const owner: NestedToolDispatch = new NestedToolDispatch(parentToolCallId, live ?? (() => turnTools),
		(call, tool, childSignal) => runNestedToolCall(call, tool, owner, scope, emitNested, childSignal), signal,
		NESTED_CANCEL_GRACE_MS, live ? turnTools : undefined);
	return owner;
}

async function runNestedToolCall(
	call: AgentToolCall, tool: AgentTool<any> | undefined, owner: NestedToolDispatch,
	scope: NonNullable<PreparedToolCall["orchestration"]>, emit: AgentEventSink, signal: AbortSignal,
): Promise<NestedToolResultMessage> {
	const concurrentNestedRead = isConcurrentNestedRead(tool);
	await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
	let finalized: FinalizedToolCallOutcome;
	if (signal.aborted || tool?.orchestration || tool?.interactionBoundary || tool?.modelOnly) {
		finalized = { toolCall: call, isError: true, result: createPreExecutionError(call.name,
			signal.aborted ? "Operation aborted before nested tool execution" : "This tool requires a direct model call; nested control or orchestration calls are not allowed") };
	} else {
		const context: AgentContext = { ...scope.context, tools: tool ? [tool] : [] };
		const prepared = await prepareToolCall(context, scope.assistantMessage, call, scope.config, signal, owner, concurrentNestedRead);
		if (prepared.kind === "immediate") {
			finalized = { toolCall: call, result: prepared.result, isError: prepared.isError };
		} else {
			const executed = await executePreparedToolCall(prepared, signal, emit, scope.config.eventInstrumentation);
			finalized = await finalizeExecutedToolCall(context, scope.assistantMessage, prepared, executed, scope.config, signal);
		}
	}
	let observationFailure: NestedObservationFailure | undefined;
	try {
		await emitToolExecutionEnd(finalized, emit);
	} catch (error) {
		// The child has already finished. Keep its outcome for Codemode records and
		// report the end-event delivery failure first, so its summary is not mistaken for a tool failure.
		const result = resultWithObservationFailure(finalized.result, error, true);
		// Receipts need the tool's own outcome, kept apart from the folded isError.
		observationFailure = { executionIsError: finalized.isError, error: (result.content[0] as TextContent).text };
		finalized = { ...finalized, result, isError: true };
	}
	// Only the parent is a protocol tool result. Child facts travel via hooks and events.
	owner.observeTermination(finalized.result.terminate);
	const message: NestedToolResultMessage = createToolResultMessage(finalized);
	if (observationFailure) message.observationFailure = observationFailure;
	return message;
}

class ToolProgressDelivery {
	private readonly prepared: PreparedToolCall;
	private readonly emit: AgentEventSink;
	private readonly instrumentation?: AgentEventInstrumentation;
	private pending: AgentToolResult<any> | undefined;
	private drainPromise: Promise<void> | undefined;
	private firstDrainError: unknown;
	private hasDrainError = false;
	private occupied = false;

	constructor(prepared: PreparedToolCall, emit: AgentEventSink, instrumentation?: AgentEventInstrumentation) {
		this.prepared = prepared;
		this.emit = emit;
		this.instrumentation = instrumentation;
	}

	publish(partialResult: AgentToolResult<any>): Promise<void> {
		if (this.hasDrainError) return this.rejectedFirstError();
		this.pending = partialResult;
		if (!this.occupied) {
			this.occupied = true;
			this.instrumentation?.onToolProgressPending?.(this.prepared.toolCall.id, 1);
		}
		if (!this.drainPromise) this.startDrain();
		return this.drainPromise ?? RESOLVED_VOID_PROMISE;
	}

	async flush(): Promise<void> {
		while (this.drainPromise) {
			try {
				await this.drainPromise;
			} catch (error) {
				this.recordDrainError(error);
			}
		}
		this.throwFirstDrainError();
		if (this.pending) {
			this.markOccupied();
			this.startDrain();
			while (this.drainPromise) {
				try {
					await this.drainPromise;
				} catch (error) {
					this.recordDrainError(error);
				}
			}
		}
		this.throwFirstDrainError();
	}

	private startDrain(): void {
		const drain = this.drain();
		this.drainPromise = drain;
		void drain.then(
			() => this.finishDrain(drain, false),
			(error) => this.finishDrain(drain, true, error),
		);
	}

	private async drain(): Promise<void> {
		while (this.pending) {
			const partialResult = this.pending;
			this.pending = undefined;
			try {
			await this.emit({
				type: "tool_execution_update",
				toolCallId: this.prepared.toolCall.id,
				toolName: this.prepared.toolCall.name,
				args: this.prepared.toolCall.arguments,
				partialResult,
			});
			} catch (error) {
				// MCP notifications are observational, never the canonical final.
				// Keep the existing critical-listener contract for other tool updates.
				if (!this.prepared.toolCall.name.startsWith("mcp__") ||
					(partialResult as unknown as Record<symbol, unknown>)[MCP_PROGRESS_SOURCE] !== true) throw error;
			}
		}
	}

	private finishDrain(drain: Promise<void>, failed: boolean, error?: unknown): void {
		if (this.drainPromise !== drain) return;
		if (failed) {
			this.recordDrainError(error);
			this.pending = undefined;
		}
		try {
			this.instrumentation?.onToolProgressDrainSettled?.(this.prepared.toolCall.id);
		} catch {
			// Instrumentation is observational and must not alter progress delivery.
		}
		this.drainPromise = undefined;
		if (!failed && this.pending) {
			this.startDrain();
			return;
		}
		this.markUnoccupied();
	}

	private recordDrainError(error: unknown): void {
		if (this.hasDrainError) return;
		this.hasDrainError = true;
		this.firstDrainError = error;
	}

	private throwFirstDrainError(): void {
		if (this.hasDrainError) throw this.firstDrainError;
	}

	private rejectedFirstError(): Promise<void> {
		const rejection = Promise.reject(this.firstDrainError);
		void rejection.catch(() => {});
		return rejection;
	}

	private markOccupied(): void {
		if (this.occupied) return;
		this.occupied = true;
		this.instrumentation?.onToolProgressPending?.(this.prepared.toolCall.id, 1);
	}

	private markUnoccupied(): void {
		if (!this.occupied) return;
		this.occupied = false;
		this.instrumentation?.onToolProgressPending?.(this.prepared.toolCall.id, 0);
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall && !executed.authorizationVeto) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
					parentToolCallId: prepared.parentDispatch?.parentToolCallId,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = (prepared.orchestration || prepared.parentDispatch) && executed.isError ? true : afterResult.isError ?? isError;
			}
		} catch (error) {
			result = resultWithObservationFailure(result, error);
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

/** Once a tool has completed, observer failures cannot erase its execution facts. */
function resultWithObservationFailure(result: AgentToolResult<any>, error: unknown, noticeFirst = false): AgentToolResult<any> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const execution = result.details?.shellExecution;
  // Completion-error boundary only. Clone once so preserved producer objects
  // stay immutable and consumers need not infer an Agent failure from stdout.
  const details = execution && typeof execution === "object"
    ? { ...result.details, shellExecution: { ...execution,
      observationError: execution.observationError ?? message,
      secondaryObservationError: execution.observationError !== undefined ? execution.secondaryObservationError ?? message : undefined,
      observationErrorsOmitted: execution.secondaryObservationError !== undefined || execution.observationErrorsOmitted === true ? true : undefined,
    } } : result.details;
  const notice = { type: "text" as const, text: `[TOOL_OBSERVATION_FAILED] ${message}` };
  // Codemode previews and child errors show only the first text block.
  const content = noticeFirst ? [notice, ...(result.content ?? [])] : [...(result.content ?? []), notice];
  return { ...result, content, details, isError: true };
}

function nonEmptyReason(reason: unknown): string | undefined {
	if (typeof reason !== "string") return undefined;
	const trimmed = reason.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function projectStructuredPolicyRefusal(reason: unknown): { text: string; details: Record<string, unknown> } | undefined {
	const structuredReason = nonEmptyReason(reason);
	if (!structuredReason || structuredReason.charCodeAt(0) !== 123) return undefined;
	let payload: unknown;
	try { payload = JSON.parse(structuredReason); } catch { return undefined; }
	if (!payload || typeof payload !== "object") return undefined;
	const value = payload as Record<string, unknown>;
	if (value.category !== "POLICY_BLOCKED" || value.stateChanged !== false) return undefined;
	const primitives = Array.isArray(value.primitives) ? value.primitives : [];
	const diagnostic = readPolicyDiagnostic(value.diagnostic);
	let code = "UNKNOWN";
	let cause = "The request could not be verified by the safety policy.";
	let next = "Submit a simpler request for authorization.";
	const policyReason = typeof value.policyReason === "string" ? value.policyReason : undefined;
	if (policyReason === "user_rejected") {
		code = "USER_REJECTED";
		cause = "The user rejected this request.";
		next = "Change the request only after obtaining user approval; do not bypass the rejection with another tool or shell.";
	} else if (policyReason === "unchanged_rejected_request") {
		code = "UNCHANGED_REJECTED_REQUEST";
		cause = "The unchanged request was already rejected.";
		next = "Change the request only after obtaining user approval; do not replay it or bypass the rejection.";
	} else if (policyReason === "scope_denied") {
		code = "SCOPE_DENIED";
		cause = "The request is outside the currently authorized scope.";
		next = "Request authorization for this exact scope or use an already permitted target; do not bypass the scope with another tool or shell.";
	} else if (policyReason === "protected_root") {
		code = "PROTECTED_PATH";
		cause = "The requested path is protected by policy.";
		next = "Request authorization for a permitted target; do not bypass the protected path with another tool or shell.";
	} else if (policyReason === "confirmation_cancelled") {
		code = "CONFIRMATION_CANCELLED";
		cause = "The required user confirmation was cancelled.";
		next = "Ask for confirmation of the exact operation again only when the user is ready.";
	} else if (policyReason === "confirmation_required") {
		code = "CONFIRMATION_REQUIRED";
		cause = "User confirmation was required before execution.";
		next = "Request approval for the exact unchanged operation.";
	} else if (policyReason === "authority_expired" || policyReason === "authorization_expired") {
		code = "AUTHORITY_EXPIRED";
		cause = "The authorization was no longer current when the request was checked.";
		next = "Restore current authorization and resubmit the operation; do not replay it automatically.";
	} else if (diagnostic) {
		code = diagnostic.code;
		const rendered = renderPolicyDiagnostic(diagnostic);
		const firstLine = rendered.indexOf("\n");
		const secondLine = firstLine === -1 ? rendered : rendered.slice(firstLine + 1);
		const nextLine = secondLine.indexOf("\n");
		cause = nextLine === -1 ? secondLine : secondLine.slice(0, nextLine);
		const nextMarker = rendered.indexOf("Next: ");
		if (nextMarker !== -1) next = rendered.slice(nextMarker + 6).trim();
	} else if (primitives.includes("opaque_shell_wrapper") || primitives.includes("unverifiable_launcher")) {
		code = "LAUNCHER_UNSUPPORTED";
		cause = "Bash analysis cannot inspect this launcher.";
		next = "Use an enabled native tool only when it is available; normal authorization still applies.";
	} else if (primitives.includes("dynamic_target") || primitives.includes("unverifiable_target") || value.policyReason === "unverifiable_target") {
		code = "DYNAMIC_TARGET";
		cause = "The target cannot be verified from this request.";
		next = "Submit a literal target for authorization.";
	}
	const feedback = (policyReason === "user_rejected" || policyReason === "unchanged_rejected_request")
		? sanitizePolicyFeedback(value.rejectionReason)
		: undefined;
	if (feedback) cause += ` User feedback: ${feedback}`;
	const details: Record<string, unknown> = { ...value };
	if (Object.prototype.hasOwnProperty.call(value, "rejectionReason")) details.rejectionReason = feedback;
	return {
		text: `[POLICY_BLOCKED:${code}] Not executed:\n${cause}\nNext: ${next}`,
		details,
	};
}

function createPreExecutionError(tool: string, message: string, originalDetails?: unknown): AgentToolResult<any> {
  if (tool !== "bash" && tool !== "powershell") return createErrorToolResult(message, originalDetails);
  const prototype = originalDetails && typeof originalDetails === "object" ? Object.getPrototypeOf(originalDetails) : undefined;
  const details = prototype === Object.prototype || prototype === null ? { ...originalDetails as Record<string, unknown> } : { originalDetails };
  return createErrorToolResult(message, { ...details, executionStatus: "not_executed",
    shellExecution: { version: 1, producer: "agent", started: false, cwd: null, exitCode: null, signal: null, termination: "not_started",
      executionStatus: "not_executed", sideEffects: "none", retryGuidance: "fresh_request",
      output: { complete: true, tailTruncated: false, log: "not_needed", cleanup: "not_needed" } } });
}

function createErrorToolResult(message: string, details: unknown = {}): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
