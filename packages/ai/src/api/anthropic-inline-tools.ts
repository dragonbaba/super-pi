import type { BetaContentBlockParam, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { AnthropicContextCheckpoint, Context, Message, Model, Tool } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

export const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";
const SUPPORTED_MODELS = new Set([
	"claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1",
	"claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
]);

export function defaultSupportsInlineTools(model: Model<"anthropic-messages">): boolean {
	return model.provider === "anthropic" && SUPPORTED_MODELS.has(model.id);
}

const PLACEHOLDER_NAME = "__pi_deferred_placeholder__";
/** Request-owned because payload hooks may mutate every part of the outgoing declaration. */
export function createInlineToolPlaceholder(): BetaTool {
	return { name: PLACEHOLDER_NAME, description: "Reserved placeholder. Never available. Never call this.",
		input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true };
}

export interface InlineToolHistory {
	initial: AnthropicContextCheckpoint;
	checkpoint: AnthropicContextCheckpoint | undefined;
	updates: Map<Message, BetaContentBlockParam[]>;
	tail: BetaContentBlockParam[];
}

function snapshotText(systemPrompt: string, tools: Tool[], toolPolicy: string): string {
	// Only provider-visible definitions; never retain execution closures, owners or schema aliases.
	const uniqueTools = new Map<string, Tool>();
	for (const tool of tools) uniqueTools.set(tool.name, tool);
	return JSON.stringify({ version: 1, toolPolicy, systemPrompt, tools: [...uniqueTools.values()].map(tool => ({
		name: tool.name, description: tool.description, parameters: tool.parameters,
		constrainedSampling: tool.constrainedSampling,
	})) });
}

function changeBlocks(previous: AnthropicContextCheckpoint, current: AnthropicContextCheckpoint,
	convert: (tools: Tool[]) => BetaTool[]): BetaContentBlockParam[] {
	const blocks: BetaContentBlockParam[] = [];
	if (current.systemPrompt !== previous.systemPrompt) blocks.push({ type: "text",
		text: sanitizeSurrogates(`The application's current system instructions follow. They replace the earlier application instructions from this point onward:\n\n${current.systemPrompt || "(No application instructions.)"}`) });
	const oldTools = new Map(previous.tools.map(tool => [tool.name, tool]));
	const newTools = new Map(current.tools.map(tool => [tool.name, tool]));
	for (const name of oldTools.keys()) if (!newTools.has(name)) blocks.push({ type: "tool_removal", tool: { type: "tool_reference", name } });
	const added: Tool[] = [];
	for (const [name, tool] of newTools) if (JSON.stringify(tool) !== JSON.stringify(oldTools.get(name))) added.push(tool);
	for (const definition of convert(added)) blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
	return blocks;
}

/** Request-lifetime replay only. Full snapshots let a pruned transcript establish a new prefix. */
export function prepareInlineToolHistory(model: Model<"anthropic-messages">, context: Context, toolPolicy: string,
	convert: (tools: Tool[]) => BetaTool[]): InlineToolHistory | undefined {
	let start = 0;
	for (let i = 0; i < context.messages.length; i++) {
		const message = context.messages[i];
		if (message.role === "assistant" && (message.anthropicContext === null ||
			(message.anthropicContext && message.anthropicContext.toolPolicy !== toolPolicy) ||
			message.api !== model.api || message.provider !== model.provider || message.model !== model.id ||
			message.rawStopReason === "pause_turn")) start = i + 1;
	}
	let initial: AnthropicContextCheckpoint | undefined;
	let latest: AnthropicContextCheckpoint | undefined;
	const updates = new Map<Message, BetaContentBlockParam[]>();
	for (let i = start; i < context.messages.length; i++) {
		const message = context.messages[i];
		if (message.role !== "assistant" || !message.anthropicContext) continue;
		const snapshot = message.anthropicContext;
		if (snapshot.version !== 1 || !Array.isArray(snapshot.tools) || typeof snapshot.systemPrompt !== "string") return undefined;
		if (latest) updates.set(message, changeBlocks(latest, snapshot, convert));
		else initial = snapshot;
		latest = snapshot;
	}
	const serialized = snapshotText(context.systemPrompt ?? "", context.tools ?? [], toolPolicy);
	const current: AnthropicContextCheckpoint = latest && snapshotText(latest.systemPrompt, latest.tools, toolPolicy) === serialized
		? latest : JSON.parse(serialized);
	initial ??= current;
	if (initial.tools.length === 0 || initial.tools.some(tool => tool.name === PLACEHOLDER_NAME) ||
		current.tools.some(tool => tool.name === PLACEHOLDER_NAME)) return undefined;
	return { initial, checkpoint: current === latest ? undefined : current, updates,
		tail: latest ? changeBlocks(latest, current, convert) : [] };
}

/** Insert at converted assistant boundaries; tool_use/tool_result adjacency is never interrupted. */
export function insertInlineToolUpdates(messages: BetaMessageParam[], positions: Map<Message, number>,
	history: InlineToolHistory): BetaMessageParam[] | undefined {
	const updates = new Map<number, BetaContentBlockParam[]>();
	for (const [message, blocks] of history.updates) {
		if (blocks.length === 0) continue;
		const position = positions.get(message);
		if (position === undefined || messages[position - 1]?.role !== "user") return undefined;
		updates.set(position, blocks);
	}
	if (history.tail.length > 0 && messages.at(-1)?.role !== "user") return undefined;
	const result: BetaMessageParam[] = [];
	for (let i = 0; i < messages.length; i++) {
		const content = updates.get(i);
		if (content) result.push({ role: "system", content });
		result.push(messages[i]);
	}
	if (history.tail.length > 0) result.push({ role: "system", content: history.tail });
	return result;
}

/** Only declaration metadata is serialized, never user text, images or large tool results. */
export function inlineDeclarationSignature(params: { model: string; system?: unknown; tools?: unknown; betas?: unknown; messages: BetaMessageParam[] }): string {
	const boundaries: unknown[] = [];
	for (const message of params.messages) boundaries.push(message.role === "system" ? message : message.role);
	return JSON.stringify([params.model, params.system, params.tools, params.betas, boundaries]);
}
