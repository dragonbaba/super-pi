import { COMPACTION_CHARS_PER_TOKEN, type AgentMessage } from "@super-pi/agent-core";
import type { AssistantMessage } from "@super-pi/ai";

const OMITTED_SOURCE_PREFIX = "// [Compaction record: completed failed codemode call ";
const OMITTED_SOURCE_SUFFIX = ". Historical source was omitted; the original call/result remain in session history. This call already failed; its recorded results and completed child effects remain valid. Do not automatically replay completed tools.]";

/** Compaction setup only: fold a completed failed exchange, never change executable source.
 * Original calls/results remain in the session journal. Keep complete outcome content/details,
 * including any successful child effects. Preserve all other blocks, signatures and pairing;
 * leave pending/mixed batches and calls with argument-bound opaque signatures untouched.
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
			if (count === 1 && call?.name === "codemode" && call.thoughtSignature === undefined && outcome?.role === "toolResult" && outcome.toolCallId === call.id && outcome.isError) {
				const args = call.arguments as unknown;
				const source = typeof args === "string" ? args : args && typeof args === "object" ? (args as { code?: unknown }).code : undefined;
				if (typeof source === "string" && source.length > keepRecentTokens * COMPACTION_CHARS_PER_TOKEN) {
					const notice = OMITTED_SOURCE_PREFIX + call.id + OMITTED_SOURCE_SUFFIX;
					// A fixed notice is a stable point even with zero retention; never enlarge input.
					if (notice.length < source.length) {
						result ??= messages.slice(0, index);
						const argumentsView = args && typeof args === "object" ? { ...args, code: notice } : { code: notice };
						const replacement = { ...call, arguments: argumentsView };
						const content: AssistantMessage["content"] = [];
						for (const block of message.content) content.push(block === call ? replacement : block);
						result.push({ ...message, content }, outcome);
						index++;
						continue;
					}
				}
			}
		}
		if (result) result.push(message);
	}
	return result ?? messages;
}
