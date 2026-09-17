import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const parameters = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 1000 }),
	description: Type.Optional(Type.String({ maxLength: 2000 })),
	options: Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 64 }),
		label: Type.String({ minLength: 1, maxLength: 200 }),
	}), { minItems: 2, maxItems: 6 }),
	allowOther: Type.Optional(Type.Boolean()),
});

export function createAskUserToolDefinition(): ToolDefinition<typeof parameters> {
	return {
		name: "ask_user", label: "等待用户选择", parameters,
		interactionBoundary: true,
		description: "Wait for an explicit user answer about conflicting requirements, preferences or material scope/behavior choices. Do not ask about routine fixable syntax or tool errors. An answer is not shell or file permission. Other calls in this response will NOT execute; replan after the answer.",
		async execute(_id, params, signal, onUpdate, ctx) {
			const stopped = (status: string) => ({ content: [{ type: "text" as const, text: status }], details: { status }, terminate: true });
			if (!ctx?.hasUI) return stopped("requires_user_input");
			if (signal?.aborted) return stopped("user_input_cancelled");
			if (new Set(params.options.map(option => option.id)).size !== params.options.length) throw new Error("Option IDs must be unique");
			const choices = params.options.map(option => `${option.id}: ${option.label}`);
			if (params.allowOther) choices.push("其他 / 补充文字");
			onUpdate?.({ content: [{ type: "text", text: `等待用户选择：${params.question}` }], details: {} });
			const sessionId = ctx.sessionManager.getSessionId();
			const selected = await ctx.ui.select(`等待用户选择：${params.question}`, choices, { signal, details: params.description ?? params.question });
			if (!selected || signal?.aborted || sessionId !== ctx.sessionManager.getSessionId()) return stopped("user_input_cancelled");
			const index = choices.indexOf(selected);
			if (index < 0) return stopped("user_input_cancelled");
			let answer: { id?: string; text: string };
			if (index < params.options.length) answer = { id: params.options[index].id, text: params.options[index].label };
			else {
				const text = await ctx.ui.input("补充回答", undefined, { signal });
				if (!text || signal?.aborted || sessionId !== ctx.sessionManager.getSessionId()) return stopped("user_input_cancelled");
				if (text.length > 4000) throw new Error("Answer exceeds 4000 characters; ask again with a shorter answer");
				answer = { text };
			}
			return { content: [{ type: "text", text: JSON.stringify(answer) }], details: { status: "answered", answer } };
		},
	};
}

export function createAskUserTool() { return wrapToolDefinition(createAskUserToolDefinition()); }
