import assert from "node:assert/strict";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/types.ts";
import toolClassification from "../../packages/tool-classification/src/index.ts";

export interface SearchTool { name: string; description: string; available?: boolean }
export function searchFixture(initialTools: SearchTool[], extension = toolClassification) {
	let tools = initialTools, active = ["tool_search"];
	let search: any;
	const hooks = new Map<string, Function[]>();
	const counters = { catalogReads: 0, activationCalls: 0 };
	let allowed: (name: string) => boolean = () => true;
	extension({
		on(name: string, fn: Function) { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); },
		events: { on() { return () => {}; } }, registerCommand() {},
		registerTool(tool: any) { if (tool.name === "tool_search") search = tool; },
		getToolCatalog() { counters.catalogReads++; return { tools, activeTools: active }; },
		getActiveTools() { return active; },
		setActiveTools(names: string[]) { counters.activationCalls++; active = names.filter(allowed); },
	} as unknown as ExtensionAPI);
	assert.ok(search);
	return {
		counters,
		search(query: string, limit = 6) { return search.execute("fixture", { query, limit }) as Promise<any>; },
		setActive(names: string[]) { active = names; },
		setCatalog(next: SearchTool[]) { tools = next; },
		setAllowed(next: (name: string) => boolean) { allowed = next; },
		emit(name: string, event: unknown) { for (const fn of hooks.get(name) ?? []) fn(event); },
	};
}
