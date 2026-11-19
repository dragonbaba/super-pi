import { Type } from "typebox";
import { Text } from "@super-pi/tui";
import { sanitizeDialogText } from "../../modes/interactive/components/selector-text.ts";
import { getTextOutput } from "./render-utils.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const parameters = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 1000 }),
	description: Type.Optional(Type.String({ maxLength: 2000 })),
	options: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 64 }),
		label: Type.String({ minLength: 1, maxLength: 200 }),
	}), { minItems: 2, maxItems: 6 })),
	allowOther: Type.Optional(Type.Boolean()),
});

export function createAskUserToolDefinition(): ToolDefinition<typeof parameters> {
	return {
		name: "ask_user", label: "等待用户选择", parameters,
		interactionBoundary: true,
		promptSnippet: "Ask one bounded question and wait for an explicit user answer",
		promptGuidelines: ["Proceed with authorized steps. If a requested condition is unmet, report it and finish independent work. When a material choice still blocks the task, call ask_user and wait for its result."],
		description: "Ask one unresolved decision. State the decision in a short question, put relevant facts in description, and give distinct action labels. Omit options for free text. Use existing authorization for requested Git or file operations. Tool permissions are enforced separately. Other calls in this response will not execute; replan after the answer.",
		renderShell: "self",
		renderCallStability: "args-only",
		renderCall(args, theme, context) {
			const row = (context.lastComponent as Text | undefined) ?? new Text("", 1, 0);
			row.setText(theme.bold("提问") + "  " + sanitizeDialogText(typeof args?.question === "string" ? args.question : ""));
			return row;
		},
		renderResult(result, options, theme, context) {
			const row = (context.lastComponent as Text | undefined) ?? new Text("", 1, 0);
			const details = result.details as { status?: string; answer?: { text?: string } } | undefined;
			let label: string;
			if (context.isError) label = theme.fg("error", getTextOutput(result, false));
			else if (typeof details?.answer?.text === "string") label = theme.fg("accent", "› ") + sanitizeDialogText(details.answer.text);
			else if (options.isPartial) label = theme.fg("dim", "等待回答…");
			else if (details?.status === "user_input_cancelled") label = theme.fg("dim", "已取消");
			else if (details?.status === "requires_user_input") label = theme.fg("dim", "需要交互输入");
			else label = getTextOutput(result, false);
			row.setText(label);
			return row;
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			const stopped = (status: string) => ({ content: [{ type: "text" as const, text: status }], details: { status }, terminate: true });
			if (!ctx?.hasUI) return stopped("requires_user_input");
			if (signal?.aborted) return stopped("user_input_cancelled");
			const sessionId = ctx.sessionManager.getSessionId();
			let answer: { id?: string; text: string };
			if (!params.options || params.options.length === 0) {
				onUpdate?.({ content: [{ type: "text", text: `等待用户回答：${params.question}` }], details: { status: "waiting_for_user_input" } });
				const text = await ctx.ui.input(params.question, params.description ?? "请直接输入回答", { signal });
				if (!text || signal?.aborted || sessionId !== ctx.sessionManager.getSessionId()) return stopped("user_input_cancelled");
				if (text.length > 4000) throw new Error("Answer exceeds 4000 characters; ask again with a shorter answer");
				answer = { text };
			} else {
				if (new Set(params.options.map(option => option.id)).size !== params.options.length) throw new Error("Option IDs must be unique");
				const choices = params.options.map((option, index) => `${index + 1}. ${option.label}`);
				if (params.allowOther) choices.push(`${choices.length + 1}. 其他 / 补充文字`);
				onUpdate?.({ content: [{ type: "text", text: `等待用户选择：${params.question}` }], details: { status: "waiting_for_user_input" } });
				const selected = await ctx.ui.select(params.question, choices, { kind: "question", signal, details: params.description });
				if (!selected || signal?.aborted || sessionId !== ctx.sessionManager.getSessionId()) return stopped("user_input_cancelled");
				const index = choices.indexOf(selected);
				if (index < 0) return stopped("user_input_cancelled");
				if (index < params.options.length) answer = { id: params.options[index].id, text: params.options[index].label };
				else {
					const text = await ctx.ui.input("补充回答", undefined, { signal });
					if (!text || signal?.aborted || sessionId !== ctx.sessionManager.getSessionId()) return stopped("user_input_cancelled");
					if (text.length > 4000) throw new Error("Answer exceeds 4000 characters; ask again with a shorter answer");
					answer = { text };
				}
			}
			return { content: [{ type: "text", text: JSON.stringify(answer) }], details: { status: "answered", answer } };
		},
	};
}

export function createAskUserTool() { return wrapToolDefinition(createAskUserToolDefinition()); }
