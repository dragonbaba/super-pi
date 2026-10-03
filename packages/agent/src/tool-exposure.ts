import type { AgentTool } from "./types.ts";

/** Rebuilt only when the active tool array changes. No allocation for ordinary agents. */
export function selectModelTools(tools: AgentTool<any>[] | undefined): AgentTool<any>[] | undefined {
	if (!tools) return undefined;
	let firstHidden = -1;
	for (let index = 0; index < tools.length; index++) {
		if (tools[index]!.modelExposure === "nested") { firstHidden = index; break; }
	}
	if (firstHidden < 0) return tools;
	const selected = tools.slice(0, firstHidden);
	for (let index = firstHidden + 1; index < tools.length; index++) {
		if (tools[index]!.modelExposure !== "nested") selected.push(tools[index]!);
	}
	return selected;
}

/**
 * Whether `modelTools` is still exactly `selectModelTools(tools)`. Callers may mutate or
 * replace `tools` after the projection was cached; this check costs one scan and no allocation.
 */
export function isModelToolSelection(tools: readonly AgentTool<any>[] | undefined, modelTools: readonly AgentTool<any>[] | undefined): boolean {
	if (!tools || !modelTools) return tools === modelTools;
	let selected = 0;
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index]!;
		if (tool.modelExposure === "nested") continue;
		if (modelTools[selected++] !== tool) return false;
	}
	return selected === modelTools.length;
}
