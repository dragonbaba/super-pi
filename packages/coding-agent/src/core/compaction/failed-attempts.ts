import { COMPACTION_CHARS_PER_TOKEN, type AgentMessage } from "@super-pi/agent-core";
import type { TextContent, ImageContent } from "@super-pi/ai";

/** Compaction setup only: fold a completed failed exchange, never change executable source.
 * Original calls/results remain in the session journal. Keep complete outcome content/details,
 * including any successful child effects, and leave pending/mixed tool batches untouched.
 */
export function condenseFailedCodemodeAttempts(messages: AgentMessage[], keepRecentTokens: number): AgentMessage[] {
	if (!Number.isFinite(keepRecentTokens) || keepRecentTokens < 0) return messages;
	let result: AgentMessage[] | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			let call: Extract<(typeof message.content)[number], { type: "toolCall" }> | undefined;
			let count = 0;
			for (const block of message.content) if (block.type === "toolCall") { call = block; count++; }
			const outcome = messages[index + 1];
			if (count === 1 && call?.name === "codemode" && outcome?.role === "toolResult" && outcome.toolCallId === call.id && outcome.isError) {
				const args = call.arguments as unknown;
				const source = typeof args === "string" ? args : args && typeof args === "object" ? (args as { code?: unknown }).code : undefined;
				if (typeof source === "string" && source.length > keepRecentTokens * COMPACTION_CHARS_PER_TOKEN) {
					result ??= messages.slice(0, index);
					const content: (TextContent | ImageContent)[] = [{ type: "text", text: `[Compaction record: completed failed codemode call ${call.id}. Historical source (${source.length} UTF-16 units) was omitted from this context; the original call/result remain in session history. The outcomes below remain valid; do not automatically replay completed tools.]` }];
					for (const block of outcome.content) content.push(block);
					result.push({ role: "custom", customType: "compaction_failed_tool_attempt", content, display: true,
						details: { toolCallId: call.id, toolName: call.name, isError: true, sourceChars: source.length, outcome: outcome.details }, timestamp: outcome.timestamp });
					index++;
					continue;
				}
			}
		}
		if (result) result.push(message);
	}
	return result ?? messages;
}
