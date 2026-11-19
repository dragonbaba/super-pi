import type { ExtensionUIContext, QuestionPage, QuestionPageResult } from "../extensions/types.ts";

export const MAX_QUESTION_ANSWER_LENGTH = 4000;

/** Collect one page via the existing RPC/SDK dialog protocol. */
export async function readQuestionPageWithDialogs(
	ui: Pick<ExtensionUIContext, "select" | "input">, page: QuestionPage, signal?: AbortSignal, backOnDismiss = false,
): Promise<QuestionPageResult | undefined> {
	const title = page.count > 1 ? `${page.index + 1}/${page.count}  ${page.title}` : page.title;
	const back = { back: true, selected: page.selected, text: page.text };
	const dismissed = backOnDismiss && page.count > 1 ? back : undefined;
	let selected = page.options.length;
	if (page.options.length || page.text) {
		const choices = [...page.options];
		if (page.index > 0) choices.push("← 上一题");
		const keep = page.text ? `沿用已填写的回答：${page.text}` : undefined;
		if (keep) choices.push(keep);
		choices.push("自定义回答…");
		const value = await ui.select(title, choices, { kind: "question", details: page.description, signal });
		if (signal?.aborted) return undefined;
		if (value === undefined) return dismissed;
		if (value === "← 上一题") return back;
		if (value === keep) return { back: false, selected, text: page.text };
		if (value !== "自定义回答…") {
			selected = page.options.indexOf(value);
			if (selected < 0) return undefined;
			return { back: false, selected, text: page.text };
		}
	}
	const text = await ui.input(title, page.description ?? "请输入回答", { signal });
	if (signal?.aborted) return undefined;
	return text === undefined ? dismissed : { back: false, selected, text };
}
