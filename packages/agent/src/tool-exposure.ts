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
