import { Type } from "typebox";
import { Text } from "@super-pi/tui";
import { sanitizeDialogText } from "../../modes/interactive/components/selector-text.ts";
import { getTextOutput } from "./render-utils.ts";
import type { QuestionPage, ToolDefinition } from "../extensions/types.ts";
import { MAX_QUESTION_ANSWER_LENGTH, readQuestionPageWithDialogs } from "./question-dialogs.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const identifier = Type.String({ minLength: 1, maxLength: 64 });
const questionText = Type.String({ minLength: 1, maxLength: 1000 });
const description = Type.Optional(Type.String({ maxLength: 2000 }));
const option = Type.Object({ id: identifier, label: Type.String({ minLength: 1, maxLength: 200 }) });
const parameters = Type.Object({
	question: Type.Optional(questionText), description,
	options: Type.Optional(Type.Array(option, { minItems: 2, maxItems: 6 })),
	allowOther: Type.Optional(Type.Boolean({ description: "Legacy field. Free text is always available." })),
	questions: Type.Optional(Type.Array(Type.Object({ id: identifier, question: questionText, description,
		options: Type.Optional(Type.Array(option, { minItems: 2, maxItems: 3 })),
	}), { minItems: 1, maxItems: 3 })),
});

interface GroupAnswer { questionId: string; id?: string; text: string; }

export function createAskUserToolDefinition(): ToolDefinition<typeof parameters> {
	return {
		name: "ask_user", label: "等待用户选择", parameters,
		interactionBoundary: true,
		promptSnippet: "Ask one question or group independent decisions and wait for the answers",
		promptGuidelines: ["Proceed with authorized steps. If a requested condition is unmet, report it and finish independent work. When a material choice still blocks the task, call ask_user and wait for its result."],
		description: "Use question for one decision or questions for up to three independent decisions with unique IDs. Give 2–3 concrete options per question; the UI adds custom input. Omit options for free text. Ask dependent follow-ups after receiving the answers. Use existing authorization for requested operations. Other calls in this response will not execute.",
		renderShell: "self",
		renderCallStability: "args-only",
		renderCall(args, theme, context) {
			const row = (context.lastComponent as Text | undefined) ?? new Text("", 1, 0);
			row.setText(theme.bold("提问") + "  " + (Array.isArray(args?.questions) ? `${args.questions.length} 项` : sanitizeDialogText(typeof args?.question === "string" ? args.question : "")));
			return row;
		},
		renderResult(result, options, theme, context) {
			const row = (context.lastComponent as Text | undefined) ?? new Text("", 1, 0);
			const details = result.details as { status?: string; answer?: { text?: string }; answers?: GroupAnswer[] } | undefined;
			let label: string;
			if (context.isError) label = theme.fg("error", getTextOutput(result, false));
			else if (Array.isArray(details?.answers)) {
				const questions = context.args?.questions;
				label = "";
				for (let index = 0; index < details.answers.length; index++) {
					const item = details.answers[index]!;
					const question = questions?.[index]?.question;
					if (label) label += "\n";
					label += sanitizeDialogText(question ?? item.questionId) + "\n" + theme.fg("accent", "› ") + sanitizeDialogText(item.text);
				}
			}
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
			if (params.questions && (params.question !== undefined || params.options !== undefined || params.description !== undefined))
				throw new Error("Use either question or questions, with options and description on the corresponding question.");
			if (!params.questions && !params.question) throw new Error("A question or questions array is required");
			const questions = params.questions ?? [{ id: "", question: params.question!, options: params.options, description: params.description }];
			const pages: QuestionPage[] = [];
			const ids = new Set<string>();
			for (const q of questions) {
				if (ids.has(q.id)) throw new Error("Question IDs must be unique");
				ids.add(q.id);
				const options = q.options ?? [];
				if (new Set(options.map(opt => opt.id)).size !== options.length) throw new Error("Option IDs must be unique within a question");
				pages.push({ title: q.question, description: q.description, options: options.map((opt, i) => `${i + 1}. ${opt.label}`),
					index: pages.length, count: questions.length, selected: 0, text: "" });
			}
			onUpdate?.({ content: [{ type: "text", text: "等待用户回答" }], details: { status: "waiting_for_user_input" } });
			for (let index = 0; index < pages.length;) {
				const page = pages[index]!;
				const result = ctx.ui.questionPage
					? await ctx.ui.questionPage(page, { signal })
					: await readQuestionPageWithDialogs(ctx.ui, page, signal);
				if (!result || signal?.aborted || sessionId !== ctx.sessionManager.getSessionId()) return stopped("user_input_cancelled");
				if (!Number.isInteger(result.selected) || result.selected < 0 || result.selected > page.options.length || typeof result.text !== "string")
					throw new Error("Invalid question page answer");
				page.selected = result.selected;
				page.text = result.text;
				if (result.back) {
					index = Math.max(0, index - 1);
					continue;
				}
				if (page.selected === page.options.length) {
					if (!page.text.trim()) return stopped("user_input_cancelled");
					if (page.text.length > MAX_QUESTION_ANSWER_LENGTH) throw new Error(`Answer exceeds ${MAX_QUESTION_ANSWER_LENGTH} characters`);
				}
				index++;
			}
			const answers: GroupAnswer[] = [];
			for (const page of pages) {
				const q = questions[page.index]!;
				const selected = q.options?.[page.selected];
				const answer = selected ? { id: selected.id, text: selected.label } : { text: page.text };
				if (!params.questions) return { content: [{ type: "text", text: JSON.stringify(answer) }], details: { status: "answered", answer } };
				answers.push({ questionId: q.id, ...answer });
			}
			return { content: [{ type: "text", text: JSON.stringify({ answers }) }], details: { status: "answered", answers } };
		},
	};
}

export function createAskUserTool() { return wrapToolDefinition(createAskUserToolDefinition()); }
