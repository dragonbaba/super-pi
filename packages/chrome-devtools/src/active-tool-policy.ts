import { CHROME_DEVTOOLS_TOOL_NAMES, type ChromeDevToolsToolName } from "./tool-names.js";

const PLAN_MODE_QUESTION_TOOL = "plan_mode_question";
const PLAN_MODE_COMPLETE_TOOL = "plan_mode_complete";

export const CHROME_DEVTOOLS_TOOL_NAME_SET: ReadonlySet<string> = new Set(
	CHROME_DEVTOOLS_TOOL_NAMES,
);

export function planModeOwnsActiveTools(activeToolNames: readonly string[]): boolean {
	let hasQuestionTool = false;
	let hasCompleteTool = false;
	for (let index = 0; index < activeToolNames.length; index += 1) {
		const name = activeToolNames[index];
		if (name === PLAN_MODE_QUESTION_TOOL) hasQuestionTool = true;
		else if (name === PLAN_MODE_COMPLETE_TOOL) hasCompleteTool = true;
		if (hasQuestionTool && hasCompleteTool) return true;
	}
	return false;
}

export function reconcileChromeDevtoolsTools(
	activeToolNames: readonly string[],
	selectedTools: readonly ChromeDevToolsToolName[],
	preservePlanModeSelection: boolean,
): string[] | undefined {
	if (preservePlanModeSelection && planModeOwnsActiveTools(activeToolNames)) return undefined;

	const next: string[] = [];
	for (let index = 0; index < activeToolNames.length; index += 1) {
		const name = activeToolNames[index];
		if (!CHROME_DEVTOOLS_TOOL_NAME_SET.has(name)) next.push(name);
	}
	for (let index = 0; index < selectedTools.length; index += 1) {
		const name = selectedTools[index];
		if (!CHROME_DEVTOOLS_TOOL_NAME_SET.has(name) || next.includes(name)) continue;
		next.push(name);
	}
	return next;
}
